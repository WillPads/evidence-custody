//! The ledger: an append-only list of records, each linked to the one before.
//!
//! Rules enforced here (and re-checked by `verify`):
//! - Only **authorized custodians** may hold evidence. The person who opens the
//!   case is authorized automatically; anyone else must be added to the list
//!   (by someone already on it) before they can receive anything.
//! - Only the **current custodian** of an item can transfer it.
//! - A custodian can't be removed from the list while they still hold evidence.

use crate::hash::GENESIS_PREV_HASH;
use crate::record::{Event, Record};
use serde::{Deserialize, Serialize};
use std::fmt;

/// Bumped when the file format changes in an incompatible way.
/// Version 2 added the authorized custodian list and evidence categories.
pub const FORMAT_VERSION: u32 = 2;

/// Role given to whoever opens the case.
pub const CASE_LEAD_ROLE: &str = "Case lead";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Ledger {
    pub format_version: u32,
    pub records: Vec<Record>,
}

/// Everything that can go wrong when *changing* the ledger.
/// (Problems found when *checking* the ledger are `verify::Issue`s instead.)
#[derive(Debug, Clone, PartialEq)]
pub enum LedgerError {
    EmptyField(&'static str),
    UnknownEvidence(u32),
    /// The same file (same hash) was already logged.
    DuplicateEvidence { existing_id: u32 },
    /// Only the person currently holding the evidence may transfer it.
    NotCustodian { evidence_id: u32, custodian: String, actor: String },
    SameCustodian(String),
    /// This person is not (or no longer) on the authorized custodian list.
    NotAuthorized(String),
    AlreadyAuthorized(String),
    /// Can't revoke someone who still holds evidence.
    StillHoldsEvidence { name: String, count: usize },
    /// At least one authorized custodian must remain.
    LastCustodian(String),
    /// We refuse to append to a ledger that already fails verification,
    /// otherwise new records would "bless" a tampered history.
    LedgerBroken { issue_count: usize },
    InvalidFile(String),
}

impl fmt::Display for LedgerError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            LedgerError::EmptyField(name) => write!(f, "{name} must not be empty"),
            LedgerError::UnknownEvidence(id) => write!(f, "there is no evidence #{id} in this ledger"),
            LedgerError::DuplicateEvidence { existing_id } => {
                write!(f, "this exact file is already logged as evidence #{existing_id}")
            }
            LedgerError::NotCustodian { evidence_id, custodian, actor } => write!(
                f,
                "{actor} cannot transfer evidence #{evidence_id}: it is currently held by {custodian}"
            ),
            LedgerError::SameCustodian(name) => write!(f, "{name} already holds this evidence"),
            LedgerError::NotAuthorized(name) => {
                write!(f, "{name} is not on the authorized custodian list")
            }
            LedgerError::AlreadyAuthorized(name) => {
                write!(f, "{name} is already an authorized custodian")
            }
            LedgerError::StillHoldsEvidence { name, count } => write!(
                f,
                "{name} still holds {count} item(s) of evidence; transfer them to another custodian first"
            ),
            LedgerError::LastCustodian(name) => write!(
                f,
                "{name} is the only authorized custodian left; add another before removing them"
            ),
            LedgerError::LedgerBroken { issue_count } => write!(
                f,
                "the ledger failed verification ({issue_count} issue(s)); refusing to add records to a tampered ledger"
            ),
            LedgerError::InvalidFile(msg) => write!(f, "not a valid ledger file: {msg}"),
        }
    }
}

impl std::error::Error for LedgerError {}

/// A per-evidence view built by replaying the records (used for listings).
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct EvidenceSummary {
    pub evidence_id: u32,
    pub category: String,
    pub file_name: String,
    pub file_hash: String,
    pub size_bytes: u64,
    pub description: String,
    pub logged_by: String,
    pub logged_at: String,
    pub custodian: String,
    pub transfer_count: u32,
}

/// One entry on the authorized custodian list, built by replaying the records.
#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Custodian {
    pub name: String,
    pub role: String,
    pub note: String,
    pub authorized_by: String,
    pub authorized_at: String,
    /// false once revoked
    pub active: bool,
    pub revoked_by: Option<String>,
    pub revoked_at: Option<String>,
    pub revoked_reason: Option<String>,
}

