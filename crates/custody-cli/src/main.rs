//! `custody` — command-line front end for the evidence ledger.
//!
//! This file only deals with the outside world: parsing arguments, reading
//! files, printing results. All the rules live in `custody-core`.
//!
//! Exit codes: 0 = success, 1 = verification failed, 2 = error (bad input etc.)

use chrono::{SecondsFormat, Utc};
use clap::{Parser, Subcommand};
use colored::Colorize;
use custody_core::{hash_reader, Event, Ledger};
use std::fs::{self, File};
use std::io::BufReader;
use std::path::{Path, PathBuf};
use std::process::ExitCode;

#[derive(Parser)]
#[command(
    name = "custody",
    version,
    about = "Tamper-evident chain-of-custody log for digital evidence"
)]
struct Cli {
    /// Ledger file to use
    #[arg(long, global = true, default_value = "custody.json")]
    log: PathBuf,

    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Start a new ledger for a case
    Init {
        #[arg(long)]
        case: String,
        #[arg(long, default_value = "")]
        title: String,
        /// Person opening the ledger
        #[arg(long)]
        by: String,
    },
    /// Add a person or organization to the authorized custodian list
    Authorize {
        name: String,
        /// e.g. "Paralegal", "Forensic laboratory", "Court"
        #[arg(long)]
        role: String,
        /// Someone already on the list
        #[arg(long)]
        by: String,
        #[arg(long, default_value = "")]
        note: String,
    },
    /// Remove someone from the authorized custodian list
    Revoke {
        name: String,
        #[arg(long)]
        by: String,
        #[arg(long, default_value = "")]
        reason: String,
    },
    /// Show the authorized custodian list
    Custodians,
    /// Hash a file and log it as evidence
    Add {
        file: PathBuf,
        /// Authorized custodian logging the evidence (becomes its holder)
        #[arg(long)]
        by: String,
        /// e.g. "Document", "Photograph", "Video recording"
        #[arg(long, default_value = "Document")]
        category: String,
        #[arg(long, default_value = "")]
        desc: String,
    },
    /// Transfer custody of an item to an authorized custodian
    Transfer {
        evidence_id: u32,
        /// Current custodian (must match the ledger)
        #[arg(long)]
        by: String,
        /// Receiving custodian (must be on the authorized list)
        #[arg(long)]
        to: String,
        #[arg(long, default_value = "")]
        reason: String,
    },
    /// List all evidence and who holds it now
    List,
    /// Show the full timeline, or one item's custody history
    History { evidence_id: Option<u32> },
    /// Check the chain and re-hash every evidence file
    Verify {
        /// A head hash recorded earlier (proves the history wasn't rewritten)
        #[arg(long)]
        anchor: Option<String>,
        /// Only check the chain, skip re-hashing files
        #[arg(long)]
        no_files: bool,
    },
    /// Compare any file against a logged piece of evidence
    Check { evidence_id: u32, file: PathBuf },
    /// Print the newest record's hash (write it down somewhere safe)
    Head,
}

fn main() -> ExitCode {
    #[cfg(windows)]
    let _ = colored::control::set_virtual_terminal(true);

    let cli = Cli::parse();
    match run(cli) {
        Ok(code) => code,
        Err(message) => {
            eprintln!("{} {message}", "error:".red().bold());
            ExitCode::from(2)
        }
    }
}

/// Current time in UTC, e.g. "2026-11-14T04:30:00Z".
fn now() -> String {
    Utc::now().to_rfc3339_opts(SecondsFormat::Secs, true)
}

fn load(path: &Path) -> Result<Ledger, String> {
    let text = fs::read_to_string(path).map_err(|e| {
        format!("cannot read {} ({e}). Run `custody init` first?", path.display())
    })?;
    Ledger::from_json(&text).map_err(|e| e.to_string())
}

/// Writes to a temporary file first, then renames it over the real one, so a
/// crash halfway through can never leave a half-written ledger.
fn save(path: &Path, ledger: &Ledger) -> Result<(), String> {
    let tmp = path.with_extension("json.tmp");
    fs::write(&tmp, ledger.to_json()).map_err(|e| format!("cannot write {}: {e}", tmp.display()))?;
    fs::rename(&tmp, path).map_err(|e| format!("cannot save {}: {e}", path.display()))
}

