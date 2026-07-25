/// Torrent Session — orchestrates a complete torrent download.
///
/// Combines: tracker announce → listener → peer pool → metadata fetch → piece download
/// This is the main entry point for the torrent engine.

use anyhow::{bail, Context, Result};
use sha1::{Digest, Sha1};
use std::net::SocketAddr;
use tokio::sync::mpsc;
use tokio::time::Duration;
use tracing::{debug, info, warn};

use super::listener::{IncomingPeer, PeerListener};
use super::peer_pool::PeerPool;
use crate::services::torrent::magnet::MagnetLink;
use crate::services::torrent::metadata::{self, TorrentMetadata};
use crate::services::torrent::tracker::{self, generate_peer_id, Peer};

/// A torrent session with all state needed for a download.
pub struct TorrentSession {
    pub magnet: MagnetLink,
    pub peer_id: [u8; 20],
    pub listen_port: u16,
    pub pool: PeerPool,
    pub metadata: Option<TorrentMetadata>,
    incoming_rx: mpsc::Receiver<IncomingPeer>,
}

impl TorrentSession {
    /// Create a new session for a magnet link.
    /// Starts the listener and performs tracker announce.
    pub async fn new(magnet: MagnetLink) -> Result<Self> {
        let peer_id = generate_peer_id();

        // Start TCP listener for incoming peers
        let (incoming_tx, incoming_rx) = mpsc::channel(32);
        let (_listener, listen_port) = PeerListener::start(incoming_tx).await?;

        let pool = PeerPool::new(magnet.info_hash, peer_id);

        Ok(Self {
            magnet,
            peer_id,
            listen_port,
            pool,
            metadata: None,
            incoming_rx,
        })
    }

    /// Fetch metadata: announce to trackers, connect to peers, get info dict.
    pub async fn fetch_metadata(&mut self) -> Result<&TorrentMetadata> {
        info!("Fetching metadata for {}", self.magnet.info_hash_hex);

        // Announce to trackers (with our listening port!)
        let peers = tracker::announce_all(
            &self.magnet.trackers,
            &self.magnet.info_hash,
            &self.peer_id,
            10,
        ).await;

        info!("Trackers returned {} peers", peers.len());

        // Connect to peers
        let addrs: Vec<SocketAddr> = peers.iter().map(|p| p.addr()).collect();
        self.pool.connect_to_peers(&addrs, 50).await;

        // Also check for any incoming peers (wait a brief moment)
        tokio::time::sleep(Duration::from_millis(500)).await;
        while let Ok(incoming) = self.incoming_rx.try_recv() {
            if incoming.info_hash == self.magnet.info_hash {
                let _ = self.pool.add_incoming(incoming).await;
            }
        }

        if self.pool.peer_count() == 0 {
            bail!("No peers connected");
        }

        // Initialize peers (ext handshake, interested, wait for unchoke)
        self.pool.initialize_peers().await;

        // Fetch metadata from a peer that has it
        let info_dict = self.pool.fetch_metadata().await.context("fetch metadata from peers")?;

        // Verify SHA-1
        let hash: [u8; 20] = Sha1::digest(&info_dict).into();
        if hash != self.magnet.info_hash {
            bail!("Metadata SHA-1 mismatch");
        }

        info!("Metadata verified ✅ ({} bytes)", info_dict.len());
        let meta = metadata::parse_info_dict_public(&info_dict, &self.magnet.info_hash_hex)?;
        self.metadata = Some(meta);

        Ok(self.metadata.as_ref().unwrap())
    }

    /// Download specific pieces and return the assembled file bytes.
    pub async fn download_file(
        &mut self,
        file_offset: u64,
        file_length: u64,
        piece_length: u32,
        piece_hashes: &[u8],
        total_torrent_size: u64,
        progress_cb: impl Fn(u64),
    ) -> Result<Vec<u8>> {
        let first_piece = (file_offset / piece_length as u64) as u32;
        let last_piece = ((file_offset + file_length - 1) / piece_length as u64) as u32;
        let total_pieces = last_piece - first_piece + 1;

        info!("Downloading pieces {first_piece}..{last_piece} ({total_pieces} pieces, {file_length} bytes)");

        // Ensure we have connected peers ready for transfer
        if self.pool.peer_count() == 0 {
            // Re-announce and connect
            let peers = tracker::announce_all(
                &self.magnet.trackers,
                &self.magnet.info_hash,
                &self.peer_id,
                10,
            ).await;
            let addrs: Vec<SocketAddr> = peers.iter().map(|p| p.addr()).collect();
            self.pool.connect_to_peers(&addrs, 30).await;
            self.pool.initialize_peers().await;
        }

        let mut downloaded_pieces: Vec<Option<Vec<u8>>> = vec![None; total_pieces as usize];
        let mut pieces_done: u32 = 0;

        for piece_idx in first_piece..=last_piece {
            let local_idx = (piece_idx - first_piece) as usize;

            // Calculate piece size (last piece may be shorter)
            let piece_start = piece_idx as u64 * piece_length as u64;
            let piece_end = (piece_start + piece_length as u64).min(total_torrent_size);
            let this_piece_len = (piece_end - piece_start) as u32;

            // Download the piece (with retries)
            let mut attempts = 0;
            let piece_data = loop {
                attempts += 1;
                if attempts > 5 {
                    bail!("Failed to download piece {piece_idx} after 5 attempts");
                }

                match self.pool.download_piece(piece_idx, this_piece_len).await {
                    Ok(data) => {
                        // Verify SHA-1
                        let hash_offset = piece_idx as usize * 20;
                        if hash_offset + 20 <= piece_hashes.len() {
                            let expected = &piece_hashes[hash_offset..hash_offset + 20];
                            let actual: [u8; 20] = Sha1::digest(&data).into();
                            if actual.as_slice() != expected {
                                warn!("Piece {piece_idx} SHA-1 mismatch, retrying...");
                                continue;
                            }
                        }
                        break data;
                    }
                    Err(e) => {
                        debug!("Piece {piece_idx} attempt {attempts} failed: {e}");
                        tokio::time::sleep(Duration::from_millis(500)).await;
                    }
                }
            };

            downloaded_pieces[local_idx] = Some(piece_data);
            pieces_done += 1;

            // Report progress
            let bytes_done = pieces_done as u64 * piece_length as u64;
            progress_cb(bytes_done.min(file_length));

            if pieces_done % 10 == 0 {
                info!("Progress: {pieces_done}/{total_pieces} pieces");
            }
        }

        // Assemble file bytes from pieces
        let file_start_in_first_piece = (file_offset % piece_length as u64) as usize;
        let mut file_data = Vec::with_capacity(file_length as usize);

        for (i, piece_opt) in downloaded_pieces.iter().enumerate() {
            let piece_data = piece_opt.as_ref().unwrap();
            let start = if i == 0 { file_start_in_first_piece } else { 0 };
            let remaining = file_length as usize - file_data.len();
            let end = start + remaining.min(piece_data.len() - start);
            file_data.extend_from_slice(&piece_data[start..end]);
        }

        info!("File assembled: {} bytes ✅", file_data.len());
        Ok(file_data)
    }
}
