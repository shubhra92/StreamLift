#![allow(dead_code, unused_imports, unused_variables, unused_mut, unused_assignments)]
/// Torrent metadata fetch via BEP-9 (ut_metadata extension).
///
/// Connect to peers, request the info dict in pieces, verify SHA-1.

use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use tokio::time::{timeout, Duration};
use tracing::info;

use super::magnet::MagnetLink;
use super::peer::{PeerConnection, PeerMessage};
use super::tracker::{announce_all, generate_peer_id, Peer};
use crate::utils::format::{format_bytes, get_file_type};

const PEER_TIMEOUT: Duration = Duration::from_secs(20);
const METADATA_PIECE_SIZE: usize = 16 * 1024; // 16 KB

/// A file entry from torrent metadata.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TorrentFile {
    pub index: usize,
    pub name: String,
    pub path: String,
    pub size: u64,
    #[serde(rename = "sizeFormatted")]
    pub size_formatted: String,
    #[serde(rename = "type")]
    pub file_type: String,
}

/// Full torrent metadata.
#[derive(Debug, Clone, serde::Serialize)]
pub struct TorrentMetadata {
    pub name: String,
    #[serde(rename = "infoHash")]
    pub info_hash: String,
    #[serde(rename = "totalSize")]
    pub total_size: u64,
    #[serde(rename = "totalSizeFormatted")]
    pub total_size_formatted: String,
    pub files: Vec<TorrentFile>,
    #[serde(rename = "fileCount")]
    pub file_count: usize,
    #[serde(rename = "pieceLength")]
    pub piece_length: u32,
    #[serde(rename = "pieceCount")]
    pub piece_count: u32,
    /// Raw SHA-1 hashes for all pieces (20 bytes each, flattened)
    #[serde(skip)]
    pub piece_hashes: Vec<u8>,
}

/// Fetch torrent metadata from a magnet link.
pub async fn fetch_metadata(magnet: &MagnetLink) -> Result<TorrentMetadata> {
    let peer_id = generate_peer_id();

    // Retry up to 3 times with fresh tracker announces
    for attempt in 1..=3 {
        info!("Metadata fetch attempt {attempt}/3...");

        let peers = announce_all(&magnet.trackers, &magnet.info_hash, &peer_id, 5).await;
        if peers.is_empty() {
            if attempt < 3 {
                tokio::time::sleep(Duration::from_secs(1)).await;
                continue;
            }
            bail!("No peers found from trackers");
        }

        info!("Got {} peers, trying metadata fetch...", peers.len());

        match fetch_metadata_from_peers(peers, &magnet.info_hash, &peer_id).await {
            Ok(info_dict) => return parse_info_dict(&info_dict, &magnet.info_hash_hex),
            Err(e) => {
                if attempt < 3 {
                    info!("Attempt {attempt} failed: {e}, retrying...");
                    tokio::time::sleep(Duration::from_millis(500)).await;
                } else {
                    return Err(e);
                }
            }
        }
    }

    bail!("All metadata fetch attempts failed")
}

/// Try multiple peers concurrently to fetch metadata.
async fn fetch_metadata_from_peers(
    peers: Vec<Peer>,
    info_hash: &[u8; 20],
    peer_id: &[u8; 20],
) -> Result<Vec<u8>> {
    use tokio::sync::mpsc;

    let (tx, mut rx) = mpsc::channel::<Vec<u8>>(1);
    let info_hash = *info_hash;
    let peer_id = *peer_id;

    // Spawn concurrent peer attempts (try ALL peers)
    let max_concurrent = peers.len().min(50);
    for peer in peers.into_iter().take(max_concurrent) {
        let tx = tx.clone();
        let ih = info_hash;
        let pid = peer_id;
        tokio::spawn(async move {
            match timeout(
                Duration::from_secs(45),
                try_fetch_from_peer(peer.addr(), &ih, &pid),
            ).await {
                Ok(Ok(data)) => { let _ = tx.send(data).await; }
                Ok(Err(e)) => info!("Peer {} failed: {}", peer.addr(), e),
                Err(_) => info!("Peer {} timed out (45s)", peer.addr()),
            }
        });
    }
    drop(tx);

    // Wait for the first successful result (up to 50s per attempt)
    match timeout(Duration::from_secs(50), rx.recv()).await {
        Ok(Some(data)) => Ok(data),
        Ok(None) => bail!("All peers failed to provide metadata"),
        Err(_) => bail!("Metadata fetch timed out"),
    }
}

