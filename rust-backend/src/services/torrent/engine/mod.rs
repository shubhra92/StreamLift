#![allow(dead_code, unused_imports, unused_variables, unused_mut, unused_assignments)]
/// StreamLift Torrent Engine — persistent, long-lived BitTorrent client.
///
/// Runs for the entire server lifetime. Maintains peer connections,
/// accepts incoming connections, and caches sessions across requests.

pub mod listener;
pub mod peer_pool;
pub mod session;
pub mod wire;

use anyhow::{Context, Result};
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::{mpsc, RwLock};
use tokio::time::{interval, Duration};
use tracing::{debug, info, warn};

use listener::{IncomingPeer, PeerListener};
use crate::services::torrent::magnet::MagnetLink;
use crate::services::torrent::metadata::TorrentMetadata;
use crate::services::torrent::tracker::generate_peer_id;

/// The persistent torrent engine — shared across all request handlers.
pub struct TorrentEngine {
    /// Our peer ID (constant for server lifetime)
    pub peer_id: [u8; 20],
    /// Port we're listening on for incoming peers
    pub listen_port: u16,
    /// Active torrent sessions keyed by info_hash hex
    sessions: RwLock<HashMap<String, Arc<RwLock<TorrentSession>>>>,
    /// Channel to receive incoming peer connections from the listener
    incoming_rx: RwLock<mpsc::Receiver<IncomingPeer>>,
}

/// An active torrent session with cached state.
pub struct TorrentSession {
    pub magnet: MagnetLink,
    pub metadata: Option<TorrentMetadata>,
    /// Connected peers (kept alive)
    pub peers: Vec<ConnectedPeer>,
    /// Last time this session was used
    pub last_used: std::time::Instant,
    /// Whether we've announced to trackers
    pub announced: bool,
}

/// A connected peer with its wire connection.
pub struct ConnectedPeer {
    pub conn: wire::WireConn,
    pub has_metadata: bool,
    pub ut_metadata_id: Option<u8>,
    pub metadata_size: usize,
    pub am_choked: bool,
    pub has_pieces: std::collections::HashSet<u32>,
}

impl TorrentEngine {
    /// Start the torrent engine. Call once at server startup.
    pub async fn start() -> Result<Arc<Self>> {
        let peer_id = generate_peer_id();

        // Start TCP listener
        let (incoming_tx, incoming_rx) = mpsc::channel(64);
        let (_listener, listen_port) = PeerListener::start(incoming_tx).await?;

        let engine = Arc::new(Self {
            peer_id,
            listen_port,
            sessions: RwLock::new(HashMap::new()),
            incoming_rx: RwLock::new(incoming_rx),
        });

        // Spawn background tasks
        let engine_clone = engine.clone();
        tokio::spawn(async move {
            engine_clone.background_loop().await;
        });

        info!("Torrent engine started (peer_id={}, listen_port={})",
            hex::encode(&peer_id[..8]), listen_port);

        Ok(engine)
    }

    /// Get or create a session for a magnet link.
    pub async fn get_or_create_session(&self, magnet: &MagnetLink) -> Arc<RwLock<TorrentSession>> {
        let key = magnet.info_hash_hex.clone();

        // Check if session exists
        {
            let sessions = self.sessions.read().await;
            if let Some(session) = sessions.get(&key) {
                return session.clone();
            }
        }

        // Create new session
        let session = TorrentSession {
            magnet: magnet.clone(),
            metadata: None,
            peers: Vec::new(),
            last_used: std::time::Instant::now(),
            announced: false,
        };

        let session = Arc::new(RwLock::new(session));
        self.sessions.write().await.insert(key, session.clone());
        session
    }

    /// Fetch metadata for a magnet link using the persistent engine.
    pub async fn fetch_metadata(&self, magnet: &MagnetLink) -> Result<TorrentMetadata> {
        let session_arc = self.get_or_create_session(magnet).await;

        // Check if we already have metadata cached
        {
            let session = session_arc.read().await;
            if let Some(ref meta) = session.metadata {
                debug!("Metadata cache hit for {}", magnet.info_hash_hex);
                return Ok(meta.clone());
            }
        }

        // Need to fetch metadata — announce + connect + request
        self.do_fetch_metadata(magnet, session_arc).await
    }

