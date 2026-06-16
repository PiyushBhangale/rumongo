//! rumongo — Rust-native MongoDB read driver for Node.js (napi-rs).
//! Rust + Mongo. See plan / BENCHMARKS.md for phase history.

#[macro_use]
mod debug;
mod client;
mod collection;
mod cursor;
mod deserialize;
mod error;
mod findcursor;
mod rawdoc;

pub use findcursor::FindCursor;
pub use rawdoc::RawDoc;

pub use client::MongoClient;
