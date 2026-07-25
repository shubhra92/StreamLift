/// HTTP URL → server disk  or  HTTP URL → MEGA

use anyhow::{Context, Result};
use futures::StreamExt;
use sqlx::PgPool;
use std::path::PathBuf;
use tokio::io::AsyncWriteExt;
use tracing::{error, info};
use uuid::Uuid;

use crate::services::mega::auth::MegaState;
use crate::services::mega::upload::{get_or_create_folder, upload_stream_to_mega};
use crate::services::progress_store::{Progress, ProgressStore};

// ── HTTP fetch with retry ─────────────────────────────────────────────────────

async fn fetch_with_retry(client: &reqwest::Client, url: &str) -> Result<reqwest::Response> {
    let mut last_err = None;
    for attempt in 1..=3u32 {
        match client
            .get(url)
            .header("User-Agent", "Mozilla/5.0 (Windows NT 10.0; Win64; x64)")
            .send()
            .await
        {
            Ok(r) if r.status().is_success() => return Ok(r),
            Ok(r) => {
                let status = r.status();
                tracing::warn!("Fetch {url} attempt {attempt}/3: HTTP {status}");
                last_err = Some(anyhow::anyhow!("HTTP {status}"));
            }
            Err(e) => {
                tracing::warn!("Fetch {url} attempt {attempt}/3 network error: {e}");
                last_err = Some(e.into());
            }
        }
        tokio::time::sleep(std::time::Duration::from_secs(attempt as u64)).await;
    }
    Err(last_err.unwrap())
}

struct DownloadMeta {
    filename: String,
    total_bytes: u64,
    content_type: Option<String>,
}

fn parse_meta(resp: &reqwest::Response, file_name_hint: Option<&str>) -> DownloadMeta {
    let ct = resp
        .headers()
        .get(reqwest::header::CONTENT_TYPE)
        .and_then(|v| v.to_str().ok())
        .map(|s| s.to_string());

    let ext = ct.as_deref().and_then(|s| s.split('/').nth(1)).unwrap_or("bin");

    let total_bytes = resp
        .headers()
        .get(reqwest::header::CONTENT_LENGTH)
        .and_then(|v| v.to_str().ok())
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(0);

    let filename = if let Some(name) = file_name_hint {
        name.to_string()
    } else {
        resp.headers()
            .get("content-disposition")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| {
                s.split(';').find_map(|part| {
                    let p = part.trim();
                    if p.starts_with("filename=") {
                        Some(p.trim_start_matches("filename=").trim_matches('"').to_string())
                    } else {
                        None
                    }
                })
            })
            .unwrap_or_else(|| format!("file.{}", ext))
    };

    DownloadMeta { filename, total_bytes, content_type: ct }
}

// ── DB helpers ────────────────────────────────────────────────────────────────

