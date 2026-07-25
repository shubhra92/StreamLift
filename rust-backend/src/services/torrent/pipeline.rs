/// Torrent → MEGA / disk pipeline.

use anyhow::{Context, Result};
use sqlx::PgPool;
use tracing::{error, info, warn};
use uuid::Uuid;

use super::magnet::MagnetLink;
use super::metadata::{fetch_metadata, TorrentFile, TorrentMetadata};
use super::store::PieceStore;
use crate::services::mega::auth::MegaState;
use crate::services::mega::upload::{get_or_create_folder, upload_stream_to_mega};
use crate::services::progress_store::{Progress, ProgressStore};

// ── DB helpers ────────────────────────────────────────────────────────────────

async fn mark_downloading(pool: &PgPool, id: Uuid, file: &TorrentFile) -> Result<()> {
    sqlx::query(
        "UPDATE file_downloads \
         SET status = 'downloading', file_name = $1, file_type = $2, \
             file_size = $3, location_path = $4, updated_at = NOW() \
         WHERE id = $5",
    )
    .bind(&file.name)
    .bind(&file.file_type)
    .bind(file.size as i64)
    .bind(&file.name)
    .bind(id)
    .persistent(false)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_completed(pool: &PgPool, id: Uuid) -> Result<()> {
    sqlx::query(
        "UPDATE file_downloads SET status = 'completed', updated_at = NOW() WHERE id = $1",
    )
    .bind(id)
    .persistent(false)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_failed(pool: &PgPool, id: Uuid, msg: &str) -> Result<()> {
    sqlx::query(
        "UPDATE file_downloads SET status = 'failed', error_message = $1, updated_at = NOW() \
         WHERE id = $2",
    )
    .bind(msg)
    .bind(id)
    .persistent(false)
    .execute(pool)
    .await?;
    Ok(())
}

// ── Public entry points ───────────────────────────────────────────────────────

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
    if let Err(e) = _stream_torrent_to_mega(
        id, &magnet_str, file_name_hint.as_deref(), file_indices, guest_id,
        &pool, &progress, &http, mega,
    ).await {
        error!("stream_torrent_to_mega failed {id}: {e:#}");
        let _ = mark_failed(&pool, id, &e.to_string()).await;
        progress.insert(id, Progress::failed());
    }
}

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
    if let Err(e) = _download_torrent_to_server(
        id, &magnet_str, file_name_hint.as_deref(), file_indices,
        &pool, &progress,
    ).await {
        error!("download_torrent_to_server failed {id}: {e:#}");
        let _ = mark_failed(&pool, id, &e.to_string()).await;
        progress.insert(id, Progress::failed());
    }
}

// ── Internals ─────────────────────────────────────────────────────────────────

async fn _stream_torrent_to_mega(
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
    info!("Fetching torrent metadata for {}", magnet.info_hash_hex);

    let meta = fetch_metadata(&magnet).await.context("fetch metadata")?;
    info!("Metadata: {} ({} files)", meta.name, meta.file_count);

    let selected = select_files(&meta, file_indices.as_deref());
    let total_bytes: u64 = selected.iter().map(|f| f.size).sum();

    let target_handle = match guest_id {
        Some(gid) => get_or_create_folder(
            &mut mega.client,
            &mega.root_handle,
            &gid.to_string(),
            &mega.master_key,
        ).await?,
        None => mega.root_handle.clone(),
    };

    let mut total_uploaded: u64 = 0;

    for file in &selected {
        let upload_name = if selected.len() == 1 {
            file_name_hint.unwrap_or(&file.name).to_string()
        } else {
            file.name.clone()
        };

        mark_downloading(pool, id, file).await?;

        let stream = create_torrent_file_stream(&magnet, file, &meta).await?;

        {
            let progress_clone = progress.clone();
            let base = total_uploaded;
            let total = total_bytes;
            upload_stream_to_mega(
                &mut mega.client,
                http.clone(),
                &target_handle,
                &upload_name,
                file.size,
                &mega.master_key,
                stream,
                move |uploaded| {
                    let abs = base + uploaded;
                    let mut p = progress_clone.entry(id).or_insert(Progress::initial());
                    p.update(abs, total);
                },
            )
            .await
            .context("upload to MEGA")?;
        }

        total_uploaded += file.size;
    }

    mark_completed(pool, id).await?;
    progress.insert(id, Progress::complete(total_bytes));
    info!("Torrent → MEGA complete ✅ id={id}");
    Ok(())
}

