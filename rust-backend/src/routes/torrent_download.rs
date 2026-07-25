use axum::{extract::State, http::StatusCode, response::IntoResponse, Json};
use serde::Deserialize;
use serde_json::json;
use sqlx::Row;
use uuid::Uuid;

use crate::services::progress_store::Progress;
use crate::services::torrent::metadata::fetch_metadata;
use crate::services::torrent::magnet::MagnetLink;
use crate::services::torrent::pipeline;
use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct TorrentRequest {
    pub magnet_link: String,
    pub file_name: Option<String>,
    pub file_id: Option<Uuid>,
    pub file_indices: Option<Vec<usize>>,
}

fn validate_magnet(magnet: &str) -> Option<axum::response::Response> {
    if magnet.is_empty() {
        return Some((StatusCode::BAD_REQUEST,
            Json(json!({ "status": false, "message": "magnet_link is required" }))).into_response());
    }
    if !magnet.starts_with("magnet:?") {
        return Some((StatusCode::BAD_REQUEST,
            Json(json!({ "status": false, "message": "Invalid magnet link format" }))).into_response());
    }
    None
}

struct TorrentRecord {
    id: Uuid,
    guest_id: Option<Uuid>,
    file_name: Option<String>,
    file_size: Option<i64>,
}

async fn upsert_torrent_record(
    pool: &sqlx::PgPool,
    file_id: Option<Uuid>,
    magnet_link: &str,
    location: &str,
    file_name: Option<&str>,
    file_indices: Option<&[usize]>,
) -> anyhow::Result<TorrentRecord> {
    if let Some(id) = file_id {
        let row = sqlx::query(
            "SELECT id, guest_id, file_name, file_size \
             FROM file_downloads WHERE id = $1 LIMIT 1",
        )
        .bind(id)
        .persistent(false)
        .fetch_optional(pool)
        .await?;

        if let Some(r) = row {
            return Ok(TorrentRecord {
                id: r.try_get("id")?,
                guest_id: r.try_get("guest_id")?,
                file_name: r.try_get("file_name")?,
                file_size: r.try_get("file_size")?,
            });
        }
    }

    let indices_json = file_indices.map(|i| serde_json::to_string(i).unwrap());
    let row = sqlx::query(
        "INSERT INTO file_downloads \
             (source_url, location, file_name, download_type, selected_file_indices) \
         VALUES ($1, $2, $3, 'torrent', $4) \
         RETURNING id, guest_id, file_name, file_size",
    )
    .bind(magnet_link)
    .bind(location)
    .bind(file_name)
    .bind(indices_json)
    .persistent(false)
    .fetch_one(pool)
    .await?;

    Ok(TorrentRecord {
        id: row.try_get("id")?,
        guest_id: row.try_get("guest_id")?,
        file_name: row.try_get("file_name")?,
        file_size: row.try_get("file_size")?,
    })
}

// ── POST /api/torrent-download/metadata ──────────────────────────────────────

pub async fn get_metadata(Json(body): Json<TorrentRequest>) -> impl IntoResponse {
    if let Some(r) = validate_magnet(&body.magnet_link) { return r; }

    let magnet = match MagnetLink::parse(&body.magnet_link) {
        Ok(m) => m,
        Err(e) => return (StatusCode::BAD_REQUEST,
            Json(json!({ "status": false, "message": e.to_string() }))).into_response(),
    };

    match tokio::time::timeout(
        std::time::Duration::from_secs(30),
        fetch_metadata(&magnet),
    ).await {
        Ok(Ok(meta)) => (StatusCode::OK, Json(json!({
            "status": true,
            "message": "Metadata fetched successfully",
            "data": meta
        }))).into_response(),
        Ok(Err(e)) => (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({
            "status": false,
            "message": "Failed to fetch metadata",
            "details": e.to_string()
        }))).into_response(),
        Err(_) => (StatusCode::REQUEST_TIMEOUT, Json(json!({
            "status": false,
            "message": "Timeout: Could not fetch metadata. Torrent may be dead or have no seeders."
        }))).into_response(),
    }
}

// ── POST /api/torrent-download/server ────────────────────────────────────────

pub async fn server_download(
    State(state): State<AppState>,
    Json(body): Json<TorrentRequest>,
) -> impl IntoResponse {
    if let Some(r) = validate_magnet(&body.magnet_link) { return r; }

    if let Some(id) = body.file_id {
        if state.progress.contains_key(&id) {
            return (StatusCode::OK, Json(json!({
                "status": true,
                "message": "torrent download already started",
                "data": { "fileStatusId": id }
            }))).into_response();
        }
    }

    let record = upsert_torrent_record(
        &state.pool, body.file_id, &body.magnet_link, "server",
        body.file_name.as_deref(), body.file_indices.as_deref(),
    ).await;

    let record = match record {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "details": e.to_string() }))).into_response(),
    };

    let id = record.id;
    state.progress.insert(id, Progress {
        downloaded_bytes: Some(0),
        total_bytes: record.file_size.map(|s| s as u64),
        percent_fixed2: None, percent: None, done: false,
    });

    let (pool, progress, http) = (state.pool.clone(), state.progress.clone(), state.http.clone());
    let file_name = record.file_name.or(body.file_name.clone());
    let (magnet, indices) = (body.magnet_link.clone(), body.file_indices.clone());
    tokio::spawn(async move {
        pipeline::download_torrent_to_server(
            id, magnet, file_name, indices, record.guest_id, pool, progress, http,
        ).await;
    });

    (StatusCode::OK, Json(json!({
        "status": true,
        "message": "torrent download started successfully",
        "data": { "fileStatusId": id }
    }))).into_response()
}

// ── POST /api/torrent-download/mega ──────────────────────────────────────────

pub async fn mega_upload(
    State(state): State<AppState>,
    Json(body): Json<TorrentRequest>,
) -> impl IntoResponse {
    if let Some(r) = validate_magnet(&body.magnet_link) { return r; }

    if let Some(id) = body.file_id {
        if state.progress.contains_key(&id) {
            return (StatusCode::OK, Json(json!({
                "status": true,
                "message": "torrent download already started",
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

    let record = upsert_torrent_record(
        &state.pool, body.file_id, &body.magnet_link, "mega",
        body.file_name.as_deref(), body.file_indices.as_deref(),
    ).await;

    let record = match record {
        Ok(r) => r,
        Err(e) => return (StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "details": e.to_string() }))).into_response(),
    };

    let id = record.id;
    state.progress.insert(id, Progress {
        downloaded_bytes: Some(0),
        total_bytes: record.file_size.map(|s| s as u64),
        percent_fixed2: None, percent: None, done: false,
    });

    let (pool, progress, http) = (state.pool.clone(), state.progress.clone(), state.http.clone());
    let file_name = record.file_name.or(body.file_name.clone());
    let (magnet, indices) = (body.magnet_link.clone(), body.file_indices.clone());
    tokio::spawn(async move {
        pipeline::stream_torrent_to_mega(
            id, magnet, file_name, indices, record.guest_id,
            pool, progress, http, mega_state,
        ).await;
    });

    (StatusCode::OK, Json(json!({
        "status": true,
        "message": "torrent to MEGA upload started successfully",
        "data": { "fileStatusId": id }
    }))).into_response()
}
