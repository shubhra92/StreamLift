/// UDP tracker announce — BEP-15.
///
/// Flow:
///   1. Send connect request  (action=0)
///   2. Receive connect response → connection_id
///   3. Send announce request (action=1) with info_hash + peer_id
///   4. Receive announce response → list of (ip, port) peers

use anyhow::{bail, Context, Result};
use rand::RngCore;
use std::net::{Ipv4Addr, SocketAddr, SocketAddrV4};
use tokio::net::UdpSocket;
use tokio::time::{timeout, Duration};
use tracing::{debug, info, warn};

const CONNECT_MAGIC: u64 = 0x41727101980;
const ACTION_CONNECT: u32 = 0;
const ACTION_ANNOUNCE: u32 = 1;
const ANNOUNCE_TIMEOUT_SECS: u64 = 15;

#[derive(Debug, Clone)]
pub struct Peer {
    pub ip: Ipv4Addr,
    pub port: u16,
}

impl Peer {
    pub fn addr(&self) -> SocketAddr {
        SocketAddr::V4(SocketAddrV4::new(self.ip, self.port))
    }
}

/// Announce to all trackers in `urls` and collect unique peers.
/// Tries UDP and HTTP trackers concurrently, returns when we have `min_peers`.
pub async fn announce_all(
    urls: &[String],
    info_hash: &[u8; 20],
    peer_id: &[u8; 20],
    min_peers: usize,
) -> Vec<Peer> {
    let mut all_peers: Vec<Peer> = Vec::new();

    // Add well-known public trackers as fallback
    let mut all_urls: Vec<String> = urls.to_vec();
    let fallback_trackers = vec![
        "udp://tracker.opentrackr.org:1337/announce",
        "udp://open.stealth.si:80/announce",
        "udp://tracker.torrent.eu.org:451/announce",
        "udp://exodus.desync.com:6969/announce",
        "udp://tracker.openbittorrent.com:6969/announce",
        "https://tracker.nanoha.org:443/announce",
        "https://tracker.lilithraws.org:443/announce",
    ];
    for t in fallback_trackers {
        if !all_urls.iter().any(|u| u == t) {
            all_urls.push(t.to_string());
        }
    }

    for url in &all_urls {
        let result = if url.starts_with("udp://") {
            announce_udp(url, info_hash, peer_id).await
        } else if url.starts_with("http://") || url.starts_with("https://") {
            announce_http(url, info_hash, peer_id).await
        } else {
            continue;
        };

        match result {
            Ok(peers) => {
                info!("Tracker {} → {} peers", url, peers.len());
                all_peers.extend(peers);
                all_peers.dedup_by(|a, b| a.ip == b.ip && a.port == b.port);
                if all_peers.len() >= min_peers {
                    return all_peers;
                }
            }
            Err(e) => debug!("Tracker {url} failed: {e}"),
        }
    }

    all_peers
}

/// Send a UDP announce to a single tracker.
pub async fn announce_udp(
    tracker_url: &str,
    info_hash: &[u8; 20],
    peer_id: &[u8; 20],
) -> Result<Vec<Peer>> {
    let addr = parse_udp_tracker_url(tracker_url)?;

    let sock = UdpSocket::bind("0.0.0.0:0")
        .await
        .context("bind UDP socket")?;
    sock.connect(&addr).await.context("connect to tracker")?;

    // ── Step 1: Connect ───────────────────────────────────────────────────────
    let tx_id: u32 = rand::thread_rng().next_u32();
    let connect_req = build_connect_request(tx_id);

    timeout(Duration::from_secs(ANNOUNCE_TIMEOUT_SECS), sock.send(&connect_req))
        .await
        .context("connect send timeout")?
        .context("connect send")?;

    let mut buf = vec![0u8; 4096];
    let n = timeout(Duration::from_secs(ANNOUNCE_TIMEOUT_SECS), sock.recv(&mut buf))
        .await
        .context("connect recv timeout")?
        .context("connect recv")?;

    let connection_id = parse_connect_response(&buf[..n], tx_id)?;
    debug!("Tracker {addr}: connection_id={connection_id:#018x}");

    // ── Step 2: Announce ──────────────────────────────────────────────────────
    let tx_id2: u32 = rand::thread_rng().next_u32();
    let announce_req = build_announce_request(connection_id, tx_id2, info_hash, peer_id);

    timeout(Duration::from_secs(ANNOUNCE_TIMEOUT_SECS), sock.send(&announce_req))
        .await
        .context("announce send timeout")?
        .context("announce send")?;

    let n = timeout(Duration::from_secs(ANNOUNCE_TIMEOUT_SECS), sock.recv(&mut buf))
        .await
        .context("announce recv timeout")?
        .context("announce recv")?;

    parse_announce_response(&buf[..n], tx_id2)
}

