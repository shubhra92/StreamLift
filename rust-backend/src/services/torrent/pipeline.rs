/// Torrent download pipeline — uses the new engine for reliability.

use anyhow::{bail, Context, Result};
use sqlx::PgPool;
use tokio::io::AsyncWriteExt;
use tracing::{error, info};
use uuid::Uuid;

use super::engine::session::TorrentSession;
use super::magnet::MagnetLink;
use super::metadata::{TorrentFile, TorrentMetadata};
use crate::services::mega::auth::MegaState;
use crate::services::mega::upload::{get_or_create_folder, upload_stream_to_mega};
use crate::services::progress_store::{Progress, ProgressStore};

// ── DB helpers ────────────────────────────────────────────────────────────────

async fn mark_downloading(pool: &PgPool, id: Uuid, file: &TorrentFile, total_size: u64) -> Result<()> {
    sqlx::query(
        "UPDATE file_downloads SET status = 'downloading', file_name = $1, file_type = $2, \
         file_size = $3, location_path = $4, updated_at = NOW() WHERE id = $5",
    )
    .bind(&file.name).bind(&file.file_type).bind(total_size as i64)
    .bind(&file.name).bind(id)
    .persistent(false).execute(pool).await?;
    Ok(())
}

async fn mark_completed(pool: &PgPool, id: Uuid) -> Result<()> {
    sqlx::query("UPDATE file_downloads SET status = 'completed', updated_at = NOW() WHERE id = $1")
        .bind(id).persistent(false).execute(pool).await?;
    Ok(())
}

async fn mark_failed(pool: &PgPool, id: Uuid, msg: &str) -> Result<()> {
    sqlx::query("UPDATE file_downloads SET status = 'failed', error_message = $1, updated_at = NOW() WHERE id = $2")
        .bind(msg).bind(id).persistent(false).execute(pool).await?;
    Ok(())
}

// ── Public entry points ───────────────────────────────────────────────────────

pub async fn download_torrent_to_server(
    id: Uuid,
    magnet_str: String,
    file_name_hint: Option<String>,
    file_indices: Option<Vec<usize>>,
    _guest_id: Option<Uuid>,
    pool: PgPool,
    progress: ProgressStore,
    _http: reqwest::Client,
) {
    if let Err(e) = _download_to_server(id, &magnet_str, file_name_hint.as_deref(), file_indices, &pool, &progress).await {
        error!("torrent→server failed {id}: {e:#}");
        let _ = mark_failed(&pool, id, &e.to_string()).await;
        progress.insert(id, Progress::failed());
    }
}

pub async fn stream_torrent_to_mega(
    id: Uuid,
    magnet_str: String,
    file_name_hint: Option<String>,
    file_indices: Option<Vec<usize>>,
    guest_id: Option<Uuid>,
    pool: PgPool,
    progress: ProgressStore,
    http: reqwest::Client,
    mega: MegaState,
) {
    if let Err(e) = _stream_to_mega(
        id, &magnet_str, file_name_hint.as_deref(), file_indices, guest_id,
        &pool, &progress, &http, mega,
    ).await {
        error!("torrent→mega failed {id}: {e:#}");
        let _ = mark_failed(&pool, id, &e.to_string()).await;
        progress.insert(id, Progress::failed());
    }
}

// ── Download to server disk ───────────────────────────────────────────────────

async fn _download_to_server(
    id: Uuid,
    magnet_str: &str,
    file_name_hint: Option<&str>,
    file_indices: Option<Vec<usize>>,
    pool: &PgPool,
    progress: &ProgressStore,
) -> Result<()> {
    let magnet = MagnetLink::parse(magnet_str)?;

    // Create session (starts listener + announces to trackers)
    let mut session = TorrentSession::new(magnet).await?;

    // Fetch metadata
    let meta = session.fetch_metadata().await?.clone();
    info!("Torrent: {} ({} files, {})", meta.name, meta.file_count, meta.total_size_formatted);

    let selected = select_files(&meta, file_indices.as_deref());
    let total_bytes: u64 = selected.iter().map(|f| f.size).sum();

    let download_dir = std::path::PathBuf::from("downloads");
    tokio::fs::create_dir_all(&download_dir).await?;

    let mut total_downloaded: u64 = 0;

    for file in &selected {
        let out_name = if selected.len() == 1 {
            file_name_hint.unwrap_or(&file.name).to_string()
        } else {
            file.name.clone()
        };

        mark_downloading(pool, id, file, total_bytes).await?;

        let file_offset = calculate_file_offset(&meta, file);
        let progress_clone = progress.clone();
        let base = total_downloaded;
        let total = total_bytes;

        let file_bytes = session.download_file(
            file_offset,
            file.size,
            meta.piece_length,
            &meta.piece_hashes,
            meta.total_size,
            |downloaded| {
                let abs = base + downloaded;
                let mut p = progress_clone.entry(id).or_insert(Progress::initial());
                p.update(abs, total);
            },
        ).await?;

        let dest = download_dir.join(&out_name);
        let mut out_file = tokio::fs::File::create(&dest).await?;
        out_file.write_all(&file_bytes).await?;

        total_downloaded += file.size;
    }

    mark_completed(pool, id).await?;
    progress.insert(id, Progress::complete(total_bytes));
    info!("Torrent → disk complete ✅ id={id}");
    Ok(())
}

