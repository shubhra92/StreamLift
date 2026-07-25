#![allow(dead_code, unused_imports, unused_variables)]
///
/// Coordinates requesting pieces from peers, verifying SHA-1 hashes,
/// and storing verified pieces in the PieceStore.

use anyhow::{bail, Context, Result};
use sha1::{Digest, Sha1};
use std::net::SocketAddr;
use tokio::sync::mpsc;
use tracing::debug;

use super::peer::{PeerConnection, PeerMessage};
use super::store::PieceStore;

/// The standard BitTorrent block request size.
pub const BLOCK_SIZE: u32 = 16 * 1024; // 16 KB

#[derive(Debug, Clone)]
pub struct PieceInfo {
    pub index: u32,
    pub length: u32,          // last piece may be shorter
    pub hash: [u8; 20],       // SHA-1 expected hash
}

/// Download a set of pieces from a single peer.
///
/// `pieces` is the list of PieceInfo objects we want to download.
/// Verified pieces are stored in `store`.
/// `progress_tx` sends (piece_index, bytes_downloaded) updates.
pub async fn download_pieces_from_peer(
    peer_addr: SocketAddr,
    info_hash: &[u8; 20],
    peer_id: &[u8; 20],
    pieces: Vec<PieceInfo>,
    _piece_hashes: Vec<[u8; 20]>,
    store: PieceStore,
    progress_tx: mpsc::Sender<(u32, u64)>,
) -> Result<()> {
    let mut conn = PeerConnection::connect(peer_addr, info_hash, peer_id, false)
        .await
        .context("connect to peer")?;

    // Express interest
    conn.send(&PeerMessage::Interested).await?;

    // Wait for unchoke
    wait_for_unchoke(&mut conn).await?;

    for piece_info in &pieces {
        download_piece(&mut conn, piece_info, &store, &progress_tx).await?;
    }

    Ok(())
}

async fn wait_for_unchoke(conn: &mut PeerConnection) -> Result<()> {
    for _ in 0..50 {
        match conn.recv().await? {
            PeerMessage::Unchoke => return Ok(()),
            PeerMessage::Choke => bail!("Peer choked us"),
            _ => {} // ignore bitfield, have, etc.
        }
    }
    bail!("Never received unchoke from peer")
}

/// Download a single piece by requesting all its blocks.
async fn download_piece(
    conn: &mut PeerConnection,
    piece: &PieceInfo,
    store: &PieceStore,
    progress_tx: &mpsc::Sender<(u32, u64)>,
) -> Result<()> {
    let mut piece_data = vec![0u8; piece.length as usize];
    let mut received_bytes: u32 = 0;

    // Request all blocks for this piece
    let mut offset = 0u32;
    while offset < piece.length {
        let block_len = BLOCK_SIZE.min(piece.length - offset);
        conn.send(&PeerMessage::Request {
            index: piece.index,
            begin: offset,
            length: block_len,
        })
        .await?;
        offset += block_len;
    }

    // Collect all blocks
    let num_blocks = (piece.length + BLOCK_SIZE - 1) / BLOCK_SIZE;
    for _ in 0..num_blocks {
        let msg = conn.recv().await?;
        match msg {
            PeerMessage::Piece { index, begin, data } => {
                if index != piece.index {
                    debug!("Got piece {} but expected {}", index, piece.index);
                    continue;
                }
                let end = (begin as usize + data.len()).min(piece_data.len());
                piece_data[begin as usize..end].copy_from_slice(&data[..end - begin as usize]);
                received_bytes += data.len() as u32;
            }
            PeerMessage::Choke => bail!("Peer choked us mid-piece"),
            _ => {}
        }
    }

    // Verify SHA-1
    let mut hasher = Sha1::new();
    hasher.update(&piece_data);
    let hash: [u8; 20] = hasher.finalize().into();
    if hash != piece.hash {
        bail!("Piece {} SHA-1 mismatch", piece.index);
    }

    store.put(piece.index, piece_data);
    let _ = progress_tx
        .send((piece.index, received_bytes as u64))
        .await;

    debug!("Piece {} downloaded and verified ✅", piece.index);
    Ok(())
}

/// Build PieceInfo list for a range of pieces covering a file (or set of files).
/// `pieces_hashes` is the flat 20-bytes-per-piece SHA-1 array from the info dict.
pub fn build_piece_list(
    file_offset: u64,
    file_length: u64,
    piece_length: u32,
    total_torrent_length: u64,
    piece_hashes_flat: &[u8],
) -> Vec<PieceInfo> {
    let first_piece = (file_offset / piece_length as u64) as u32;
    let last_piece = ((file_offset + file_length - 1) / piece_length as u64) as u32;
    let _total_pieces = (piece_hashes_flat.len() / 20) as u32;

    (first_piece..=last_piece)
        .filter(|&i| (i as usize) < piece_hashes_flat.len() / 20)
        .map(|i| {
            let piece_start = i as u64 * piece_length as u64;
            let piece_end = (piece_start + piece_length as u64).min(total_torrent_length);
            let length = (piece_end - piece_start) as u32;

            let mut hash = [0u8; 20];
            hash.copy_from_slice(&piece_hashes_flat[i as usize * 20..(i as usize + 1) * 20]);

            PieceInfo { index: i, length, hash }
        })
        .collect()
}
