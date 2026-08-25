mod config;
mod db;
mod routes;
mod services;
mod utils;

use std::sync::{atomic::AtomicBool, Arc};

use anyhow::Result;
use axum::{
    http::Method,
    routing::get,
    Router,
};
use sqlx::PgPool;
use tower_http::cors::{Any, CorsLayer};
use tower_http::trace::TraceLayer;
use tracing::info;

use services::mega::{
    auth::{MegaManager, SharedMegaState},
    new_shared_state,
};
use services::progress_store::{new_store, ProgressStore};
use services::torrent::engine::TorrentEngine;

// ── App state ─────────────────────────────────────────────────────────────────

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub progress: ProgressStore,
    pub mega: SharedMegaState,
    pub http: reqwest::Client,
    pub is_ready: Arc<AtomicBool>,
    pub torrent_engine: Arc<TorrentEngine>,
    pub storage_provider: String,
    pub server_download_enabled: bool,
}

// ── Main ──────────────────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    // Load .env
    dotenvy::dotenv().ok();

    // Init tracing
    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| "rust_backend=debug,tower_http=info".into()),
        )
        .init();

    let cfg = config::Config::from_env()?;
    info!("Starting StreamLift Rust backend on port {}", cfg.port);

    // Database
    let pool = db::create_pool(&cfg.database_url).await?;
    info!("Connected to PostgreSQL ✅");

    // HTTP client (shared) — no global timeout (large files can take hours)
    // Individual read timeouts are handled at the stream consumer level
    let http = reqwest::Client::builder()
        .connect_timeout(std::time::Duration::from_secs(30))
        .user_agent("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36")
        .build()?;

    // Shared state
    let progress = new_store();
    let mega_state = new_shared_state();
    let is_ready = Arc::new(AtomicBool::new(false));

    // Start torrent engine (persistent, long-lived)
    let torrent_engine = TorrentEngine::start().await
        .expect("Failed to start torrent engine");

    let state = AppState {
        pool: pool.clone(),
        progress,
        mega: mega_state.clone(),
        http: http.clone(),
        is_ready: is_ready.clone(),
        torrent_engine,
        storage_provider: cfg.storage_provider.clone(),
        server_download_enabled: cfg.server_download_enabled,
    };

    // CORS — same as express cors() with default options (all origins)
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods([Method::GET, Method::POST, Method::OPTIONS])
        .allow_headers(Any);

    // Router
    let app = Router::new()
        .route("/", get(routes::health::root))
        .route("/health", get(routes::health::health))
        .nest("/api", routes::api_router())
        .with_state(state.clone())
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        // Readiness gate — 503 for all non-health requests while starting
        .layer(axum::middleware::from_fn_with_state(
            state.clone(),
            readiness_gate,
        ));

    // Start MEGA init in background
    let mega_manager = MegaManager::new(
        pool.clone(),
        http.clone(),
        cfg.mega_email.clone(),
        cfg.mega_password.clone(),
    );
    let mega_clone = mega_state.clone();
    let ready_flag = is_ready.clone();

    tokio::spawn(async move {
        // Recover stale downloads from previous crash/restart
        match recover_stale_downloads(&pool).await {
            Ok(0) => {}
            Ok(n) => tracing::info!("[startup] Marked {n} stale download(s) as failed"),
            Err(e) => tracing::error!("[startup] Failed to recover stale downloads: {e:#}"),
        }

        match mega_manager.init().await {
            Ok(ms) => {
                *mega_clone.write().await = Some(ms);
                info!("MEGA initialized ✅");
            }
            Err(e) => {
                tracing::error!("MEGA initialization failed: {e:#}");
                // Mark ready anyway so non-MEGA routes still work
            }
        }
        ready_flag.store(true, std::sync::atomic::Ordering::SeqCst);
    });

    let addr = std::net::SocketAddr::from(([0, 0, 0, 0], cfg.port));
    info!("Listening on http://{addr}");

    let listener = tokio::net::TcpListener::bind(addr).await?;
    axum::serve(listener, app).await?;

    Ok(())
}

// ── Readiness middleware ──────────────────────────────────────────────────────

async fn readiness_gate(
    axum::extract::State(state): axum::extract::State<AppState>,
    req: axum::extract::Request,
    next: axum::middleware::Next,
) -> axum::response::Response {
    let path = req.uri().path().to_string();
    let ready = state.is_ready.load(std::sync::atomic::Ordering::SeqCst);

    if !ready && path != "/health" {
        return axum::response::IntoResponse::into_response((
            axum::http::StatusCode::SERVICE_UNAVAILABLE,
            axum::Json(serde_json::json!({
                "error": "Server is starting up, please retry in a moment"
            })),
        ));
    }

    next.run(req).await
}

// ── Stale download recovery ──────────────────────────────────────────────────

async fn recover_stale_downloads(pool: &PgPool) -> anyhow::Result<u64> {
    let result = sqlx::query(
        "UPDATE file_downloads \
         SET status = 'failed', \
             error_message = 'Server restarted while download was in progress', \
             updated_at = NOW() \
         WHERE status = 'downloading'",
    )
    .execute(pool)
    .await?;

    Ok(result.rows_affected())
}
