//! End-to-end tests: run the real `custody` program the way a user would.

use std::fs;
use std::path::PathBuf;
use std::process::{Command, Output};

/// A fresh, empty folder per test.
fn workspace(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("custody-test-{name}-{}", std::process::id()));
    let _ = fs::remove_dir_all(&dir);
    fs::create_dir_all(&dir).unwrap();
    dir
}

fn custody(dir: &PathBuf, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_custody"))
        .current_dir(dir)
        .env("NO_COLOR", "1")
        .args(args)
        .output()
        .expect("failed to run custody")
}

fn text(out: &Output) -> String {
    format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr))
}

fn setup(name: &str) -> PathBuf {
    let dir = workspace(name);
    fs::write(dir.join("photo.jpg"), b"original photo bytes").unwrap();
    assert!(custody(&dir, &["init", "--case", "CV-1", "--title", "Test", "--by", "Atty. Cruz"]).status.success());
    assert!(custody(&dir, &["add", "photo.jpg", "--by", "Atty. Cruz", "--category", "Photograph", "--desc", "Scene photo"]).status.success());
    dir
}

#[test]
fn happy_path_verifies() {
    let dir = setup("happy");
    let out = custody(&dir, &["authorize", "Lab", "--role", "Forensic laboratory", "--by", "Atty. Cruz"]);
    assert!(out.status.success(), "{}", text(&out));
    let out = custody(&dir, &["transfer", "1", "--by", "Atty. Cruz", "--to", "Lab", "--reason", "analysis"]);
    assert!(out.status.success(), "{}", text(&out));
    let out = custody(&dir, &["verify"]);
    assert_eq!(out.status.code(), Some(0), "{}", text(&out));
    assert!(text(&out).contains("VERIFIED"));
}

#[test]
fn modified_evidence_file_fails_verify() {
    let dir = setup("modified");
    fs::write(dir.join("photo.jpg"), b"edited photo bytes").unwrap();
    let out = custody(&dir, &["verify"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(text(&out).contains("MODIFIED"));
}

#[test]
fn missing_evidence_file_fails_verify() {
    let dir = setup("missing");
    fs::remove_file(dir.join("photo.jpg")).unwrap();
    let out = custody(&dir, &["verify"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(text(&out).contains("MISSING"));
}

#[test]
fn hand_edited_ledger_fails_verify() {
    let dir = setup("edited");
    let path = dir.join("custody.json");
    let json = fs::read_to_string(&path).unwrap().replace("Scene photo", "Unrelated photo");
    fs::write(&path, json).unwrap();
    let out = custody(&dir, &["verify"]);
    assert_eq!(out.status.code(), Some(1));
    assert!(text(&out).contains("modified after it was written"));
}

#[test]
fn wrong_person_cannot_transfer() {
    let dir = setup("wrong-person");
    let out = custody(&dir, &["transfer", "1", "--by", "Intruder", "--to", "X"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(text(&out).contains("currently held by Atty. Cruz"));
}

#[test]
fn cannot_transfer_to_unlisted_person() {
    let dir = setup("unlisted");
    let out = custody(&dir, &["transfer", "1", "--by", "Atty. Cruz", "--to", "Random Courier"]);
    assert_eq!(out.status.code(), Some(2));
    assert!(text(&out).contains("not on the authorized custodian list"));
}

#[test]
fn custodians_lists_authorized_people() {
    let dir = setup("custodians");
    custody(&dir, &["authorize", "Paralegal Reyes", "--role", "Paralegal", "--by", "Atty. Cruz"]);
    let out = custody(&dir, &["custodians"]);
    let shown = text(&out);
    assert!(shown.contains("Atty. Cruz") && shown.contains("Paralegal Reyes") && shown.contains("active"));
}

#[test]
fn init_refuses_to_overwrite() {
    let dir = setup("overwrite");
    let out = custody(&dir, &["init", "--case", "CV-2", "--by", "X"]);
    assert_eq!(out.status.code(), Some(2));
}

#[test]
fn check_compares_a_file() {
    let dir = setup("check");
    fs::write(dir.join("copy.jpg"), b"original photo bytes").unwrap();
    fs::write(dir.join("fake.jpg"), b"something else").unwrap();
    assert_eq!(custody(&dir, &["check", "1", "copy.jpg"]).status.code(), Some(0));
    assert_eq!(custody(&dir, &["check", "1", "fake.jpg"]).status.code(), Some(1));
}