    /// Download a single piece from the session's connected peers.
    pub async fn download_piece(&self, magnet: &MagnetLink, piece_idx: u32, piece_length: u32) -> Result<Vec<u8>> {
        let session_arc = self.get_or_create_session(magnet).await;
        
        // Ensure peers
        {
            let session = session_arc.read().await;
            if session.peers.is_empty() {
                drop(session);
                self.reconnect_peers(magnet).await?;
            }
        }

        let mut session = session_arc.write().await;
        session.last_used = std::time::Instant::now();

        // Try each peer
        for peer in session.peers.iter_mut() {
            if peer.am_choked { continue; }
            match download_piece_from_peer(peer, piece_idx, piece_length).await {
                Ok(data) => return Ok(data),
                Err(_) => continue,
            }
        }

        anyhow::bail!("No peer could serve piece {piece_idx}")
    }

    /// Download multiple pieces in parallel from all connected peers.
    pub async fn download_pieces_parallel(
        &self,
        magnet: &MagnetLink,
        piece_requests: Vec<(u32, u32)>, // (piece_idx, piece_length)
        progress_cb: impl Fn(u32) + Send + Sync + 'static,
    ) -> Result<Vec<(u32, Vec<u8>)>> {
        use tokio::sync::mpsc;
        

        let session_arc = self.get_or_create_session(magnet).await;

        // Ensure we have peers
        {
            let session = session_arc.read().await;
            if session.peers.is_empty() {
                drop(session);
                self.reconnect_peers(magnet).await?;
            }
        }

        // Take peers out for parallel work
        let mut peers: Vec<ConnectedPeer> = {
            let mut session = session_arc.write().await;
            session.last_used = std::time::Instant::now();
            std::mem::take(&mut session.peers)
        };

        if peers.is_empty() {
            anyhow::bail!("No peers for download");
        }

        let num_peers = peers.len();
        let total_pieces = piece_requests.len();
        info!("Parallel download: {} pieces across {} peers", total_pieces, num_peers);

        // Shared piece queue
        let queue = Arc::new(tokio::sync::Mutex::new(
            std::collections::VecDeque::from(piece_requests)
        ));
        let progress_cb = Arc::new(progress_cb);

        // Result channel
        let (tx, mut rx) = mpsc::channel::<(u32, Vec<u8>)>(64);

        // Spawn a worker per peer
        let mut handles = Vec::new();
        for mut peer in peers.drain(..) {
            let queue = queue.clone();
            let tx = tx.clone();
            let progress_cb = progress_cb.clone();

            handles.push(tokio::spawn(async move {
                use wire::Message;
                use tokio::time::{timeout, Duration};
                const BLOCK_SIZE: u32 = 16384;

                let mut pieces_done = 0u32;

                // Send interested once at the start
                let _ = peer.conn.send_message(&Message::Interested).await;

                // Wait for unchoke before starting
                for _ in 0..10 {
                    match timeout(Duration::from_secs(5), peer.conn.read_message(Duration::from_secs(5))).await {
                        Ok(Ok(Some(Message::Unchoke))) => { peer.am_choked = false; break; }
                        Ok(Ok(Some(_))) => continue,
                        _ => break,
                    }
                }

                if peer.am_choked {
                    // Can't download if choked — return piece if we took one
                    return peer;
                }

                loop {
                    let item = { queue.lock().await.pop_front() };
                    let (piece_idx, piece_len) = match item {
                        Some(i) => i,
                        None => break,
                    };

                    match download_piece_from_peer(&mut peer, piece_idx, piece_len).await {
                        Ok(data) => {
                            pieces_done += 1;
                            progress_cb(pieces_done);
                            if tx.send((piece_idx, data)).await.is_err() { break; }
                        }
                        Err(_) => {
                            queue.lock().await.push_back((piece_idx, piece_len));
                            break;
                        }
                    }
                }
                peer
            }));
        }
        drop(tx);

        // Collect results
        let mut results: Vec<(u32, Vec<u8>)> = Vec::with_capacity(total_pieces);
        while let Some(r) = rx.recv().await {
            results.push(r);
        }

        // Return surviving peers to session
        let mut surviving = Vec::new();
        for h in handles {
            if let Ok(peer) = h.await {
                surviving.push(peer);
            }
        }
        {
            let mut session = session_arc.write().await;
            session.peers = surviving;
        }

        if results.len() < total_pieces {
            anyhow::bail!("Only got {}/{} pieces", results.len(), total_pieces);
        }

        Ok(results)
    }

