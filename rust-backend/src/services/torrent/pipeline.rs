/// Torrent download pipeline.

use anyhow::{bail, Context, Result};
use sqlx::PgPool;
use tokio::io::AsyncWriteExt;
use tracing::{debug, error, info};
use uuid::Uuid;

use super::magnet::MagnetLink;
use super::metadata::{fetch_metadata, TorrentFile, TorrentMetadata};
use super::tracker::{announce_all, generate_peer_id, Peer};
use super::peer::{PeerConnection, PeerMessage};
use super::pieces::BLOCK_SIZE;
use crate::services::mega::auth::MegaState;
use crate::services::mega::upload::{get_or_create_folder, upload_stream_to_mega};
use crate::services::progress_store::{Progress, ProgressStore};

use tokio::time::{timeout, Duration};

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
    id: Uuid, magnet_str: String, file_name_hint: Option<String>,
    file_indices: Option<Vec<usize>>, _guest_id: Option<Uuid>,
    pool: PgPool, progress: ProgressStore, _http: reqwest::Client,
) {
    if let Err(e) = _download_to_server(id, &magnet_str, file_name_hint.as_deref(), file_indices, &pool, &progress).await {
        error!("torrent→server failed {id}: {e:#}");
        let _ = mark_failed(&pool, id, &e.to_string()).await;
        progress.insert(id, Progress::failed());
    }
}

pub async fn stream_torrent_to_mega(
    id: Uuid, magnet_str: String, file_name_hint: Option<String>,
    file_indices: Option<Vec<usize>>, guest_id: Option<Uuid>,
    pool: PgPool, progress: ProgressStore, http: reqwest::Client, mega: MegaState,
) {
    if let Err(e) = _stream_to_mega(id, &magnet_str, file_name_hint.as_deref(), file_indices, guest_id, &pool, &progress, &http, mega).await {
        error!("torrent→mega failed {id}: {e:#}");
        let _ = mark_failed(&pool, id, &e.to_string()).await;
        progress.insert(id, Progress::failed());
    }
}

// ── Download to server ────────────────────────────────────────────────────────

async fn _download_to_server(
    id: Uuid, magnet_str: &str, file_name_hint: Option<&str>,
    file_indices: Option<Vec<usize>>, pool: &PgPool, progress: &ProgressStore,
) -> Result<()> {
    let magnet = MagnetLink::parse(magnet_str)?;
    let meta = fetch_metadata(&magnet).await.context("fetch metadata")?;

    let selected = select_files(&meta, file_indices.as_deref());
    let total_bytes: u64 = selected.iter().map(|f| f.size).sum();
    let download_dir = std::path::PathBuf::from("downloads");
    tokio::fs::create_dir_all(&download_dir).await?;

    let peer_id = generate_peer_id();
    let peers = announce_all(&magnet.trackers, &magnet.info_hash, &peer_id, 10).await;
    if peers.is_empty() { bail!("No peers"); }

    let mut total_downloaded: u64 = 0;
    for file in &selected {
        let out_name = if selected.len() == 1 { file_name_hint.unwrap_or(&file.name).to_string() } else { file.name.clone() };
        mark_downloading(pool, id, file, total_bytes).await?;

        let file_offset = calculate_file_offset(&meta, file);
        let file_bytes = download_file_pieces(&peers, &magnet.info_hash, &peer_id, &meta, file_offset, file.size, progress, id, total_downloaded, total_bytes).await?;

        let dest = download_dir.join(&out_name);
        tokio::fs::File::create(&dest).await?.write_all(&file_bytes).await?;
        total_downloaded += file.size;
    }

    mark_completed(pool, id).await?;
    progress.insert(id, Progress::complete(total_bytes));
    info!("Torrent → disk complete ✅ id={id}");
    Ok(())
}

// ── Stream to MEGA ────────────────────────────────────────────────────────────

