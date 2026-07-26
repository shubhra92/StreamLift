/// MEGA file upload — true streaming, chunked, AES-CTR encrypted.
///
/// Flow: Download bytes → buffer one chunk → encrypt + MAC → POST to MEGA → repeat
/// Memory usage: ~1MB max (one chunk buffer), not the whole file.

use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use futures::Stream;
use rand::RngCore;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::time::{timeout, Duration};
use tracing::{debug, info};

use aes::cipher::{BlockEncrypt, KeyInit};
use super::api::{encrypt_attrs, MegaClient};
use super::crypto::{aes_ctr_encrypt, aes_ecb_encrypt, b64_encode};

// MEGA chunk sizes: starts at 128KB, grows by 128KB each chunk, max 1MB
fn chunk_size(index: usize) -> usize {
    let size = 131072 + (index * 131072);
    size.min(1048576)
}

// ── MAC state (inline, no full-file buffer needed) ────────────────────────────

struct MacState {
    cipher: aes::Aes128,
    nonce: [u8; 8],
    macs: Vec<[u8; 16]>,
    current_mac: [u8; 16],
    pos: u64,
    pos_next: u64,
    increment: u64,
}

impl MacState {
    fn new(file_key: &[u8; 16], nonce: &[u8; 8]) -> Self {
        let cipher = aes::Aes128::new_from_slice(file_key).unwrap();
        let mut current_mac = [0u8; 16];
        current_mac[..8].copy_from_slice(nonce);
        current_mac[8..].copy_from_slice(nonce);

        Self {
            cipher,
            nonce: *nonce,
            macs: Vec::new(),
            current_mac,
            pos: 0,
            pos_next: 131072,
            increment: 131072,
        }
    }

    /// Feed plaintext data into MAC (call BEFORE encrypting each chunk).
    fn update(&mut self, data: &[u8]) {
        let mut i = 0;
        while i < data.len() {
            for j in 0..16 {
                let byte = if i + j < data.len() { data[i + j] } else { 0 };
                self.current_mac[j] ^= byte;
            }
            let mut block = aes::Block::clone_from_slice(&self.current_mac);
            self.cipher.encrypt_block(&mut block);
            self.current_mac.copy_from_slice(&block);

            self.pos += 16;
            if self.pos >= self.pos_next {
                self.macs.push(self.current_mac);
                self.current_mac = [0u8; 16];
                self.current_mac[..8].copy_from_slice(&self.nonce);
                self.current_mac[8..].copy_from_slice(&self.nonce);
                if self.increment < 1048576 {
                    self.increment += 131072;
                }
                self.pos_next += self.increment;
            }

            i += 16;
        }
    }

    /// Finalize and return the 8-byte condensed MAC.
    fn condense(mut self) -> [u8; 8] {
        self.macs.push(self.current_mac);

        let mut condensed = [0u8; 16];
        for m in &self.macs {
            for j in 0..16 {
                condensed[j] ^= m[j];
            }
            let mut block = aes::Block::clone_from_slice(&condensed);
            self.cipher.encrypt_block(&mut block);
            condensed.copy_from_slice(&block);
        }

        let mut result = [0u8; 8];
        for i in 0..4 {
            result[i] = condensed[i] ^ condensed[i + 4];
        }
        for i in 0..4 {
            result[i + 4] = condensed[i + 8] ^ condensed[i + 12];
        }
        result
    }
}

// ── Public upload function (TRUE STREAMING) ───────────────────────────────────

