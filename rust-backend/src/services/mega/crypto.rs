#![allow(dead_code, unused_imports, unused_variables, unused_mut)]
/// MEGA cryptography helpers.
///
/// MEGA uses a somewhat unusual key derivation scheme:
///   - The "password key" is derived from the password via repeated AES-128-ECB
///   - The account master key is then decrypted with the password key
///   - Session IDs are plain strings returned from the login API
///
/// References:
///   https://mega.nz/doc  (Mega SDK white paper)
///   megajs source

use aes::cipher::{BlockDecrypt, BlockEncrypt, KeyInit, KeyIvInit, StreamCipher};
use aes::Aes128;
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};

// ── base64url helpers ─────────────────────────────────────────────────────────

/// Decode MEGA-flavored base64url (no padding).
pub fn b64_decode(s: &str) -> Result<Vec<u8>> {
    URL_SAFE_NO_PAD
        .decode(s)
        .map_err(|e| anyhow!("base64 decode error: {e}"))
}

/// Encode to MEGA-flavored base64url (no padding).
pub fn b64_encode(data: &[u8]) -> String {
    URL_SAFE_NO_PAD.encode(data)
}

// ── password → key derivation ─────────────────────────────────────────────────

/// Derive the 16-byte AES key from a MEGA password.
/// This is a direct port of megajs `prepareKey`:
///   - Start with fixed pkey constant
///   - 65536 iterations of: for each 16-byte chunk of password, AES-ECB encrypt pkey
pub fn prepare_key(password: &str) -> [u8; 16] {
    let pw = password.as_bytes();

    // Fixed initial pkey (from megajs source)
    let mut pkey: [u8; 16] = [147, 196, 103, 227, 125, 176, 199, 164, 209, 190, 63, 129, 1, 82, 203, 86];

    for _ in 0..65536 {
        let mut j = 0;
        while j < pw.len() {
            // Build a 16-byte key from this password chunk
            let mut key = [0u8; 16];
            for i in (0..16).step_by(4) {
                if i + j < pw.len() {
                    let end = (i + j + 4).min(pw.len());
                    let len = end - (i + j);
                    key[i..i + len].copy_from_slice(&pw[i + j..end]);
                }
            }

            // AES-ECB encrypt pkey with this key
            let cipher = Aes128::new_from_slice(&key).unwrap();
            let mut block = aes::Block::clone_from_slice(&pkey);
            cipher.encrypt_block(&mut block);
            pkey.copy_from_slice(&block);

            j += 16;
        }
    }

    pkey
}

/// Decrypt the encrypted master key using the password-derived key.
/// `enc_master_key` is a base64url-encoded 16-byte AES-128-ECB ciphertext.
pub fn decrypt_master_key(enc_key_b64: &str, pw_key: &[u8; 16]) -> Result<[u8; 16]> {
    let enc = b64_decode(enc_key_b64)?;
    if enc.len() != 16 {
        return Err(anyhow!("Expected 16-byte encrypted key, got {}", enc.len()));
    }
    let cipher = Aes128::new_from_slice(pw_key).map_err(|e| anyhow!("AES init: {e}"))?;
    let mut block = aes::Block::clone_from_slice(&enc);
    cipher.decrypt_block(&mut block);
    let mut out = [0u8; 16];
    out.copy_from_slice(&block);
    Ok(out)
}

/// Decrypt an AES-128-ECB ciphertext using the given key.
pub fn aes_ecb_decrypt(ciphertext: &[u8], key: &[u8; 16]) -> Result<Vec<u8>> {
    if ciphertext.len() % 16 != 0 {
        return Err(anyhow!("Ciphertext length not multiple of 16"));
    }
    let cipher = Aes128::new_from_slice(key).map_err(|e| anyhow!("AES init: {e}"))?;
    let mut out = ciphertext.to_vec();
    for chunk in out.chunks_exact_mut(16) {
        let mut block = aes::Block::clone_from_slice(chunk);
        cipher.decrypt_block(&mut block);
        chunk.copy_from_slice(&block);
    }
    Ok(out)
}

