/// MEGA session management — geo-pinned, DB-backed.

use anyhow::{anyhow, bail, Context, Result};
use aes::cipher::{BlockDecrypt, KeyInit};
use serde::{Deserialize, Serialize};
use sqlx::PgPool;
use std::sync::Arc;
use tokio::sync::RwLock;
use tracing::{info, warn};
use uuid::Uuid;

use super::api::MegaClient;
use super::crypto::decrypt_master_key;
use crate::db::models::MegaSession;
use crate::utils::ip_geo::{get_current_ip_info, IpInfo};

// ── Session data stored in mega_sessions.session_data (JSON) ─────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SessionData {
    pub sid: String,
    pub key: String,
    pub name: Option<String>,
    pub user: Option<String>,
    pub root: Option<String>,
    #[serde(skip)]
    pub master_key: Option<[u8; 16]>,
}

// ── Shared MEGA state ─────────────────────────────────────────────────────────

#[derive(Debug, Clone)]
pub struct MegaState {
    pub client: MegaClient,
    pub session: SessionData,
    pub root_handle: String,
    pub master_key: [u8; 16],
}

pub type SharedMegaState = Arc<RwLock<Option<MegaState>>>;

pub fn new_shared_state() -> SharedMegaState {
    Arc::new(RwLock::new(None))
}

// ── Manager ───────────────────────────────────────────────────────────────────

pub struct MegaManager {
    pool: PgPool,
    http: reqwest::Client,
    email: String,
    password: String,
}

impl MegaManager {
    pub fn new(pool: PgPool, http: reqwest::Client, email: String, password: String) -> Self {
        Self { pool, http, email, password }
    }

    pub async fn init(&self) -> Result<MegaState> {
        let ip_info = get_current_ip_info(&self.http).await;
        info!("Current IP info: {:?}", ip_info);

        let db_session = self.find_session(ip_info.as_ref()).await?;

        if let Some(session_row) = db_session {
            info!("Restoring MEGA session from DB (id={})", session_row.id);
            match self.restore_session(&session_row).await {
                Ok(state) => {
                    info!("MEGA session restored ✅");
                    return Ok(state);
                }
                Err(e) => {
                    warn!("Failed to restore session: {e} — logging in fresh");
                    self.invalidate_session(session_row.id).await?;
                }
            }
        }

        info!("Logging into MEGA...");
        let state = self.fresh_login(ip_info.as_ref()).await?;
        info!(
            "MEGA login successful ✅ (country={})",
            ip_info.as_ref().map(|i| i.country.as_str()).unwrap_or("unknown")
        );
        Ok(state)
    }

    async fn find_session(&self, ip_info: Option<&IpInfo>) -> Result<Option<MegaSession>> {
        use sqlx::Row;

        // Try country-match first
        if let Some(info) = ip_info {
            let row = sqlx::query(
                "SELECT id, email, session_data, country, ip_address, worker_id, \
                 is_active, created_at, updated_at \
                 FROM mega_sessions \
                 WHERE email = $1 AND country = $2 AND is_active = true \
                 LIMIT 1",
            )
            .bind(&self.email)
            .bind(&info.country)
            .persistent(false)
            .fetch_optional(&self.pool)
            .await?;

            if let Some(r) = row {
                let session = MegaSession {
                    id: r.try_get("id")?,
                    email: r.try_get("email")?,
                    session_data: r.try_get("session_data")?,
                    country: r.try_get("country")?,
                    ip_address: r.try_get("ip_address")?,
                    worker_id: r.try_get("worker_id")?,
                    is_active: r.try_get("is_active")?,
                    created_at: r.try_get("created_at")?,
                    updated_at: r.try_get("updated_at")?,
                };
                return Ok(Some(session));
            }
        }

        // Fallback: any active session for this email
        let row = sqlx::query(
            "SELECT id, email, session_data, country, ip_address, worker_id, \
             is_active, created_at, updated_at \
             FROM mega_sessions \
             WHERE email = $1 AND is_active = true \
             LIMIT 1",
        )
        .bind(&self.email)
        .persistent(false)
        .fetch_optional(&self.pool)
        .await?;

        let session = match row {
            Some(r) => MegaSession {
                id: r.try_get("id")?,
                email: r.try_get("email")?,
                session_data: r.try_get("session_data")?,
                country: r.try_get("country")?,
                ip_address: r.try_get("ip_address")?,
                worker_id: r.try_get("worker_id")?,
                is_active: r.try_get("is_active")?,
                created_at: r.try_get("created_at")?,
                updated_at: r.try_get("updated_at")?,
            },
            None => return Ok(None),
        };

        // Note: Don't reject on country mismatch — reuse existing session
        // regardless of IP country. MEGA blocks accounts that create too many sessions.
        // The Express backend also reuses sessions across countries.

        Ok(Some(session))
    }