fn hash_file(path: &Path) -> Result<(String, u64), String> {
    let file = File::open(path).map_err(|e| format!("cannot open {}: {e}", path.display()))?;
    hash_reader(BufReader::new(file)).map_err(|e| format!("cannot read {}: {e}", path.display()))
}

/// Folder the ledger lives in. Evidence paths are stored relative to it, so
/// the whole case folder can be zipped and moved to another computer.
fn ledger_dir(log: &Path) -> PathBuf {
    match log.parent() {
        Some(p) if !p.as_os_str().is_empty() => p.to_path_buf(),
        _ => PathBuf::from("."),
    }
}

/// Removes Windows' "\\?\" prefix that `canonicalize` adds.
fn clean(path: PathBuf) -> PathBuf {
    let text = path.to_string_lossy();
    match text.strip_prefix(r"\\?\") {
        Some(rest) => PathBuf::from(rest),
        None => path,
    }
}

/// Path to store in the ledger: relative to the ledger folder when possible.
fn stored_path(file: &Path, log: &Path) -> Result<String, String> {
    let file = clean(fs::canonicalize(file).map_err(|e| format!("{}: {e}", file.display()))?);
    let dir = clean(fs::canonicalize(ledger_dir(log)).map_err(|e| e.to_string())?);
    let chosen = file.strip_prefix(&dir).map(Path::to_path_buf).unwrap_or(file);
    Ok(chosen.to_string_lossy().replace('\\', "/"))
}

fn run(cli: Cli) -> Result<ExitCode, String> {
    let log = cli.log.as_path();

    match cli.command {
        Command::Init { case, title, by } => {
            if log.exists() {
                return Err(format!("{} already exists; refusing to overwrite it", log.display()));
            }
            let ledger = Ledger::new(&case, &title, &by, &now()).map_err(|e| e.to_string())?;
            save(log, &ledger)?;
            println!("{} Ledger created for case {} at {}", "✔".green(), case.bold(), log.display());
        }

        Command::Authorize { name, role, by, note } => {
            let mut ledger = load(log)?;
            ledger.authorize(&by, &now(), &name, &role, &note).map_err(|e| e.to_string())?;
            save(log, &ledger)?;
            println!("{} {} added to the authorized custodian list ({role})", "✔".green(), name.trim().bold());
        }

        Command::Revoke { name, by, reason } => {
            let mut ledger = load(log)?;
            ledger.revoke(&by, &now(), &name, &reason).map_err(|e| e.to_string())?;
            save(log, &ledger)?;
            println!("{} {} removed from the authorized custodian list", "✔".green(), name.trim().bold());
        }

        Command::Custodians => {
            let ledger = load(log)?;
            println!("{}", "Authorized custodians".bold());
            for c in ledger.custodians() {
                let status = if c.active { "active".green() } else { "revoked".red() };
                println!(
                    "  {:<28} {:<24} {:<8} added by {} on {}",
                    c.name, c.role, status, c.authorized_by, c.authorized_at
                );
            }
        }

        Command::Add { file, by, category, desc } => {
            let mut ledger = load(log)?;
            let (hash, size) = hash_file(&file)?;
            let name = stored_path(&file, log)?;
            let id = ledger
                .add_evidence(&by, &now(), &category, &name, &hash, size, &desc)
                .map_err(|e| e.to_string())?;
            save(log, &ledger)?;
            println!("{} Logged evidence {} — {name} [{}]", "✔".green(), format!("#{id}").bold(), category.trim());
            println!("  SHA-256  {hash}");
            println!("  Size     {size} bytes   Custodian: {by}");
        }

        Command::Transfer { evidence_id, by, to, reason } => {
            let mut ledger = load(log)?;
            ledger
                .transfer(&by, &now(), evidence_id, &to, &reason)
                .map_err(|e| e.to_string())?;
            save(log, &ledger)?;
            let receiver = ledger.current_custodian(evidence_id).unwrap_or(to);
            println!("{} Custody of evidence #{evidence_id} transferred: {by} → {}", "✔".green(), receiver.bold());
        }

        Command::List => {
            let ledger = load(log)?;
            if let Some((id, title)) = ledger.case_info() {
                println!("{} {id}  {}", "Case".bold(), title.dimmed());
            }
            let items = ledger.evidence();
            if items.is_empty() {
                println!("No evidence logged yet. Use `custody add <file> --by <name>`.");
            }
            for e in items {
                println!(
                    "{:>4}  {:<28} {:<20} {:<24} {}  ({} transfer(s))",
                    format!("#{}", e.evidence_id).bold(),
                    e.file_name,
                    e.category.dimmed(),
                    e.custodian.cyan(),
                    e.file_hash[..12].dimmed(),
                    e.transfer_count
                );
            }
        }

        Command::History { evidence_id } => {
            let ledger = load(log)?;
            let records: Vec<_> = match evidence_id {
                Some(id) => {
                    let h = ledger.history(id);
                    if h.is_empty() {
                        return Err(format!("there is no evidence #{id}"));
                    }
                    h
                }
                None => ledger.records.iter().collect(),
            };
            for r in records {
                println!(
                    "{:>4}  {}  {:<18} {}",
                    format!("[{}]", r.index).dimmed(),
                    r.timestamp,
                    r.actor.cyan(),
                    r.describe()
                );
                if let Event::CustodyTransferred { reason, .. } = &r.event {
                    if !reason.is_empty() {
                        println!("{:>30}reason: {}", "", reason.dimmed());
                    }
                }
            }
        }

        Command::Verify { anchor, no_files } => return verify(log, anchor, no_files),

        Command::Check { evidence_id, file } => {
            let ledger = load(log)?;
            let (hash, _) = hash_file(&file)?;
            let result = ledger.check_file(evidence_id, &hash).map_err(|e| e.to_string())?;
            println!("Logged   {}", result.logged_hash);
            println!("This file {}", result.actual_hash);
            if result.matches {
                println!("{} Identical to evidence #{evidence_id} ({})", "✔ MATCH".green().bold(), result.file_name);
            } else {
                println!("{} This is NOT the file logged as evidence #{evidence_id}", "✘ DIFFERENT".red().bold());
                return Ok(ExitCode::from(1));
            }
        }

        Command::Head => {
            let ledger = load(log)?;
            println!("{}", ledger.head_hash());
        }
    }
    Ok(ExitCode::SUCCESS)
}