async fn mark_downloading(
    pool: &PgPool,
    id: Uuid,
    filename: &str,
    file_type: Option<&str>,
    file_size: u64,
    location_path: &str,
) -> Result<()> {
    sqlx::query(
        "UPDATE file_downloads \
         SET status = 'downloading', file_name = $1, file_type = $2, \
             file_size = $3, location_path = $4, updated_at = NOW() \
         WHERE id = $5",
    )
    .bind(filename)
    .bind(file_type)
    .bind(file_size as i64)
    .bind(location_path)
    .bind(id)
    .persistent(false)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_completed(pool: &PgPool, id: Uuid) -> Result<()> {
    sqlx::query(
        "UPDATE file_downloads SET status = 'completed', updated_at = NOW() WHERE id = $1",
    )
    .bind(id)
    .persistent(false)
    .execute(pool)
    .await?;
    Ok(())
}

async fn mark_failed(pool: &PgPool, id: Uuid, msg: &str) -> Result<()> {
    sqlx::query(
        "UPDATE file_downloads SET status = 'failed', error_message = $1, updated_at = NOW() \
         WHERE id = $2",
    )
    .bind(msg)
    .bind(id)
    .persistent(false)
    .execute(pool)
    .await?;
    Ok(())
}

// ── URL → disk ────────────────────────────────────────────────────────────────

pub async fn download_url_to_server(
    id: Uuid,
    url: String,
    file_name_hint: Option<String>,
    _guest_id: Option<Uuid>,
    pool: PgPool,
    progress: ProgressStore,
    http: reqwest::Client,
) {
    if let Err(e) =
        _download_url_to_server(id, &url, file_name_hint.as_deref(), &pool, &progress, &http).await
    {
        error!("download_url_to_server failed for {id}: {e:#}");
        let _ = mark_failed(&pool, id, &e.to_string()).await;
        progress.insert(id, Progress::failed());
    }
}

async fn _download_url_to_server(
    id: Uuid,
    url: &str,
    file_name_hint: Option<&str>,
    pool: &PgPool,
    progress: &ProgressStore,
    http: &reqwest::Client,
) -> Result<()> {
    let resp = fetch_with_retry(http, url).await.context("fetch url")?;
    let meta = parse_meta(&resp, file_name_hint);

    let download_dir = PathBuf::from("downloads");
    tokio::fs::create_dir_all(&download_dir).await?;
    let dest = download_dir.join(&meta.filename);

    mark_downloading(
        pool, id, &meta.filename,
        meta.content_type.as_deref().and_then(|ct| ct.split('/').next()),
        meta.total_bytes,
        &meta.filename,
    )
    .await?;

    let mut file = tokio::fs::File::create(&dest).await?;
    let mut stream = resp.bytes_stream();
    let mut downloaded: u64 = 0;

    while let Some(chunk) = stream.next().await {
        let bytes = chunk.context("stream read error")?;
        file.write_all(&bytes).await?;
        downloaded += bytes.len() as u64;
        let mut p = progress.entry(id).or_insert(Progress::initial());
        p.update(downloaded, meta.total_bytes);
    }

    file.flush().await?;
    mark_completed(pool, id).await?;
    progress.insert(id, Progress::complete(downloaded));
    info!("Downloaded {url} → {} ({downloaded} bytes)", dest.display());
    Ok(())
}

// ── URL → MEGA ────────────────────────────────────────────────────────────────

pub async fn stream_url_to_mega(
    id: Uuid,
    url: String,
    file_name_hint: Option<String>,
    guest_id: Option<Uuid>,
    pool: PgPool,
    progress: ProgressStore,
    http: reqwest::Client,
    mega: MegaState,
) {
    if let Err(e) = _stream_url_to_mega(
        id,
        &url,
        file_name_hint.as_deref(),
        guest_id,
        &pool,
        &progress,
        &http,
        mega,
    )
    .await
    {
        error!("stream_url_to_mega failed for {id}: {e:#}");
        let _ = mark_failed(&pool, id, &e.to_string()).await;
        progress.insert(id, Progress::failed());
    }
}

async fn _stream_url_to_mega(
    id: Uuid,
    url: &str,
    file_name_hint: Option<&str>,
    guest_id: Option<Uuid>,
    pool: &PgPool,
    progress: &ProgressStore,
    http: &reqwest::Client,
    mut mega: MegaState,
) -> Result<()> {
    let resp = fetch_with_retry(http, url).await.context("fetch url")?;
    let meta = parse_meta(&resp, file_name_hint);

    let target_handle = match guest_id {
        Some(gid) => get_or_create_folder(
            &mut mega.client,
            &mega.root_handle,
            &gid.to_string(),
            &mega.master_key,
        )
        .await?,
        None => mega.root_handle.clone(),
    };

    let file_type = meta
        .content_type
        .as_deref()
        .and_then(|ct| ct.split('/').next())
        .map(|s| s.to_string());

    mark_downloading(pool, id, &meta.filename, file_type.as_deref(), meta.total_bytes, &meta.filename)
        .await?;

    let progress_clone = progress.clone();
    let total = meta.total_bytes;
    let stream = resp.bytes_stream();

    upload_stream_to_mega(
        &mut mega.client,
        http.clone(),
        &target_handle,
        &meta.filename,
        meta.total_bytes,
        &mega.master_key,
        stream,
        move |uploaded| {
            let mut p = progress_clone.entry(id).or_insert(Progress::initial());
            p.update(uploaded, total);
        },
    )
    .await
    .context("upload to MEGA")?;

    mark_completed(pool, id).await?;
    progress.insert(id, Progress::complete(meta.total_bytes));
    info!("Streamed {url} → MEGA/{}", meta.filename);
    Ok(())
}
