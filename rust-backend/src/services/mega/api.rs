/// Raw MEGA API calls via reqwest.
///
/// MEGA's API is a JSON-RPC style endpoint:
///   POST https://g.api.mega.co.nz/cs?id=<seq>&sid=<session_id>
/// Each request is a JSON array of command objects.
/// The response is a JSON array of results (or a negative integer error code).

use anyhow::{anyhow, bail, Result};
use aes::cipher::{BlockEncrypt, KeyInit};
use serde_json::{json, Value};
use tracing::debug;

const API_URL: &str = "https://g.api.mega.co.nz/cs";

/// Errors returned by the MEGA API as negative integers.
fn mega_error_message(code: i64) -> &'static str {
    match code {
        -1 => "EINTERNAL",
        -2 => "EARGS",
        -3 => "EAGAIN",
        -4 => "ERATELIMIT",
        -5 => "EFAILED",
        -6 => "ETOOMANY",
        -7 => "ERANGE",
        -8 => "EEXPIRED",
        -9 => "ENOENT",
        -10 => "ECIRCULAR",
        -11 => "EACCESS",
        -12 => "EEXIST",
        -13 => "EINCOMPLETE",
        -14 => "EKEY",
        -15 => "ESID",
        -16 => "EBLOCKED",
        -17 => "EOVERQUOTA",
        -18 => "ETEMPUNAVAIL",
        _ => "UNKNOWN",
    }
}

#[derive(Debug, Clone)]
pub struct MegaClient {
    client: reqwest::Client,
    /// Current session ID (set after login)
    pub sid: Option<String>,
    /// Sequence number for API requests
    seq: u64,
}

impl MegaClient {
    pub fn new(client: reqwest::Client) -> Self {
        use rand::Rng;
        let seq = rand::thread_rng().gen_range(100_000_000..999_999_999);
        Self {
            client,
            sid: None,
            seq,
        }
    }

    pub fn with_sid(client: reqwest::Client, sid: String) -> Self {
        let mut c = Self::new(client);
        c.sid = Some(sid);
        c
    }

    /// Build the request URL with the current sequence number.
    fn url(&mut self) -> String {
        self.seq += 1;
        if let Some(sid) = &self.sid {
            format!("{}?id={}&sid={}", API_URL, self.seq, sid)
        } else {
            format!("{}?id={}", API_URL, self.seq)
        }
    }

    /// Send a single command and return its result value.
    pub async fn call(&mut self, cmd: Value) -> Result<Value> {
        let url = self.url();
        let body = json!([cmd]);
        debug!("MEGA API → {}", body);

        let resp = self
            .client
            .post(&url)
            .json(&body)
            .send()
            .await?
            .json::<Value>()
            .await?;

        debug!("MEGA API ← {}", resp);

        // Response is always an array
        let arr = resp
            .as_array()
            .ok_or_else(|| anyhow!("MEGA response is not an array: {resp}"))?;

        let result = arr
            .first()
            .ok_or_else(|| anyhow!("MEGA response array is empty"))?;

        // Check for error code (negative integer)
        if let Some(code) = result.as_i64() {
            if code < 0 {
                bail!("MEGA API error {}: {}", code, mega_error_message(code));
            }
        }

        Ok(result.clone())
    }

    /// Login with email + password key (u value from prepare_key hash).
    /// Returns (session_id, encrypted_master_key, private_rsa_key_enc).
    pub async fn login(
        &mut self,
        email: &str,
        pw_key: &[u8; 16],
    ) -> Result<LoginResult> {

        let string_hash = compute_string_hash(email, pw_key)?;

        let result = self
            .call(json!({
                "a": "us",
                "user": email,
                "uh": string_hash
            }))
            .await?;

        let csid = result["csid"]
            .as_str()
            .ok_or_else(|| anyhow!("No csid in login response"))?
            .to_string();
        let privk = result["privk"]
            .as_str()
            .ok_or_else(|| anyhow!("No privk in login response"))?
            .to_string();
        let k = result["k"]
            .as_str()
            .ok_or_else(|| anyhow!("No k in login response"))?
            .to_string();

        Ok(LoginResult { csid, privk, k })
    }

    /// Fetch the user's file tree.
    pub async fn get_files(&mut self) -> Result<Value> {
        self.call(json!({"a": "f", "c": 1, "r": 1})).await
    }

    /// Create a new upload URL for a file of `size` bytes.
    /// Returns the upload URL string.
    pub async fn request_upload_url(&mut self, size: u64) -> Result<String> {
        let result = self.call(json!({"a": "u", "s": size})).await?;
        result["p"]
            .as_str()
            .map(|s| s.to_string())
            .ok_or_else(|| anyhow!("No upload URL in response"))
    }

