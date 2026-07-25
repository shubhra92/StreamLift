/// Torrent metadata fetch via BEP-9 (ut_metadata extension).
///
/// This is what lets us get the torrent info dict from just a magnet link,
/// by connecting to peers and requesting the info dict in pieces.
///
/// BEP-9: https://www.bittorrent.org/beps/bep_0009.html
/// BEP-10: https://www.bittorrent.org/beps/bep_0010.html

use anyhow::{bail, Context, Result};
use std::collections::HashMap;
use tokio::time::{timeout, Duration};
use tracing::{debug, info};

use super::magnet::MagnetLink;
use super::peer::{PeerConnection, PeerMessage};
use super::tracker::{announce_all, generate_peer_id};
use crate::utils::format::{format_bytes, get_file_type};

const METADATA_TIMEOUT: Duration = Duration::from_secs(120);
const METADATA_PIECE_SIZE: usize = 16 * 1024; // 16 KB
const UT_METADATA_REQUEST: u8 = 0;
const UT_METADATA_DATA: u8 = 1;

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
    /// Piece length in bytes
    #[serde(rename = "pieceLength")]
    pub piece_length: u32,
    /// Number of pieces
    #[serde(rename = "pieceCount")]
    pub piece_count: u32,
}

/// Fetch torrent metadata from a magnet link.
/// Tries up to `max_peers` peers before giving up.
pub async fn fetch_metadata(magnet: &MagnetLink) -> Result<TorrentMetadata> {
    let peer_id = generate_peer_id();

    // Get peers from trackers
    info!("Announcing to {} trackers...", magnet.trackers.len());
    let peers = announce_all(&magnet.trackers, &magnet.info_hash, &peer_id, 5).await;

    if peers.is_empty() {
        // Try DHT fallback or hardcoded bootstrap peers
        bail!("No peers found from trackers — DHT not yet implemented");
    }

    info!("Got {} peers, trying to fetch metadata...", peers.len());

    // Try each peer until we get the metadata
    let result = timeout(
        METADATA_TIMEOUT,
        try_peers_for_metadata(peers, &magnet.info_hash, &peer_id),
    )
    .await
    .context("metadata fetch timeout")?;

    match result {
        Some(info_dict) => parse_info_dict(&info_dict, &magnet.info_hash_hex),
        None => bail!("Could not fetch metadata from any peer"),
    }
}

async fn try_peers_for_metadata(
    peers: Vec<super::tracker::Peer>,
    info_hash: &[u8; 20],
    peer_id: &[u8; 20],
) -> Option<Vec<u8>> {
    for peer in peers {
        match fetch_metadata_from_peer(peer.addr(), info_hash, peer_id).await {
            Ok(data) => return Some(data),
            Err(e) => debug!("Peer {} failed: {e}", peer.addr()),
        }
    }
    None
}

/// Connect to one peer and fetch the metadata info dict via ut_metadata.
async fn fetch_metadata_from_peer(
    addr: std::net::SocketAddr,
    info_hash: &[u8; 20],
    peer_id: &[u8; 20],
) -> Result<Vec<u8>> {
    debug!("Connecting to peer {addr} for metadata...");

    let mut conn = PeerConnection::connect(addr, info_hash, peer_id, true)
        .await
        .context("peer connect")?;

    if !conn.supports_extensions() {
        bail!("Peer does not support BEP-10 extensions");
    }

    // Send extended handshake
    conn.send_extended_handshake(1).await?; // register ut_metadata as ext id 1

    // Wait for peer's extended handshake to learn:
    //   - their ut_metadata extension ID
    //   - the metadata_size
    let (peer_ut_metadata_id, metadata_size) =
        wait_for_ext_handshake(&mut conn).await?;

    if metadata_size == 0 {
        bail!("Peer reported metadata_size=0");
    }

    let num_pieces = (metadata_size + METADATA_PIECE_SIZE - 1) / METADATA_PIECE_SIZE;
    let mut pieces: Vec<Option<Vec<u8>>> = vec![None; num_pieces];

    // Request all pieces
    for i in 0..num_pieces {
        request_metadata_piece(&mut conn, peer_ut_metadata_id, i).await?;
    }

    // Collect responses
    let mut received = 0;
    loop {
        let msg = conn.recv().await?;
        match msg {
            PeerMessage::Extended { ext_id, payload } => {
                if ext_id == 1 {
                    // ut_metadata message
                    if let Some((piece_index, data)) = parse_ut_metadata_data(&payload) {
                        if piece_index < num_pieces && pieces[piece_index].is_none() {
                            pieces[piece_index] = Some(data);
                            received += 1;
                            debug!("Metadata piece {piece_index}/{num_pieces} received");
                        }
                        if received == num_pieces {
                            break;
                        }
                    }
                }
            }
            _ => {} // ignore other messages
        }
    }

    // Assemble the info dict
    let info_dict: Vec<u8> = pieces
        .into_iter()
        .flatten()
        .flatten()
        .collect();

    // Verify SHA-1 hash of info dict matches info_hash
    use sha1::{Digest, Sha1};
    let mut hasher = Sha1::new();
    hasher.update(&info_dict);
    let computed: [u8; 20] = hasher.finalize().into();
    if &computed != info_hash {
        bail!("Info dict SHA-1 mismatch — corrupt metadata");
    }

    info!("Metadata verified ✅ ({} bytes)", info_dict.len());
    Ok(info_dict)
}