// ── Protocol builders ─────────────────────────────────────────────────────────

fn build_connect_request(transaction_id: u32) -> [u8; 16] {
    let mut buf = [0u8; 16];
    buf[..8].copy_from_slice(&CONNECT_MAGIC.to_be_bytes());
    buf[8..12].copy_from_slice(&ACTION_CONNECT.to_be_bytes());
    buf[12..16].copy_from_slice(&transaction_id.to_be_bytes());
    buf
}

fn parse_connect_response(buf: &[u8], expected_tx: u32) -> Result<u64> {
    if buf.len() < 16 {
        bail!("Connect response too short: {} bytes", buf.len());
    }
    let action = u32::from_be_bytes(buf[0..4].try_into().unwrap());
    let tx_id = u32::from_be_bytes(buf[4..8].try_into().unwrap());
    if action != ACTION_CONNECT {
        bail!("Expected action=0 in connect response, got {action}");
    }
    if tx_id != expected_tx {
        bail!("Transaction ID mismatch: expected {expected_tx}, got {tx_id}");
    }
    Ok(u64::from_be_bytes(buf[8..16].try_into().unwrap()))
}

fn build_announce_request(
    connection_id: u64,
    transaction_id: u32,
    info_hash: &[u8; 20],
    peer_id: &[u8; 20],
) -> [u8; 98] {
    let mut buf = [0u8; 98];
    buf[0..8].copy_from_slice(&connection_id.to_be_bytes());
    buf[8..12].copy_from_slice(&ACTION_ANNOUNCE.to_be_bytes());
    buf[12..16].copy_from_slice(&transaction_id.to_be_bytes());
    buf[16..36].copy_from_slice(info_hash);    // info_hash
    buf[36..56].copy_from_slice(peer_id);      // peer_id
    // downloaded=0, left=0, uploaded=0 (bytes 56..80 all zero)
    buf[80..84].copy_from_slice(&0u32.to_be_bytes()); // event=0 (none)
    // ip=0 (use source IP), key=random, num_want=-1 (default), port
    let key: u32 = rand::thread_rng().next_u32();
    buf[84..88].copy_from_slice(&0u32.to_be_bytes()); // ip=0
    buf[88..92].copy_from_slice(&key.to_be_bytes());
    buf[92..96].copy_from_slice(&(-1i32 as u32).to_be_bytes()); // num_want = -1
    buf[96..98].copy_from_slice(&6881u16.to_be_bytes()); // port
    buf
}

fn parse_announce_response(buf: &[u8], expected_tx: u32) -> Result<Vec<Peer>> {
    if buf.len() < 20 {
        bail!("Announce response too short: {} bytes", buf.len());
    }
    let action = u32::from_be_bytes(buf[0..4].try_into().unwrap());
    let tx_id = u32::from_be_bytes(buf[4..8].try_into().unwrap());

    if action != ACTION_ANNOUNCE {
        bail!("Expected action=1 in announce response, got {action}");
    }
    if tx_id != expected_tx {
        bail!("Transaction ID mismatch in announce response");
    }

    let _interval = u32::from_be_bytes(buf[8..12].try_into().unwrap());
    let _leechers = u32::from_be_bytes(buf[12..16].try_into().unwrap());
    let _seeders = u32::from_be_bytes(buf[16..20].try_into().unwrap());

    let mut peers = Vec::new();
    let peer_data = &buf[20..];
    for chunk in peer_data.chunks_exact(6) {
        let ip = Ipv4Addr::new(chunk[0], chunk[1], chunk[2], chunk[3]);
        let port = u16::from_be_bytes([chunk[4], chunk[5]]);
        if port > 0 {
            peers.push(Peer { ip, port });
        }
    }

    Ok(peers)
}