pub async fn upload_stream_to_mega<S, E>(
    mega_client: &mut MegaClient,
    _http: reqwest::Client,
    parent_node: &str,
    filename: &str,
    file_size: u64,
    master_key: &[u8; 16],
    mut stream: S,
    progress_cb: impl Fn(u64) + Send,
) -> Result<String>
where
    S: Stream<Item = Result<Bytes, E>> + Unpin,
    E: std::error::Error + Send + Sync + 'static,
{
    use futures::StreamExt;

    info!("Starting MEGA streaming upload: {} ({} bytes) → parent={}", filename, file_size, parent_node);

    // 1. Get upload URL
    let upload_url = mega_client.request_upload_url(file_size).await.context("request upload URL")?;

    // 2. Generate random file key + nonce
    let mut file_key = [0u8; 16];
    let mut nonce = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut file_key);
    rand::thread_rng().fill_bytes(&mut nonce);

    // 3. Open persistent TCP connection to MEGA upload server
    let mut tcp = open_upload_connection(&upload_url).await?;
    let (host, base_path) = parse_upload_url(&upload_url)?;

    // 4. Stream: download → buffer chunk → MAC + encrypt → POST → repeat
    let mut mac_state = MacState::new(&file_key, &nonce);
    let mut chunk_buf: Vec<u8> = Vec::with_capacity(chunk_size(0));
    let mut chunk_idx: usize = 0;
    let mut file_offset: usize = 0;
    let mut total_downloaded: u64 = 0;
    let mut upload_handle: Option<String> = None;

    while let Some(chunk_result) = stream.next().await {
        let bytes = chunk_result.context("stream read error")?;
        chunk_buf.extend_from_slice(&bytes);
        total_downloaded += bytes.len() as u64;
        progress_cb(total_downloaded);

        // Flush full chunks immediately (stream to MEGA as we download)
        while chunk_buf.len() >= chunk_size(chunk_idx) {
            let cs = chunk_size(chunk_idx);
            let chunk_data: Vec<u8> = chunk_buf.drain(..cs).collect();
            // Check if this chunk completes the file
            let bytes_after_this = file_offset + chunk_data.len();
            let is_last = bytes_after_this >= file_size as usize;

            let handle = flush_one_chunk(
                &mut tcp, &host, &base_path, &chunk_data,
                &file_key, &nonce, &mut mac_state,
                file_offset, chunk_idx, file_size as usize, is_last,
            ).await?;

            if let Some(h) = handle {
                upload_handle = Some(h);
            }

            file_offset += chunk_data.len();
            chunk_idx += 1;
        }
    }

    // 5. Flush the final partial chunk (remaining bytes after stream ends)
    if !chunk_buf.is_empty() {
        let is_last = true;
        let handle = flush_one_chunk(
            &mut tcp, &host, &base_path, &chunk_buf,
            &file_key, &nonce, &mut mac_state,
            file_offset, chunk_idx, file_size as usize, is_last,
        ).await?;

        if let Some(h) = handle {
            upload_handle = Some(h);
        }
    }

    let handle = upload_handle.ok_or_else(|| anyhow!("No upload handle from MEGA"))?;

    // 6. Build completion data
    let condensed_mac = mac_state.condense();

    let mut merged = [0u8; 32];
    merged[..16].copy_from_slice(&file_key);
    merged[16..24].copy_from_slice(&nonce);
    merged[24..32].copy_from_slice(&condensed_mac);
    for i in 0..16 {
        merged[i] ^= merged[16 + i];
    }

    let enc_key = aes_ecb_encrypt(&merged, master_key)?;
    let enc_key_b64 = b64_encode(&enc_key);
    let attrs_b64 = encrypt_attrs(filename, &file_key)?;

    // 7. Complete upload
    let result = mega_client
        .complete_upload(&handle, parent_node, &enc_key_b64, &attrs_b64)
        .await
        .context("complete upload")?;

    let node_handle = result["f"][0]["h"]
        .as_str()
        .ok_or_else(|| anyhow!("No node handle in complete_upload response"))?
        .to_string();

    info!("MEGA upload complete ✅ node={}", node_handle);
    Ok(node_handle)
}

// ── Flush one chunk: MAC + encrypt + POST ─────────────────────────────────────

async fn flush_one_chunk(
    tcp: &mut TcpStream,
    host: &str,
    base_path: &str,
    chunk_data: &[u8],
    file_key: &[u8; 16],
    nonce: &[u8; 8],
    mac_state: &mut MacState,
    offset: usize,
    chunk_idx: usize,
    total_size: usize,
    is_last: bool,
) -> Result<Option<String>> {
    // MAC on plaintext BEFORE encryption
    mac_state.update(chunk_data);

    // Encrypt with AES-CTR
    let encrypted = aes_ctr_encrypt(chunk_data, file_key, nonce, offset as u64);
    let enc_len = encrypted.len();

    // Progress log
    let pct = (offset as f64 / total_size as f64 * 100.0) as u32;
    if chunk_idx % 10 == 0 || is_last {
        info!("MEGA upload: {}% ({}/{} bytes, chunk {})", pct, offset, total_size, chunk_idx);
    }

    // POST chunk over persistent connection
    let path = format!("{}/{}", base_path, offset);
    let header = format!(
        "POST {path} HTTP/1.1\r\n\
         Host: {host}\r\n\
         Content-Type: application/octet-stream\r\n\
         Content-Length: {enc_len}\r\n\
         Connection: keep-alive\r\n\
         \r\n"
    );

    tcp.write_all(header.as_bytes()).await.context("send chunk headers")?;
    tcp.write_all(&encrypted).await.context("send chunk body")?;
    tcp.flush().await?;

    // Read response
    let response = read_http_response(tcp, is_last).await?;

    if response.is_empty() {
        return Ok(None);
    }

    // Check for error
    let resp_str = String::from_utf8_lossy(&response);
    let trimmed = resp_str.trim();
    if trimmed.starts_with('-') && trimmed.len() <= 3 {
        bail!("MEGA upload chunk {} error: {}", chunk_idx, trimmed);
    }

    // Detect handle format
    let is_b64_text = response.iter().all(|&b| {
        (b >= b'A' && b <= b'Z') || (b >= b'a' && b <= b'z') ||
        (b >= b'0' && b <= b'9') || b == b'-' || b == b'_'
    });

    let handle = if is_b64_text {
        String::from_utf8_lossy(&response).trim().to_string()
    } else {
        b64_encode(&response)
    };

    info!("Got upload handle: {}", handle);
    Ok(Some(handle))
}

