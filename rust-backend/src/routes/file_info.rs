use std::time::Duration;

use axum::{
    extract::{Query, State},
    http::StatusCode,
    response::IntoResponse,
    Json,
};
use serde::Deserialize;
use serde_json::json;

use crate::AppState;

#[derive(Debug, Deserialize)]
pub struct FileInfoQuery {
    pub url: String,
}

// ── MIME → extension ──────────────────────────────────────────────────────────

fn ext_from_mime(mime: &str) -> Option<&'static str> {
    let base = mime.split(';').next()?.trim().to_lowercase();
    match base.as_str() {
        "video/mp4" => Some("mp4"),
        "video/x-matroska" => Some("mkv"),
        "video/webm" => Some("webm"),
        "video/avi" | "video/x-msvideo" => Some("avi"),
        "video/quicktime" => Some("mov"),
        "audio/mpeg" => Some("mp3"),
        "audio/mp4" => Some("m4a"),
        "audio/ogg" => Some("ogg"),
        "audio/flac" => Some("flac"),
        "audio/wav" => Some("wav"),
        "application/zip" => Some("zip"),
        "application/x-rar-compressed" => Some("rar"),
        "application/x-7z-compressed" => Some("7z"),
        "application/pdf" => Some("pdf"),
        "image/jpeg" => Some("jpg"),
        "image/png" => Some("png"),
        "image/gif" => Some("gif"),
        "image/webp" => Some("webp"),
        _ => None,
    }
}

// ── Content-Disposition parser ────────────────────────────────────────────────

fn parse_content_disposition(header: &str) -> Option<String> {
    // filename*=UTF-8''...
    if let Some(pos) = header.find("filename*=UTF-8''") {
        let val = &header[pos + "filename*=UTF-8''".len()..];
        let val = val.split(';').next()?.trim();
        return Some(urlencoding::decode(val).ok()?.into_owned());
    }
    // filename="..."
    if let Some(start) = header.find("filename=\"") {
        let rest = &header[start + "filename=\"".len()..];
        let end = rest.find('"')?;
        return Some(rest[..end].to_string());
    }
    // filename=...
    if let Some(start) = header.find("filename=") {
        let rest = &header[start + "filename=".len()..];
        let val = rest.split(';').next()?.trim();
        return Some(val.to_string());
    }
    None
}

// ── Filename from URL ────────────────────────────────────────────────────────

fn filename_from_url(raw_url: &str) -> Option<String> {
    let parsed = url::Url::parse(raw_url).ok()?;
    let last = parsed.path_segments()?.filter(|s| !s.is_empty()).next_back()?;
    Some(urlencoding::decode(last).ok()?.into_owned())
}

// ── GET /api/file-info ───────────────────────────────────────────────────────

pub async fn get_file_info(
    State(state): State<AppState>,
    Query(query): Query<FileInfoQuery>,
) -> impl IntoResponse {
    let url = &query.url;

    // Validate URL
    let parsed_url = match url::Url::parse(url) {
        Ok(u) => u,
        Err(_) => {
            return (StatusCode::BAD_REQUEST, Json(json!({ "error": "Invalid URL" })))
                .into_response()
        }
    };
    if parsed_url.scheme() != "http" && parsed_url.scheme() != "https" {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({ "error": "Only http/https URLs are supported" })),
        )
            .into_response();
    }

    // Try HEAD first, fall back to GET with Range: bytes=0-0
    let timeout = Duration::from_secs(10);

    let response = {
        let req = state
            .http
            .head(url)
            .header("User-Agent", "Mozilla/5.0 (compatible; StreamLift/1.0)")
            .header("Accept", "*/*")
            .timeout(timeout);

        match req.send().await {
            Ok(r) if r.status().is_success() => Some(r),
            _ => {
                // Fallback: GET with Range
                let req2 = state
                    .http
                    .get(url)
                    .header("User-Agent", "Mozilla/5.0 (compatible; StreamLift/1.0)")
                    .header("Accept", "*/*")
                    .header("Range", "bytes=0-0")
                    .timeout(timeout);
                match req2.send().await {
                    Ok(r) => {
                        if r.status().is_success() || r.status() == StatusCode::PARTIAL_CONTENT {
                            Some(r)
                        } else {
                            None
                        }
                    }
                    Err(_) => None,
                }
            }
        }
    };

    let response = match response {
        Some(r) => r,
        None => {
            return (
                StatusCode::BAD_GATEWAY,
                Json(json!({ "error": "Could not reach the URL" })),
            )
                .into_response()
        }
    };

    let status = response.status();
    if !status.is_success() && status != StatusCode::PARTIAL_CONTENT {
        return (
            StatusCode::from_u16(status.as_u16()).unwrap_or(StatusCode::BAD_GATEWAY),
            Json(json!({ "error": format!("Remote server returned {status}") })),
        )
            .into_response();
    }

    let headers = response.headers();
    let content_type = headers
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    // content-length or content-range
    let content_length = headers
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .or_else(|| {
            headers
                .get("content-range")
                .and_then(|v| v.to_str().ok())
                .and_then(|s| {
                    // "bytes 0-0/TOTAL"
                    s.rsplit('/').next()?.parse::<u64>().ok()
                })
        });

    let content_disposition = headers
        .get("content-disposition")
        .and_then(|v| v.to_str().ok());

    let file_type = content_type
        .as_deref()
        .and_then(|ct| ct.split(';').next())
        .map(|s| s.trim().to_string());

    let file_extension = file_type.as_deref().and_then(ext_from_mime);
    let file_size = content_length;

    // Determine filename: content-disposition > URL path > fallback
    let raw_name = content_disposition
        .and_then(parse_content_disposition)
        .or_else(|| filename_from_url(url));

    let file_name = match raw_name {
        Some(n) => n,
        None => match file_extension {
            Some(ext) => format!("download.{ext}"),
            None => "download".to_string(),
        },
    };

    Json(json!({
        "fileName": file_name,
        "fileSize": file_size,
        "fileType": file_type,
        "fileExtension": file_extension,
    }))
    .into_response()
}