    /// Reconnect to peers for a torrent session.
    async fn reconnect_peers(&self, magnet: &MagnetLink) -> Result<()> {
        use crate::services::torrent::tracker::announce_all;
        use wire::WireConn;
        use tokio::time::timeout;

        let peers = announce_all(&magnet.trackers, &magnet.info_hash, &self.peer_id, 10).await;
        let addrs: Vec<std::net::SocketAddr> = peers.iter().map(|p| p.addr()).collect();

        let mut tasks = Vec::new();
        for addr in addrs.iter().take(50) {
            let addr = *addr;
            let ih = magnet.info_hash;
            let pid = self.peer_id;
            tasks.push(tokio::spawn(async move {
                timeout(Duration::from_secs(8), WireConn::connect(addr, &ih, &pid, true, Duration::from_secs(5)))
                    .await.ok().and_then(|r| r.ok())
            }));
        }

        let session_arc = self.get_or_create_session(magnet).await;
        let mut session = session_arc.write().await;

        for task in tasks {
            if let Ok(Some(conn)) = task.await {
                // Send ext handshake + interested
                let mut c = conn;
                let _ = c.send_ext_handshake(1).await;
                let _ = c.send_message(&wire::Message::Interested).await;
                session.peers.push(ConnectedPeer {
                    conn: c, has_metadata: false, ut_metadata_id: None,
                    metadata_size: 0, am_choked: true, has_pieces: std::collections::HashSet::new(),
                });
            }
        }

        // Wait for unchoke from new peers
        for peer in session.peers.iter_mut() {
            for _ in 0..10 {
                match tokio::time::timeout(Duration::from_secs(3), peer.conn.read_message(Duration::from_secs(3))).await {
                    Ok(Ok(Some(wire::Message::Unchoke))) => { peer.am_choked = false; break; }
                    Ok(Ok(Some(_))) => continue,
                    _ => break,
                }
            }
        }

        info!("Reconnected: {} peers ({} unchoked)",
            session.peers.len(),
            session.peers.iter().filter(|p| !p.am_choked).count());
        Ok(())
    }