/// Names are compared ignoring case and surrounding spaces,
/// so "Atty. Cruz" and "atty. cruz " are the same person.
pub(crate) fn same_name(a: &str, b: &str) -> bool {
    a.trim().to_lowercase() == b.trim().to_lowercase()
}

fn require(value: &str, name: &'static str) -> Result<(), LedgerError> {
    if value.trim().is_empty() {
        Err(LedgerError::EmptyField(name))
    } else {
        Ok(())
    }
}

impl Ledger {
    /// Opens a new ledger for a case. The first record is the "genesis" record,
    /// and `actor` becomes the first authorized custodian.
    pub fn new(case_id: &str, case_title: &str, actor: &str, timestamp: &str) -> Result<Self, LedgerError> {
        require(case_id, "case number")?;
        require(actor, "your name")?;
        require(timestamp, "timestamp")?;
        let genesis = Record::new(
            0,
            timestamp.to_string(),
            actor.trim().to_string(),
            Event::CaseOpened {
                case_id: case_id.trim().to_string(),
                case_title: case_title.trim().to_string(),
            },
            GENESIS_PREV_HASH.to_string(),
        );
        Ok(Ledger { format_version: FORMAT_VERSION, records: vec![genesis] })
    }

    pub fn from_json(json: &str) -> Result<Self, LedgerError> {
        let ledger: Ledger =
            serde_json::from_str(json).map_err(|e| LedgerError::InvalidFile(e.to_string()))?;
        if ledger.format_version != FORMAT_VERSION {
            return Err(LedgerError::InvalidFile(format!(
                "it uses format version {} but this program reads version {FORMAT_VERSION}",
                ledger.format_version
            )));
        }
        Ok(ledger)
    }

    pub fn to_json(&self) -> String {
        serde_json::to_string_pretty(self).expect("serializing a ledger cannot fail")
    }

    /// Hash of the newest record. Writing this down somewhere outside the
    /// ledger (an email, a court filing) lets you later prove the *whole*
    /// ledger wasn't rewritten. See `verify_with_anchor`.
    pub fn head_hash(&self) -> &str {
        self.records.last().map(|r| r.hash.as_str()).unwrap_or(GENESIS_PREV_HASH)
    }

    /// (case_id, case_title) from the genesis record, if present.
    pub fn case_info(&self) -> Option<(&str, &str)> {
        match self.records.first().map(|r| &r.event) {
            Some(Event::CaseOpened { case_id, case_title }) => Some((case_id, case_title)),
            _ => None,
        }
    }

    // ------------------------------------------------------------------
    // Authorized custodian list
    // ------------------------------------------------------------------

    /// Adds a person or organization to the authorized custodian list.
    /// `actor` must already be an authorized custodian.
    pub fn authorize(
        &mut self,
        actor: &str,
        timestamp: &str,
        name: &str,
        role: &str,
        note: &str,
    ) -> Result<(), LedgerError> {
        require(timestamp, "timestamp")?;
        require(name, "name")?;
        require(role, "role")?;
        self.ensure_intact()?;
        let actor = self.require_active(actor)?;
        if let Some(existing) = self.active_custodian(name) {
            return Err(LedgerError::AlreadyAuthorized(existing.name));
        }
        self.append(
            &actor,
            timestamp,
            Event::CustodianAuthorized {
                name: name.trim().to_string(),
                role: role.trim().to_string(),
                note: note.trim().to_string(),
            },
        );
        Ok(())
    }

    /// Removes someone from the authorized list. They must not hold any evidence.
    pub fn revoke(&mut self, actor: &str, timestamp: &str, name: &str, reason: &str) -> Result<(), LedgerError> {
        require(timestamp, "timestamp")?;
        require(name, "name")?;
        self.ensure_intact()?;
        let actor = self.require_active(actor)?;
        let target = self.require_active(name)?;
        let held = self.evidence().iter().filter(|e| same_name(&e.custodian, &target)).count();
        if held > 0 {
            return Err(LedgerError::StillHoldsEvidence { name: target, count: held });
        }
        if self.custodians().iter().filter(|c| c.active).count() <= 1 {
            return Err(LedgerError::LastCustodian(target));
        }
        self.append(
            &actor,
            timestamp,
            Event::CustodianRevoked { name: target, reason: reason.trim().to_string() },
        );
        Ok(())
    }