fn verify(log: &Path, anchor: Option<String>, no_files: bool) -> Result<ExitCode, String> {
    let ledger = load(log)?;
    let report = match &anchor {
        Some(a) => ledger.verify_with_anchor(a),
        None => ledger.verify(),
    };

    println!("{}", "Chain of records".bold());
    if report.ok {
        println!(
            "  {} {} records, all hashes and links valid",
            "✔".green(),
            report.records_checked
        );
        if anchor.is_some() {
            println!("  {} anchor hash found in the chain", "✔".green());
        }
    }
    for issue in &report.issues {
        let place = issue.record_index.map(|i| format!("record #{i}")).unwrap_or_else(|| "ledger".into());
        println!("  {} [{place}] {}", "✘".red(), issue.message);
    }

    let mut files_ok = true;
    if !no_files {
        println!("{}", "Evidence files".bold());
        let dir = ledger_dir(log);
        for e in ledger.evidence() {
            let path = dir.join(&e.file_name);
            let label = format!("#{} {}", e.evidence_id, e.file_name);
            match hash_file(&path) {
                Ok((hash, _)) if hash == e.file_hash => println!("  {} {label}", "✔".green()),
                Ok((hash, _)) => {
                    files_ok = false;
                    println!(
                        "  {} {label} — MODIFIED since it was logged (expected {}…, now {}…)",
                        "✘".red(),
                        &e.file_hash[..12],
                        &hash[..12]
                    );
                }
                Err(_) => {
                    files_ok = false;
                    println!("  {} {label} — MISSING (looked in {})", "✘".red(), path.display());
                }
            }
        }
    }

    println!();
    if report.ok && files_ok {
        println!("{} Ledger and evidence are intact.", "VERIFIED".green().bold());
        println!("Head hash: {}", report.head_hash.dimmed());
        Ok(ExitCode::SUCCESS)
    } else {
        println!("{} Do not rely on this evidence without investigation.", "TAMPERING DETECTED".red().bold());
        Ok(ExitCode::from(1))
    }
}
