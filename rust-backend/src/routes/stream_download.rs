use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::services::progress_store::Progress;
use crate::services::stream_url;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct StreamDownloadRequest {
    pub source_url: String,
    pub file_name: Option<String>,
    pub file_id: Option<Uuid>,
}

struct FileRecord {
    id: Uuid,
    guest_id: Option<Uuid>,
}

async fn upsert_file_download(
    pool: &sqlx::PgPool,
    file_id: Option<Uuid>,
    source_url: &str,
    location: &str,
    file_name: Option<&str>,
) -> anyhow::Result<FileRecord> {
    if let Some(id) = file_id {
        let row = sqlx::query(
            "SELECT id, guest_id FROM file_downloads WHERE id = $1 LIMIT 1",
        )
        .bind(id)
        .persistent(false)
        .fetch_optional(pool)
        .await?;

        if let Some(r) = row {
            return Ok(FileRecord {
                id: r.try_get("id")?,
                guest_id: r.try_get("guest_id")?,
            });
        }
    }

    let row = sqlx::query(
        "INSERT INTO file_downloads (source_url, location, file_name, download_type) \
         VALUES ($1, $2, $3, 'http') \
         RETURNING id, guest_id",
    )
    .bind(source_url)
    .bind(location)
    .bind(file_name)
    .persistent(false)
    .fetch_one(pool)
    .await?;

    Ok(FileRecord {
        id: row.try_get("id")?,
        guest_id: row.try_get("guest_id")?,
    })
}

// ── POST /api/stream-download/server ─────────────────────────────────────────

pub async fn server_download(
    State(state): State<AppState>,
    Json(body): Json<StreamDownloadRequest>,
) -> impl IntoResponse {
    // Upsert DB record first so frontend always gets a valid fileStatusId
    let record = upsert_file_download(
        &state.pool, body.file_id, &body.source_url, "server", body.file_name.as_deref(),
    ).await;

    let record = match record {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "details": e.to_string() }))).into_response(),
    };

    let id = record.id;

    if !state.server_download_enabled {
        let _ = sqlx::query(
            "UPDATE file_downloads SET status = 'failed', error_message = 'server download not available', updated_at = NOW() WHERE id = $1"
        )
        .bind(id)
        .execute(&state.pool)
        .await;
        state.progress.insert(id, Progress {
            downloaded_bytes: None,
            total_bytes: None,
            percent_fixed2: None,
            percent: None,
            done: true,
        });
        return (StatusCode::OK, Json(json!({
            "status": true,
            "message": "server download not available",
            "data": { "fileStatusId": id }
        }))).into_response();
    }

    if state.progress.contains_key(&id) {
        return (StatusCode::OK, Json(json!({
            "status": true,
            "message": "file download already started",
            "data": { "fileStatusId": id }
        }))).into_response();
    }

    state.progress.insert(id, Progress::initial());

    let (pool, progress, http) = (state.pool.clone(), state.progress.clone(), state.http.clone());
    let (url, file_name) = (body.source_url.clone(), body.file_name.clone());
    tokio::spawn(async move {
        stream_url::download_url_to_server(
            id, url, file_name, record.guest_id, pool, progress, http,
        ).await;
    });

    (StatusCode::OK, Json(json!({
        "status": true,
        "message": "message successful received",
        "data": { "fileStatusId": id }
    }))).into_response()
}

// ── POST /api/stream-download/mega ────────────────────────────────────────────

pub async fn mega_upload(
    State(state): State<AppState>,
    Json(body): Json<StreamDownloadRequest>,
) -> impl IntoResponse {
    if state.storage_provider != "mega" {
        return (StatusCode::SERVICE_UNAVAILABLE, Json(json!({
            "details": format!("Unsupported storage provider: {}", state.storage_provider)
        }))).into_response();
    }

    if let Some(id) = body.file_id {
        if state.progress.contains_key(&id) {
            return (StatusCode::OK, Json(json!({
                "status": true,
                "message": "file download already started",
                "data": { "fileStatusId": id }
            }))).into_response();
        }
    }

    let mega_state = { state.mega.read().await.clone() };
    let mega_state = match mega_state {
        Some(m) => m,
        None => return (StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({ "details": "MEGA not initialized" }))).into_response(),
    };

    let record = upsert_file_download(
        &state.pool, body.file_id, &body.source_url, "cloud", body.file_name.as_deref(),
    ).await;

    let record = match record {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "details": e.to_string() }))).into_response(),
    };

    let id = record.id;
    state.progress.insert(id, Progress::initial());

    let (pool, progress, http) = (state.pool.clone(), state.progress.clone(), state.http.clone());
    let (url, file_name) = (body.source_url.clone(), body.file_name.clone());
    tokio::spawn(async move {
        stream_url::stream_url_to_mega(
            id, url, file_name, record.guest_id, pool, progress, http, mega_state,
        ).await;
    });

    (StatusCode::OK, Json(json!({
        "status": true,
        "message": "message successful received",
        "data": { "fileStatusId": id }
    }))).into_response()
}
