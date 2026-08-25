pub mod debug;
pub mod file_info;
pub mod health;
pub mod progress;
pub mod stream_download;
pub mod torrent_download;

use axum::{routing::{get, post}, Router};
use crate::AppState;

pub fn api_router() -> Router<AppState> {
    Router::new()
        // Progress
        .route("/progress/:id", get(progress::get_progress))
        .route("/progress/:id/stream", get(progress::stream_progress))
        // HTTP downloads
        .route("/stream-download/server", post(stream_download::server_download))
        .route("/stream-download/cloud", post(stream_download::mega_upload))
        // Torrent downloads
        .route("/torrent-download/metadata", post(torrent_download::get_metadata))
        .route("/torrent-download/server", post(torrent_download::server_download))
        .route("/torrent-download/cloud", post(torrent_download::mega_upload))
        // File info
        .route("/file-info", get(file_info::get_file_info))
        // Debug
        .route("/debug/mega-put-test", get(debug::mega_put_test))
}
