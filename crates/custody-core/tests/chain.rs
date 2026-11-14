//! Tests for the core rules. Each tampering test does one realistic thing an
//! attacker might try, then checks that `verify` catches it and says where.

use custody_core::{hash_bytes, Event, Ledger, LedgerError, Record};

const T0: &str = "2026-11-14T01:00:00Z";
const T1: &str = "2026-11-14T02:00:00Z";
const T2: &str = "2026-11-14T03:00:00Z";
const T3: &str = "2026-11-14T04:00:00Z";
const T4: &str = "2026-11-14T05:00:00Z";
const LATER: &str = "2026-11-15T00:00:00Z";

/// A small realistic case:
/// #0 case opened   #1 lab authorized   #2 phone image added
/// #3 CCTV added    #4 phone image transferred to the lab
fn sample() -> Ledger {
    let mut ledger = Ledger::new("CV-2026-0142", "Sample v. Example", "Atty. Cruz", T0).unwrap();
    ledger.authorize("Atty. Cruz", T1, "Forensics Lab", "Forensic laboratory", "Accredited").unwrap();
    ledger
        .add_evidence("Atty. Cruz", T2, "Device extraction", "phone_image.bin", &hash_bytes(b"phone"), 5, "Forensic image")
        .unwrap();
    ledger
        .add_evidence("Atty. Cruz", T3, "Video recording", "cctv.mp4", &hash_bytes(b"cctv"), 4, "CCTV footage")
        .unwrap();
    ledger.transfer("Atty. Cruz", T4, 1, "Forensics Lab", "For analysis").unwrap();
    ledger
}

fn kinds(ledger: &Ledger) -> Vec<(Option<u64>, &'static str)> {
    ledger.verify().issues.iter().map(|i| (i.record_index, i.kind)).collect()
}

/// Appends a correctly hashed and linked record WITHOUT going through the
/// rules, i.e. what an attacker who knows the algorithm could produce.
fn forge(ledger: &mut Ledger, actor: &str, ts: &str, event: Event) {
    let record = Record::new(
        ledger.records.len() as u64,
        ts.into(),
        actor.into(),
        event,
        ledger.head_hash().to_string(),
    );
    ledger.records.push(record);
}

// ---------- Normal use ----------

#[test]
fn untouched_ledger_verifies() {
    let report = sample().verify();
    assert!(report.ok, "{:?}", report.issues);
    assert_eq!(report.records_checked, 5);
}

#[test]
fn records_are_linked() {
    let ledger = sample();
    for pair in ledger.records.windows(2) {
        assert_eq!(pair[1].prev_hash, pair[0].hash);
    }
}

#[test]
fn custody_follows_transfers() {
    let ledger = sample();
    assert_eq!(ledger.current_custodian(1).as_deref(), Some("Forensics Lab"));
    assert_eq!(ledger.current_custodian(2).as_deref(), Some("Atty. Cruz"));
    assert_eq!(ledger.history(1).len(), 2);
}

#[test]
fn categories_are_recorded() {
    let ledger = sample();
    let items = ledger.evidence();
    assert_eq!(items[0].category, "Device extraction");
    assert_eq!(items[1].category, "Video recording");
}

#[test]
fn json_round_trip_keeps_ledger_valid() {
    let ledger = sample();
    let reloaded = Ledger::from_json(&ledger.to_json()).unwrap();
    assert_eq!(reloaded, ledger);
    assert!(reloaded.verify().ok);
}

#[test]
fn old_format_is_rejected_clearly() {
    let json = sample().to_json().replace("\"format_version\": 2", "\"format_version\": 1");
    let err = Ledger::from_json(&json).unwrap_err();
    assert!(err.to_string().contains("format version 1"));
}

// ---------- Authorized custodian list ----------

#[test]
fn case_opener_is_first_custodian() {
    let ledger = Ledger::new("C-1", "t", "Atty. Cruz", T0).unwrap();
    let list = ledger.custodians();
    assert_eq!(list.len(), 1);
    assert_eq!(list[0].name, "Atty. Cruz");
    assert!(list[0].active);
}

#[test]
fn cannot_transfer_to_someone_not_on_the_list() {
    let mut ledger = sample();
    let err = ledger.transfer("Atty. Cruz", LATER, 2, "Random Courier", "").unwrap_err();
    assert_eq!(err, LedgerError::NotAuthorized("Random Courier".into()));
}

#[test]
fn names_match_ignoring_case_and_spaces() {
    let mut ledger = sample();
    ledger.transfer("atty. cruz", LATER, 2, "  forensics lab ", "").unwrap();
    // Stored with the exact spelling from the list.
    assert_eq!(ledger.current_custodian(2).as_deref(), Some("Forensics Lab"));
    assert!(ledger.verify().ok);
}

