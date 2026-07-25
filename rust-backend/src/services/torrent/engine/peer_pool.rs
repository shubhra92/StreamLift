/// Peer connection pool — manages multiple concurrent peer connections.
///
/// Features:
///   - Connects to peers in parallel
///   - Accepts incoming connections from the listener
///   - Tracks which peers have which pieces (bitfield)
///   - Rotates through peers for piece requests
///   - Handles choking/unchoking properly

use anyhow::{bail, Context, Result};
use bytes::Bytes;
use std::collections::{HashMap, HashSet};
use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::{mpsc, Mutex};
use tokio::time::{timeout, Duration};
use tracing::{debug, info, warn};

use super::wire::{Message, WireConn};
use super::listener::IncomingPeer;

/// A managed peer with state tracking.
struct ManagedPeer {
    conn: WireConn,
    /// Which pieces this peer has (from bitfield/have messages)
    has_pieces: HashSet<u32>,
    /// Are we choked by this peer?
    am_choked: bool,
    /// Are we interested in this peer?
    am_interested: bool,
    /// Peer's ut_metadata extension id (if they support BEP-9)
    ut_metadata_id: Option<u8>,
    /// Peer's reported metadata_size
    metadata_size: usize,
    /// Number of pieces successfully downloaded from this peer
    pieces_downloaded: u32,
}

/// The peer pool for one torrent session.
pub struct PeerPool {
    info_hash: [u8; 20],
    our_peer_id: [u8; 20],
    peers: Vec<ManagedPeer>,
}

impl PeerPool {
    pub fn new(info_hash: [u8; 20], our_peer_id: [u8; 20]) -> Self {
        Self {
            info_hash,
            our_peer_id,
            peers: Vec::new(),
        }
    }

    /// Connect to multiple peers concurrently. Returns count of successful connections.
    pub async fn connect_to_peers(&mut self, addrs: &[SocketAddr], max_connections: usize) -> usize {
        let mut tasks = Vec::new();
        let to_try = addrs.len().min(max_connections);

        for &addr in addrs.iter().take(to_try) {
            let ih = self.info_hash;
            let pid = self.our_peer_id;
            tasks.push(tokio::spawn(async move {
                let result = timeout(
                    Duration::from_secs(8),
                    WireConn::connect(addr, &ih, &pid, true, Duration::from_secs(5)),
                ).await;
                match result {
                    Ok(Ok(conn)) => Some(conn),
                    _ => None,
                }
            }));
        }

        let mut connected = 0;
        for task in tasks {
            if let Ok(Some(conn)) = task.await {
                debug!("Connected to {}", conn.addr);
                self.peers.push(ManagedPeer {
                    conn,
                    has_pieces: HashSet::new(),
                    am_choked: true,
                    am_interested: false,
                    ut_metadata_id: None,
                    metadata_size: 0,
                    pieces_downloaded: 0,
                });
                connected += 1;
            }
        }

        info!("Connected to {connected}/{to_try} peers");
        connected
    }

    /// Add an incoming peer connection (from the listener).
    pub async fn add_incoming(&mut self, incoming: IncomingPeer) -> Result<()> {
        let conn = WireConn::from_incoming(
            incoming.stream,
            incoming.addr,
            &self.info_hash,
            &self.our_peer_id,
        ).await?;

        self.peers.push(ManagedPeer {
            conn,
            has_pieces: HashSet::new(),
            am_choked: true,
            am_interested: false,
            ut_metadata_id: None,
            metadata_size: 0,
            pieces_downloaded: 0,
        });

        info!("Accepted incoming peer: {}", incoming.addr);
        Ok(())
    }

