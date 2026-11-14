//! Browser bindings.
//!
//! `#[wasm_bindgen]` makes a Rust function callable from JavaScript.
//! To keep the boundary simple, the ledger crosses it as a JSON string:
//! JavaScript holds the JSON, Rust parses it, applies the change, verifies,
//! and hands back the new JSON. Every rule still runs in Rust.
//!
//! Errors come back to JavaScript as thrown exceptions with a readable message.
//! (Browsers can't read the clock from plain WebAssembly, so the page passes
//! the timestamp in.)

use custody_core::{hash_bytes, Ledger};
use wasm_bindgen::prelude::*;

fn to_js_err(e: impl std::fmt::Display) -> JsValue {
    JsValue::from_str(&e.to_string())
}

fn parse(json: &str) -> Result<Ledger, JsValue> {
    Ledger::from_json(json).map_err(to_js_err)
}

fn to_json<T: serde::Serialize>(value: &T) -> String {
    serde_json::to_string(value).expect("serializable")
}

/// SHA-256 of a file's bytes (the page reads the file, Rust hashes it).
#[wasm_bindgen(js_name = hashBytes)]
pub fn hash_bytes_js(data: &[u8]) -> String {
    hash_bytes(data)
}

#[wasm_bindgen(js_name = newLedger)]
pub fn new_ledger(case_id: &str, case_title: &str, actor: &str, timestamp: &str) -> Result<String, JsValue> {
    Ok(Ledger::new(case_id, case_title, actor, timestamp).map_err(to_js_err)?.to_json())
}

/// Adds someone to the authorized custodian list. Returns the new ledger JSON.
#[wasm_bindgen]
pub fn authorize(
    ledger_json: &str,
    actor: &str,
    timestamp: &str,
    name: &str,
    role: &str,
    note: &str,
) -> Result<String, JsValue> {
    let mut ledger = parse(ledger_json)?;
    ledger.authorize(actor, timestamp, name, role, note).map_err(to_js_err)?;
    Ok(ledger.to_json())
}

/// Removes someone from the authorized custodian list. Returns the new ledger JSON.
#[wasm_bindgen]
pub fn revoke(ledger_json: &str, actor: &str, timestamp: &str, name: &str, reason: &str) -> Result<String, JsValue> {
    let mut ledger = parse(ledger_json)?;
    ledger.revoke(actor, timestamp, name, reason).map_err(to_js_err)?;
    Ok(ledger.to_json())
}

/// Returns `{ "ledger": "<new json>", "evidenceId": 3 }`.
#[wasm_bindgen(js_name = addEvidence)]
#[allow(clippy::too_many_arguments)]
pub fn add_evidence(
    ledger_json: &str,
    actor: &str,
    timestamp: &str,
    category: &str,
    file_name: &str,
    file_hash: &str,
    size_bytes: f64, // JavaScript numbers are f64
    description: &str,
) -> Result<String, JsValue> {
    let mut ledger = parse(ledger_json)?;
    let id = ledger
        .add_evidence(actor, timestamp, category, file_name, file_hash, size_bytes as u64, description)
        .map_err(to_js_err)?;
    Ok(format!(r#"{{"ledger":{},"evidenceId":{id}}}"#, to_json(&ledger.to_json())))
}

#[wasm_bindgen]
pub fn transfer(
    ledger_json: &str,
    actor: &str,
    timestamp: &str,
    evidence_id: u32,
    to: &str,
    reason: &str,
) -> Result<String, JsValue> {
    let mut ledger = parse(ledger_json)?;
    ledger.transfer(actor, timestamp, evidence_id, to, reason).map_err(to_js_err)?;
    Ok(ledger.to_json())
}

/// Verification report as JSON. `anchor` may be an empty string.
#[wasm_bindgen]
pub fn verify(ledger_json: &str, anchor: &str) -> Result<String, JsValue> {
    let ledger = parse(ledger_json)?;
    let report = if anchor.trim().is_empty() {
        ledger.verify()
    } else {
        ledger.verify_with_anchor(anchor)
    };
    Ok(to_json(&report))
}

/// `{ "case": {...}, "evidence": [...], "records": [{..., "summary": "..."}] }`
#[wasm_bindgen]
pub fn summary(ledger_json: &str) -> Result<String, JsValue> {
    let ledger = parse(ledger_json)?;
    let (case_id, case_title) = ledger.case_info().unwrap_or(("?", ""));
    let records: Vec<serde_json::Value> = ledger
        .records
        .iter()
        .map(|r| {
            let mut value = serde_json::to_value(r).expect("serializable");
            value["summary"] = serde_json::Value::String(r.describe());
            value
        })
        .collect();
    Ok(serde_json::json!({
        "case": { "id": case_id, "title": case_title },
        "headHash": ledger.head_hash(),
        "evidence": ledger.evidence(),
        "custodians": ledger.custodians(),
        "records": records,
    })
    .to_string())
}

/// Tamper-lab only: recomputes one record's hash after it was edited, the way
/// an attacker who knows the algorithm would. Verification still catches it,
/// because the *next* record keeps pointing at the old hash.
#[wasm_bindgen(js_name = rehashRecord)]
pub fn rehash_record(ledger_json: &str, index: u32) -> Result<String, JsValue> {
    let mut ledger = parse(ledger_json)?;
    let record = ledger
        .records
        .get_mut(index as usize)
        .ok_or_else(|| to_js_err(format!("no record #{index}")))?;
    record.hash = record.compute_hash();
    Ok(ledger.to_json())
}

/// Which evidence has this exact fingerprint? Returns the item as JSON, or "null".
#[wasm_bindgen(js_name = findFile)]
pub fn find_file(ledger_json: &str, file_hash: &str) -> Result<String, JsValue> {
    let ledger = parse(ledger_json)?;
    Ok(to_json(&ledger.find_by_hash(file_hash)))
}

#[wasm_bindgen(js_name = checkFile)]
pub fn check_file(ledger_json: &str, evidence_id: u32, actual_hash: &str) -> Result<String, JsValue> {
    let ledger = parse(ledger_json)?;
    Ok(to_json(&ledger.check_file(evidence_id, actual_hash).map_err(to_js_err)?))
}
