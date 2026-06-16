//! MongoClient: thin napi wrapper around `mongodb::Client`.
//!
//! The client is stored as `Arc<Client>` (cheaply cloneable, no Mutex needed).
//! Async work runs on napi-rs's built-in tokio runtime (the `tokio_rt` feature),
//! which is created once and reused for every call — satisfying the
//! "one runtime, never per-query" rule without a manual `once_cell` global.

use std::sync::Arc;
use std::time::Duration;

use mongodb::options::ClientOptions;
use mongodb::Client;
use napi::Result;
use napi_derive::napi;
use serde::Deserialize;

use crate::error::to_napi;

/// Connection pool / timeout configuration, passed as a JSON string from TS.
#[derive(Deserialize, Default)]
struct ConnConfig {
    #[serde(rename = "maxPoolSize")]
    max_pool_size: Option<u32>,
    #[serde(rename = "minPoolSize")]
    min_pool_size: Option<u32>,
    #[serde(rename = "connectTimeoutMs")]
    connect_timeout_ms: Option<u64>,
    #[serde(rename = "serverSelectionTimeoutMs")]
    server_selection_timeout_ms: Option<u64>,
    /// Application name reported to the server.
    #[serde(rename = "appName")]
    app_name: Option<String>,
}

#[napi]
pub struct MongoClient {
    pub(crate) inner: Arc<Client>,
}

#[napi]
impl MongoClient {
    /// Connect to MongoDB. `options` is an optional JSON string with pool/timeout
    /// config: `{ maxPoolSize, minPoolSize, connectTimeoutMs,
    /// serverSelectionTimeoutMs, appName }`. The driver already pools connections;
    /// these expose the knobs.
    #[napi(factory)]
    pub async fn connect(uri: String, options: Option<String>) -> Result<MongoClient> {
        let mut opts = ClientOptions::parse(&uri).await.map_err(to_napi)?;
        if let Some(json) = options.filter(|s| !s.trim().is_empty()) {
            let cfg: ConnConfig = serde_json::from_str(&json).map_err(to_napi)?;
            if let Some(v) = cfg.max_pool_size {
                opts.max_pool_size = Some(v);
            }
            if let Some(v) = cfg.min_pool_size {
                opts.min_pool_size = Some(v);
            }
            if let Some(ms) = cfg.connect_timeout_ms {
                opts.connect_timeout = Some(Duration::from_millis(ms));
            }
            if let Some(ms) = cfg.server_selection_timeout_ms {
                opts.server_selection_timeout = Some(Duration::from_millis(ms));
            }
            if cfg.app_name.is_some() {
                opts.app_name = cfg.app_name;
            }
        }
        let client = Client::with_options(opts).map_err(to_napi)?;
        Ok(MongoClient {
            inner: Arc::new(client),
        })
    }

    /// Terminate background workers and close connections. Call before process
    /// exit: otherwise the driver's topology-monitor tasks keep the runtime
    /// alive and Node will not exit. `immediate(true)` does not wait for live
    /// cursor handles (acceptable at teardown).
    #[napi]
    pub async fn close(&self) -> Result<()> {
        // Clone is a cheap Arc bump; shutdown consumes this owned handle.
        let client = (*self.inner).clone();
        client.shutdown().immediate(true).await;
        Ok(())
    }
}