    /// Initialize all peers: send ext handshake, express interest, wait for unchoke.
    /// Returns the number of peers that are ready for data transfer.
    pub async fn initialize_peers(&mut self) -> usize {
        let mut ready = 0;

        for peer in &mut self.peers {
            // Send extended handshake
            if peer.conn.supports_extensions() {
                if let Err(e) = peer.conn.send_ext_handshake(1).await {
                    debug!("Ext handshake to {} failed: {e}", peer.conn.addr);
                    continue;
                }
            }

            // Send interested
            if let Err(e) = peer.conn.send_message(&Message::Interested).await {
                debug!("Interested to {} failed: {e}", peer.conn.addr);
                continue;
            }
            peer.am_interested = true;

            // Read initial messages (bitfield, ext handshake, unchoke) with timeout
            let init_result = timeout(Duration::from_secs(10), async {
                for _ in 0..20 {
                    match peer.conn.read_message(Duration::from_secs(5)).await {
                        Ok(Some(msg)) => {
                            match msg {
                                Message::Unchoke => {
                                    peer.am_choked = false;
                                    return Ok(true);
                                }
                                Message::Bitfield(bf) => {
                                    for (byte_idx, &byte) in bf.iter().enumerate() {
                                        for bit in 0..8 {
                                            if byte & (0x80 >> bit) != 0 {
                                                peer.has_pieces.insert((byte_idx * 8 + bit) as u32);
                                            }
                                        }
                                    }
                                }
                                Message::Have(idx) => { peer.has_pieces.insert(idx); }
                                Message::Extended { id: 0, payload } => {
                                    // Parse ext handshake for ut_metadata
                                    if let Ok((ut_id, msize)) = parse_ext_handshake_payload(&payload) {
                                        peer.ut_metadata_id = Some(ut_id);
                                        peer.metadata_size = msize;
                                    }
                                }
                                Message::Choke => { peer.am_choked = true; }
                                _ => {}
                            }
                        }
                        Ok(None) => return Ok(false), // disconnected
                        Err(_) => return Ok(false),
                    }
                }
                Ok::<bool, anyhow::Error>(false)
            }).await;

            match init_result {
                Ok(Ok(true)) => {
                    ready += 1;
                    debug!("Peer {} ready (has {} pieces)", peer.conn.addr, peer.has_pieces.len());
                }
                _ => {
                    debug!("Peer {} not ready (choked or timeout)", peer.conn.addr);
                }
            }
        }

        info!("{ready}/{} peers ready for transfer", self.peers.len());
        ready
    }

    /// Get the number of connected peers.
    pub fn peer_count(&self) -> usize {
        self.peers.len()
    }

    /// Get metadata info from any peer that has it.
    pub fn get_metadata_info(&self) -> Option<(u8, usize, SocketAddr)> {
        self.peers.iter()
            .find(|p| p.ut_metadata_id.is_some() && p.metadata_size > 0)
            .map(|p| (p.ut_metadata_id.unwrap(), p.metadata_size, p.conn.addr))
    }

    /// Get a mutable reference to a peer that has a specific piece and is unchoked.
    pub fn get_peer_for_piece(&mut self, piece_idx: u32) -> Option<&mut ManagedPeer> {
        self.peers.iter_mut()
            .find(|p| !p.am_choked && p.has_pieces.contains(&piece_idx))
    }

    /// Get any unchoked peer (for metadata requests).
    pub fn get_any_ready_peer(&mut self) -> Option<&mut ManagedPeer> {
        self.peers.iter_mut().find(|p| !p.am_choked || p.ut_metadata_id.is_some())
    }

    /// Get a peer with ut_metadata support.
    pub fn get_metadata_peer(&mut self) -> Option<&mut ManagedPeer> {
        self.peers.iter_mut().find(|p| p.ut_metadata_id.is_some() && p.metadata_size > 0)
    }

    /// Download a piece from the best available peer.
    pub async fn download_piece(&mut self, piece_idx: u32, piece_length: u32) -> Result<Vec<u8>> {
        const BLOCK_SIZE: u32 = 16384; // 16KB

        // Find a peer that has this piece and is unchoked
        let peer = self.peers.iter_mut()
            .find(|p| !p.am_choked && (p.has_pieces.contains(&piece_idx) || p.has_pieces.is_empty()))
            .ok_or_else(|| anyhow::anyhow!("No peer available for piece {piece_idx}"))?;

        let mut piece_data = vec![0u8; piece_length as usize];
        let num_blocks = (piece_length + BLOCK_SIZE - 1) / BLOCK_SIZE;

        // Pipeline: request all blocks, then collect responses
        let mut offset = 0u32;
        while offset < piece_length {
            let block_len = BLOCK_SIZE.min(piece_length - offset);
            peer.conn.send_message(&Message::Request {
                index: piece_idx,
                begin: offset,
                length: block_len,
            }).await?;
            offset += block_len;
        }

        // Collect blocks
        let mut blocks_received = 0u32;
        for _ in 0..(num_blocks * 2 + 10) {
            let msg = peer.conn.read_message(Duration::from_secs(15)).await?
                .ok_or_else(|| anyhow::anyhow!("peer disconnected"))?;

            match msg {
                Message::Piece { index, begin, data } if index == piece_idx => {
                    let end = (begin as usize + data.len()).min(piece_data.len());
                    piece_data[begin as usize..end].copy_from_slice(&data[..end - begin as usize]);
                    blocks_received += 1;
                    if blocks_received >= num_blocks { break; }
                }
                Message::Choke => {
                    peer.am_choked = true;
                    bail!("Choked mid-piece");
                }
                _ => {} // ignore other messages
            }
        }

        if blocks_received < num_blocks {
            bail!("Incomplete piece: {blocks_received}/{num_blocks} blocks");
        }

        peer.pieces_downloaded += 1;
        Ok(piece_data)
    }

