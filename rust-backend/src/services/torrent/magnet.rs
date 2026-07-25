/// Parse magnet links into their component parts.
///
/// Magnet URI format:
///   magnet:?xt=urn:btih:<info_hash>&dn=<name>&tr=<tracker_url>&...

use anyhow::{bail, Result};

#[derive(Debug, Clone)]
pub struct MagnetLink {
    /// 20-byte SHA-1 info hash
    pub info_hash: [u8; 20],
    /// Info hash as hex string
    pub info_hash_hex: String,
    /// Display name (dn parameter)
    pub name: Option<String>,
    /// Tracker announce URLs (tr parameters)
    pub trackers: Vec<String>,
}

impl MagnetLink {
    pub fn parse(magnet: &str) -> Result<Self> {
        if !magnet.starts_with("magnet:?") {
            bail!("Not a magnet link");
        }

        let query = &magnet["magnet:?".len()..];
        let mut info_hash_hex: Option<String> = None;
        let mut name: Option<String> = None;
        let mut trackers = Vec::new();

        for param in query.split('&') {
            let (key, value) = match param.split_once('=') {
                Some(kv) => kv,
                None => continue,
            };
            let value = urlencoding_decode(value);

            match key {
                "xt" => {
                    // xt=urn:btih:<hash> (hex or base32)
                    if let Some(hash) = value.strip_prefix("urn:btih:") {
                        info_hash_hex = Some(normalize_info_hash(hash)?);
                    }
                }
                "dn" => {
                    name = Some(value);
                }
                "tr" => {
                    trackers.push(value);
                }
                _ => {}
            }
        }

        let hex = info_hash_hex.ok_or_else(|| anyhow::anyhow!("No xt=urn:btih in magnet link"))?;
        let info_hash = hex_to_20_bytes(&hex)?;

        Ok(Self {
            info_hash,
            info_hash_hex: hex,
            name,
            trackers,
        })
    }
}

/// Normalize info hash: if it's 32 chars it may be base32, convert to hex.
fn normalize_info_hash(hash: &str) -> Result<String> {
    match hash.len() {
        40 => Ok(hash.to_lowercase()), // already hex
        32 => {
            // base32 encoded — decode to 20 bytes then hex
            let upper = hash.to_uppercase();
            let bytes = base32_decode(&upper)?;
            Ok(hex::encode(bytes))
        }
        _ => bail!("Unknown info hash format (len={}): {}", hash.len(), hash),
    }
}

fn hex_to_20_bytes(s: &str) -> Result<[u8; 20]> {
    let bytes = hex::decode(s)?;
    if bytes.len() != 20 {
        bail!("Info hash must be 20 bytes, got {}", bytes.len());
    }
    let mut out = [0u8; 20];
    out.copy_from_slice(&bytes);
    Ok(out)
}

/// Minimal URL percent-decoding.
fn urlencoding_decode(s: &str) -> String {
    // Replace + with space, then percent-decode
    let s = s.replace('+', " ");
    let mut out = String::with_capacity(s.len());
    let _chars = s.chars().peekable();
    let bytes = s.as_bytes();
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(
                std::str::from_utf8(&bytes[i + 1..i + 3]).unwrap_or(""),
                16,
            ) {
                out.push(b as char);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i] as char);
        i += 1;
    }
    out
}

/// Minimal base32 decode (RFC 4648 alphabet, no padding required).
fn base32_decode(s: &str) -> Result<Vec<u8>> {
    const ALPHA: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
    let mut bits: u64 = 0;
    let mut bit_count = 0u32;
    let mut out = Vec::new();

    for &c in s.as_bytes() {
        if c == b'=' {
            break;
        }
        let val = ALPHA.iter().position(|&a| a == c)
            .ok_or_else(|| anyhow::anyhow!("Invalid base32 char: {}", c as char))? as u64;
        bits = (bits << 5) | val;
        bit_count += 5;
        if bit_count >= 8 {
            bit_count -= 8;
            out.push(((bits >> bit_count) & 0xFF) as u8);
        }
    }

    Ok(out)
}
