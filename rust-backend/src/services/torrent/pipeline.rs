#![allow(dead_code, unused_imports, unused_variables, unused_mut)]
/// Torrent download pipeline.

use anyhow::{bail, Context, Result};
use sqlx::PgPool;
use tokio::io::AsyncWriteExt;
use tracing::{error, info};
use uuid::Uuid;

use super::magnet::MagnetLink;
use super::metadata::{TorrentFile, TorrentMetadata};
use super::tracker::Peer;
use super::peer::{PeerConnection, PeerMessage};
use super::pieces::BLOCK_SIZE;
use super::engine::download_piece_from_peer;
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
    engine: std::sync::Arc<crate::services::torrent::engine::TorrentEngine>,
) {
    if let Err(e) = _download_to_server(id, &magnet_str, file_name_hint.as_deref(), file_indices, &pool, &progress, &engine).await {
        error!("torrent→server failed {id}: {e:#}");
        let _ = mark_failed(&pool, id, &e.to_string()).await;
        progress.insert(id, Progress::failed());
    }
}

pub async fn stream_torrent_to_mega(
    id: Uuid, magnet_str: String, file_name_hint: Option<String>,
    file_indices: Option<Vec<usize>>, guest_id: Option<Uuid>,
    pool: PgPool, progress: ProgressStore, http: reqwest::Client, mega: MegaState,
    engine: std::sync::Arc<crate::services::torrent::engine::TorrentEngine>,
) {
    if let Err(e) = _stream_to_mega(id, &magnet_str, file_name_hint.as_deref(), file_indices, guest_id, &pool, &progress, &http, mega, &engine).await {
        error!("torrent→mega failed {id}: {e:#}");
        let _ = mark_failed(&pool, id, &e.to_string()).await;
        progress.insert(id, Progress::failed());
    }
}

// ── Download to server ────────────────────────────────────────────────────────