    /// Internal: actually fetch metadata from peers.
    async fn do_fetch_metadata(
        &self,
        magnet: &MagnetLink,
        session_arc: Arc<RwLock<TorrentSession>>,
    ) -> Result<TorrentMetadata> {
        use crate::services::torrent::tracker::announce_all;
        
        use wire::WireConn;
        use tokio::time::timeout;

        info!("Fetching metadata for {} (engine)", magnet.info_hash_hex);

        // Announce to trackers
        let peers = announce_all(&magnet.trackers, &magnet.info_hash, &self.peer_id, 10).await;
        if peers.is_empty() {
            anyhow::bail!("No peers from trackers");
        }
        info!("Got {} peers from trackers", peers.len());

        // Also check incoming peers
        self.process_incoming_peers(magnet).await;

        // Connect to peers concurrently
        let addrs: Vec<std::net::SocketAddr> = peers.iter().map(|p| p.addr()).collect();
        let mut connections: Vec<WireConn> = Vec::new();

        let mut tasks = Vec::new();
        for addr in addrs.iter().take(50) {
            let addr = *addr;
            let ih = magnet.info_hash;
            let pid = self.peer_id;
            tasks.push(tokio::spawn(async move {
                timeout(
                    Duration::from_secs(8),
                    WireConn::connect(addr, &ih, &pid, true, Duration::from_secs(5)),
                ).await.ok().and_then(|r| r.ok())
            }));
        }

        for task in tasks {
            if let Ok(Some(conn)) = task.await {
                connections.push(conn);
            }
        }

        info!("Connected to {} peers", connections.len());
        if connections.is_empty() {
            anyhow::bail!("No peers connected");
        }

        // Try each connected peer for metadata (with long patience)
        let metadata_result = self.try_metadata_from_connections(
            &mut connections, magnet,
        ).await;

        // Store surviving connections in the session for reuse
        {
            let mut session = session_arc.write().await;
            session.last_used = std::time::Instant::now();
            session.announced = true;
            for conn in connections {
                session.peers.push(ConnectedPeer {
                    conn,
                    has_metadata: false,
                    ut_metadata_id: None,
                    metadata_size: 0,
                    am_choked: true,
                    has_pieces: std::collections::HashSet::new(),
                });
            }
        }

        match metadata_result {
            Ok((_info_dict, meta)) => {
                // Cache metadata
                let mut session = session_arc.write().await;
                session.metadata = Some(meta.clone());
                Ok(meta)
            }
            Err(e) => Err(e),
        }
    }

    /// Try to get metadata from connected peers.
    async fn try_metadata_from_connections(
        &self,
        connections: &mut Vec<wire::WireConn>,
        magnet: &MagnetLink,
    ) -> Result<(Vec<u8>, TorrentMetadata)> {
        use wire::Message;
        use crate::services::torrent::metadata::{bencode_decode, parse_info_dict_public};
        use sha1::{Digest, Sha1};
        use tokio::time::timeout;
        use bytes::Bytes;

        const PIECE_SIZE: usize = 16384;

        // Process each connection: send ext handshake + interested, read responses
        for conn in connections.iter_mut() {
            if !conn.supports_extensions() { continue; }

            // Send interested + ext handshake
            let _ = conn.send_message(&Message::Interested).await;
            let _ = conn.send_ext_handshake(1).await;
        }

        // Give peers a moment to respond
        tokio::time::sleep(Duration::from_millis(300)).await;

        // Read from all connections looking for ext handshake with metadata_size
        for conn in connections.iter_mut() {
            if !conn.supports_extensions() { continue; }

            // Read messages for up to 5s looking for ext handshake
            let mut ut_id: Option<u8> = None;
            let mut meta_size: usize = 0;

            for _ in 0..20 {
                match timeout(Duration::from_secs(2), conn.read_message(Duration::from_secs(2))).await {
                    Ok(Ok(Some(Message::Extended { id: 0, payload }))) => {
                        if let Ok(decoded) = bencode_decode(&payload) {
                            if let Some(m) = decoded.get("m") {
                                if let Some(id) = m.get("ut_metadata").and_then(|v| v.as_integer()) {
                                    ut_id = Some(id as u8);
                                }
                            }
                            if let Some(size) = decoded.get("metadata_size").and_then(|v| v.as_integer()) {
                                meta_size = size as usize;
                            }
                        }
                        if ut_id.is_some() && meta_size > 0 { break; }
                    }
                    Ok(Ok(Some(_))) => continue, // bitfield, have, etc — skip
                    _ => break, // timeout or error
                }
            }

            if ut_id.is_none() || meta_size == 0 { continue; }
            let ut_id = ut_id.unwrap();

            info!("Peer {}: ut_metadata={ut_id}, size={meta_size}", conn.addr);

            // Request metadata pieces
            let num_pieces = (meta_size + PIECE_SIZE - 1) / PIECE_SIZE;
            for i in 0..num_pieces {
                let dict = format!("d8:msg_typei0e5:piecei{}ee", i);
                let _ = conn.send_message(&Message::Extended {
                    id: ut_id,
                    payload: Bytes::from(dict.into_bytes()),
                }).await;
            }

            // Wait a moment for the peer to process (some clients need this)
            tokio::time::sleep(Duration::from_millis(500)).await;

            // Collect metadata pieces (wait up to 30s for all pieces)
            let mut pieces: Vec<Option<Vec<u8>>> = vec![None; num_pieces];
            let mut received = 0;

            let collect_start = std::time::Instant::now();
            while received < num_pieces && collect_start.elapsed() < Duration::from_secs(30) {
                match timeout(Duration::from_secs(10), conn.read_message(Duration::from_secs(10))).await {
                    Ok(Ok(Some(Message::Extended { id: 1, payload }))) => {
                        // ut_metadata response (our registered ID = 1)
                        if let Some((idx, data)) = parse_metadata_piece_payload(&payload) {
                            if idx < num_pieces && pieces[idx].is_none() {
                                pieces[idx] = Some(data);
                                received += 1;
                            }
                        }
                    }
                    Ok(Ok(Some(Message::Extended { id: 2, payload }))) => {
                        // PEX message (our registered ID = 2) — extract new peers
                        if let Some(new_peers) = parse_pex_message(&payload) {
                            info!("PEX: got {} new peers from {}", new_peers.len(), conn.addr);
                            // TODO: connect to these peers for metadata
                        }
                    }
                    Ok(Ok(Some(_))) => continue, // other messages, keep reading
                    Ok(Ok(None)) => break, // peer disconnected
                    Ok(Err(_)) => break, // read error
                    Err(_) => continue, // timeout — try again
                }
            }

            if received < num_pieces {
                info!("Peer {}: got {}/{} metadata pieces", conn.addr, received, num_pieces);
                continue;
            }

            // Assemble and verify
            let info_dict: Vec<u8> = pieces.into_iter().flatten().flatten().collect();
            let hash: [u8; 20] = Sha1::digest(&info_dict).into();
            if hash != magnet.info_hash {
                warn!("Peer {}: metadata SHA-1 mismatch", conn.addr);
                continue;
            }

            info!("Metadata verified ✅ ({} bytes from {})", info_dict.len(), conn.addr);
            let meta = parse_info_dict_public(&info_dict, &magnet.info_hash_hex)?;
            return Ok((info_dict, meta));
        }

        anyhow::bail!("No peer provided valid metadata")
    }