    async fn restore_session(&self, row: &MegaSession) -> Result<MegaState> {
        let data_str = row.session_data.as_deref()
            .ok_or_else(|| anyhow!("session_data is null"))?;

        let mut session: SessionData =
            serde_json::from_str(data_str).context("deserialize session_data")?;

        // The stored session.key is the DECRYPTED master key (base64url-encoded)
        // megajs toJSON() stores it already decrypted — do NOT decrypt again
        use super::crypto::b64_decode;
        let key_bytes = b64_decode(&session.key)?;
        if key_bytes.len() != 16 {
            bail!("Expected 16-byte master key, got {} bytes", key_bytes.len());
        }
        let mut master_key = [0u8; 16];
        master_key.copy_from_slice(&key_bytes);
        session.master_key = Some(master_key);

        let mut mega_client = MegaClient::with_sid(self.http.clone(), session.sid.clone());
        let files = mega_client.get_files().await.context("validate session")?;
        let root_handle = extract_root_handle(&files)?;

        Ok(MegaState { client: mega_client, session, root_handle, master_key })
    }

    async fn fresh_login(&self, ip_info: Option<&IpInfo>) -> Result<MegaState> {
        let mut mega_client = MegaClient::new(self.http.clone());
        let login_result = mega_client.login(&self.email, &self.password).await?;

        let master_key = decrypt_master_key(&login_result.k, &login_result.pw_key)?;
        let sid = decrypt_session_id(&login_result.csid, &login_result.privk, &master_key)?;
        mega_client.sid = Some(sid.clone());

        let files = mega_client.get_files().await?;
        let root_handle = extract_root_handle(&files)?;

        let session = SessionData {
            sid,
            key: login_result.k,
            name: None,
            user: None,
            root: Some(root_handle.clone()),
            master_key: Some(master_key),
        };

        self.save_session(&session, ip_info).await?;

        Ok(MegaState { client: mega_client, session, root_handle, master_key })
    }

    async fn save_session(&self, session: &SessionData, ip_info: Option<&IpInfo>) -> Result<()> {
        let session_json = serde_json::to_string(session)?;
        let country = ip_info.map(|i| i.country.clone());
        let ip = ip_info.map(|i| i.ip.clone());

        // Check for existing to upsert
        let existing: Option<Uuid> = match &country {
            Some(c) => sqlx::query_scalar(
                "SELECT id FROM mega_sessions WHERE email = $1 AND country = $2 LIMIT 1",
            )
            .bind(&self.email)
            .bind(c)
            .persistent(false)
            .fetch_optional(&self.pool)
            .await?,
            None => sqlx::query_scalar(
                "SELECT id FROM mega_sessions WHERE email = $1 LIMIT 1",
            )
            .bind(&self.email)
            .persistent(false)
            .fetch_optional(&self.pool)
            .await?,
        };

        if let Some(id) = existing {
            sqlx::query(
                "UPDATE mega_sessions \
                 SET session_data = $1, country = $2, ip_address = $3, \
                     is_active = true, updated_at = NOW() \
                 WHERE id = $4",
            )
            .bind(&session_json)
            .bind(&country)
            .bind(&ip)
            .bind(id)
            .persistent(false)
            .execute(&self.pool)
            .await?;
        } else {
            sqlx::query(
                "INSERT INTO mega_sessions \
                 (email, session_data, country, ip_address, is_active) \
                 VALUES ($1, $2, $3, $4, true)",
            )
            .bind(&self.email)
            .bind(&session_json)
            .bind(&country)
            .bind(&ip)
            .persistent(false)
            .execute(&self.pool)
            .await?;
        }

        info!("MEGA session saved (country={})", country.as_deref().unwrap_or("unknown"));
        Ok(())
    }

    async fn invalidate_session(&self, id: Uuid) -> Result<()> {
        sqlx::query(
            "UPDATE mega_sessions SET is_active = false, updated_at = NOW() WHERE id = $1",
        )
        .bind(id)
        .persistent(false)
        .execute(&self.pool)
        .await?;
        Ok(())
    }
}

// ── File tree helpers ─────────────────────────────────────────────────────────