#[test]
fn only_listed_people_can_add_evidence_or_authorize() {
    let mut ledger = sample();
    let err = ledger
        .add_evidence("Stranger", LATER, "Document", "x.pdf", &hash_bytes(b"x"), 1, "")
        .unwrap_err();
    assert_eq!(err, LedgerError::NotAuthorized("Stranger".into()));
    let err = ledger.authorize("Stranger", LATER, "Friend", "Courier", "").unwrap_err();
    assert_eq!(err, LedgerError::NotAuthorized("Stranger".into()));
}

#[test]
fn cannot_authorize_twice() {
    let mut ledger = sample();
    let err = ledger.authorize("Atty. Cruz", LATER, "FORENSICS LAB", "Lab", "").unwrap_err();
    assert_eq!(err, LedgerError::AlreadyAuthorized("Forensics Lab".into()));
}

#[test]
fn cannot_revoke_someone_holding_evidence() {
    let mut ledger = sample();
    let err = ledger.revoke("Atty. Cruz", LATER, "Forensics Lab", "Contract ended").unwrap_err();
    assert_eq!(err, LedgerError::StillHoldsEvidence { name: "Forensics Lab".into(), count: 1 });
}

#[test]
fn revoked_custodian_cannot_receive_again() {
    let mut ledger = sample();
    ledger.transfer("Forensics Lab", LATER, 1, "Atty. Cruz", "Returned").unwrap();
    ledger.revoke("Atty. Cruz", LATER, "Forensics Lab", "Contract ended").unwrap();
    assert!(!ledger.custodians()[1].active);
    let err = ledger.transfer("Atty. Cruz", LATER, 1, "Forensics Lab", "").unwrap_err();
    assert!(matches!(err, LedgerError::NotAuthorized(_)));
    // ...until they are authorized again.
    ledger.authorize("Atty. Cruz", LATER, "Forensics Lab", "Forensic laboratory", "Renewed").unwrap();
    ledger.transfer("Atty. Cruz", LATER, 1, "Forensics Lab", "").unwrap();
    assert!(ledger.verify().ok, "{:?}", ledger.verify().issues);
}

#[test]
fn cannot_revoke_last_custodian() {
    let mut ledger = Ledger::new("C-1", "t", "Atty. Cruz", T0).unwrap();
    let err = ledger.revoke("Atty. Cruz", T1, "Atty. Cruz", "").unwrap_err();
    assert_eq!(err, LedgerError::LastCustodian("Atty. Cruz".into()));
}

// ---------- Evidence rules ----------

#[test]
fn only_current_custodian_can_transfer() {
    let mut ledger = sample();
    let err = ledger.transfer("Atty. Cruz", LATER, 1, "Atty. Cruz", "x").unwrap_err();
    assert!(matches!(err, LedgerError::NotCustodian { .. }));
}

#[test]
fn cannot_transfer_unknown_evidence() {
    let mut ledger = sample();
    assert_eq!(
        ledger.transfer("Atty. Cruz", LATER, 99, "Forensics Lab", "").unwrap_err(),
        LedgerError::UnknownEvidence(99)
    );
}

#[test]
fn cannot_log_same_file_twice() {
    let mut ledger = sample();
    let err = ledger
        .add_evidence("Atty. Cruz", LATER, "Document", "copy.bin", &hash_bytes(b"phone"), 5, "")
        .unwrap_err();
    assert_eq!(err, LedgerError::DuplicateEvidence { existing_id: 1 });
}

#[test]
fn category_is_required() {
    let mut ledger = sample();
    let err = ledger
        .add_evidence("Atty. Cruz", LATER, " ", "new.pdf", &hash_bytes(b"new"), 3, "")
        .unwrap_err();
    assert_eq!(err, LedgerError::EmptyField("category"));
}

#[test]
fn refuses_to_append_to_tampered_ledger() {
    let mut ledger = sample();
    ledger.records[2].actor = "Someone Else".into();
    let err = ledger
        .add_evidence("Atty. Cruz", LATER, "Document", "new.bin", &hash_bytes(b"new"), 3, "")
        .unwrap_err();
    assert!(matches!(err, LedgerError::LedgerBroken { .. }));
}

#[test]
fn empty_names_rejected() {
    assert_eq!(Ledger::new(" ", "t", "a", T0).unwrap_err(), LedgerError::EmptyField("case number"));
}

// ---------- Tampering ----------

#[test]
fn detects_edited_record() {
    let mut ledger = sample();
    // Quietly change the evidence description, leave the stored hash alone.
    if let Event::EvidenceAdded { description, .. } = &mut ledger.records[2].event {
        *description = "Nothing important".into();
    }
    assert_eq!(kinds(&ledger), vec![(Some(2), "hash_mismatch")]);
}

#[test]
fn detects_edited_record_even_if_hash_recomputed() {
    let mut ledger = sample();
    // A smarter attacker also fixes up the record's own hash...
    if let Event::EvidenceAdded { file_hash, .. } = &mut ledger.records[2].event {
        *file_hash = hash_bytes(b"swapped file");
    }
    ledger.records[2].hash = ledger.records[2].compute_hash();
    // ...but the NEXT record still points at the old hash.
    assert_eq!(kinds(&ledger), vec![(Some(3), "broken_link")]);
}