/// Try to fetch metadata from a single peer.
async fn try_fetch_from_peer(
    addr: std::net::SocketAddr,
    info_hash: &[u8; 20],
    peer_id: &[u8; 20],
) -> Result<Vec<u8>> {
    info!("Trying peer {addr}...");

    let mut conn = PeerConnection::connect(addr, info_hash, peer_id, true).await
        .context("handshake failed")?;

    if !conn.supports_extensions() {
        bail!("No BEP-10 support");
    }

    info!("Peer {addr}: connected, has extensions ✅");

    // Send interested + extended handshake immediately (like WebTorrent)
    conn.send(&PeerMessage::Interested).await.context("send interested")?;
    conn.send_extended_handshake(1).await.context("send ext handshake")?;

    // Now enter message loop: handle bitfield, have, extended handshake, metadata pieces
    let mut peer_ut_id: Option<u8> = None;
    let mut metadata_size: usize = 0;
    let mut num_pieces: usize = 0;
    let mut pieces: Vec<Option<Vec<u8>>> = Vec::new();
    let mut received: usize = 0;
    let mut requested = false;

    for _ in 0..100 {
        let msg = timeout(PEER_TIMEOUT, conn.recv()).await
            .context("msg timeout")??;

        match msg {
            PeerMessage::Extended { ext_id: 0, payload } => {
                // Peer's extended handshake
                let (ut_id, msize) = parse_ext_handshake(&payload)?;
                peer_ut_id = Some(ut_id);
                metadata_size = msize;
                if metadata_size == 0 { bail!("metadata_size=0"); }
                num_pieces = (metadata_size + METADATA_PIECE_SIZE - 1) / METADATA_PIECE_SIZE;
                pieces = vec![None; num_pieces];
                info!("Peer {addr}: metadata_size={metadata_size}, pieces={num_pieces}");

                // Request metadata pieces immediately (no drain, no delay)
                for i in 0..num_pieces {
                    let dict = format!("d8:msg_typei0e5:piecei{}ee", i);
                    conn.send(&PeerMessage::Extended {
                        ext_id: ut_id,
                        payload: bytes::Bytes::from(dict.into_bytes()),
                    }).await?;
                }
                requested = true;
            }
            PeerMessage::Extended { ext_id: _, payload } if requested => {
                // Metadata data response
                // The peer responds with ext_id = the ID WE registered (1)
                // because that's what we told them in our handshake
                if let Some(_peer_id) = peer_ut_id {
                    if let Some((idx, data)) = parse_metadata_data(&payload) {
                        if idx < num_pieces && pieces[idx].is_none() {
                            pieces[idx] = Some(data);
                            received += 1;
                            if received == num_pieces {
                                break;
                            }
                        }
                    }
                }
            }
            // Ignore bitfield, have, unchoke, etc.
            PeerMessage::Bitfield(_) | PeerMessage::Have(_) |
            PeerMessage::Unchoke | PeerMessage::Choke |
            PeerMessage::Interested | PeerMessage::NotInterested |
            PeerMessage::KeepAlive => {}
            _ => {}
        }
    }

    if received < num_pieces {
        bail!("Incomplete: {received}/{num_pieces} pieces");
    }

    // Assemble and verify
    let info_dict: Vec<u8> = pieces.into_iter().flatten().flatten().collect();

    use sha1::{Digest, Sha1};
    let hash: [u8; 20] = Sha1::digest(&info_dict).into();
    if &hash != info_hash {
        bail!("SHA-1 mismatch");
    }

    info!("Metadata verified ✅ ({} bytes from {addr})", info_dict.len());
    Ok(info_dict)
}