// ── Stream to MEGA ────────────────────────────────────────────────────────────

async fn _stream_to_mega(
    id: Uuid,
    magnet_str: &str,
    file_name_hint: Option<&str>,
    file_indices: Option<Vec<usize>>,
    guest_id: Option<Uuid>,
    pool: &PgPool,
    progress: &ProgressStore,
    http: &reqwest::Client,
    mut mega: MegaState,
) -> Result<()> {
    let magnet = MagnetLink::parse(magnet_str)?;

    let mut session = TorrentSession::new(magnet).await?;
    let meta = session.fetch_metadata().await?.clone();
    info!("Torrent: {} ({} files, {})", meta.name, meta.file_count, meta.total_size_formatted);

    let selected = select_files(&meta, file_indices.as_deref());
    let total_bytes: u64 = selected.iter().map(|f| f.size).sum();

    let target_handle = match guest_id {
        Some(gid) => get_or_create_folder(
            &mut mega.client, &mega.root_handle, &gid.to_string(), &mega.master_key,
        ).await?,
        None => mega.root_handle.clone(),
    };

    let mut total_downloaded: u64 = 0;

    for file in &selected {
        let upload_name = if selected.len() == 1 {
            file_name_hint.unwrap_or(&file.name).to_string()
        } else {
            file.name.clone()
        };

        mark_downloading(pool, id, file, total_bytes).await?;

        let file_offset = calculate_file_offset(&meta, file);
        let progress_clone = progress.clone();
        let base = total_downloaded;
        let total = total_bytes;

        let file_bytes = session.download_file(
            file_offset,
            file.size,
            meta.piece_length,
            &meta.piece_hashes,
            meta.total_size,
            |downloaded| {
                let abs = base + downloaded;
                let mut p = progress_clone.entry(id).or_insert(Progress::initial());
                p.update(abs, total);
            },
        ).await?;

        // Upload to MEGA
        let file_size = file_bytes.len() as u64;
        let stream = Box::pin(futures::stream::once(async move {
            Ok::<_, std::io::Error>(bytes::Bytes::from(file_bytes))
        }));

        let progress_clone2 = progress.clone();
        let base2 = total_downloaded;

        upload_stream_to_mega(
            &mut mega.client,
            http.clone(),
            &target_handle,
            &upload_name,
            file_size,
            &mega.master_key,
            stream,
            move |uploaded| {
                let mut p = progress_clone2.entry(id).or_insert(Progress::initial());
                p.update(base2 + uploaded, total_bytes);
            },
        ).await.context("MEGA upload")?;

        total_downloaded += file.size;
    }

    mark_completed(pool, id).await?;
    progress.insert(id, Progress::complete(total_bytes));
    info!("Torrent → MEGA complete ✅ id={id}");
    Ok(())
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn select_files<'a>(meta: &'a TorrentMetadata, indices: Option<&[usize]>) -> Vec<&'a TorrentFile> {
    match indices {
        Some(idxs) if !idxs.is_empty() => {
            meta.files.iter().filter(|f| idxs.contains(&f.index)).collect()
        }
        _ => meta.files.iter().max_by_key(|f| f.size).map(|f| vec![f]).unwrap_or_default(),
    }
}

fn calculate_file_offset(meta: &TorrentMetadata, target: &TorrentFile) -> u64 {
    let mut sorted: Vec<&TorrentFile> = meta.files.iter().collect();
    sorted.sort_by_key(|f| f.index);
    let mut offset = 0u64;
    for file in sorted {
        if file.index == target.index { return offset; }
        offset += file.size;
    }
    0
}