    /// The full authorized custodian list (including revoked entries), in the
    /// order people were added.
    pub fn custodians(&self) -> Vec<Custodian> {
        let mut list: Vec<Custodian> = Vec::new();
        for record in &self.records {
            match &record.event {
                Event::CaseOpened { .. } => list.push(Custodian {
                    name: record.actor.clone(),
                    role: CASE_LEAD_ROLE.to_string(),
                    note: "Opened the case".to_string(),
                    authorized_by: record.actor.clone(),
                    authorized_at: record.timestamp.clone(),
                    active: true,
                    revoked_by: None,
                    revoked_at: None,
                    revoked_reason: None,
                }),
                Event::CustodianAuthorized { name, role, note } => {
                    let entry = Custodian {
                        name: name.clone(),
                        role: role.clone(),
                        note: note.clone(),
                        authorized_by: record.actor.clone(),
                        authorized_at: record.timestamp.clone(),
                        active: true,
                        revoked_by: None,
                        revoked_at: None,
                        revoked_reason: None,
                    };
                    // Re-authorizing someone who was revoked replaces their old entry.
                    match list.iter_mut().find(|c| same_name(&c.name, name)) {
                        Some(existing) => *existing = entry,
                        None => list.push(entry),
                    }
                }
                Event::CustodianRevoked { name, reason } => {
                    if let Some(c) = list.iter_mut().find(|c| same_name(&c.name, name)) {
                        c.active = false;
                        c.revoked_by = Some(record.actor.clone());
                        c.revoked_at = Some(record.timestamp.clone());
                        c.revoked_reason = Some(reason.clone());
                    }
                }
                Event::EvidenceAdded { .. } | Event::CustodyTransferred { .. } => {}
            }
        }
        list
    }

    /// The active authorized custodian with this name, if any.
    pub fn active_custodian(&self, name: &str) -> Option<Custodian> {
        self.custodians().into_iter().find(|c| c.active && same_name(&c.name, name))
    }

    /// Returns the name exactly as it appears on the list, or NotAuthorized.
    fn require_active(&self, name: &str) -> Result<String, LedgerError> {
        require(name, "name")?;
        self.active_custodian(name)
            .map(|c| c.name)
            .ok_or_else(|| LedgerError::NotAuthorized(name.trim().to_string()))
    }

    // ------------------------------------------------------------------
    // Evidence
    // ------------------------------------------------------------------

    /// Logs a new piece of evidence and returns its evidence number.
    /// The person logging it must be an authorized custodian, and becomes its holder.
    #[allow(clippy::too_many_arguments)]
    pub fn add_evidence(
        &mut self,
        actor: &str,
        timestamp: &str,
        category: &str,
        file_name: &str,
        file_hash: &str,
        size_bytes: u64,
        description: &str,
    ) -> Result<u32, LedgerError> {
        require(timestamp, "timestamp")?;
        require(category, "category")?;
        require(file_name, "file name")?;
        require(file_hash, "file hash")?;
        self.ensure_intact()?;
        let actor = self.require_active(actor)?;

        let file_hash = file_hash.trim().to_lowercase();
        let evidence = self.evidence();
        if let Some(existing) = evidence.iter().find(|e| e.file_hash == file_hash) {
            return Err(LedgerError::DuplicateEvidence { existing_id: existing.evidence_id });
        }
        let evidence_id = evidence.iter().map(|e| e.evidence_id).max().unwrap_or(0) + 1;

        self.append(
            &actor,
            timestamp,
            Event::EvidenceAdded {
                evidence_id,
                category: category.trim().to_string(),
                file_name: file_name.trim().to_string(),
                file_hash,
                size_bytes,
                description: description.trim().to_string(),
            },
        );
        Ok(evidence_id)
    }

