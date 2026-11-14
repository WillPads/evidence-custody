//! Verification: walks the whole chain and reports every problem it finds.

use crate::hash::GENESIS_PREV_HASH;
use crate::ledger::{same_name, Ledger, LedgerError};
use crate::record::Event;
use serde::Serialize;
use std::collections::{HashMap, HashSet};

/// One problem found during verification.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Issue {
    /// Which record the problem is in (None = the ledger as a whole).
    pub record_index: Option<u64>,
    /// Short machine-readable code, e.g. "hash_mismatch".
    pub kind: &'static str,
    /// Plain-English explanation for a person.
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct VerifyReport {
    pub ok: bool,
    pub records_checked: usize,
    pub head_hash: String,
    pub issues: Vec<Issue>,
}

/// Result of comparing a file on hand against what was logged.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct FileCheck {
    pub evidence_id: u32,
    pub file_name: String,
    pub logged_hash: String,
    pub actual_hash: String,
    pub matches: bool,
}

impl Ledger {
    /// Checks, for every record:
    /// 1. its position number is correct (catches deleted / reordered records)
    /// 2. its `prev_hash` equals the previous record's hash (the chain link)
    /// 3. its stored hash equals a fresh hash of its contents (catches edits)
    /// 4. the history makes sense: evidence exists, only the holder transfers it,
    ///    only authorized custodians act or receive evidence, nobody is removed
    ///    from the list while holding evidence, time never runs backwards, and
    ///    there is exactly one "case opened" record, first
    pub fn verify(&self) -> VerifyReport {
        let mut issues = Vec::new();
        let mut issue = |index: Option<u64>, kind: &'static str, message: String| {
            issues.push(Issue { record_index: index, kind, message });
        };

        if self.records.is_empty() {
            issue(None, "empty_ledger", "The ledger has no records at all.".into());
        }

        // Rebuilt as we walk the chain:
        //   holders:    evidence id -> who holds it at this point
        //   authorized: names (lower-case) on the authorized custodian list at this point
        let mut holders: HashMap<u32, String> = HashMap::new();
        let mut authorized: HashSet<String> = HashSet::new();
        let key = |name: &str| name.trim().to_lowercase();
        let mut previous_timestamp: Option<&str> = None;