async fn _stream_to_mega(
    id: Uuid, magnet_str: &str, file_name_hint: Option<&str>,
    file_indices: Option<Vec<usize>>, guest_id: Option<Uuid>,
    pool: &PgPool, progress: &ProgressStore, http: &reqwest::Client, mut mega: MegaState,
) -> Result<()> {
    let magnet = MagnetLink::parse(magnet_str)?;
    let meta = fetch_metadata(&magnet).await.context("fetch metadata")?;

    let selected = select_files(&meta, file_indices.as_deref());
    let total_bytes: u64 = selected.iter().map(|f| f.size).sum();

    let target_handle = match guest_id {
        Some(gid) => get_or_create_folder(&mut mega.client, &mega.root_handle, &gid.to_string(), &mega.master_key).await?,
        None => mega.root_handle.clone(),
    };

    let peer_id = generate_peer_id();
    let peers = announce_all(&magnet.trackers, &magnet.info_hash, &peer_id, 10).await;
    if peers.is_empty() { bail!("No peers"); }

    let mut total_downloaded: u64 = 0;
    for file in &selected {
        let upload_name = if selected.len() == 1 { file_name_hint.unwrap_or(&file.name).to_string() } else { file.name.clone() };
        mark_downloading(pool, id, file, total_bytes).await?;

        let file_offset = calculate_file_offset(&meta, file);
        let file_bytes = download_file_pieces(&peers, &magnet.info_hash, &peer_id, &meta, file_offset, file.size, progress, id, total_downloaded, total_bytes).await?;

        let file_size = file_bytes.len() as u64;
        let stream = Box::pin(futures::stream::once(async { Ok::<_, std::io::Error>(bytes::Bytes::from(file_bytes)) }));
        let progress_clone = progress.clone();
        let base = total_downloaded;
        let total = total_bytes;

        upload_stream_to_mega(&mut mega.client, http.clone(), &target_handle, &upload_name, file_size, &mega.master_key, stream, move |u| {
            let mut p = progress_clone.entry(id).or_insert(Progress::initial());
            p.update(base + u, total);
        }).await.context("MEGA upload")?;

        total_downloaded += file.size;
    }

    mark_completed(pool, id).await?;
    progress.insert(id, Progress::complete(total_bytes));
    info!("Torrent → MEGA complete ✅ id={id}");
    Ok(())
}

// ── Piece download ────────────────────────────────────────────────────────────

async fn download_file_pieces(
    peers: &[Peer], info_hash: &[u8; 20], peer_id: &[u8; 20],
    meta: &TorrentMetadata, file_offset: u64, file_length: u64,
    progress: &ProgressStore, id: Uuid, base_downloaded: u64, total_bytes: u64,
) -> Result<Vec<u8>> {
    let piece_length = meta.piece_length as u64;
    let first_piece = (file_offset / piece_length) as u32;
    let last_piece = ((file_offset + file_length - 1) / piece_length) as u32;
    let total_pieces = (last_piece - first_piece + 1) as usize;

    let mut downloaded: Vec<Option<Vec<u8>>> = vec![None; total_pieces];
    let mut done = 0;

    for peer in peers.iter().take(20) {
        if done >= total_pieces { break; }
        let remaining: Vec<u32> = (first_piece..=last_piece)
            .enumerate()
            .filter(|(i, _)| downloaded[*i].is_none())
            .map(|(_, p)| p)
            .collect();

        match timeout(Duration::from_secs(60), download_from_peer(peer.addr(), info_hash, peer_id, &remaining, meta)).await {
            Ok(Ok(pieces_data)) => {
                for (idx, data) in pieces_data {
                    let local = (idx - first_piece) as usize;
                    if local < downloaded.len() && downloaded[local].is_none() {
                        downloaded[local] = Some(data);
                        done += 1;
                        let mut p = progress.entry(id).or_insert(Progress::initial());
                        p.update(base_downloaded + (done as f64 / total_pieces as f64 * file_length as f64) as u64, total_bytes);
                    }
                }
                if done > 0 { info!("Got {done}/{total_pieces} pieces from {}", peer.addr()); }
            }
            _ => {}
        }
    }

    if done < total_pieces { bail!("Only got {done}/{total_pieces} pieces"); }

    // Assemble
    let mut file_data = Vec::with_capacity(file_length as usize);
    let start_in_first = (file_offset % piece_length) as usize;
    for (i, p) in downloaded.iter().enumerate() {
        let data = p.as_ref().unwrap();
        let start = if i == 0 { start_in_first } else { 0 };
        let remaining = file_length as usize - file_data.len();
        let end = start + remaining.min(data.len() - start);
        file_data.extend_from_slice(&data[start..end]);
    }
    Ok(file_data)
}

