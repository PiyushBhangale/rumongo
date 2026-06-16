//! Phase 4 — streaming lazy cursor.
//!
//! `find_lazy` returns ALL docs as handles at once: peak live memory = whole
//! result set, which under concurrency drives heavy GC (the jitter source).
//!
//! `FindCursor` instead hands back one batch at a time. Awaiting `next_batch`
//! yields the event loop between batches and lets each batch be processed and
//! dropped before the next is materialized, so peak live objects ≈ one batch.
//! Lower heap pressure → far less GC → lower jitter. Also bounds memory.

use napi::Result;
use napi_derive::napi;
use tokio::sync::Mutex;

use crate::cursor::RawBatchPipeline;
use crate::deserialize::split_raw_batch;
use crate::error::to_napi;
use crate::rawdoc::RawDoc;

#[napi]
pub struct FindCursor {
    pipe: Mutex<RawBatchPipeline>,
}

impl FindCursor {
    pub(crate) fn new(pipe: RawBatchPipeline) -> Self {
        Self {
            pipe: Mutex::new(pipe),
        }
    }
}

#[napi]
impl FindCursor {
    /// Next batch of lazy `RawDoc` handles, or `null` when exhausted.
    /// Awaiting this is a real loop yield point, so timers/IO run between batches.
    #[napi]
    pub async fn next_batch(&self) -> Result<Option<Vec<RawDoc>>> {
        let mut pipe = self.pipe.lock().await;
        match pipe.next().await {
            Some(Ok(batch)) => {
                let chunks = tokio::task::spawn_blocking(move || split_raw_batch(&batch))
                    .await
                    .map_err(to_napi)?
                    .map_err(to_napi)?;
                Ok(Some(chunks.into_iter().map(|raw| RawDoc { raw }).collect()))
            }
            Some(Err(e)) => Err(to_napi(e)),
            None => Ok(None),
        }
    }
}