        for (position, record) in self.records.iter().enumerate() {
            let at = Some(position as u64);

            // 1. Position
            if record.index != position as u64 {
                issue(at, "index_mismatch", format!(
                    "Record at position {position} says it is record #{}. A record was deleted, inserted or moved.",
                    record.index
                ));
            }

            // 2. Link to the previous record
            let expected_prev = if position == 0 {
                GENESIS_PREV_HASH
            } else {
                self.records[position - 1].hash.as_str()
            };
            if record.prev_hash != expected_prev {
                issue(at, "broken_link", format!(
                    "Record #{position} does not link to the record before it (expected prev_hash {}…, found {}…).",
                    short(expected_prev),
                    short(&record.prev_hash)
                ));
            }

            // 3. Contents vs. stored hash
            let recomputed = record.compute_hash();
            if recomputed != record.hash {
                issue(at, "hash_mismatch", format!(
                    "Record #{position} was modified after it was written (stored hash {}…, contents now hash to {}…).",
                    short(&record.hash),
                    short(&recomputed)
                ));
            }

            // 4. Does the history make sense?
            if let Some(prev) = previous_timestamp {
                if record.timestamp.as_str() < prev {
                    issue(at, "time_reversed", format!(
                        "Record #{position} is dated {} which is earlier than the record before it ({prev}).",
                        record.timestamp
                    ));
                }
            }
            previous_timestamp = Some(&record.timestamp);

            let is_case_opened = matches!(record.event, Event::CaseOpened { .. });
            if position == 0 && !is_case_opened {
                issue(at, "missing_case_opened", "The first record must open the case.".into());
            }
            // Everything except opening the case must be done by an authorized custodian.
            if !is_case_opened && !authorized.contains(&key(&record.actor)) {
                issue(at, "unauthorized_actor", format!(
                    "Record #{position} was made by {}, who was not an authorized custodian at that time.",
                    record.actor
                ));
            }

            match &record.event {
                Event::CaseOpened { .. } => {
                    if position != 0 {
                        issue(at, "unexpected_case_opened", format!(
                            "Record #{position} opens a case, but only the first record may do that."
                        ));
                    }
                    authorized.insert(key(&record.actor));
                }
                Event::CustodianAuthorized { name, .. } => {
                    if !authorized.insert(key(name)) {
                        issue(at, "duplicate_authorization", format!(
                            "Record #{position} authorizes {name}, who was already authorized."
                        ));
                    }
                }
                Event::CustodianRevoked { name, .. } => {
                    if !authorized.remove(&key(name)) {
                        issue(at, "unknown_custodian", format!(
                            "Record #{position} revokes {name}, who was not an authorized custodian."
                        ));
                    }
                    if holders.values().any(|h| same_name(h, name)) {
                        issue(at, "revoked_while_holding", format!(
                            "Record #{position} revokes {name} while they still held evidence."
                        ));
                    }
                }
                Event::EvidenceAdded { evidence_id, .. } => {
                    if holders.contains_key(evidence_id) {
                        issue(at, "duplicate_evidence_id", format!(
                            "Record #{position} reuses evidence number #{evidence_id}."
                        ));
                    }
                    holders.insert(*evidence_id, record.actor.clone());
                }
                Event::CustodyTransferred { evidence_id, from, to, .. } => {
                    match holders.get(evidence_id) {
                        None => issue(at, "unknown_evidence", format!(
                            "Record #{position} transfers evidence #{evidence_id}, which was never logged."
                        )),
                        Some(holder) => {
                            if !same_name(holder, from) || !same_name(&record.actor, from) {
                                issue(at, "invalid_transfer", format!(
                                    "Record #{position}: {} transferred evidence #{evidence_id} \"from {from}\", but it was held by {holder}.",
                                    record.actor
                                ));
                            }
                        }
                    }
                    if !authorized.contains(&key(to)) {
                        issue(at, "unauthorized_recipient", format!(
                            "Record #{position} transfers evidence #{evidence_id} to {to}, who was not an authorized custodian at that time."
                        ));
                    }
                    holders.insert(*evidence_id, to.clone());
                }
            }
        }

        VerifyReport {
            ok: issues.is_empty(),
            records_checked: self.records.len(),
            head_hash: self.head_hash().to_string(),
            issues,
        }
    }

    /// Same as `verify`, plus: the `anchor` hash (a head hash written down
    /// earlier, outside the ledger) must still appear in the chain.
    ///
    /// Why: someone with write access could rewrite *every* record and
    /// recompute all the hashes, producing a chain that is internally
    /// consistent. They can't change a hash you already emailed to a client
    /// or printed in a filing, though.
    pub fn verify_with_anchor(&self, anchor: &str) -> VerifyReport {
        let mut report = self.verify();
        let anchor = anchor.trim().to_lowercase();
        if !self.records.iter().any(|r| r.hash == anchor) {
            report.issues.push(Issue {
                record_index: None,
                kind: "anchor_missing",
                message: format!(
                    "The anchor hash {}… is not in this ledger. The history was rewritten, or this is a different ledger.",
                    short(&anchor)
                ),
            });
            report.ok = false;
        }
        report
    }

    /// Compares a file's current hash with the hash recorded when it was logged.
    pub fn check_file(&self, evidence_id: u32, actual_hash: &str) -> Result<FileCheck, LedgerError> {
        let item = self
            .evidence()
            .into_iter()
            .find(|e| e.evidence_id == evidence_id)
            .ok_or(LedgerError::UnknownEvidence(evidence_id))?;
        let actual_hash = actual_hash.trim().to_lowercase();
        Ok(FileCheck {
            evidence_id,
            matches: item.file_hash == actual_hash,
            file_name: item.file_name,
            logged_hash: item.file_hash,
            actual_hash,
        })
    }
}

/// First 12 characters of a hash, for readable messages.
/// (Counts characters, not bytes, so odd input can't cause a panic.)
fn short(hash: &str) -> String {
    hash.chars().take(12).collect()
}
