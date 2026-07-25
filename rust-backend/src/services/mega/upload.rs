/// MEGA file upload — streaming, chunked, AES-CTR encrypted.

use anyhow::{anyhow, bail, Context, Result};
use bytes::Bytes;
use futures::Stream;
use rand::RngCore;
use tracing::{debug, info};

use aes::cipher::{BlockEncrypt, KeyInit};
use super::api::{encrypt_attrs, MegaClient};
use super::crypto::{aes_ctr_encrypt, aes_ecb_encrypt, b64_encode};

// MEGA chunk sizes: starts at 128KB, grows by 128KB each chunk, max 1MB
fn chunk_size(index: usize) -> usize {
    let size = 131072 + (index * 131072); // 128KB, 256KB, 384KB, 512KB...
    size.min(1048576) // cap at 1MB
}

// ── Public upload function ────────────────────────────────────────────────────

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

    info!("Starting MEGA upload: {} ({} bytes) → parent={}", filename, file_size, parent_node);

    let upload_url = mega_client.request_upload_url(file_size).await.context("request upload URL")?;

    // Generate random file key (16 bytes) and nonce (8 bytes)
    let mut file_key = [0u8; 16];
    let mut nonce = [0u8; 8];
    rand::thread_rng().fill_bytes(&mut file_key);
    rand::thread_rng().fill_bytes(&mut nonce);

    // Buffer entire file
    let mut file_data: Vec<u8> = Vec::with_capacity(file_size as usize);
    let mut total_read: u64 = 0;
    while let Some(chunk_result) = stream.next().await {
        let bytes = chunk_result.context("stream read error")?;
        file_data.extend_from_slice(&bytes);
        total_read += bytes.len() as u64;
        progress_cb(total_read);
    }

    // ── Compute MAC (matches megajs MAC class) ────────────────────────────────
    let condensed_mac = compute_mega_mac(&file_data, &file_key, &nonce);

    // ── Upload all chunks on single persistent connection ─────────────────────
    let upload_handle = upload_all_chunks(&upload_url, &file_data, &file_key, &nonce)
        .await
        .context("upload chunks")?;

    // ── Build completion data ─────────────────────────────────────────────────
    // mergeKeyMac: [key(16) | nonce(8) | mac(8)] → XOR first16 with last16
    let mut merged = [0u8; 32];
    merged[..16].copy_from_slice(&file_key);
    merged[16..24].copy_from_slice(&nonce);
    merged[24..32].copy_from_slice(&condensed_mac);
    for i in 0..16 {
        merged[i] ^= merged[16 + i];
    }

    // Encrypt 32-byte key with master key (AES-ECB)
    let enc_key = aes_ecb_encrypt(&merged, master_key)?;
    let enc_key_b64 = b64_encode(&enc_key);

    // Encrypt file attributes with the file key (AES-CBC, zero IV)
    let attrs_b64 = encrypt_attrs(filename, &file_key)?;

    // ── Complete upload ───────────────────────────────────────────────────────
    let result = mega_client
        .complete_upload(&upload_handle, parent_node, &enc_key_b64, &attrs_b64)
        .await
        .context("complete upload")?;

    let node_handle = result["f"][0]["h"]
        .as_str()
        .ok_or_else(|| anyhow!("No node handle in complete_upload response"))?
        .to_string();

    info!("MEGA upload complete ✅ node={}", node_handle);
    Ok(node_handle)
}

// ── MEGA MAC computation ──────────────────────────────────────────────────────
// Exactly matches megajs MAC class behavior:
//   - Process 16-byte blocks
//   - At each boundary (128KB, 384KB, 768KB...) save current MAC to array and reset
//   - At the end, condense: XOR all MACs together with AES-ECB between each
//   - Fold 16→8 bytes

fn compute_mega_mac(data: &[u8], file_key: &[u8; 16], nonce: &[u8; 8]) -> [u8; 8] {
    let cipher = aes::Aes128::new_from_slice(file_key).unwrap();

    let mut macs: Vec<[u8; 16]> = Vec::new();
    let mut mac = [0u8; 16];
    mac[..8].copy_from_slice(nonce);
    mac[8..].copy_from_slice(nonce);

    let mut pos: u64 = 0;
    let mut pos_next: u64 = 131072;  // first boundary at 128KB
    let mut increment: u64 = 131072;

    // Process in 16-byte blocks
    let mut i = 0;
    while i < data.len() {
        // XOR 16 bytes into MAC
        for j in 0..16 {
            let byte = if i + j < data.len() { data[i + j] } else { 0 };
            mac[j] ^= byte;
        }

        // AES-ECB encrypt
        let mut block = aes::Block::clone_from_slice(&mac);
        cipher.encrypt_block(&mut block);
        mac.copy_from_slice(&block);

        // Boundary check (megajs: checkBounding)
        pos += 16;
        if pos >= pos_next {
            macs.push(mac);
            // Reset MAC
            mac = [0u8; 16];
            mac[..8].copy_from_slice(nonce);
            mac[8..].copy_from_slice(nonce);
            // Advance
            if increment < 1048576 {
                increment += 131072;
            }
            pos_next += increment;
        }

        i += 16;
    }

    // Push the final (possibly partial) chunk MAC
    macs.push(mac);

    // Condense: XOR all MACs together with AES-ECB between each
    let mut condensed = [0u8; 16];
    for m in &macs {
        for j in 0..16 {
            condensed[j] ^= m[j];
        }
        let mut block = aes::Block::clone_from_slice(&condensed);
        cipher.encrypt_block(&mut block);
        condensed.copy_from_slice(&block);
    }

    // Fold 16 → 8 bytes
    let mut result = [0u8; 8];
    for i in 0..4 {
        result[i] = condensed[i] ^ condensed[i + 4];
    }
    for i in 0..4 {
        result[i + 4] = condensed[i + 8] ^ condensed[i + 12];
    }

    result
}