/// Parse the peer's extended handshake payload (bencoded dict).
fn parse_ext_handshake(payload: &[u8]) -> Result<(u8, usize)> {
    let decoded = bencode_decode(payload)?;

    let m = decoded.get("m").ok_or_else(|| anyhow::anyhow!("No 'm' in ext handshake"))?;
    let ut_id = m.get("ut_metadata")
        .and_then(|v| v.as_integer())
        .ok_or_else(|| anyhow::anyhow!("No ut_metadata in 'm'"))? as u8;

    let metadata_size = decoded.get("metadata_size")
        .and_then(|v| v.as_integer())
        .unwrap_or(0) as usize;

    Ok((ut_id, metadata_size))
}

/// Parse a ut_metadata data response. Returns (piece_index, data).
fn parse_metadata_data(payload: &[u8]) -> Option<(usize, Vec<u8>)> {
    // Payload: bencoded_dict + raw_data
    let (dict, data_offset) = find_bencode_end(payload)?;
    let msg_type = dict.get("msg_type")?.as_integer()?;
    if msg_type != 1 { return None; } // 1 = data
    let piece = dict.get("piece")?.as_integer()? as usize;
    let data = payload[data_offset..].to_vec();
    Some((piece, data))
}

// ── Info dict parsing ─────────────────────────────────────────────────────────

/// Parse info dict bytes into TorrentMetadata. Public for use by the engine session.
pub fn parse_info_dict_public(info_dict: &[u8], info_hash_hex: &str) -> Result<TorrentMetadata> {
    parse_info_dict(info_dict, info_hash_hex)
}

fn parse_info_dict(info_dict: &[u8], info_hash_hex: &str) -> Result<TorrentMetadata> {
    let decoded = bencode_decode(info_dict)?;

    let name = decoded.get("name")
        .and_then(|v| v.as_bytes())
        .map(|b| String::from_utf8_lossy(b).to_string())
        .ok_or_else(|| anyhow::anyhow!("No 'name' in info dict"))?;

    let piece_length = decoded.get("piece length")
        .and_then(|v| v.as_integer())
        .ok_or_else(|| anyhow::anyhow!("No 'piece length'"))? as u32;

    let pieces_bytes = decoded.get("pieces")
        .and_then(|v| v.as_bytes())
        .ok_or_else(|| anyhow::anyhow!("No 'pieces'"))?;

    let piece_count = (pieces_bytes.len() / 20) as u32;

    let (files, total_size) = if let Some(files_list) = decoded.get("files") {
        let file_list = files_list.as_list()
            .ok_or_else(|| anyhow::anyhow!("'files' not a list"))?;

        let mut result = Vec::new();
        let mut total: u64 = 0;

        for (i, entry) in file_list.iter().enumerate() {
            let length = entry.get("length")
                .and_then(|v| v.as_integer())
                .unwrap_or(0) as u64;

            let path_parts: Vec<String> = entry.get("path")
                .and_then(|v| v.as_list())
                .map(|parts| parts.iter()
                    .filter_map(|p| p.as_bytes())
                    .map(|b| String::from_utf8_lossy(b).to_string())
                    .collect())
                .unwrap_or_default();

            let path = path_parts.join("/");
            let file_name = path_parts.last().cloned().unwrap_or_default();

            total += length;
            result.push(TorrentFile {
                index: i,
                name: file_name.clone(),
                path: format!("{}/{}", name, path),
                size: length,
                size_formatted: format_bytes(length),
                file_type: get_file_type(&file_name).to_string(),
            });
        }

        result.sort_by(|a, b| b.size.cmp(&a.size));
        (result, total)
    } else {
        let length = decoded.get("length")
            .and_then(|v| v.as_integer())
            .ok_or_else(|| anyhow::anyhow!("No 'length'"))? as u64;

        (vec![TorrentFile {
            index: 0,
            name: name.clone(),
            path: name.clone(),
            size: length,
            size_formatted: format_bytes(length),
            file_type: get_file_type(&name).to_string(),
        }], length)
    };

    Ok(TorrentMetadata {
        name,
        info_hash: info_hash_hex.to_string(),
        total_size,
        total_size_formatted: format_bytes(total_size),
        file_count: files.len(),
        files,
        piece_length,
        piece_count,
        piece_hashes: pieces_bytes.to_vec(),
    })
}