    /// Process any incoming peers from the listener.
    async fn process_incoming_peers(&self, magnet: &MagnetLink) {
        let mut rx = self.incoming_rx.write().await;
        while let Ok(incoming) = rx.try_recv() {
            if incoming.info_hash == magnet.info_hash {
                debug!("Got incoming peer for {}: {}", magnet.info_hash_hex, incoming.addr);
                // TODO: complete handshake and add to session
            }
        }
    }

    /// Background loop: keep-alive pings + session cleanup.
    async fn background_loop(&self) {
        let mut ticker = interval(Duration::from_secs(30));
        loop {
            ticker.tick().await;

            let mut sessions = self.sessions.write().await;
            let now = std::time::Instant::now();

            // Clean up sessions unused for 30 minutes
            sessions.retain(|hash, session| {
                let session = session.try_read();
                match session {
                    Ok(s) => {
                        if now.duration_since(s.last_used) > Duration::from_secs(1800) {
                            info!("Cleaning up torrent session {hash} (idle 30min)");
                            false
                        } else {
                            true
                        }
                    }
                    Err(_) => true, // session is in use, keep it
                }
            });
        }
    }
}

/// Parse a metadata piece from the extended message payload.
fn parse_metadata_piece_payload(payload: &[u8]) -> Option<(usize, Vec<u8>)> {
    // Payload = bencoded_dict || raw_piece_data
    // Dict contains: {msg_type: 1, piece: N, total_size: M}
    // We need to find where the dict ends and raw data begins
    
    if payload.is_empty() || payload[0] != b'd' { return None; }

    // Find dict end by tracking bencode structure
    let dict_end = find_dict_end(payload)?;
    
    // Parse the dict part
    use crate::services::torrent::metadata::bencode_decode;
    let dict = bencode_decode(&payload[..dict_end]).ok()?;
    
    let msg_type = dict.get("msg_type")?.as_integer()?;
    if msg_type != 1 { return None; } // 1 = data
    let piece_idx = dict.get("piece")?.as_integer()? as usize;

    let data = payload[dict_end..].to_vec();
    Some((piece_idx, data))
}

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
                i += 1;
                while i < data.len() && data[i] != b'e' { i += 1; }
                i += 1;
            }
            b'0'..=b'9' => {
                let start = i;
                while i < data.len() && data[i] != b':' { i += 1; }
                let len: usize = std::str::from_utf8(&data[start..i]).ok()?.parse().ok()?;
                i += 1 + len;
            }
            _ => return None,
        }
    }
    None
}

