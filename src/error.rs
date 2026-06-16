//! Error mapping: convert Rust errors into `napi::Error` with meaningful messages.
//! No `unwrap()` in production paths — every fallible call uses `?` plus one of these.

use napi::{Error, Status};

/// Convert any `Display` error (mongodb, serde_json, bson) into a napi error.
pub fn to_napi<E: std::fmt::Display>(e: E) -> Error {
    Error::new(Status::GenericFailure, e.to_string())
}