// ── Raw TCP POST for MEGA upload ──────────────────────────────────────────────

/// Upload all chunks on a SINGLE persistent TCP connection.
/// MEGA expects all chunks for one upload to come over the same socket.
async fn upload_all_chunks(
    upload_url: &str,
    file_data: &[u8],
    file_key: &[u8; 16],
    nonce: &[u8; 8],
) -> Result<String> {
    use tokio::io::{AsyncReadExt, AsyncWriteExt};
    use tokio::net::TcpStream;
    use tokio::time::{timeout, Duration};

    // Parse the upload URL
    let without_scheme = upload_url
        .strip_prefix("http://")
        .ok_or_else(|| anyhow!("Expected http:// URL"))?;
    let (host_port, base_path) = without_scheme
        .split_once('/')
        .map(|(h, p)| (h, format!("/{p}")))
        .unwrap_or((without_scheme, "/".to_string()));
    let addr = if host_port.contains(':') {
        host_port.to_string()
    } else {
        format!("{host_port}:80")
    };
    let host = host_port.split(':').next().unwrap_or(host_port);

    // Open ONE persistent TCP connection
    let mut stream = TcpStream::connect(&addr).await.context("TCP connect to MEGA")?;
    stream.set_nodelay(true)?;

    let total_size = file_data.len();
    let mut offset: usize = 0;
    let mut chunk_idx: usize = 0;
    let mut upload_handle: Option<String> = None;

    while offset < total_size {
        let cs = chunk_size(chunk_idx);
        let end = (offset + cs).min(total_size);
        let chunk_data = &file_data[offset..end];
        let is_last = end >= total_size;

        // Encrypt with AES-CTR
        let encrypted = aes_ctr_encrypt(chunk_data, file_key, nonce, offset as u64);
        let enc_len = encrypted.len();

        // Log upload progress every few chunks
        let upload_pct = (offset as f64 / total_size as f64 * 100.0) as u32;
        if chunk_idx % 5 == 0 || is_last {
            info!("Uploading to MEGA: {}% ({}/{} bytes, chunk {})",
                upload_pct, offset, total_size, chunk_idx);
        }

        // Build HTTP request for this chunk (keep-alive for all but last)
        let path = format!("{}/{}", base_path, offset);
        let connection = if is_last { "close" } else { "keep-alive" };
        let header = format!(
            "POST {path} HTTP/1.1\r\n\
             Host: {host}\r\n\
             Content-Type: application/octet-stream\r\n\
             Content-Length: {enc_len}\r\n\
             Connection: {connection}\r\n\
             \r\n"
        );

        debug!("POST chunk idx={} offset={} size={} last={}", chunk_idx, offset, enc_len, is_last);

        // Send request
        stream.write_all(header.as_bytes()).await.context("send chunk headers")?;
        stream.write_all(&encrypted).await.context("send chunk body")?;
        stream.flush().await?;

        // Read response
        let response = read_http_response(&mut stream, is_last).await?;

        if !response.is_empty() {
            // Check for error code (negative number as ASCII text)
            let resp_str = String::from_utf8_lossy(&response);
            let trimmed = resp_str.trim();
            if trimmed.starts_with('-') && trimmed.len() <= 3 {
                bail!("MEGA upload chunk {} returned error: {}", chunk_idx, trimmed);
            }
            
            // MEGA upload handle: some servers return raw binary (need b64 encode),
            // others return the handle already as base64url text (pass directly).
            // If all bytes are valid base64url characters, it's already encoded.
            let is_b64_text = response.iter().all(|&b| {
                (b >= b'A' && b <= b'Z') || (b >= b'a' && b <= b'z') ||
                (b >= b'0' && b <= b'9') || b == b'-' || b == b'_'
            });
            
            let handle = if is_b64_text {
                // Already a base64url string — use directly
                String::from_utf8_lossy(&response).trim().to_string()
            } else {
                // Raw binary — base64url-encode it
                b64_encode(&response)
            };
            info!("Got upload handle: {} (b64_text={}, {} bytes)", handle, is_b64_text, response.len());
            upload_handle = Some(handle);
        }

        offset = end;
        chunk_idx += 1;
    }

    upload_handle.ok_or_else(|| anyhow!("No upload handle received from MEGA"))
}

/// Read one HTTP response from the stream.
/// Returns the body bytes (empty for intermediate chunks).
async fn read_http_response(
    stream: &mut tokio::net::TcpStream,
    is_last: bool,
) -> Result<Vec<u8>> {
    use tokio::io::AsyncReadExt;
    use tokio::time::{timeout, Duration};

    // Read headers first (look for \r\n\r\n)
    let mut header_buf = Vec::with_capacity(512);
    let mut found_end = false;

    let read_timeout = if is_last {
        Duration::from_secs(30)
    } else {
        Duration::from_secs(10)
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
                break; // Safety limit
            }
        }
        Ok::<(), anyhow::Error>(())
    }).await;

    match header_result {
        Ok(Ok(())) => {}
        Ok(Err(e)) => return Err(e),
        Err(_) => {
            // Timeout reading headers — for intermediate chunks this means empty response
            if !is_last {
                return Ok(Vec::new());
            }
            bail!("Timeout reading MEGA upload response headers");
        }
    }

    if !found_end {
        return Ok(Vec::new());
    }

    // Parse Content-Length from headers
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

    // Read body
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