async fn wait_for_ext_handshake(
    conn: &mut PeerConnection,
) -> Result<(u8, usize)> {
    // Wait for the peer's extended handshake (ext_id=0)
    for _ in 0..20 {
        let msg = conn.recv().await?;
        if let PeerMessage::Extended { ext_id: 0, payload } = msg {
            return parse_ext_handshake_payload(&payload);
        }
    }
    bail!("Never received extended handshake from peer")
}

fn parse_ext_handshake_payload(payload: &[u8]) -> Result<(u8, usize)> {
    // Payload is a bencoded dict; we need to extract:
    //   m.ut_metadata (their extension ID for ut_metadata)
    //   metadata_size
    let decoded = bencode_decode(payload)?;

    let m = decoded
        .get("m")
        .ok_or_else(|| anyhow::anyhow!("No 'm' in ext handshake"))?;

    let ut_id = m
        .get("ut_metadata")
        .and_then(|v| v.as_integer())
        .ok_or_else(|| anyhow::anyhow!("No ut_metadata in 'm'"))? as u8;

    let metadata_size = decoded
        .get("metadata_size")
        .and_then(|v| v.as_integer())
        .unwrap_or(0) as usize;

    Ok((ut_id, metadata_size))
}

async fn request_metadata_piece(
    conn: &mut PeerConnection,
    peer_ext_id: u8,
    piece: usize,
) -> Result<()> {
    // ut_metadata request: {"msg_type":0,"piece":<index>}
    let dict = format!("d8:msg_typei0e5:piecei{}ee", piece);
    let payload = bytes::Bytes::from(dict.into_bytes());
    conn.send(&PeerMessage::Extended {
        ext_id: peer_ext_id,
        payload,
    })
    .await
}

/// Parse a ut_metadata data message.
/// Returns (piece_index, data_bytes).
fn parse_ut_metadata_data(payload: &[u8]) -> Option<(usize, Vec<u8>)> {
    // Payload is: bencoded_dict || raw_data
    // The bencoded dict ends at the first 'e' that closes the top-level dict
    // We need to find where the bencoded part ends
    let (dict, data_offset) = find_bencode_end(payload)?;
    
    let msg_type = dict.get("msg_type")?.as_integer()?;
    if msg_type != UT_METADATA_DATA as i64 {
        return None;
    }
    let piece = dict.get("piece")?.as_integer()? as usize;
    let data = payload[data_offset..].to_vec();
    Some((piece, data))
}

// ── Info dict parsing ─────────────────────────────────────────────────────────

