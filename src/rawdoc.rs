//! Phase 4 — lazy zero-copy documents.
//!
//! `RawDoc` holds the raw BSON bytes of one document and parses a value only
//! when JS asks for it (`get_field`). `find_lazy` returns these handles without
//! parsing anything, so the event loop is not blocked by a deserialize burst on
//! return. A JS `Proxy` (ts/index.ts) makes `doc.field` call `get_field`.

use bson::raw::{RawArray, RawBsonRef, RawDocument};
use napi::{Env, JsObject, JsUnknown};
use napi_derive::napi;

use crate::error::to_napi;

/// Convert a single raw BSON value into a native JS value.
/// Documents/arrays are built eagerly for the accessed subtree.
fn bson_ref_to_js(env: &Env, val: RawBsonRef) -> napi::Result<JsUnknown> {
    Ok(match val {
        RawBsonRef::Double(f) => env.create_double(f)?.into_unknown(),
        RawBsonRef::String(s) => env.create_string(s)?.into_unknown(),
        RawBsonRef::Boolean(b) => env.get_boolean(b)?.into_unknown(),
        RawBsonRef::Null => env.get_null()?.into_unknown(),
        RawBsonRef::Undefined => env.get_undefined()?.into_unknown(),
        RawBsonRef::Int32(i) => env.create_int32(i)?.into_unknown(),
        RawBsonRef::Int64(i) => env.create_int64(i)?.into_unknown(),
        // ObjectId -> hex string (matches the plan's convention).
        RawBsonRef::ObjectId(oid) => env.create_string(&oid.to_hex())?.into_unknown(),
        // DateTime -> JS Date.
        RawBsonRef::DateTime(dt) => {
            env.create_date(dt.timestamp_millis() as f64)?.into_unknown()
        }
        RawBsonRef::Document(d) => raw_doc_to_object(env, d)?.into_unknown(),
        RawBsonRef::Array(a) => raw_array_to_js(env, a)?.into_unknown(),
        RawBsonRef::Binary(b) => env
            .create_buffer_with_data(b.bytes.to_vec())?
            .into_raw()
            .into_unknown(),
        // Rare/unsupported BSON types fall back to null.
        _ => env.get_null()?.into_unknown(),
    })
}

fn raw_doc_to_object(env: &Env, doc: &RawDocument) -> napi::Result<JsObject> {
    let mut obj = env.create_object()?;
    for pair in doc.iter() {
        let (k, v) = pair.map_err(to_napi)?;
        let value = bson_ref_to_js(env, v)?;
        obj.set_named_property(k, value)?;
    }
    Ok(obj)
}

fn raw_array_to_js(env: &Env, arr: &RawArray) -> napi::Result<JsObject> {
    let mut js = env.create_array_with_length(0)?;
    let mut i: u32 = 0;
    for item in arr.into_iter() {
        let v = item.map_err(to_napi)?;
        let value = bson_ref_to_js(env, v)?;
        js.set_element(i, value)?;
        i += 1;
    }
    Ok(js)
}

/// A lazily-parsed MongoDB document backed by raw BSON bytes.
#[napi]
pub struct RawDoc {
    pub(crate) raw: Vec<u8>,
}

#[napi]
impl RawDoc {
    /// Parse and return a single field. `undefined` if absent.
    #[napi]
    pub fn get_field(&self, env: Env, name: String) -> napi::Result<JsUnknown> {
        let doc = RawDocument::from_bytes(&self.raw).map_err(to_napi)?;
        match doc.get(name.as_str()).map_err(to_napi)? {
            Some(v) => bson_ref_to_js(&env, v),
            None => Ok(env.get_undefined()?.into_unknown()),
        }
    }

    /// Full parse into a plain JS object (escape hatch for spread/JSON.stringify).
    #[napi]
    pub fn to_object(&self, env: Env) -> napi::Result<JsObject> {
        let doc = RawDocument::from_bytes(&self.raw).map_err(to_napi)?;
        raw_doc_to_object(&env, doc)
    }

    /// Field names without parsing any values.
    #[napi]
    pub fn keys(&self) -> napi::Result<Vec<String>> {
        let doc = RawDocument::from_bytes(&self.raw).map_err(to_napi)?;
        let mut out = Vec::new();
        for pair in doc.iter() {
            let (k, _) = pair.map_err(to_napi)?;
            out.push(k.to_string());
        }
        Ok(out)
    }
}
