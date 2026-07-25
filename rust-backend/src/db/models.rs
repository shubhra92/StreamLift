use chrono::NaiveDateTime;
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

// ── guests ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Guest {
    pub id: Uuid,
    pub token: String,
    pub ip_address: Option<String>,
    pub user_agent: Option<String>,
    pub is_active: Option<bool>,
    pub last_seen_at: Option<NaiveDateTime>,
    pub created_at: Option<NaiveDateTime>,
    pub expires_at: NaiveDateTime,
}

// ── mega_sessions ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct MegaSession {
    pub id: Uuid,
    pub email: String,
    pub session_data: Option<String>,
    pub country: Option<String>,
    pub ip_address: Option<String>,
    pub worker_id: Option<Uuid>,
    pub is_active: Option<bool>,
    pub created_at: Option<NaiveDateTime>,
    pub updated_at: Option<NaiveDateTime>,
}

// ── workers ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct Worker {
    pub id: Uuid,
    pub guest_id: Option<Uuid>,
    pub name: String,
    pub download_location: String,
    pub compute_type: String,
    pub mega_email: Option<String>,
    pub mega_password: Option<String>,
    pub auth_token: String,
    pub version: Option<String>,
    pub total_downloads: Option<i32>,
    pub total_bytes: Option<i64>,
    pub total_uptime: Option<i32>,
    pub created_at: Option<NaiveDateTime>,
    pub updated_at: Option<NaiveDateTime>,
}

// ── file_downloads ────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize, FromRow)]
pub struct FileDownload {
    pub id: Uuid,
    pub guest_id: Option<Uuid>,
    pub session_id: Option<Uuid>,
    pub worker_id: Option<Uuid>,
    pub file_name: Option<String>,
    pub source_url: String,
    pub location: Option<String>,
    pub location_path: Option<String>,
    pub file_size: Option<i64>,
    pub file_type: Option<String>,
    pub status: Option<String>,
    pub error_message: Option<String>,
    pub download_type: Option<String>,
    pub selected_file_indices: Option<String>,
    pub created_at: Option<NaiveDateTime>,
    pub updated_at: Option<NaiveDateTime>,
}

// ── Insert / update helpers ───────────────────────────────────────────────────

#[derive(Debug, Default)]
pub struct NewFileDownload {
    pub guest_id: Option<Uuid>,
    pub source_url: String,
    pub location: Option<String>,
    pub file_name: Option<String>,
    pub download_type: Option<String>,
    pub selected_file_indices: Option<String>,
}
