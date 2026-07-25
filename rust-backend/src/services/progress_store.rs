use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use uuid::Uuid;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Progress {
    #[serde(rename = "downloadedBytes")]
    pub downloaded_bytes: Option<u64>,
    #[serde(rename = "totalBytes")]
    pub total_bytes: Option<u64>,
    /// String like "42.37"
    #[serde(rename = "percentFixed2")]
    pub percent_fixed2: Option<String>,
    /// Integer 0-100
    #[serde(rename = "percent")]
    pub percent: Option<u32>,
    /// true when download finished (success or failure)
    #[serde(default)]
    pub done: bool,
}

impl Progress {
    pub fn initial() -> Self {
        Self {
            downloaded_bytes: Some(0),
            total_bytes: None,
            percent_fixed2: None,
            percent: None,
            done: false,
        }
    }

    pub fn update(&mut self, downloaded: u64, total: u64) {
        self.downloaded_bytes = Some(downloaded);
        self.total_bytes = Some(total);
        if total > 0 {
            let pct = (downloaded as f64 / total as f64) * 100.0;
            self.percent_fixed2 = Some(format!("{:.2}", pct));
            self.percent = Some(pct.round() as u32);
        }
    }

    pub fn complete(total: u64) -> Self {
        Self {
            downloaded_bytes: Some(total),
            total_bytes: Some(total),
            percent_fixed2: Some("100.00".to_string()),
            percent: Some(100),
            done: true,
        }
    }

    pub fn failed() -> Self {
        Self {
            downloaded_bytes: None,
            total_bytes: None,
            percent_fixed2: None,
            percent: None,
            done: true,
        }
    }
}

/// Shared, thread-safe progress map — clone the Arc to share across handlers.
pub type ProgressStore = Arc<DashMap<Uuid, Progress>>;

pub fn new_store() -> ProgressStore {
    Arc::new(DashMap::new())
}