fn extract_root_handle(files_resp: &serde_json::Value) -> Result<String> {
    let nodes = files_resp["f"]
        .as_array()
        .ok_or_else(|| anyhow!("No 'f' array in files response"))?;
    for node in nodes {
        if node["t"].as_i64() == Some(2) {
            if let Some(h) = node["h"].as_str() {
                return Ok(h.to_string());
            }
        }
    }
    Err(anyhow!("Root node (type 2) not found in file tree"))
}

pub fn find_child_node(
    files_resp: &serde_json::Value,
    parent_handle: &str,
    name: &str,
    master_key: &[u8; 16],
) -> Option<String> {
    let nodes = files_resp["f"].as_array()?;
    for node in nodes {
        if node["p"].as_str() == Some(parent_handle) {
            if let (Some(a), Some(k)) = (node["a"].as_str(), node["k"].as_str()) {
                let key_part = k.split(':').nth(1).unwrap_or(k);
                if let Ok(n) = decrypt_node_name(a, key_part, master_key) {
                    if n == name {
                        return node["h"].as_str().map(|s| s.to_string());
                    }
                }
            }
        }
    }
    None
}

fn decrypt_node_name(attrs_b64: &str, key_b64: &str, master_key: &[u8; 16]) -> Result<String> {
    use super::crypto::{aes_ecb_decrypt, b64_decode};

    let enc_key = b64_decode(key_b64)?;
    if enc_key.len() < 16 { bail!("Node key too short"); }
    let node_key = aes_ecb_decrypt(&enc_key[..16], master_key)?;
    let node_key_16: [u8; 16] = node_key[..16].try_into()?;

    let enc_attrs = b64_decode(attrs_b64)?;
    let cipher = aes::Aes128::new_from_slice(&node_key_16).map_err(|e| anyhow!("{e}"))?;

    let mut dec = enc_attrs.clone();
    let mut prev = [0u8; 16];
    for chunk in dec.chunks_exact_mut(16) {
        let ct = chunk.to_vec();
        let mut block = aes::Block::clone_from_slice(chunk);
        cipher.decrypt_block(&mut block);
        for i in 0..16 { chunk[i] = block[i] ^ prev[i]; }
        prev.copy_from_slice(&ct);
    }

    let end = dec.iter().position(|&b| b == 0).unwrap_or(dec.len());
    let text = String::from_utf8_lossy(&dec[..end]).to_string();
    let json_str = text.trim_start_matches("MEGA");
    let obj: serde_json::Value = serde_json::from_str(json_str)?;
    obj["n"].as_str().map(|s| s.to_string())
        .ok_or_else(|| anyhow!("No 'n' in node attrs"))
}

// ── RSA session ID decryption ─────────────────────────────────────────────────

fn decrypt_session_id(csid_b64: &str, privk_b64: &str, master_key: &[u8; 16]) -> Result<String> {
    use super::crypto::{aes_ecb_decrypt, b64_decode, b64_encode};
    use num_bigint::BigUint;

    let enc_privk = b64_decode(privk_b64)?;
    let privk_bytes = aes_ecb_decrypt(&enc_privk, master_key)?;

    let (p, rest) = read_mpi(&privk_bytes)?;
    let (q, rest) = read_mpi(&rest)?;
    let (d, _) = read_mpi(&rest)?;
    let n = &p * &q;

    let csid_bytes = b64_decode(csid_b64)?;
    let csid_int = if csid_bytes.len() > 2 {
        let bit_len = u16::from_be_bytes([csid_bytes[0], csid_bytes[1]]) as usize;
        let byte_len = (bit_len + 7) / 8;
        BigUint::from_bytes_be(&csid_bytes[2..2 + byte_len])
    } else {
        BigUint::from_bytes_be(&csid_bytes)
    };

    let sid_int = csid_int.modpow(&d, &n);
    let sid_bytes = sid_int.to_bytes_be();
    let sid_len = sid_bytes.len().min(43);
    Ok(b64_encode(&sid_bytes[..sid_len]))
}

fn read_mpi(data: &[u8]) -> Result<(num_bigint::BigUint, Vec<u8>)> {
    if data.len() < 2 { bail!("Not enough data for MPI"); }
    let bit_len = u16::from_be_bytes([data[0], data[1]]) as usize;
    let byte_len = (bit_len + 7) / 8;
    if data.len() < 2 + byte_len { bail!("MPI data truncated"); }
    let n = num_bigint::BigUint::from_bytes_be(&data[2..2 + byte_len]);
    Ok((n, data[2 + byte_len..].to_vec()))
}
