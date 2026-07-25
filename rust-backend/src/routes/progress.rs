use axum::response::sse::KeepAlive;
use axum::{
    extract::{Path, State},
    response::{
        sse::{Event, Sse},
        IntoResponse, Json,
    },
};
use axum::http::StatusCode;
use futures::stream;
use serde_json::json;
use std::convert::Infallible;
use std::time::Duration;
use uuid::Uuid;

use crate::AppState;

/// GET /api/progress/:id
/// Polling endpoint — returns the current progress snapshot.
pub async fn get_progress(
    Path(id): Path<Uuid>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    match state.progress.get(&id) {
        Some(p) => {
            let p = p.clone();
            // Schedule cleanup 60s after done (non-blocking)
            if p.done {
                let store = state.progress.clone();
                tokio::spawn(async move {
                    tokio::time::sleep(Duration::from_secs(60)).await;
                    store.remove(&id);
                });
            }
            (StatusCode::OK, Json(p)).into_response()
        }
        None => (
            StatusCode::NOT_FOUND,
            Json(json!({ "details": "Progress not found", "fileId": id })),
        )
            .into_response(),
    }
}

/// GET /api/progress/:id/stream
/// SSE endpoint — pushes progress every second until done.
pub async fn stream_progress(
    Path(id): Path<Uuid>,
    State(state): State<AppState>,
) -> impl IntoResponse {
    // Verify the id exists first
    if state.progress.get(&id).is_none() {
        return (
            StatusCode::NOT_FOUND,
            Json(json!({ "details": "Progress not found", "fileId": id })),
        )
            .into_response();
    }

    let store = state.progress.clone();

    // Build an SSE stream that ticks every second
    let sse_stream = stream::unfold(
        (store, false),
        move |(store, finished)| async move {
            if finished {
                return None;
            }

            tokio::time::sleep(Duration::from_secs(1)).await;

            let result = {
                match store.get(&id) {
                    Some(p) => {
                        let p = p.clone();
                        let done = p.done;
                        let data = serde_json::to_string(&p).unwrap_or_default();
                        Some((done, data))
                    }
                    None => None,
                }
            };

            match result {
                Some((done, data)) => {
                    let event = Event::default().data(data);
                    Some((Ok::<Event, Infallible>(event), (store, done)))
                }
                None => None,
            }
        },
    );

    Sse::new(sse_stream)
        .keep_alive(
            KeepAlive::new()
                .interval(Duration::from_secs(15))
                .text("keep-alive"),
        )
        .into_response()
}
