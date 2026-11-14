//! # custody-core
//!
//! A tamper-evident **chain-of-custody ledger** for digital evidence.
//!
//! The idea in one sentence: every record stores the SHA-256 hash of the
//! record before it, so changing, deleting or reordering any past record
//! breaks every link after it — and `verify` points to exactly where.
//!
//! This crate has no file or network I/O on purpose. The CLI and the web app
//! both call into it, so the rules live in exactly one place.
//!
//! Modules:
//! - [`hash`]   — SHA-256 helpers (file fingerprints and record hashes)
//! - [`record`] — what one entry in the ledger looks like
//! - [`ledger`] — the chain itself: create, add evidence, transfer custody
//! - [`verify`] — re-checks the whole chain and reports problems

pub mod hash;
pub mod ledger;
pub mod record;
pub mod verify;

pub use hash::{hash_bytes, hash_reader, GENESIS_PREV_HASH};
pub use ledger::{Custodian, EvidenceSummary, Ledger, LedgerError, CASE_LEAD_ROLE, FORMAT_VERSION};
pub use record::{Event, Record};
pub use verify::{FileCheck, Issue, VerifyReport};