async fn download_from_peer(
    addr: std::net::SocketAddr, info_hash: &[u8; 20], peer_id: &[u8; 20],
    pieces: &[u32], meta: &TorrentMetadata,
) -> Result<Vec<(u32, Vec<u8>)>> {
    let mut conn = PeerConnection::connect(addr, info_hash, peer_id, false).await?;
    conn.send(&PeerMessage::Interested).await?;

    // Wait for unchoke
    for _ in 0..20 {
        match timeout(Duration::from_secs(10), conn.recv()).await {
            Ok(Ok(PeerMessage::Unchoke)) => break,
            Ok(Ok(_)) => continue,
            _ => bail!("unchoke timeout"),
        }
    }

    let mut results = Vec::new();
    for &piece_idx in pieces {
        let piece_len = {
            let start = piece_idx as u64 * meta.piece_length as u64;
            let end = (start + meta.piece_length as u64).min(meta.total_size);
            (end - start) as u32
        };

        match timeout(Duration::from_secs(30), download_one_piece(&mut conn, piece_idx, piece_len, meta)).await {
            Ok(Ok(data)) => results.push((piece_idx, data)),
            _ => break,
        }
    }
    Ok(results)
}

async fn download_one_piece(conn: &mut PeerConnection, idx: u32, len: u32, meta: &TorrentMetadata) -> Result<Vec<u8>> {
    let mut data = vec![0u8; len as usize];
    let num_blocks = (len + BLOCK_SIZE - 1) / BLOCK_SIZE;

    let mut offset = 0u32;
    while offset < len {
        let bl = BLOCK_SIZE.min(len - offset);
        conn.send(&PeerMessage::Request { index: idx, begin: offset, length: bl }).await?;
        offset += bl;
    }

    let mut got = 0u32;
    for _ in 0..(num_blocks * 2 + 5) {
        match timeout(Duration::from_secs(15), conn.recv()).await {
            Ok(Ok(PeerMessage::Piece { index, begin, data: d })) if index == idx => {
                let end = (begin as usize + d.len()).min(data.len());
                data[begin as usize..end].copy_from_slice(&d[..end - begin as usize]);
                got += 1;
                if got >= num_blocks { break; }
            }
            Ok(Ok(PeerMessage::Choke)) => bail!("choked"),
            Ok(Ok(_)) => continue,
            _ => bail!("block timeout"),
        }
    }

    // Verify SHA-1
    use sha1::{Digest, Sha1};
    let hash: [u8; 20] = Sha1::digest(&data).into();
    let expected = &meta.piece_hashes[idx as usize * 20..(idx as usize + 1) * 20];
    if hash.as_slice() != expected { bail!("SHA-1 mismatch piece {idx}"); }
    Ok(data)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn select_files<'a>(meta: &'a TorrentMetadata, indices: Option<&[usize]>) -> Vec<&'a TorrentFile> {
    match indices {
        Some(idxs) if !idxs.is_empty() => meta.files.iter().filter(|f| idxs.contains(&f.index)).collect(),
        _ => meta.files.iter().max_by_key(|f| f.size).map(|f| vec![f]).unwrap_or_default(),
    }
}

fn calculate_file_offset(meta: &TorrentMetadata, target: &TorrentFile) -> u64 {
    let mut sorted: Vec<&TorrentFile> = meta.files.iter().collect();
    sorted.sort_by_key(|f| f.index);
    let mut offset = 0u64;
    for file in sorted { if file.index == target.index { return offset; } offset += file.size; }
    0
}
