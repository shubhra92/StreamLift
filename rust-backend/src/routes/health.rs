use axum::{extract::State, response::IntoResponse, Json};
use serde_json::json;

use crate::AppState;

pub async fn root() -> impl IntoResponse {
    "Server is running!...."
}

pub async fn health(State(state): State<AppState>) -> impl IntoResponse {
    let ready = state.is_ready.load(std::sync::atomic::Ordering::SeqCst);
    let status = if ready { 200 } else { 503 };
    (
        axum::http::StatusCode::from_u16(status).unwrap(),
        Json(json!({ "ready": ready })),
    )
}
