//! Phase 3 — off-thread BSON parsing.
//!
//! A raw server batch is parsed into per-document JSON strings using rayon's
//! work-stealing pool, so the bytes→Document→JSON work is spread across CPU
//! cores instead of running on a single async worker thread.
//!
//! (Native JS values / lazy field access are Phase 4; this phase keeps the
//! JSON-string interface and only changes *where* the parse runs.)

use bson::{Document, RawDocument};
use mongodb::raw_batch_cursor::RawBatch;
use rayon::prelude::*;

/// Parse every document in a raw server batch into a JSON string, in parallel.
///
/// Borrows the batch for the duration; each `RawDocument` is a zero-copy slice
/// into the batch buffer until it is deserialized.
pub fn parse_raw_batch(batch: &RawBatch) -> Result<Vec<String>, String> {
    let array = batch.doc_slices().map_err(|e| e.to_string())?;

    // Collect borrowed raw documents first (cheap; no value parsing yet),
    // then deserialize them in parallel.
    let mut raws: Vec<&RawDocument> = Vec::new();
    for item in array {
        let value = item.map_err(|e| e.to_string())?;
        let doc = value
            .as_document()
            .ok_or_else(|| "batch element is not a document".to_string())?;
        raws.push(doc);
    }

    raws.par_iter()
        .map(|raw| {
            let doc: Document = bson::from_slice(raw.as_bytes()).map_err(|e| e.to_string())?;
            serde_json::to_string(&doc).map_err(|e| e.to_string())
        })
        .collect()
}

/// Split a raw server batch into per-document owned byte buffers, in parallel.
/// No value parsing happens — each buffer is just the raw BSON of one document,
/// ready to be wrapped in a lazy `RawDoc` (Phase 4).
pub fn split_raw_batch(batch: &RawBatch) -> Result<Vec<Vec<u8>>, String> {
    let array = batch.doc_slices().map_err(|e| e.to_string())?;
    let mut raws: Vec<&RawDocument> = Vec::new();
    for item in array {
        let value = item.map_err(|e| e.to_string())?;
        let doc = value
            .as_document()
            .ok_or_else(|| "batch element is not a document".to_string())?;
        raws.push(doc);
    }
    Ok(raws.par_iter().map(|raw| raw.as_bytes().to_vec()).collect())
}