async fn _download_torrent_to_server(
    id: Uuid,
    magnet_str: &str,
    file_name_hint: Option<&str>,
    file_indices: Option<Vec<usize>>,
    pool: &PgPool,
    progress: &ProgressStore,
) -> Result<()> {
    use futures::StreamExt;
    use tokio::io::AsyncWriteExt;

    let magnet = MagnetLink::parse(magnet_str)?;
    info!("Fetching torrent metadata for {}", magnet.info_hash_hex);

    let meta = fetch_metadata(&magnet).await.context("fetch metadata")?;
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

        mark_downloading(pool, id, file).await?;

        let dest = download_dir.join(&out_name);
        let mut out_file = tokio::fs::File::create(&dest).await?;

        let mut stream = create_torrent_file_stream(&magnet, file, &meta).await?;

        while let Some(chunk) = stream.next().await {
            let bytes = chunk.map_err(|e| anyhow::anyhow!(e))?;
            out_file.write_all(&bytes).await?;
            total_downloaded += bytes.len() as u64;
            let mut p = progress.entry(id).or_insert(Progress::initial());
            p.update(total_downloaded, total_bytes);
        }
    }

    mark_completed(pool, id).await?;
    progress.insert(id, Progress::complete(total_bytes));
    info!("Torrent → disk complete ✅ id={id}");
    Ok(())
}

// ── File selection ────────────────────────────────────────────────────────────

fn select_files<'a>(meta: &'a TorrentMetadata, indices: Option<&[usize]>) -> Vec<&'a TorrentFile> {
    match indices {
        Some(idxs) if !idxs.is_empty() => {
            idxs.iter().filter_map(|&i| meta.files.get(i)).collect()
        }
        _ => meta.files.iter().max_by_key(|f| f.size).map(|f| vec![f]).unwrap_or_default(),
    }
}

// ── Torrent byte stream (placeholder until full piece engine) ─────────────────

async fn create_torrent_file_stream(
    magnet: &MagnetLink,
    file: &TorrentFile,
    meta: &TorrentMetadata,
) -> Result<impl futures::Stream<Item = Result<bytes::Bytes, std::io::Error>> + Unpin> {
    use super::tracker::{announce_all, generate_peer_id};

    let peer_id = generate_peer_id();
    let info_hash = magnet.info_hash;
    let trackers = magnet.trackers.clone();
    let _piece_length = meta.piece_length as u64;
    let file_offset = calculate_file_offset(meta, file);

    info!(
        "Preparing stream for '{}' offset={} size={}",
        file.name, file_offset, file.size
    );

    let _store = PieceStore::new(meta.piece_length, meta.piece_count);
    let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(32);

    tokio::spawn(async move {
        let peers = announce_all(&trackers, &info_hash, &peer_id, 5).await;
        if peers.is_empty() {
            let _ = tx.send(Err(std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "No peers found from trackers",
            ))).await;
            return;
        }
        // Phase 3: full piece download loop goes here
        warn!("Torrent piece download not yet implemented — stream will be empty");
    });

    Ok(tokio_stream::wrappers::ReceiverStream::new(rx))
}

fn calculate_file_offset(meta: &TorrentMetadata, target: &TorrentFile) -> u64 {
    let mut sorted: Vec<&TorrentFile> = meta.files.iter().collect();
    sorted.sort_by_key(|f| f.index);
    let mut offset = 0u64;
    for file in sorted {
        if file.index == target.index {
            return offset;
        }
        offset += file.size;
    }
    0
}