/// Parse a PEX (Peer Exchange) message and extract peer addresses.
/// PEX format: bencoded dict with "added" key containing compact peer data (6 bytes each).
fn parse_pex_message(payload: &[u8]) -> Option<Vec<std::net::SocketAddr>> {
    use crate::services::torrent::metadata::bencode_decode;
    use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};

    let decoded = bencode_decode(payload).ok()?;
    let added = decoded.get("added")?.as_bytes()?;

    let mut peers = Vec::new();
    for chunk in added.chunks_exact(6) {
        let ip = Ipv4Addr::new(chunk[0], chunk[1], chunk[2], chunk[3]);
        let port = u16::from_be_bytes([chunk[4], chunk[5]]);
        if port > 0 {
            peers.push(SocketAddr::V4(SocketAddrV4::new(ip, port)));
        }
    }
    Some(peers)
}

/// Download a single piece from a specific peer.
pub async fn download_piece_from_peer(
    peer: &mut ConnectedPeer,
    piece_idx: u32,
    piece_length: u32,
) -> Result<Vec<u8>> {
    use wire::Message;
    use tokio::time::{timeout, Duration};

    const BLOCK_SIZE: u32 = 16384;
    let num_blocks = (piece_length + BLOCK_SIZE - 1) / BLOCK_SIZE;

    // Pipeline: send ALL block requests immediately
    let mut offset = 0u32;
    while offset < piece_length {
        let bl = BLOCK_SIZE.min(piece_length - offset);
        peer.conn.send_message(&Message::Request {
            index: piece_idx,
            begin: offset,
            length: bl,
        }).await.context("send request")?;
        offset += bl;
    }

    // Collect all blocks (peer sends them back-to-back since we pipelined requests)
    let mut piece_data = vec![0u8; piece_length as usize];
    let mut got = 0u32;

    for _ in 0..(num_blocks as usize * 2 + 5) {
        match timeout(Duration::from_secs(30), peer.conn.read_message(Duration::from_secs(30))).await {
            Ok(Ok(Some(Message::Piece { index, begin, data }))) if index == piece_idx => {
                let end = (begin as usize + data.len()).min(piece_data.len());
                piece_data[begin as usize..end].copy_from_slice(&data[..end - begin as usize]);
                got += 1;
                if got >= num_blocks { break; }
            }
            Ok(Ok(Some(Message::Unchoke))) => { peer.am_choked = false; }
            Ok(Ok(Some(Message::Choke))) => {
                peer.am_choked = true;
                anyhow::bail!("choked");
            }
            Ok(Ok(Some(_))) => continue,
            Ok(Ok(None)) => anyhow::bail!("disconnected"),
            Ok(Err(e)) => anyhow::bail!("read error: {e}"),
            Err(_) => anyhow::bail!("timeout"),
        }
    }

    if got < num_blocks {
        anyhow::bail!("incomplete: {got}/{num_blocks} blocks");
    }

    Ok(piece_data)
}
