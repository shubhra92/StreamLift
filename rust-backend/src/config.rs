use anyhow::{Context, Result};

#[derive(Debug, Clone)]
pub struct Config {
    pub port: u16,
    pub database_url: String,
    pub mega_email: String,
    pub mega_password: String,
    pub storage_provider: String,
    pub server_download_enabled: bool,
}

impl Config {
    pub fn from_env() -> Result<Self> {
        let server_download_enabled = std::env::var("SERVER_DOWNLOAD_ENABLED")
            .unwrap_or_else(|_| "false".to_string())
            .to_lowercase()
            == "true";

        Ok(Self {
            port: std::env::var("PORT")
                .unwrap_or_else(|_| "4000".to_string())
                .parse()
                .context("PORT must be a valid number")?,
            database_url: std::env::var("DATABASE_URL")
                .context("DATABASE_URL is required")?,
            mega_email: std::env::var("MEGA_EMAIL")
                .context("MEGA_EMAIL is required")?,
            mega_password: std::env::var("MEGA_PASSWORD")
                .context("MEGA_PASSWORD is required")?,
            storage_provider: std::env::var("STORAGE_PROVIDER")
                .unwrap_or_else(|_| "mega".to_string()),
            server_download_enabled,
        })
    }
}