fn parse_info_dict(info_dict: &[u8], info_hash_hex: &str) -> Result<TorrentMetadata> {
    let decoded = bencode_decode(info_dict)?;

    let name = decoded
        .get("name")
        .and_then(|v| v.as_bytes())
        .map(|b| String::from_utf8_lossy(b).to_string())
        .ok_or_else(|| anyhow::anyhow!("No 'name' in info dict"))?;

    let piece_length = decoded
        .get("piece length")
        .and_then(|v| v.as_integer())
        .ok_or_else(|| anyhow::anyhow!("No 'piece length' in info dict"))? as u32;

    let pieces_bytes = decoded
        .get("pieces")
        .and_then(|v| v.as_bytes())
        .ok_or_else(|| anyhow::anyhow!("No 'pieces' in info dict"))?;

    let piece_count = (pieces_bytes.len() / 20) as u32;

    // Determine files
    let files: Vec<TorrentFile>;
    let total_size: u64;

    if let Some(files_list) = decoded.get("files") {
        // Multi-file torrent
        let file_list = files_list
            .as_list()
            .ok_or_else(|| anyhow::anyhow!("'files' is not a list"))?;

        let mut result = Vec::new();
        let mut running_total: u64 = 0;

        for (i, file_entry) in file_list.iter().enumerate() {
            let length = file_entry
                .get("length")
                .and_then(|v| v.as_integer())
                .unwrap_or(0) as u64;

            let path_parts: Vec<String> = file_entry
                .get("path")
                .and_then(|v| v.as_list())
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(|p| p.as_bytes())
                        .map(|b| String::from_utf8_lossy(b).to_string())
                        .collect()
                })
                .unwrap_or_default();

            let path = path_parts.join("/");
            let file_name = path_parts.last().cloned().unwrap_or_default();

            running_total += length;
            result.push(TorrentFile {
                index: i,
                name: file_name.clone(),
                path: format!("{}/{}", name, path),
                size: length,
                size_formatted: format_bytes(length),
                file_type: get_file_type(&file_name).to_string(),
            });
        }

        // Sort largest first (matches JS behavior)
        result.sort_by(|a, b| b.size.cmp(&a.size));
        total_size = running_total;
        files = result;
    } else {
        // Single-file torrent
        let length = decoded
            .get("length")
            .and_then(|v| v.as_integer())
            .ok_or_else(|| anyhow::anyhow!("No 'length' in single-file info dict"))? as u64;

        total_size = length;
        files = vec![TorrentFile {
            index: 0,
            name: name.clone(),
            path: name.clone(),
            size: length,
            size_formatted: format_bytes(length),
            file_type: get_file_type(&name).to_string(),
        }];
    }

    Ok(TorrentMetadata {
        name,
        info_hash: info_hash_hex.to_string(),
        total_size,
        total_size_formatted: format_bytes(total_size),
        file_count: files.len(),
        files,
        piece_length,
        piece_count,
    })
}

// ── Minimal bencode parser ────────────────────────────────────────────────────

/// A simple bencode value type.
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

fn bencode_decode(data: &[u8]) -> Result<BencodeValue> {
    let (val, _) = decode_value(data, 0)?;
    Ok(val)
}

fn decode_value(data: &[u8], pos: usize) -> Result<(BencodeValue, usize)> {
    if pos >= data.len() {
        bail!("Unexpected end of bencode data");
    }
    match data[pos] {
        b'i' => decode_integer(data, pos),
        b'l' => decode_list(data, pos),
        b'd' => decode_dict(data, pos),
        b'0'..=b'9' => decode_bytes(data, pos),
        b => bail!("Unknown bencode type: {b}"),
    }
}

fn decode_integer(data: &[u8], pos: usize) -> Result<(BencodeValue, usize)> {
    let end = data[pos..].iter().position(|&b| b == b'e')
        .ok_or_else(|| anyhow::anyhow!("Unterminated integer"))?
        + pos;
    let s = std::str::from_utf8(&data[pos + 1..end])?;
    let n: i64 = s.parse()?;
    Ok((BencodeValue::Integer(n), end + 1))
}

fn decode_bytes(data: &[u8], pos: usize) -> Result<(BencodeValue, usize)> {
    let colon = data[pos..].iter().position(|&b| b == b':')
        .ok_or_else(|| anyhow::anyhow!("No colon in byte string"))?
        + pos;
    let len_s = std::str::from_utf8(&data[pos..colon])?;
    let len: usize = len_s.parse()?;
    let start = colon + 1;
    let end = start + len;
    if end > data.len() {
        bail!("Byte string out of bounds");
    }
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
            _ => bail!("Dict key not a byte string"),
        };
        let (val, next2) = decode_value(data, next)?;
        map.insert(key, val);
        cur = next2;
    }
    Ok((BencodeValue::Dict(map), cur + 1))
}

/// Find where a bencoded value ends; returns (decoded_dict, byte_offset_after_dict).
fn find_bencode_end(data: &[u8]) -> Option<(BencodeValue, usize)> {
    let (val, end) = decode_dict(data, 0).ok()?;
    Some((val, end))
}
