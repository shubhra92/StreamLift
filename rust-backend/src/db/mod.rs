pub mod models;

use anyhow::Result;
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::PgPool;
use std::str::FromStr;

pub async fn create_pool(database_url: &str) -> Result<PgPool> {
    // Strip the ?pgbouncer=true marker (it's a hint for us, not a valid PG param).
    // Then force statement_cache_capacity(0) so sqlx never creates named prepared
    // statements — required for Supabase PgBouncer in transaction pooling mode.
    let clean_url = database_url
        .replace("?pgbouncer=true", "")
        .replace("&pgbouncer=true", "");

    let connect_opts = PgConnectOptions::from_str(&clean_url)?
        .statement_cache_capacity(0);

    let pool = PgPoolOptions::new()
        .max_connections(5)
        .acquire_timeout(std::time::Duration::from_secs(30))
        .connect_with(connect_opts)
        .await?;

    Ok(pool)
}
