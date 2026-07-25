/// Debug endpoint — tests a raw TCP PUT to MEGA.
use axum::{extract::State, response::IntoResponse, Json};
use serde_json::json;
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tracing::info;

use crate::AppState;

pub async fn mega_put_test(State(state): State<AppState>) -> impl IntoResponse {
    let mega = { state.mega.read().await.clone() };
    let mut mega = match mega {
        Some(m) => m,
        None => return Json(json!({ "error": "MEGA not initialized" })).into_response(),
    };

    // 1. Request an upload slot for 16 bytes
    let upload_url = match mega.client.request_upload_url(16).await {
        Ok(u) => u,
        Err(e) => return Json(json!({ "error": format!("request_upload_url: {e}") })).into_response(),
    };
    info!("Upload URL: {upload_url}");

    // 2. Raw TCP PUT — 16 bytes
    let put_url = format!("{}/0", upload_url);
    info!("Raw TCP PUT to: {put_url}");

    match raw_tcp_put(&put_url, vec![0x41u8; 16]).await {
        Ok(body) => {
            info!("PUT ok body={body:?}");
            Json(json!({
                "upload_url": upload_url,
                "put_body": body,
                "result": "ok"
            })).into_response()
        }
        Err(e) => {
            info!("PUT error: {e:#}");
            Json(json!({ "error": format!("{e:#}") })).into_response()
        }
    }
}

async fn raw_tcp_put(url: &str, data: Vec<u8>) -> anyhow::Result<String> {
    let without_scheme = url.strip_prefix("http://")
        .ok_or_else(|| anyhow::anyhow!("not http"))?;
    let (host_port, path) = without_scheme.split_once('/')
        .map(|(h, p)| (h, format!("/{p}")))
        .unwrap_or((without_scheme, "/".to_string()));
    let addr = if host_port.contains(':') {
        host_port.to_string()
    } else {
        format!("{host_port}:80")
    };
    let host = host_port.split(':').next().unwrap_or(host_port);

    let header = format!(
        "POST {path} HTTP/1.1\r\nHost: {host}\r\nContent-Type: application/octet-stream\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        data.len()
    );

    let mut stream = TcpStream::connect(&addr).await?;
    stream.write_all(header.as_bytes()).await?;
    stream.write_all(&data).await?;
    stream.flush().await?;

    let mut response = Vec::new();
    let _ = stream.read_to_end(&mut response).await;

    let s = String::from_utf8_lossy(&response).to_string();
    info!("Raw response ({} bytes): {:?}", response.len(), &s[..s.len().min(200)]);

    if let Some(pos) = s.find("\r\n\r\n") {
        Ok(s[pos + 4..].trim().to_string())
    } else {
        Ok(s.trim().to_string())
    }
}