    /// Records a custody transfer. `actor` must be the current custodian and
    /// `to` must be on the authorized custodian list.
    pub fn transfer(
        &mut self,
        actor: &str,
        timestamp: &str,
        evidence_id: u32,
        to: &str,
        reason: &str,
    ) -> Result<(), LedgerError> {
        require(actor, "actor")?;
        require(timestamp, "timestamp")?;
        require(to, "receiving custodian")?;
        self.ensure_intact()?;

        let custodian = self
            .current_custodian(evidence_id)
            .ok_or(LedgerError::UnknownEvidence(evidence_id))?;
        if !same_name(&custodian, actor) {
            return Err(LedgerError::NotCustodian {
                evidence_id,
                custodian,
                actor: actor.trim().to_string(),
            });
        }
        let to = self.require_active(to)?;
        if same_name(&custodian, &to) {
            return Err(LedgerError::SameCustodian(custodian));
        }

        self.append(
            &custodian,
            timestamp,
            Event::CustodyTransferred {
                evidence_id,
                from: custodian.clone(),
                to,
                reason: reason.trim().to_string(),
            },
        );
        Ok(())
    }

    /// Who holds a piece of evidence right now (replays the history).
    pub fn current_custodian(&self, evidence_id: u32) -> Option<String> {
        self.evidence()
            .into_iter()
            .find(|e| e.evidence_id == evidence_id)
            .map(|e| e.custodian)
    }

    /// All evidence with its current state, in the order it was logged.
    pub fn evidence(&self) -> Vec<EvidenceSummary> {
        let mut items: Vec<EvidenceSummary> = Vec::new();
        for record in &self.records {
            match &record.event {
                Event::EvidenceAdded { evidence_id, category, file_name, file_hash, size_bytes, description } => {
                    items.push(EvidenceSummary {
                        evidence_id: *evidence_id,
                        category: category.clone(),
                        file_name: file_name.clone(),
                        file_hash: file_hash.clone(),
                        size_bytes: *size_bytes,
                        description: description.clone(),
                        logged_by: record.actor.clone(),
                        logged_at: record.timestamp.clone(),
                        custodian: record.actor.clone(),
                        transfer_count: 0,
                    });
                }
                Event::CustodyTransferred { evidence_id, to, .. } => {
                    if let Some(item) = items.iter_mut().find(|e| e.evidence_id == *evidence_id) {
                        item.custodian = to.clone();
                        item.transfer_count += 1;
                    }
                }
                Event::CaseOpened { .. } | Event::CustodianAuthorized { .. } | Event::CustodianRevoked { .. } => {}
            }
        }
        items
    }

    /// Finds which logged evidence (if any) has exactly this fingerprint.
    /// Lets someone drop in a file and ask "is this one of ours, unchanged?"
    /// without needing to know its evidence number.
    pub fn find_by_hash(&self, file_hash: &str) -> Option<EvidenceSummary> {
        let wanted = file_hash.trim().to_lowercase();
        self.evidence().into_iter().find(|e| e.file_hash == wanted)
    }

    /// All records that mention one piece of evidence (its custody history).
    pub fn history(&self, evidence_id: u32) -> Vec<&Record> {
        self.records
            .iter()
            .filter(|r| match &r.event {
                Event::EvidenceAdded { evidence_id: id, .. }
                | Event::CustodyTransferred { evidence_id: id, .. } => *id == evidence_id,
                _ => false,
            })
            .collect()
    }

    fn ensure_intact(&self) -> Result<(), LedgerError> {
        let report = self.verify();
        if report.ok {
            Ok(())
        } else {
            Err(LedgerError::LedgerBroken { issue_count: report.issues.len() })
        }
    }

    /// The only place new records are created: always links to the current head.
    fn append(&mut self, actor: &str, timestamp: &str, event: Event) {
        let record = Record::new(
            self.records.len() as u64,
            timestamp.to_string(),
            actor.trim().to_string(),
            event,
            self.head_hash().to_string(),
        );
        self.records.push(record);
    }
}