#[test]
fn detects_deleted_record() {
    let mut ledger = sample();
    ledger.records.remove(3);
    let found = kinds(&ledger);
    assert!(found.contains(&(Some(3), "index_mismatch")));
    assert!(found.contains(&(Some(3), "broken_link")));
}

#[test]
fn detects_reordered_records() {
    let mut ledger = sample();
    ledger.records.swap(2, 3);
    assert!(!ledger.verify().ok);
}

#[test]
fn detects_forged_transfer() {
    let mut ledger = sample();
    // Rewrite who the hand-over came from and rebuild the hash,
    // so only the history check can catch it.
    if let Event::CustodyTransferred { from, .. } = &mut ledger.records[4].event {
        *from = "Unknown Person".into();
    }
    ledger.records[4].hash = ledger.records[4].compute_hash();
    assert_eq!(kinds(&ledger), vec![(Some(4), "invalid_transfer")]);
}

#[test]
fn detects_forged_transfer_to_unauthorized_person() {
    let mut ledger = sample();
    // Perfectly hashed and linked, but the recipient was never authorized.
    forge(&mut ledger, "Atty. Cruz", LATER, Event::CustodyTransferred {
        evidence_id: 2,
        from: "Atty. Cruz".into(),
        to: "Random Courier".into(),
        reason: String::new(),
    });
    assert_eq!(kinds(&ledger), vec![(Some(5), "unauthorized_recipient")]);
}

#[test]
fn detects_forged_entry_by_unauthorized_person() {
    let mut ledger = sample();
    forge(&mut ledger, "Stranger", LATER, Event::CustodianAuthorized {
        name: "Accomplice".into(),
        role: "Courier".into(),
        note: String::new(),
    });
    assert_eq!(kinds(&ledger), vec![(Some(5), "unauthorized_actor")]);
}

#[test]
fn detects_forged_revocation_while_holding() {
    let mut ledger = sample();
    forge(&mut ledger, "Atty. Cruz", LATER, Event::CustodianRevoked {
        name: "Forensics Lab".into(),
        reason: String::new(),
    });
    assert_eq!(kinds(&ledger), vec![(Some(5), "revoked_while_holding")]);
}

#[test]
fn detects_backdated_record() {
    let mut ledger = Ledger::new("C-1", "t", "A", T2).unwrap();
    ledger.add_evidence("A", T1, "Document", "f", &hash_bytes(b"f"), 1, "").unwrap();
    assert_eq!(kinds(&ledger), vec![(Some(1), "time_reversed")]);
}

#[test]
fn anchor_detects_full_rewrite() {
    let original = sample();
    let anchor = original.head_hash().to_string(); // e.g. emailed to the client

    // Attacker rebuilds an entirely consistent fake history.
    let mut fake = Ledger::new("CV-2026-0142", "Sample v. Example", "Atty. Cruz", T0).unwrap();
    fake.add_evidence("Atty. Cruz", T1, "Device extraction", "phone_image.bin", &hash_bytes(b"FAKE"), 4, "Forensic image")
        .unwrap();
    assert!(fake.verify().ok, "the fake is internally consistent");

    let report = fake.verify_with_anchor(&anchor);
    assert!(!report.ok);
    assert_eq!(report.issues[0].kind, "anchor_missing");
    assert!(original.verify_with_anchor(&anchor).ok);
}

#[test]
fn anchor_still_valid_after_new_records() {
    let mut ledger = sample();
    let anchor = ledger.head_hash().to_string();
    ledger.add_evidence("Atty. Cruz", LATER, "Document", "later.pdf", &hash_bytes(b"later"), 5, "")
        .unwrap();
    assert!(ledger.verify_with_anchor(&anchor).ok);
}

// ---------- File checks ----------

#[test]
fn file_check_matches_and_mismatches() {
    let ledger = sample();
    assert!(ledger.check_file(1, &hash_bytes(b"phone")).unwrap().matches);
    assert!(!ledger.check_file(1, &hash_bytes(b"phonE")).unwrap().matches);
    assert_eq!(ledger.check_file(7, "abc").unwrap_err(), LedgerError::UnknownEvidence(7));
}

#[test]
fn find_by_hash_identifies_files() {
    let ledger = sample();
    let found = ledger.find_by_hash(&hash_bytes(b"cctv").to_uppercase()).unwrap();
    assert_eq!(found.evidence_id, 2);
    assert_eq!(found.file_name, "cctv.mp4");
    assert!(ledger.find_by_hash(&hash_bytes(b"cctv edited")).is_none());
}

#[test]
fn invalid_json_is_an_error_not_a_crash() {
    assert!(matches!(Ledger::from_json("{not json"), Err(LedgerError::InvalidFile(_))));
}