/// Encrypt an AES-128-ECB plaintext using the given key.
pub fn aes_ecb_encrypt(plaintext: &[u8], key: &[u8; 16]) -> Result<Vec<u8>> {
    if plaintext.len() % 16 != 0 {
        return Err(anyhow!("Plaintext length not multiple of 16"));
    }
    let cipher = Aes128::new_from_slice(key).map_err(|e| anyhow!("AES init: {e}"))?;
    let mut out = plaintext.to_vec();
    for chunk in out.chunks_exact_mut(16) {
        let mut block = aes::Block::clone_from_slice(chunk);
        cipher.encrypt_block(&mut block);
        chunk.copy_from_slice(&block);
    }
    Ok(out)
}

// ── MEGA CBC-MAC / file key helpers ───────────────────────────────────────────

/// Decrypt a MEGA file key using the account master key.
/// MEGA file keys are 32 bytes (for regular files): first 16 = AES key XOR'd with nonce,
/// last 16 = meta-MAC.
pub fn decrypt_file_key(enc_key_b64: &str, master_key: &[u8; 16]) -> Result<Vec<u8>> {
    let enc = b64_decode(enc_key_b64)?;
    aes_ecb_decrypt(&enc, master_key)
}

// ── AES-128-CTR for upload encryption ────────────────────────────────────────

/// Encrypt a chunk of data with AES-128-CTR.
/// MEGA uses AES-CTR with a specific counter layout:
///   counter[0..8]  = nonce (8 bytes, from file key)
///   counter[8..16] = block counter (big-endian u64, increments per 16-byte block)
pub fn aes_ctr_encrypt(data: &[u8], key: &[u8; 16], nonce: &[u8; 8], start_pos: u64) -> Vec<u8> {
    use ctr::Ctr128BE;

    // Build the full 16-byte IV: nonce || block_counter
    let block_offset = start_pos / 16;
    let mut iv = [0u8; 16];
    iv[..8].copy_from_slice(nonce);
    iv[8..].copy_from_slice(&block_offset.to_be_bytes());

    let mut cipher = <Ctr128BE<Aes128>>::new(key.into(), &iv.into());
    let mut out = data.to_vec();
    cipher.apply_keystream(&mut out);
    out
}

// ── Utility conversions ───────────────────────────────────────────────────────

// (helpers u32s_to_bytes and bytes_to_u32s removed — not needed anymore)

// ── MAC computation for MEGA upload completion ────────────────────────────────

/// Compute the condensed MAC that MEGA requires in the completion request.
/// This is a CBC-MAC over 16-byte blocks using the file key.
pub fn compute_mac(data: &[u8], key: &[u8; 16], nonce: &[u8; 8]) -> [u8; 16] {
    use aes::cipher::BlockEncrypt;
    let cipher = Aes128::new_from_slice(key).unwrap();

    let mut mac = [0u8; 16];
    // Set MAC init to nonce || nonce
    mac[..8].copy_from_slice(nonce);
    mac[8..].copy_from_slice(nonce);

    for chunk in data.chunks(16) {
        let mut block_data = [0u8; 16];
        let len = chunk.len().min(16);
        block_data[..len].copy_from_slice(&chunk[..len]);

        // XOR with current MAC
        for i in 0..16 {
            mac[i] ^= block_data[i];
        }
        let mut block = aes::Block::clone_from_slice(&mac);
        cipher.encrypt_block(&mut block);
        mac.copy_from_slice(&block);
    }
    mac
}

/// Condense a 16-byte MAC into the 8-byte "meta MAC" MEGA uses.
pub fn condense_mac(mac: &[u8; 16]) -> [u8; 8] {
    let mut out = [0u8; 8];
    for i in 0..4 {
        out[i] = mac[i] ^ mac[i + 4];
    }
    for i in 0..4 {
        out[i + 4] = mac[i + 8] ^ mac[i + 12];
    }
    out
}