    /// Complete a file upload.
    /// `upload_handle` is the handle returned by the upload PUT request.
    /// `parent_node` is the handle of the destination folder.
    /// `enc_key_b64` is the base64url-encoded encrypted file key (32 bytes).
    /// `file_attrs_b64` is the encrypted file attributes.
    pub async fn complete_upload(
        &mut self,
        upload_handle: &str,
        parent_node: &str,
        enc_key_b64: &str,
        file_attrs_b64: &str,
    ) -> Result<Value> {
        let cmd = json!({
            "a": "p",
            "t": parent_node,
            "n": [{
                "h": upload_handle,
                "t": 0,
                "a": file_attrs_b64,
                "k": enc_key_b64
            }]
        });
        tracing::info!("complete_upload request: {}", serde_json::to_string(&cmd).unwrap());
        self.call(cmd).await
    }

    /// Find or create a folder under the given parent node.
    /// Returns the handle of the folder.
    pub async fn mkdir(
        &mut self,
        parent_node: &str,
        folder_name: &str,
        master_key: &[u8; 16],
    ) -> Result<String> {
        use super::crypto::{aes_ecb_encrypt, b64_encode};
        use rand::RngCore;

        // Generate a random 16-byte folder key
        let mut folder_key = [0u8; 16];
        rand::thread_rng().fill_bytes(&mut folder_key);

        // Encrypt folder attributes: {"n":"folder_name"}
        let attrs = encrypt_attrs(folder_name, &folder_key)?;

        // Encrypt the folder key with the master key
        let enc_key = aes_ecb_encrypt(&folder_key, master_key)?;
        let enc_key_b64 = b64_encode(&enc_key);

        let result = self
            .call(json!({
                "a": "p",
                "t": parent_node,
                "n": [{
                    "h": "xxxxxxxx",
                    "t": 1,   // folder type
                    "a": attrs,
                    "k": enc_key_b64
                }]
            }))
            .await?;

        // The response contains the new node handle
        let handle = result["f"][0]["h"]
            .as_str()
            .ok_or_else(|| anyhow!("No handle in mkdir response"))?
            .to_string();

        Ok(handle)
    }
}

// ── Login result ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct LoginResult {
    /// Encrypted session ID (RSA-encrypted with user's private key)
    pub csid: String,
    /// Encrypted private RSA key
    pub privk: String,
    /// Encrypted master key (base64url)
    pub k: String,
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/// Compute the MEGA "stringhash" used in login.
/// This is an AES-128 CBC-MAC over the string, condensed to 8 bytes, base64url-encoded.
fn compute_string_hash(s: &str, key: &[u8; 16]) -> Result<String> {
    use super::crypto::b64_encode;
    use aes::cipher::BlockEncrypt;

    let s_lower = s.to_lowercase();
    let bytes = s_lower.as_bytes();

    // CBC-MAC: accumulate 16-byte blocks with XOR + AES encrypt
    let mut mac = [0u8; 16];
    let cipher = aes::Aes128::new_from_slice(key).map_err(|e| anyhow!("{e}"))?;

    let mut i = 0;
    while i < bytes.len() || i == 0 {
        for j in 0..16 {
            mac[j] ^= if i + j < bytes.len() { bytes[i + j] } else { 0 };
        }
        let mut block = aes::Block::clone_from_slice(&mac);
        cipher.encrypt_block(&mut block);
        mac.copy_from_slice(&block);
        if bytes.is_empty() {
            break;
        }
        i += 16;
        if i == 0 {
            break;
        }
    }

    // Condense 16 bytes → 8 bytes
    let mut condensed = [0u8; 8];
    for i in 0..4 {
        condensed[i] = mac[i] ^ mac[i + 4];
    }
    for i in 0..4 {
        condensed[i + 4] = mac[i + 8] ^ mac[i + 12];
    }

    Ok(b64_encode(&condensed))
}

/// Encrypt file/folder attributes as MEGA expects:
/// - plaintext: "MEGA{\"n\":\"filename\"}"
/// - padded to 16-byte boundary with zeros
/// - AES-128-CBC encrypted with zero IV
pub fn encrypt_attrs(name: &str, key: &[u8; 16]) -> Result<String> {
    use super::crypto::b64_encode;

    let raw = format!("MEGA{{\"n\":\"{}\"}}", name);
    let raw_bytes = raw.as_bytes();

    // Pad to 16-byte boundary
    let padded_len = ((raw_bytes.len() + 15) / 16) * 16;
    let mut padded = vec![0u8; padded_len];
    padded[..raw_bytes.len()].copy_from_slice(raw_bytes);

    // AES-128-CBC with zero IV
    let cipher = aes::Aes128::new_from_slice(key).map_err(|e| anyhow!("{e}"))?;
    let iv = [0u8; 16];
    let mut prev_block = iv;

    for chunk in padded.chunks_exact_mut(16) {
        for i in 0..16 {
            chunk[i] ^= prev_block[i];
        }
        let mut block = aes::Block::clone_from_slice(chunk);
        cipher.encrypt_block(&mut block);
        chunk.copy_from_slice(&block);
        prev_block.copy_from_slice(chunk);
    }

    Ok(b64_encode(&padded))
}
