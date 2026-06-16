//! Phase 3 — raw-batch fetch pipeline.
//!
//! A spawned tokio task drives a `RawBatchCursor` (network `getMore`s) and
//! pushes owned `RawBatch`es into a bounded mpsc channel. The consumer pulls a
//! batch and hands it to rayon for parallel parsing while the fetcher is already
//! fetching the next batch. Network fetch (tokio) overlaps CPU parse (rayon).
//!
//! The bounded channel is the backpressure mechanism: a lagging consumer parks
//! the fetcher, capping buffered batches at `capacity`.

use futures::stream::TryStreamExt;
use mongodb::raw_batch_cursor::{RawBatch, RawBatchCursor};
use tokio::sync::mpsc;

pub struct RawBatchPipeline {
    rx: mpsc::Receiver<Result<RawBatch, String>>,
}

impl RawBatchPipeline {
    /// `capacity` = max in-flight batches (backpressure).
    pub fn spawn(mut cursor: RawBatchCursor, capacity: usize) -> Self {
        let (tx, rx) = mpsc::channel(capacity.max(1));

        tokio::spawn(async move {
            loop {
                match cursor.try_next().await {
                    Ok(Some(batch)) => {
                        if tx.send(Ok(batch)).await.is_err() {
                            break; // consumer dropped
                        }
                    }
                    Ok(None) => break, // exhausted
                    Err(e) => {
                        let _ = tx.send(Err(e.to_string())).await;
                        break;
                    }
                }
            }
        });

        Self { rx }
    }

    /// Next raw batch, or None when the stream is finished.
    pub async fn next(&mut self) -> Option<Result<RawBatch, String>> {
        self.rx.recv().await
    }
}