    /// Fetch metadata via ut_metadata from a connected peer.
    pub async fn fetch_metadata(&mut self) -> Result<Vec<u8>> {
        let peer = self.get_metadata_peer()
            .ok_or_else(|| anyhow::anyhow!("No peer with metadata support"))?;

        let ut_id = peer.ut_metadata_id.unwrap();
        let metadata_size = peer.metadata_size;
        let piece_size = 16384usize; // 16KB per metadata piece
        let num_pieces = (metadata_size + piece_size - 1) / piece_size;

        info!("Fetching metadata: {} bytes, {} pieces from {}", metadata_size, num_pieces, peer.conn.addr);

        // Request all pieces
        for i in 0..num_pieces {
            let dict = format!("d8:msg_typei0e5:piecei{}ee", i);
            peer.conn.send_message(&Message::Extended {
                id: ut_id,
                payload: Bytes::from(dict.into_bytes()),
            }).await?;
        }

        // Collect responses
        let mut pieces: Vec<Option<Vec<u8>>> = vec![None; num_pieces];
        let mut received = 0;

        for _ in 0..100 {
            let msg = peer.conn.read_message(Duration::from_secs(10)).await?
                .ok_or_else(|| anyhow::anyhow!("peer disconnected during metadata fetch"))?;

            if let Message::Extended { id: 1, payload } = msg {
                if let Some((idx, data)) = parse_metadata_piece(&payload) {
                    if idx < num_pieces && pieces[idx].is_none() {
                        pieces[idx] = Some(data);
                        received += 1;
                        if received == num_pieces { break; }
                    }
                }
            }
        }

        if received < num_pieces {
            bail!("Incomplete metadata: {received}/{num_pieces}");
        }

        Ok(pieces.into_iter().flatten().flatten().collect())
    }
}

// ── Helpers ───────────────────────────────────────────────────────────────────

fn parse_ext_handshake_payload(payload: &[u8]) -> Result<(u8, usize)> {
    use crate::services::torrent::metadata::bencode_decode;
    let decoded = bencode_decode(payload)?;
    let m = decoded.get("m").ok_or_else(|| anyhow::anyhow!("No 'm'"))?;
    let ut_id = m.get("ut_metadata").and_then(|v| v.as_integer()).unwrap_or(0) as u8;
    let msize = decoded.get("metadata_size").and_then(|v| v.as_integer()).unwrap_or(0) as usize;
    Ok((ut_id, msize))
}

fn parse_metadata_piece(payload: &[u8]) -> Option<(usize, Vec<u8>)> {
    use crate::services::torrent::metadata::bencode_decode;
    // Payload: bencoded_dict || raw_data
    // Find where dict ends
    let decoded = bencode_decode(payload).ok()?;
    let msg_type = decoded.get("msg_type")?.as_integer()?;
    if msg_type != 1 { return None; } // 1 = data
    let piece_idx = decoded.get("piece")?.as_integer()? as usize;

    // Find the end of the bencoded dict to get raw data after it
    let dict_end = find_dict_end(payload)?;
    let data = payload[dict_end..].to_vec();
    Some((piece_idx, data))
}

/// Find where a bencoded dict ends in the byte stream.
fn find_dict_end(data: &[u8]) -> Option<usize> {
    if data.is_empty() || data[0] != b'd' { return None; }
    let mut depth = 0;
    let mut i = 0;
    while i < data.len() {
        match data[i] {
            b'd' | b'l' => { depth += 1; i += 1; }
            b'e' => {
                depth -= 1;
                i += 1;
                if depth == 0 { return Some(i); }
            }
            b'i' => {
                // Integer: i<digits>e
                i += 1;
                while i < data.len() && data[i] != b'e' { i += 1; }
                i += 1; // skip 'e'
            }
            b'0'..=b'9' => {
                // Byte string: <len>:<data>
                let start = i;
                while i < data.len() && data[i] != b':' { i += 1; }
                let len: usize = std::str::from_utf8(&data[start..i]).ok()?.parse().ok()?;
                i += 1 + len; // skip ':' + data
            }
            _ => return None,
        }
    }
    None
}
