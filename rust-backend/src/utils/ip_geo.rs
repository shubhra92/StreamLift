#![allow(dead_code, unused_imports, unused_variables, unused_mut)]
use anyhow::Result;
use serde::Deserialize;
use tracing::{error, info, warn};

#[derive(Debug, Clone)]
pub struct IpInfo {
    pub ip: String,
    pub country: String,       // ISO country code e.g. "AU"
    pub country_name: String,
    pub region: Option<String>,
    pub city: Option<String>,
}

// ── response shapes ───────────────────────────────────────────────────────────

#[derive(Deserialize)]
struct IpApiResponse {
    status: Option<String>,
    query: Option<String>,
    #[serde(rename = "countryCode")]
    country_code: Option<String>,
    country: Option<String>,
    #[serde(rename = "regionName")]
    region_name: Option<String>,
    city: Option<String>,
}

#[derive(Deserialize)]
struct IpWhoIsResponse {
    success: Option<bool>,
    ip: Option<String>,
    country_code: Option<String>,
    country: Option<String>,
    region: Option<String>,
    city: Option<String>,
}

#[derive(Deserialize)]
struct IpApiCoResponse {
    ip: Option<String>,
    country_code: Option<String>,
    country_name: Option<String>,
    region: Option<String>,
    city: Option<String>,
    error: Option<bool>,
}

// ── public API ────────────────────────────────────────────────────────────────

/// Try three IP geolocation services in order. Returns `None` if all fail.
pub async fn get_current_ip_info(client: &reqwest::Client) -> Option<IpInfo> {
    // 1. ip-api.com
    match try_ip_api(client).await {
        Ok(Some(info)) => {
            info!("IP info from ip-api.com: {} ({})", info.ip, info.country);
            return Some(info);
        }
        Ok(None) => warn!("ip-api.com returned no usable data"),
        Err(e) => error!("ip-api.com failed: {e}"),
    }

    // 2. ipwho.is
    match try_ipwho_is(client).await {
        Ok(Some(info)) => {
            info!("IP info from ipwho.is: {} ({})", info.ip, info.country);
            return Some(info);
        }
        Ok(None) => warn!("ipwho.is returned no usable data"),
        Err(e) => error!("ipwho.is failed: {e}"),
    }

    // 3. ipapi.co
    match try_ipapi_co(client).await {
        Ok(Some(info)) => {
            info!("IP info from ipapi.co: {} ({})", info.ip, info.country);
            return Some(info);
        }
        Ok(None) => warn!("ipapi.co returned no usable data"),
        Err(e) => error!("ipapi.co failed: {e}"),
    }

    error!("All IP geo services failed");
    None
}

// ── providers ─────────────────────────────────────────────────────────────────

async fn try_ip_api(client: &reqwest::Client) -> Result<Option<IpInfo>> {
    let resp: IpApiResponse = client
        .get("http://ip-api.com/json/?fields=status,country,countryCode,regionName,city,query")
        .send()
        .await?
        .json()
        .await?;

    if resp.status.as_deref() == Some("success") {
        if let (Some(ip), Some(code)) = (resp.query, resp.country_code) {
            return Ok(Some(IpInfo {
                ip,
                country: code,
                country_name: resp.country.unwrap_or_default(),
                region: resp.region_name,
                city: resp.city,
            }));
        }
    }
    Ok(None)
}

async fn try_ipwho_is(client: &reqwest::Client) -> Result<Option<IpInfo>> {
    let resp: IpWhoIsResponse = client
        .get("https://ipwho.is/")
        .send()
        .await?
        .json()
        .await?;

    if resp.success == Some(true) {
        if let (Some(ip), Some(code)) = (resp.ip, resp.country_code) {
            return Ok(Some(IpInfo {
                ip,
                country: code,
                country_name: resp.country.unwrap_or_default(),
                region: resp.region,
                city: resp.city,
            }));
        }
    }
    Ok(None)
}

async fn try_ipapi_co(client: &reqwest::Client) -> Result<Option<IpInfo>> {
    let resp: IpApiCoResponse = client
        .get("https://ipapi.co/json/")
        .send()
        .await?
        .json()
        .await?;

    if resp.error != Some(true) {
        if let (Some(ip), Some(code)) = (resp.ip, resp.country_code) {
            return Ok(Some(IpInfo {
                ip,
                country: code,
                country_name: resp.country_name.unwrap_or_default(),
                region: resp.region,
                city: resp.city,
            }));
        }
    }
    Ok(None)
}
