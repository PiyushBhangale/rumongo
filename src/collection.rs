//! `find()` (eager, JSON strings) and `find_lazy()` (Phase 4, lazy RawDoc).
//!
//! Both use the raw-batch + rayon pipeline (Phase 3). `find` deserializes each
//! batch to JSON strings; `find_lazy` only splits batches into per-document byte
//! buffers and returns `RawDoc` handles that parse on field access.

use bson::Document;
use futures::stream::TryStreamExt;
use mongodb::action::Find;
use napi::Result;
use napi_derive::napi;
use serde::Deserialize;

use crate::client::MongoClient;
use crate::cursor::RawBatchPipeline;
use crate::deserialize::{parse_raw_batch, split_raw_batch};
use crate::error::to_napi;
use crate::findcursor::FindCursor;
use crate::rawdoc::RawDoc;

/// Subset of find options understood so far.
#[derive(Deserialize, Default)]
struct FindOpts {
    limit: Option<i64>,
    skip: Option<u64>,
    sort: Option<Document>,
    projection: Option<Document>,
    #[serde(rename = "batchSize")]
    batch_size: Option<u32>,
    /// Bounded in-flight batches for the pipeline (backpressure). Default 4.
    #[serde(rename = "maxInflight")]
    max_inflight: Option<usize>,
    /// false => sequential standard-cursor path (Phase 1 baseline, eager only).
    pipeline: Option<bool>,
}

/// Parse the filter as Extended JSON and the options blob.
fn parse_filter_opts(filter_json: &str, opts_json: &str) -> Result<(Document, FindOpts)> {
    let filter_value: serde_json::Value = serde_json::from_str(filter_json).map_err(to_napi)?;
    let filter = match bson::Bson::try_from(filter_value).map_err(to_napi)? {
        bson::Bson::Document(doc) => doc,
        _ => return Err(to_napi("filter must be a JSON object")),
    };
    let opts: FindOpts = if opts_json.trim().is_empty() {
        FindOpts::default()
    } else {
        serde_json::from_str(opts_json).map_err(to_napi)?
    };
    Ok((filter, opts))
}

/// Apply the option fields to a Find action builder.
fn apply_opts<'a>(mut action: Find<'a, Document>, opts: &FindOpts) -> Find<'a, Document> {
    if let Some(limit) = opts.limit {
        action = action.limit(limit);
    }
    if let Some(skip) = opts.skip {
        action = action.skip(skip);
    }
    if let Some(sort) = opts.sort.clone() {
        action = action.sort(sort);
    }
    if let Some(projection) = opts.projection.clone() {
        action = action.projection(projection);
    }
    if let Some(batch_size) = opts.batch_size {
        action = action.batch_size(batch_size);
    }
    action
}

#[napi]
impl MongoClient {
    /// Eager find: returns one JSON string per document (Phase 3 path).
    #[napi]
    pub async fn find(
        &self,
        db: String,
        coll: String,
        filter_json: String,
        opts_json: String,
    ) -> Result<Vec<String>> {
        let started = std::time::Instant::now();
        let (filter, opts) = parse_filter_opts(&filter_json, &opts_json)?;
        let collection = self.inner.database(&db).collection::<Document>(&coll);
        let action = apply_opts(collection.find(filter), &opts);

        let mut out: Vec<String> = Vec::new();
        if opts.pipeline.unwrap_or(true) {
            let capacity = opts.max_inflight.unwrap_or(4);
            let cursor = action.batch().await.map_err(to_napi)?;
            let mut pipe = RawBatchPipeline::spawn(cursor, capacity);
            while let Some(item) = pipe.next().await {
                let batch = item.map_err(to_napi)?;
                let parsed = tokio::task::spawn_blocking(move || parse_raw_batch(&batch))
                    .await
                    .map_err(to_napi)?
                    .map_err(to_napi)?;
                out.extend(parsed);
            }
        } else {
            let mut cursor = action.await.map_err(to_napi)?;
            while let Some(doc) = cursor.try_next().await.map_err(to_napi)? {
                out.push(serde_json::to_string(&doc).map_err(to_napi)?);
            }
        }
        dbg_log!(
            "find {}.{} -> {} docs in {:?}",
            db,
            coll,
            out.len(),
            started.elapsed()
        );
        Ok(out)
    }

    /// Lazy find (Phase 4): returns `RawDoc` handles holding raw bytes. No values
    /// are parsed until JS reads a field, so the event loop is not blocked by a
    /// deserialize burst on return.
    #[napi]
    pub async fn find_lazy(
        &self,
        db: String,
        coll: String,
        filter_json: String,
        opts_json: String,
    ) -> Result<Vec<RawDoc>> {
        let (filter, opts) = parse_filter_opts(&filter_json, &opts_json)?;
        let collection = self.inner.database(&db).collection::<Document>(&coll);
        let action = apply_opts(collection.find(filter), &opts);

        let capacity = opts.max_inflight.unwrap_or(4);
        let cursor = action.batch().await.map_err(to_napi)?;
        let mut pipe = RawBatchPipeline::spawn(cursor, capacity);

        let mut out: Vec<RawDoc> = Vec::new();
        while let Some(item) = pipe.next().await {
            let batch = item.map_err(to_napi)?;
            let chunks = tokio::task::spawn_blocking(move || split_raw_batch(&batch))
                .await
                .map_err(to_napi)?
                .map_err(to_napi)?;
            out.extend(chunks.into_iter().map(|raw| RawDoc { raw }));
        }
        Ok(out)
    }

    /// Streaming lazy find (Phase 4): returns a `FindCursor`. Pull batches with
    /// `next_batch()` and process+drop each before the next, so peak live memory
    /// is one batch and GC jitter under concurrency stays low.
    #[napi]
    pub async fn find_cursor(
        &self,
        db: String,
        coll: String,
        filter_json: String,
        opts_json: String,
    ) -> Result<FindCursor> {
        let (filter, opts) = parse_filter_opts(&filter_json, &opts_json)?;
        let collection = self.inner.database(&db).collection::<Document>(&coll);
        let action = apply_opts(collection.find(filter), &opts);

        let capacity = opts.max_inflight.unwrap_or(4);
        let cursor = action.batch().await.map_err(to_napi)?;
        let pipe = RawBatchPipeline::spawn(cursor, capacity);
        Ok(FindCursor::new(pipe))
    }
}