// ── TCP connection helpers ────────────────────────────────────────────────────

async fn open_upload_connection(upload_url: &str) -> Result<TcpStream> {
    let without_scheme = upload_url
        .strip_prefix("http://")
        .ok_or_else(|| anyhow!("Expected http:// URL"))?;
    let host_port = without_scheme.split('/').next().unwrap_or(without_scheme);
    let addr = if host_port.contains(':') {
        host_port.to_string()
    } else {
        format!("{host_port}:80")
    };

    let stream = TcpStream::connect(&addr).await.context("TCP connect to MEGA")?;
    stream.set_nodelay(true)?;
    Ok(stream)
}

fn parse_upload_url(upload_url: &str) -> Result<(String, String)> {
    let without_scheme = upload_url
        .strip_prefix("http://")
        .ok_or_else(|| anyhow!("Expected http:// URL"))?;
    let (host_port, path) = without_scheme
        .split_once('/')
        .map(|(h, p)| (h, format!("/{p}")))
        .unwrap_or((without_scheme, "/".to_string()));
    let host = host_port.split(':').next().unwrap_or(host_port).to_string();
    Ok((host, path))
}

/// Read one HTTP response from the TCP stream.
async fn read_http_response(stream: &mut TcpStream, is_last: bool) -> Result<Vec<u8>> {
    let mut header_buf = Vec::with_capacity(512);
    let mut found_end = false;

    let read_timeout = if is_last {
        Duration::from_secs(120)
    } else {
        Duration::from_secs(15)
    };

    let header_result = timeout(read_timeout, async {
        loop {
            let mut byte = [0u8; 1];
            stream.read_exact(&mut byte).await?;
            header_buf.push(byte[0]);
            if header_buf.len() >= 4 && &header_buf[header_buf.len()-4..] == b"\r\n\r\n" {
                found_end = true;
                break;
            }
            if header_buf.len() > 4096 {
                break;
            }
        }
        Ok::<(), anyhow::Error>(())
    }).await;

    match header_result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            if !is_last { return Ok(Vec::new()); }
            bail!("Timeout reading MEGA response");
        }
    }

    if !found_end {
        return Ok(Vec::new());
    }

    let header_str = String::from_utf8_lossy(&header_buf);
    let content_length: usize = header_str
        .lines()
        .find(|l| l.to_lowercase().starts_with("content-length:"))
        .and_then(|l| l.split(':').nth(1))
        .and_then(|v| v.trim().parse().ok())
        .unwrap_or(0);

    if content_length == 0 {
        return Ok(Vec::new());
    }

    let mut body = vec![0u8; content_length];
    timeout(Duration::from_secs(10), stream.read_exact(&mut body))
        .await
        .context("timeout reading body")?
        .context("read body")?;

    Ok(body)
}

// ── Folder helpers ────────────────────────────────────────────────────────────

pub async fn get_or_create_folder(
    mega_client: &mut MegaClient,
    parent_handle: &str,
    folder_name: &str,
    master_key: &[u8; 16],
) -> Result<String> {
    use super::auth::find_child_node;

    let files = mega_client.get_files().await.context("get files")?;

    if let Some(handle) = find_child_node(&files, parent_handle, folder_name, master_key) {
        debug!("Folder '{}' exists: {}", folder_name, handle);
        return Ok(handle);
    }

    let handle = mega_client.mkdir(parent_handle, folder_name, master_key).await.context("mkdir")?;
    info!("Created MEGA folder '{}' → {}", folder_name, handle);
    Ok(handle)
}