// ── Minimal bencode parser ────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub enum BencodeValue {
    Integer(i64),
    Bytes(Vec<u8>),
    List(Vec<BencodeValue>),
    Dict(HashMap<String, BencodeValue>),
}

impl BencodeValue {
    pub fn as_integer(&self) -> Option<i64> {
        if let Self::Integer(i) = self { Some(*i) } else { None }
    }
    pub fn as_bytes(&self) -> Option<&[u8]> {
        if let Self::Bytes(b) = self { Some(b) } else { None }
    }
    pub fn as_list(&self) -> Option<&[BencodeValue]> {
        if let Self::List(l) = self { Some(l) } else { None }
    }
    pub fn get(&self, key: &str) -> Option<&BencodeValue> {
        if let Self::Dict(m) = self { m.get(key) } else { None }
    }
}

pub fn bencode_decode(data: &[u8]) -> Result<BencodeValue> {
    let (val, _) = decode_value(data, 0)?;
    Ok(val)
}

fn decode_value(data: &[u8], pos: usize) -> Result<(BencodeValue, usize)> {
    if pos >= data.len() { bail!("Unexpected end of bencode"); }
    match data[pos] {
        b'i' => decode_integer(data, pos),
        b'l' => decode_list(data, pos),
        b'd' => decode_dict(data, pos),
        b'0'..=b'9' => decode_bytes(data, pos),
        b => bail!("Unknown bencode type: {}", b as char),
    }
}

fn decode_integer(data: &[u8], pos: usize) -> Result<(BencodeValue, usize)> {
    let end = data[pos..].iter().position(|&b| b == b'e')
        .ok_or_else(|| anyhow::anyhow!("Unterminated integer"))? + pos;
    let s = std::str::from_utf8(&data[pos + 1..end])?;
    Ok((BencodeValue::Integer(s.parse()?), end + 1))
}

fn decode_bytes(data: &[u8], pos: usize) -> Result<(BencodeValue, usize)> {
    let colon = data[pos..].iter().position(|&b| b == b':')
        .ok_or_else(|| anyhow::anyhow!("No colon"))? + pos;
    let len: usize = std::str::from_utf8(&data[pos..colon])?.parse()?;
    let start = colon + 1;
    let end = start + len;
    if end > data.len() { bail!("Byte string out of bounds"); }
    Ok((BencodeValue::Bytes(data[start..end].to_vec()), end))
}

fn decode_list(data: &[u8], pos: usize) -> Result<(BencodeValue, usize)> {
    let mut items = Vec::new();
    let mut cur = pos + 1;
    while cur < data.len() && data[cur] != b'e' {
        let (val, next) = decode_value(data, cur)?;
        items.push(val);
        cur = next;
    }
    Ok((BencodeValue::List(items), cur + 1))
}

fn decode_dict(data: &[u8], pos: usize) -> Result<(BencodeValue, usize)> {
    let mut map = HashMap::new();
    let mut cur = pos + 1;
    while cur < data.len() && data[cur] != b'e' {
        let (key_val, next) = decode_bytes(data, cur)?;
        let key = match key_val {
            BencodeValue::Bytes(b) => String::from_utf8_lossy(&b).to_string(),
            _ => bail!("Dict key not bytes"),
        };
        let (val, next2) = decode_value(data, next)?;
        map.insert(key, val);
        cur = next2;
    }
    Ok((BencodeValue::Dict(map), cur + 1))
}

/// Find where a top-level bencoded dict ends. Returns (value, offset_after_dict).
fn find_bencode_end(data: &[u8]) -> Option<(BencodeValue, usize)> {
    decode_dict(data, 0).ok()
}