async fn _download_to_server(
    id: Uuid, magnet_str: &str, file_name_hint: Option<&str>,
    file_indices: Option<Vec<usize>>, pool: &PgPool, progress: &ProgressStore,
    engine: &crate::services::torrent::engine::TorrentEngine,
) -> Result<()> {
    let magnet = MagnetLink::parse(magnet_str)?;
    
    // Use engine to get metadata (reuses cached sessions)
    let meta = engine.fetch_metadata(&magnet).await.context("fetch metadata")?;

    let selected = select_files(&meta, file_indices.as_deref());
    let total_bytes: u64 = selected.iter().map(|f| f.size).sum();
    let download_dir = std::path::PathBuf::from("downloads");
    tokio::fs::create_dir_all(&download_dir).await?;

    let mut total_downloaded: u64 = 0;
    for file in &selected {
        let out_name = if selected.len() == 1 { file_name_hint.unwrap_or(&file.name).to_string() } else { file.name.clone() };
        mark_downloading(pool, id, file, total_bytes).await?;

        let file_offset = calculate_file_offset(&meta, file);
        let file_bytes = download_file_via_engine(engine, &magnet, &meta, file_offset, file.size, progress, id, total_downloaded, total_bytes).await?;

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
    engine: &crate::services::torrent::engine::TorrentEngine,
) -> Result<()> {
    let magnet = MagnetLink::parse(magnet_str)?;
    let meta = engine.fetch_metadata(&magnet).await.context("fetch metadata")?;

    let selected = select_files(&meta, file_indices.as_deref());
    let total_bytes: u64 = selected.iter().map(|f| f.size).sum();

    let target_handle = match guest_id {
        Some(gid) => get_or_create_folder(&mut mega.client, &mega.root_handle, &gid.to_string(), &mega.master_key).await?,
        None => mega.root_handle.clone(),
    };

    let mut total_downloaded: u64 = 0;
    for file in &selected {
        let upload_name = if selected.len() == 1 { file_name_hint.unwrap_or(&file.name).to_string() } else { file.name.clone() };
        mark_downloading(pool, id, file, total_bytes).await?;

        let file_offset = calculate_file_offset(&meta, file);
        let piece_length = meta.piece_length as u64;
        let first_piece = (file_offset / piece_length) as u32;
        let last_piece = ((file_offset + file_length_of(file, &meta)) / piece_length) as u32;

        // Create a channel: torrent download produces bytes, MEGA upload consumes
        let (tx, rx) = tokio::sync::mpsc::channel::<Result<bytes::Bytes, std::io::Error>>(4);

        // Convert receiver to a Stream for upload_stream_to_mega
        let byte_stream = tokio_stream::wrappers::ReceiverStream::new(rx);

        let progress_clone = progress.clone();
        let base = total_downloaded;
        let total = total_bytes;
        let file_size = file.size;

        // Spawn torrent piece download (producer) — downloads pieces in order, sends bytes
        let magnet_clone = magnet.clone();
        let meta_clone = meta.clone();
        let file_offset_copy = file_offset;
        let file_size_copy = file.size;

        // We can't pass &engine to a spawned task, so we'll download sequentially
        // in the same task but interleave with the upload via the channel
        let download_handle = {
            let tx = tx;
            let magnet_clone = magnet_clone;
            let meta_clone = meta_clone;
            
            // Download pieces sequentially and feed to channel
            // This runs in a separate task to allow MEGA upload to consume concurrently
            let session_arc = engine.get_or_create_session(&magnet_clone).await;
            
            tokio::spawn(async move {
                let piece_length = meta_clone.piece_length as u64;
                let first_piece = (file_offset_copy / piece_length) as u32;
                let last_piece = ((file_offset_copy + file_size_copy - 1) / piece_length) as u32;
                let start_in_first = (file_offset_copy % piece_length) as usize;

                // Initialize peers for piece download (send Interested, wait for Unchoke)
                {
                    let mut session = session_arc.write().await;
                    for peer in session.peers.iter_mut() {
                        let _ = peer.conn.send_message(&super::engine::wire::Message::Interested).await;
                    }
                    // Brief wait for unchoke
                    for peer in session.peers.iter_mut() {
                        for _ in 0..5 {
                            match tokio::time::timeout(
                                tokio::time::Duration::from_secs(2),
                                peer.conn.read_message(tokio::time::Duration::from_secs(2)),
                            ).await {
                                Ok(Ok(Some(super::engine::wire::Message::Unchoke))) => {
                                    peer.am_choked = false;
                                    break;
                                }
                                Ok(Ok(Some(_))) => continue,
                                _ => break,
                            }
                        }
                    }
                    let unchoked = session.peers.iter().filter(|p| !p.am_choked).count();
                    tracing::info!("Streaming download: {} peers ({} unchoked)", session.peers.len(), unchoked);
                }

                for piece_idx in first_piece..=last_piece {
                    let piece_start = piece_idx as u64 * piece_length;
                    let piece_end = (piece_start + piece_length).min(meta_clone.total_size);
                    let this_piece_len = (piece_end - piece_start) as u32;

                    // Download piece from session peers
                    let mut piece_data = None;
                    for attempt in 0..3 {
                        let mut session = session_arc.write().await;
                        session.last_used = std::time::Instant::now();
                        
                        for peer in session.peers.iter_mut() {
                            if peer.am_choked { continue; }
                            match download_piece_from_peer(peer, piece_idx, this_piece_len).await {
                                Ok(data) => { piece_data = Some(data); break; }
                                Err(_) => continue,
                            }
                        }
                        drop(session);
                        if piece_data.is_some() { break; }
                        tokio::time::sleep(tokio::time::Duration::from_millis(500)).await;
                    }

                    let data = match piece_data {
                        Some(d) => d,
                        None => {
                            let _ = tx.send(Err(std::io::Error::new(
                                std::io::ErrorKind::Other, format!("Failed piece {piece_idx}")
                            ))).await;
                            return;
                        }
                    };

                    // Extract file's portion from this piece
                    let local_idx = (piece_idx - first_piece) as usize;
                    let start = if local_idx == 0 { start_in_first } else { 0 };
                    let file_bytes_so_far = if local_idx == 0 { 0 } else {
                        (local_idx as u64 * piece_length) - start_in_first as u64
                    };
                    let remaining = file_size_copy - file_bytes_so_far.min(file_size_copy);
                    let end = start + (remaining as usize).min(data.len() - start);
                    
                    if start >= end || start >= data.len() { continue; }
                    let file_chunk = &data[start..end];

                    if tx.send(Ok(bytes::Bytes::copy_from_slice(file_chunk))).await.is_err() {
                        return;
                    }
                }
            })
        };

        // Run MEGA upload (consumer) — consumes byte stream from channel
        upload_stream_to_mega(
            &mut mega.client, http.clone(), &target_handle, &upload_name,
            file_size, &mega.master_key, byte_stream,
            move |uploaded| {
                let mut p = progress_clone.entry(id).or_insert(Progress::initial());
                p.update(base + uploaded, total);
            },
        ).await.context("MEGA upload")?;

        // Wait for download task to finish
        let _ = download_handle.await;

        total_downloaded += file.size;
    }

    mark_completed(pool, id).await?;
    progress.insert(id, Progress::complete(total_bytes));
    info!("Torrent → MEGA streaming complete ✅ id={id}");
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
    let mut conn = PeerConnection::connect(addr, info_hash, peer_id, true).await?;
    
    // Send ext handshake + interested (matches what works for metadata)
    conn.send_extended_handshake(1).await?;
    conn.send(&PeerMessage::Interested).await?;

    // Wait for unchoke (handle bitfield, ext handshake, etc)
    let mut unchoked = false;
    for _ in 0..30 {
        match timeout(Duration::from_secs(10), conn.recv()).await {
            Ok(Ok(PeerMessage::Unchoke)) => { unchoked = true; break; }
            Ok(Ok(_)) => continue,
            _ => break,
        }
    }
    if !unchoked { bail!("not unchoked"); }

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

// ── Download via engine (reuses connected peers) ──────────────────────────────

async fn download_file_via_engine(
    engine: &crate::services::torrent::engine::TorrentEngine,
    magnet: &MagnetLink,
    meta: &TorrentMetadata,
    file_offset: u64,
    file_length: u64,
    progress: &ProgressStore,
    id: Uuid,
    base_downloaded: u64,
    total_bytes: u64,
) -> Result<Vec<u8>> {
    use sha1::{Digest, Sha1};

    let piece_length = meta.piece_length as u64;
    let first_piece = (file_offset / piece_length) as u32;
    let last_piece = ((file_offset + file_length - 1) / piece_length) as u32;
    let total_pieces = (last_piece - first_piece + 1) as usize;

    info!("Downloading pieces {first_piece}..{last_piece} ({total_pieces} pieces)");

    // Build piece request list
    let piece_requests: Vec<(u32, u32)> = (first_piece..=last_piece)
        .map(|idx| {
            let start = idx as u64 * piece_length;
            let end = (start + piece_length).min(meta.total_size);
            (idx, (end - start) as u32)
        })
        .collect();

    // Download all pieces in parallel
    let progress_clone = progress.clone();
    let file_len = file_length;
    let base = base_downloaded;
    let total = total_bytes;
    let tp = total_pieces;
    let pieces_done = std::sync::Arc::new(std::sync::atomic::AtomicU32::new(0));
    let pieces_done_clone = pieces_done.clone();

    let results = engine.download_pieces_parallel(
        magnet,
        piece_requests,
        move |_per_peer_count| {
            // Use global atomic counter instead of per-peer count
            let done = pieces_done_clone.fetch_add(1, std::sync::atomic::Ordering::SeqCst) + 1;
            let downloaded = base + (done as f64 / tp as f64 * file_len as f64) as u64;
            let mut p = progress_clone.entry(id).or_insert(Progress::initial());
            p.update(downloaded, total);
        },
    ).await?;

    // Verify SHA-1 for each piece
    let mut verified: Vec<(u32, Vec<u8>)> = Vec::with_capacity(results.len());
    for (idx, data) in results {
        let hash_offset = idx as usize * 20;
        if hash_offset + 20 <= meta.piece_hashes.len() {
            let expected = &meta.piece_hashes[hash_offset..hash_offset + 20];
            let actual: [u8; 20] = Sha1::digest(&data).into();
            if actual.as_slice() != expected {
                bail!("SHA-1 mismatch piece {idx}");
            }
        }
        verified.push((idx, data));
    }

    // Sort by piece index and assemble file
    verified.sort_by_key(|(idx, _)| *idx);

    let start_in_first = (file_offset % piece_length) as usize;
    let mut file_data = Vec::with_capacity(file_length as usize);
    for (i, (_, data)) in verified.iter().enumerate() {
        let start = if i == 0 { start_in_first } else { 0 };
        let remaining = file_length as usize - file_data.len();
        let end = start + remaining.min(data.len() - start);
        file_data.extend_from_slice(&data[start..end]);
    }

    info!("File assembled: {} bytes ✅", file_data.len());
    Ok(file_data)
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

fn file_length_of(file: &TorrentFile, _meta: &TorrentMetadata) -> u64 {
    file.size
}
