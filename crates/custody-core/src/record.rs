//! One entry ("record") in the ledger.

use crate::hash::hash_bytes;
use serde::{Deserialize, Serialize};

/// What happened. Stored in JSON with a `"type"` field, e.g.
/// `{ "type": "evidence_added", "evidence_id": 1, ... }`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum Event {
    /// Always the first record: opens the ledger for one case.
    /// The person who opens it is automatically the first authorized custodian.
    CaseOpened { case_id: String, case_title: String },

    /// A person or organization was added to the authorized custodian list.
    /// Only people on this list may receive or hold evidence.
    CustodianAuthorized { name: String, role: String, note: String },

    /// A custodian was removed from the authorized list.
    CustodianRevoked { name: String, reason: String },

    /// A piece of evidence was logged. `file_hash` is the file's fingerprint
    /// at the moment it was logged.
    EvidenceAdded {
        evidence_id: u32,
        /// e.g. "Document", "Photograph", or a custom category
        category: String,
        file_name: String,
        file_hash: String,
        size_bytes: u64,
        description: String,
    },

    /// Custody of one piece of evidence moved from one person to another.
    CustodyTransferred {
        evidence_id: u32,
        from: String,
        to: String,
        reason: String,
    },
}

/// A full record as saved in the ledger file.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Record {
    /// Position in the chain: 0, 1, 2, ...
    pub index: u64,
    /// When it happened (RFC 3339 / ISO 8601, UTC), e.g. "2026-11-14T04:30:00Z".
    pub timestamp: String,
    /// Who performed the action.
    pub actor: String,
    pub event: Event,
    /// Hash of the previous record — this is the "link" in the chain.
    pub prev_hash: String,
    /// Hash of this record's own contents (everything above).
    pub hash: String,
}

/// The exact fields that go into a record's hash. Everything except `hash`
/// itself (a record can't contain its own fingerprint).
///
/// serde_json always writes struct fields in the order they're declared, so
/// the same record always produces the same bytes, and therefore the same hash.
#[derive(Serialize)]
struct HashInput<'a> {
    index: u64,
    timestamp: &'a str,
    actor: &'a str,
    event: &'a Event,
    prev_hash: &'a str,
}

impl Record {
    /// Builds a record and computes its hash.
    pub fn new(index: u64, timestamp: String, actor: String, event: Event, prev_hash: String) -> Self {
        let mut record = Record {
            index,
            timestamp,
            actor,
            event,
            prev_hash,
            hash: String::new(),
        };
        record.hash = record.compute_hash();
        record
    }

    /// Recomputes what this record's hash *should* be from its contents.
    /// If someone edited the record, this won't match the stored `hash`.
    pub fn compute_hash(&self) -> String {
        let input = HashInput {
            index: self.index,
            timestamp: &self.timestamp,
            actor: &self.actor,
            event: &self.event,
            prev_hash: &self.prev_hash,
        };
        let bytes = serde_json::to_vec(&input).expect("serializing a record cannot fail");
        hash_bytes(&bytes)
    }

    /// Short human-readable description used by the CLI and the web app.
    pub fn describe(&self) -> String {
        match &self.event {
            Event::CaseOpened { case_id, case_title } => {
                format!("Case opened: {case_id} — {case_title}")
            }
            Event::CustodianAuthorized { name, role, .. } => {
                format!("Authorized custodian added: {name} ({role})")
            }
            Event::CustodianRevoked { name, .. } => {
                format!("Custodian authorization revoked: {name}")
            }
            Event::EvidenceAdded { evidence_id, category, file_name, size_bytes, .. } => {
                format!("Evidence #{evidence_id} logged: {file_name} [{category}] ({size_bytes} bytes)")
            }
            Event::CustodyTransferred { evidence_id, from, to, .. } => {
                format!("Evidence #{evidence_id} custody transferred: {from} → {to}")
            }
        }
    }
}