// ── URL parsing ───────────────────────────────────────────────────────────────

fn parse_udp_tracker_url(url: &str) -> Result<String> {
    // udp://tracker.example.com:1337/announce → tracker.example.com:1337
    let without_scheme = url
        .strip_prefix("udp://")
        .ok_or_else(|| anyhow::anyhow!("Not a UDP tracker URL: {url}"))?;
    let host_port = without_scheme
        .split('/')
        .next()
        .unwrap_or(without_scheme);
    Ok(host_port.to_string())
}

/// Generate a random 20-byte peer ID with "-SL0001-" prefix (StreamLift).
pub fn generate_peer_id() -> [u8; 20] {
    let mut id = [0u8; 20];
    let prefix = b"-SL0001-";
    id[..prefix.len()].copy_from_slice(prefix);
    rand::thread_rng().fill_bytes(&mut id[prefix.len()..]);
    id
}

// ── HTTP/HTTPS tracker announce (BEP-3) ───────────────────────────────────────

/// Announce to an HTTP/HTTPS tracker.
/// BEP-3: GET /announce?info_hash=...&peer_id=...&port=...&uploaded=0&downloaded=0&left=0&compact=1
pub async fn announce_http(
    tracker_url: &str,
    info_hash: &[u8; 20],
    peer_id: &[u8; 20],
) -> Result<Vec<Peer>> {
    // URL-encode info_hash and peer_id (percent-encoding for raw bytes)
    let ih_encoded = percent_encode_bytes(info_hash);
    let pid_encoded = percent_encode_bytes(peer_id);

    let url = format!(
        "{}{}info_hash={}&peer_id={}&port=6881&uploaded=0&downloaded=0&left=0&compact=1&numwant=50",
        tracker_url,
        if tracker_url.contains('?') { "&" } else { "?" },
        ih_encoded,
        pid_encoded
    );

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(10))
        .build()?;

    let resp = timeout(Duration::from_secs(10), client.get(&url).send())
        .await
        .context("HTTP tracker timeout")?
        .context("HTTP tracker request")?;

    if !resp.status().is_success() {
        bail!("HTTP tracker returned {}", resp.status());
    }

    let body = resp.bytes().await.context("read tracker response")?;

    // Parse bencoded response
    parse_http_tracker_response(&body)
}

/// Parse a bencoded HTTP tracker response (compact format).
fn parse_http_tracker_response(data: &[u8]) -> Result<Vec<Peer>> {
    use super::metadata::BencodeValue;

    let decoded = super::metadata::bencode_decode(data)?;
    
    // Check for failure
    if let Some(reason) = decoded.get("failure reason") {
        if let Some(msg) = reason.as_bytes() {
            bail!("Tracker failure: {}", String::from_utf8_lossy(msg));
        }
    }

    // Extract compact peers (6 bytes each: 4 IP + 2 port)
    let peers_data = decoded.get("peers")
        .and_then(|v| v.as_bytes())
        .ok_or_else(|| anyhow::anyhow!("No 'peers' in tracker response"))?;

    let mut peers = Vec::new();
    for chunk in peers_data.chunks_exact(6) {
        let ip = Ipv4Addr::new(chunk[0], chunk[1], chunk[2], chunk[3]);
        let port = u16::from_be_bytes([chunk[4], chunk[5]]);
        if port > 0 {
            peers.push(Peer { ip, port });
        }
    }

    Ok(peers)
}

/// Percent-encode raw bytes for URL query parameters.
fn percent_encode_bytes(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 3);
    for &b in bytes {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(b as char);
            }
            _ => {
                encoded.push_str(&format!("%{:02X}", b));
            }
        }
    }
    encoded
}
