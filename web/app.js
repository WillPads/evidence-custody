// Page logic: forms, dialogs, tabs and wording only.
// Every rule (fingerprinting, linking entries, the authorized custodian list,
// who may transfer what, tamper checks) is the Rust code in crates/custody-core,
// compiled to WebAssembly. If this page sent a forbidden action, Rust refuses it.
import init, * as custody from "./pkg/custody_web.js";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];
const KEY = { ledger: "custody.v2.ledger", pristine: "custody.v2.pristine", user: "custody.actor", tech: "custody.tech", tab: "custody.tab" };
const OTHER = "__other__";
const SAMPLE_CASE = "sample-evidence/1-originals/sample-case.json";
const TABS = ["overview", "evidence", "custodians", "log", "integrity"];

const CATEGORIES = [
  ["Document", "Document (contract, letter, affidavit)"],
  ["Photograph", "Photograph"],
  ["Video recording", "Video recording"],
  ["Audio recording", "Audio recording"],
  ["CCTV / surveillance footage", "CCTV / surveillance footage"],
  ["Email or message", "Email, chat or text message"],
  ["Device extraction", "Device extraction (phone or computer data)"],
  ["Financial record", "Financial record"],
  ["Medical record", "Medical record"],
  ["Government record", "Government-issued record"],
];

const ROLES = [
  "Lawyer", "Paralegal", "Law firm staff", "Client", "Forensic laboratory",
  "Law enforcement", "Court / clerk of court", "Expert witness", "Records custodian",
];

let ledgerJson = null;   // the case records, exactly as Rust saved them
let pristineJson = null; // last version made through normal use (for "Restore original records")
let userName = "";
let data = null;         // summary of the current case (from Rust)
let report = null;       // latest verification report (from Rust)

// ============================================================ helpers

/** Build an element. Text is always set as text (never HTML), so names can't inject code. */
function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, props);
  for (const c of children) if (c != null && c !== false) node.append(c);
  return node;
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* storage blocked */ } },
};

/** "2026-11-14T04:30:00Z", the same format the command-line tool writes. */
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

const when = (iso) => {
  const d = new Date(iso);
  return isNaN(d) ? iso : d.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
};

function ago(iso) {
  const s = (Date.now() - new Date(iso)) / 1000;
  if (isNaN(s)) return "";
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)} min ago`;
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`;
  const d = Math.floor(s / 86400);
  return d === 1 ? "yesterday" : `${d} days ago`;
}

function size(n) {
  if (n < 1024) return `${n} bytes`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const sameName = (a, b) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** Turn the Rust error text into a sentence for a person. */
function friendly(err) {
  const msg = String(err?.message ?? err);
  if (msg.includes("refusing to add records")) {
    return "These records have been tampered with, so new entries are blocked. Restore the original records or open a saved case file.";
  }
  if (msg.startsWith("not a valid ledger file")) {
    return msg.includes("format version")
      ? "That case file was made by an older version of this app and can't be opened."
      : "That file isn't a case file from this app.";
  }
  return msg.charAt(0).toUpperCase() + msg.slice(1) + ".";
}

let toastTimer;
function toast(message, isError = false, extra = null) {
  const t = $("#toast");
  t.replaceChildren(message);
  if (extra) t.append(" ", extra);
  t.className = "toast" + (isError ? " error" : "");
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), isError ? 9000 : 6000);
}

/** Run an action; show a readable message if Rust (or anything) refuses it. */
async function attempt(fn, inDialog = null) {
  try {
    await fn();
  } catch (e) {
    const message = friendly(e);
    if (inDialog) showDialogError(inDialog, message);
    else toast(message, true);
  }
}

/** Errors inside a dialog are shown inside it (a toast behind a dialog is invisible). */
function showDialogError(dialog, message) {
  let box = dialog.querySelector(".dlg-error");
  if (!box) {
    box = el("div", { className: "result bad dlg-error", role: "alert" });
    dialog.querySelector(".dlg-buttons").before(box);
  }
  box.textContent = message;
  box.hidden = false;
}
function clearDialogError(dialog) {
  const box = dialog?.querySelector(".dlg-error");
  if (box) box.hidden = true;
}
function openDialog(dialog) {
  clearDialogError(dialog);
  dialog.showModal();
}

async function fingerprint(file) {
  return custody.hashBytes(new Uint8Array(await file.arrayBuffer()));
}

const itemName = (id) => data?.evidence.find((e) => e.evidence_id === id)?.file_name ?? `item ${id}`;
const activeCustodians = () => (data?.custodians ?? []).filter((c) => c.active);
const transferCount = () => (data?.records ?? []).filter((r) => r.event.type === "custody_transferred").length;

/** Fill a <select> from [value, label] pairs, plus an "Other (specify)" option. */
function fillWithOther(select, options) {
  select.replaceChildren(
    // defaultSelected (not just selected) so form.reset() returns to "Select…"
    el("option", { value: "", textContent: "Select…", disabled: true, selected: true, defaultSelected: true }),
    ...options.map(([value, label]) => el("option", { value, textContent: label })),
    el("option", { value: OTHER, textContent: "Other (specify)" }),
  );
  const otherField = select.closest("form").querySelector(".other-field");
  select.addEventListener("change", () => {
    otherField.hidden = select.value !== OTHER;
    otherField.querySelector("input").required = select.value === OTHER;
    if (select.value === OTHER) otherField.querySelector("input").focus();
  });
}

const valueWithOther = (select, otherInput) => (select.value === OTHER ? otherInput.value.trim() : select.value);

function resetOther(form) {
  const f = form.querySelector(".other-field");
  f.hidden = true;
  f.querySelector("input").required = false;
}

// ============================================================ plain-English tamper reports

function explain(issue) {
  const n = issue.record_index;
  switch (issue.kind) {
    case "hash_mismatch": return `Log entry ${n} was altered after it was recorded.`;
    case "broken_link": return `Log entry ${n} no longer connects to the entry before it. An earlier entry was altered or removed.`;
    case "index_mismatch": return `A log entry is missing or out of order around entry ${n}.`;
    case "time_reversed": return `Log entry ${n} is dated earlier than the entry before it.`;
    case "invalid_transfer": return `Log entry ${n} records a transfer by someone who did not have custody at the time.`;
    case "unauthorized_recipient": return `Log entry ${n} transfers evidence to someone who was not an authorized custodian.`;
    case "unauthorized_actor": return `Log entry ${n} was made by someone who was not an authorized custodian.`;
    case "revoked_while_holding": return `Log entry ${n} removes a custodian who still held evidence.`;
    case "duplicate_authorization":
    case "unknown_custodian": return `Log entry ${n} contains an inconsistent change to the custodian list.`;
    case "unknown_evidence": return `Log entry ${n} refers to evidence that was never logged.`;
    case "duplicate_evidence_id": return `Log entry ${n} reuses another item's number.`;
    case "unexpected_case_opened":
    case "missing_case_opened": return "The opening entry of the case is missing or out of place.";
    case "anchor_missing": return "This receipt code does not appear in this case's history. The history was rewritten, or the code belongs to a different case.";
    case "empty_ledger": return "The case has no entries.";
    default: return issue.message;
  }
}

// ============================================================ state

function setLedger(json, { pristine = true } = {}) {
  ledgerJson = json;
  if (pristine) pristineJson = json;
  store.set(KEY.ledger, json);
  store.set(KEY.pristine, pristineJson);
  render();
}

function setUser(name) {
  userName = (name ?? "").trim();
  store.set(KEY.user, userName);
  $("#user-name").textContent = userName || "not selected";
  for (const node of $$(".me")) node.textContent = userName;
}

function closeCase() {
  ledgerJson = pristineJson = data = report = null;
  store.set(KEY.ledger, null);
  store.set(KEY.pristine, null);
  history.replaceState(null, "", location.pathname);
  render();
  window.scrollTo({ top: 0 });
}

/** Make sure "Acting as" is an active authorized custodian. Resolves true when it is. */
function ensureUser() {
  if (userName && activeCustodians().some((c) => sameName(c.name, userName))) return Promise.resolve(true);
  return new Promise((resolve) => {
    $("#dlg-user").addEventListener("close", () => resolve(activeCustodians().some((c) => sameName(c.name, userName))), { once: true });
    openUserDialog();
  });
}

function openUserDialog() {
  const select = $("#form-user [name=name]");
  select.replaceChildren(...activeCustodians().map((c) => el("option", { value: c.name, textContent: `${c.name} (${c.role})` })));
  const current = activeCustodians().find((c) => sameName(c.name, userName));
  if (current) select.value = current.name;
  openDialog($("#dlg-user"));
}

// ============================================================ tabs

function showTab(name, { focus = false } = {}) {
  if (!TABS.includes(name)) name = "overview";
  for (const btn of $$(".tabs [role=tab]")) {
    const on = btn.dataset.tab === name;
    btn.setAttribute("aria-selected", String(on));
    btn.tabIndex = on ? 0 : -1;
    if (on && focus) btn.focus();
  }
  for (const panel of $$("[data-panel]")) panel.hidden = panel.dataset.panel !== name;
  store.set(KEY.tab, name);
  if (ledgerJson && location.hash !== "#" + name) history.replaceState(null, "", "#" + name);
}
const currentTab = () => $(".tabs [aria-selected=true]")?.dataset.tab ?? "overview";

for (const btn of $$(".tabs [role=tab]")) {
  btn.addEventListener("click", () => showTab(btn.dataset.tab));
  btn.addEventListener("keydown", (e) => {
    const i = TABS.indexOf(btn.dataset.tab);
    if (e.key === "ArrowRight") showTab(TABS[(i + 1) % TABS.length], { focus: true });
    if (e.key === "ArrowLeft") showTab(TABS[(i + TABS.length - 1) % TABS.length], { focus: true });
  });
}
document.addEventListener("click", (e) => {
  const goto = e.target.closest("[data-goto]");
  if (goto) { showTab(goto.dataset.goto); window.scrollTo({ top: 0 }); }
  const act = e.target.closest("[data-act]");
  if (act) ({ add: openAdd, transfer: () => openTransfer(), check: () => openCheck(), custodian: () => openCustodianDialog() })[act.dataset.act]?.();
});
$("#brand-home").addEventListener("click", (e) => {
  e.preventDefault();
  if (ledgerJson) showTab("overview");
  window.scrollTo({ top: 0 });
});

// ============================================================ rendering

function render() {
  $("#boot").hidden = true;
  $("#start").hidden = !!ledgerJson;
  $("#case").hidden = !ledgerJson;
  $("#userbox").hidden = !ledgerJson;
  if (!ledgerJson) return;

  try { $("#raw").value = JSON.stringify(JSON.parse(ledgerJson), null, 2); } catch { $("#raw").value = ledgerJson; }

  try {
    data = JSON.parse(custody.summary(ledgerJson));
    report = JSON.parse(custody.verify(ledgerJson, ""));
  } catch (e) {
    data = null;
    renderStatus({ ok: false, issues: [{ kind: "unreadable", record_index: null, message: "The saved records can't be read. They may have been edited by hand. " + friendly(e) }] });
    return;
  }

  $("#case-number").textContent = `Case ${data.case.id}`;
  $("#case-title").textContent = data.case.title || data.case.id;
  $("#receipt").textContent = data.headHash;
  $("#count-evidence").textContent = data.evidence.length;
  $("#count-custodians").textContent = activeCustodians().length;
  $("#count-log").textContent = data.records.length;

  renderStatus(report);
  renderOverview();
  renderEvidence();
  renderCustodians();
  renderLog();
  updateSelects();
}

function renderStatus(rep) {
  const box = $("#status");
  if (rep.ok) {
    box.className = "status ok";
    box.replaceChildren(
      el("span", { className: "icon", ariaHidden: "true" }, "✓"),
      el("div", {},
        el("strong", {}, "Custody log verified"),
        `No entry has been altered, removed or reordered (${rep.records_checked} ${rep.records_checked === 1 ? "entry" : "entries"} checked).`),
    );
  } else {
    box.className = "status bad";
    box.replaceChildren(
      el("span", { className: "icon", ariaHidden: "true" }, "!"),
      el("div", {},
        el("strong", {}, "Warning: the custody log has been tampered with"),
        "Do not rely on these records until the discrepancy is explained.",
        el("ul", {}, ...rep.issues.map((i) => el("li", {}, explain(i)))),
        el("details", {},
          el("summary", {}, "Technical details"),
          el("ul", {}, ...rep.issues.map((i) => el("li", {}, i.message)))),
      ),
    );
  }
}

function renderOverview() {
  // Getting-started checklist, shown until each step has been done once.
  const steps = [
    { done: activeCustodians().length > 1, text: "Add the people or organizations allowed to hold evidence", label: "Add custodian", act: () => openCustodianDialog() },
    { done: data.evidence.length > 0, text: "Log your first evidence file", label: "Log evidence", act: openAdd },
    { done: transferCount() > 0, text: "Record a transfer of custody", label: "Transfer custody", act: () => openTransfer() },
    { done: data.evidence.length > 0 && store.get("custody.verified") === "1", text: "Verify a copy of a file", label: "Verify a file", act: () => openCheck() },
  ];
  const allDone = steps.every((s) => s.done);
  $("#checklist").hidden = allDone;
  $("#checklist-items").replaceChildren(...steps.map((s) =>
    el("li", { className: s.done ? "done" : "" },
      el("span", { className: "tick", ariaHidden: "true" }, s.done ? "✓" : ""),
      el("span", { className: "text" }, s.text),
      s.done ? null : el("button", { type: "button", textContent: s.label, onclick: s.act }),
    )));

  // Summary numbers
  const last = data.records[data.records.length - 1];
  const stat = (value, label, tab) => el("button", { type: "button", className: "stat", onclick: () => tab && showTab(tab) },
    el("div", { className: "value" }, String(value)), el("div", { className: "label" }, label));
  $("#stats").replaceChildren(
    stat(data.evidence.length, "evidence items", "evidence"),
    stat(activeCustodians().length, "authorized custodians", "custodians"),
    stat(transferCount(), "custody transfers", "log"),
    stat(last ? ago(last.timestamp) : "–", "last activity", "log"),
  );

  // Last 5 entries
  renderActivity($("#recent"), data.records.slice(-5), report);
}

function renderEvidence() {
  const search = $("#evidence-search").value.trim().toLowerCase();
  const cat = $("#evidence-filter").value;
  const all = data.evidence;

  // Category filter options reflect what's actually in the case.
  const cats = [...new Set(all.map((e) => e.category))].sort();
  $("#evidence-filter").replaceChildren(
    el("option", { value: "", textContent: "All categories" }),
    ...cats.map((c) => el("option", { value: c, textContent: c })));
  $("#evidence-filter").value = cats.includes(cat) ? cat : "";

  const items = all.filter((e) =>
    (!$("#evidence-filter").value || e.category === $("#evidence-filter").value) &&
    (!search || [e.file_name, e.description, e.custodian, e.category].some((v) => v.toLowerCase().includes(search))));

  const empty = $("#evidence-empty");
  empty.hidden = items.length > 0;
  empty.replaceChildren(...(all.length === 0
    ? [el("p", {}, el("strong", {}, "No evidence logged yet.")), el("p", { className: "muted" }, "Log your first file to start the chain of custody."),
       el("button", { type: "button", className: "primary", textContent: "Log evidence", onclick: openAdd })]
    : [el("p", {}, el("strong", {}, "No evidence matches your search.")),
       el("button", { type: "button", textContent: "Clear search", onclick: () => { $("#evidence-search").value = ""; $("#evidence-filter").value = ""; renderEvidence(); } })]));

  $("#evidence-list").replaceChildren(...items.map((e) =>
    el("article", { className: "card item" },
      el("div", { className: "tag" }, `Item ${e.evidence_id}`, el("span", { className: "chip" }, e.category), size(e.size_bytes)),
      el("div", { className: "name" }, e.file_name),
      e.description ? el("div", { className: "muted small" }, e.description) : null,
      el("div", { className: "holder" }, "Custodian: ", el("strong", {}, e.custodian)),
      el("div", { className: "muted small" }, `Logged ${when(e.logged_at)} by ${e.logged_by}`),
      el("div", { className: "fp tech" }, `Fingerprint: ${e.file_hash}`),
      el("div", { className: "item-buttons" },
        el("button", { type: "button", textContent: "Transfer", onclick: () => openTransfer(e.evidence_id) }),
        el("button", { type: "button", textContent: "Verify copy", onclick: () => openCheck(e) }),
        el("button", { type: "button", textContent: "History", onclick: () => openHistory(e) }),
      ),
    )));
}
$("#evidence-search").addEventListener("input", () => renderEvidence());
$("#evidence-filter").addEventListener("change", () => renderEvidence());

function renderCustodians() {
  $("#custodian-body").replaceChildren(...data.custodians.map((c) => {
    const holding = data.evidence.filter((e) => sameName(e.custodian, c.name)).length;
    return el("tr", { className: c.active ? "" : "revoked" },
      el("td", {}, el("strong", {}, c.name), c.note ? el("span", { className: "sub" }, c.note) : null),
      el("td", {}, c.role),
      el("td", {}, holding ? plural(holding, "item") : "None"),
      el("td", {}, when(c.authorized_at), el("span", { className: "sub" }, `by ${c.authorized_by}`)),
      el("td", {},
        el("span", { className: "badge " + (c.active ? "active" : "revoked") }, c.active ? "Active" : "Revoked"),
        !c.active && c.revoked_reason ? el("span", { className: "sub" }, c.revoked_reason) : null),
      el("td", { className: "actions-cell" },
        c.active ? el("button", { type: "button", textContent: "Revoke", onclick: () => openRevoke(c, holding) }) : null),
    );
  }));
}

function renderLog() {
  const f = $("#log-filter").value;
  const records = data.records.filter((r) =>
    f === "all" ? true :
    f === "custodians" ? ["custodian_authorized", "custodian_revoked", "case_opened"].includes(r.event.type) :
    r.event.type === f);
  renderActivity($("#activity"), records, report);
}
$("#log-filter").addEventListener("change", () => renderLog());

/** Keep the dialog dropdowns in sync with the case. */
function updateSelects() {
  const select = $("#form-transfer [name=id]");
  const previous = select.value;
  select.replaceChildren(...data.evidence.map((e) =>
    el("option", { value: e.evidence_id, textContent: `Item ${e.evidence_id}: ${e.file_name} (with ${e.custodian})` })));
  if ([...select.options].some((o) => o.value === previous)) select.value = previous;
}

/** One line of plain English for a log entry. */
function sentence(r) {
  const ev = r.event;
  switch (ev.type) {
    case "case_opened": return `${r.actor} opened the case and became the case lead`;
    case "custodian_authorized": return `${r.actor} authorized ${ev.name} (${ev.role}) as a custodian`;
    case "custodian_revoked": return `${r.actor} revoked the authorization of ${ev.name}`;
    case "evidence_added": return `${r.actor} logged ${ev.file_name} (${ev.category})`;
    case "custody_transferred": return `${ev.from} transferred custody of ${itemName(ev.evidence_id)} to ${ev.to}`;
    default: return r.summary;
  }
}

function renderActivity(list, records, rep) {
  const problems = new Map();
  for (const i of rep?.issues ?? []) {
    if (i.record_index == null) continue;
    problems.set(i.record_index, [...(problems.get(i.record_index) ?? []), explain(i)]);
  }
  if (!records.length) {
    list.replaceChildren(el("li", { className: "activity-empty" }, "No entries to show."));
    return;
  }
  list.replaceChildren(...[...records].reverse().map((r) => {
    const position = data.records.indexOf(r); // position in the whole log
    const issues = problems.get(position) ?? [];
    const ev = r.event;
    const kind = ev.type === "custody_transferred" ? "kind-transfer"
      : ev.type.startsWith("custodian") ? "kind-custodian" : "";
    const detail =
      ev.type === "custody_transferred" && ev.reason ? `Purpose: ${ev.reason}` :
      ev.type === "evidence_added" && ev.description ? ev.description :
      ev.type === "custodian_authorized" && ev.note ? `Reference: ${ev.note}` :
      ev.type === "custodian_revoked" && ev.reason ? `Reason: ${ev.reason}` : null;
    return el("li", { className: [kind, issues.length ? "broken" : ""].join(" ").trim() },
      el("div", { className: "when" }, `${when(r.timestamp)} · entry ${position}`),
      el("div", {}, sentence(r)),
      detail ? el("div", { className: "why" }, detail) : null,
      ...issues.map((m) => el("div", { className: "problem" }, "⚠ " + m)),
      el("div", { className: "tech" }, `entry fingerprint ${r.hash}`),
      el("div", { className: "tech" }, `links to previous ${r.prev_hash}`),
    );
  }));
}

// ============================================================ dialogs: shared

for (const btn of $$("[data-close]")) btn.addEventListener("click", () => btn.closest("dialog").close());

function resetDrop(form) {
  const drop = form.querySelector(".drop");
  if (!drop) return;
  drop.classList.remove("chosen");
  drop.querySelector(".drop-text").replaceChildren("Click to choose a file", el("br"), el("small", {}, "or drag it here"));
}

for (const drop of $$(".drop")) {
  const input = drop.querySelector("input");
  input.addEventListener("change", () => {
    const f = input.files[0];
    if (!f) return resetDrop(drop.closest("form"));
    drop.classList.add("chosen");
    drop.querySelector(".drop-text").replaceChildren(el("strong", {}, f.name), el("br"), el("small", {}, size(f.size)));
    const result = drop.closest("form").querySelector("#check-result");
    if (result) result.hidden = true;
    clearDialogError(drop.closest("dialog"));
  });
  drop.addEventListener("dragover", () => drop.classList.add("over"));
  for (const evt of ["dragleave", "drop"]) drop.addEventListener(evt, () => drop.classList.remove("over"));
}

// A file dropped outside a drop zone would make the browser leave the page. Ignore those.
for (const evt of ["dragover", "drop"]) {
  window.addEventListener(evt, (e) => { if (!e.target.closest?.(".drop")) e.preventDefault(); });
}

fillWithOther($("#form-add [name=category]"), CATEGORIES);
fillWithOther($("#form-custodian [name=role]"), ROLES.map((r) => [r, r]));

// ============================================================ Log evidence

async function openAdd() {
  if (!(await ensureUser())) return;
  const form = $("#form-add");
  form.reset();
  resetDrop(form);
  resetOther(form);
  openDialog($("#dlg-add"));
}
$("#act-add").addEventListener("click", openAdd);

$("#form-add").addEventListener("submit", (ev) => attempt(async () => {
  ev.preventDefault();
  const form = ev.target;
  const file = form.file.files[0];
  const category = valueWithOther(form.category, form.categoryOther);
  if (!category) throw new Error("choose a category");
  if (!file) throw new Error("choose a file to log");
  const hash = await fingerprint(file);
  const result = JSON.parse(custody.addEvidence(ledgerJson, userName, nowIso(), category, file.name, hash, file.size, form.desc.value));
  setLedger(result.ledger);
  $("#dlg-add").close();
  toast(`Logged ${file.name} as item ${result.evidenceId} (${category}).`);
}, $("#dlg-add")));

// ============================================================ Transfer custody

function openTransfer(id) {
  if (!data?.evidence.length) {
    toast("Log some evidence first. Then you can transfer it.", true);
    return;
  }
  const form = $("#form-transfer");
  form.reason.value = "";
  if (id) form.id.value = String(id);
  updateTransferOptions();
  openDialog($("#dlg-transfer"));
}

/** "Released by" = current custodian; "Receiving custodian" = everyone else on the active list. */
function updateTransferOptions() {
  const form = $("#form-transfer");
  const item = data?.evidence.find((e) => e.evidence_id === Number(form.id.value));
  const holder = item?.custodian ?? "";
  $("#transfer-from").textContent = holder;
  const options = activeCustodians().filter((c) => !sameName(c.name, holder));
  const previous = form.to.value;
  form.to.replaceChildren(
    el("option", { value: "", textContent: "Select an authorized custodian…", disabled: true, selected: true }),
    ...options.map((c) => el("option", { value: c.name, textContent: `${c.name} (${c.role})` })),
  );
  if (options.some((c) => c.name === previous)) form.to.value = previous;
  const none = options.length === 0;
  $("#transfer-fields").hidden = none;
  $("#transfer-none").hidden = !none;
  $("#btn-confirm-transfer").disabled = none;
  form.to.required = !none;
}

$("#act-transfer").addEventListener("click", () => openTransfer());
$("#form-transfer [name=id]").addEventListener("change", updateTransferOptions);
$("#btn-transfer-add-custodian").addEventListener("click", () => {
  $("#dlg-transfer").close();
  openCustodianDialog(() => openTransfer(Number($("#form-transfer [name=id]").value)));
});

$("#form-transfer").addEventListener("submit", (ev) => attempt(() => {
  ev.preventDefault();
  const f = ev.target;
  const id = Number(f.id.value);
  const from = $("#transfer-from").textContent;
  // Released by the current custodian; Rust re-checks custody and that the
  // receiver is on the authorized list.
  setLedger(custody.transfer(ledgerJson, from, nowIso(), id, f.to.value, f.reason.value));
  $("#dlg-transfer").close();
  toast(`Custody of ${itemName(id)} transferred from ${from} to ${f.to.value}.`);
}, $("#dlg-transfer")));

// ============================================================ Authorized custodians

let afterCustodianAdded = null;
async function openCustodianDialog(then = null) {
  if (!(await ensureUser())) return;
  afterCustodianAdded = then;
  const form = $("#form-custodian");
  form.reset();
  resetOther(form);
  openDialog($("#dlg-custodian"));
}
$("#btn-add-custodian").addEventListener("click", () => openCustodianDialog());

$("#form-custodian").addEventListener("submit", (ev) => attempt(() => {
  ev.preventDefault();
  const f = ev.target;
  const role = valueWithOther(f.role, f.roleOther);
  if (!role) throw new Error("choose a role");
  setLedger(custody.authorize(ledgerJson, userName, nowIso(), f.name.value, role, f.note.value));
  $("#dlg-custodian").close();
  toast(`${f.name.value.trim()} added to the authorized custodian list.`);
  const then = afterCustodianAdded;
  afterCustodianAdded = null;
  if (then) then();
}, $("#dlg-custodian")));

let revokeTarget = null;
async function openRevoke(c, holding) {
  if (holding) {
    toast(`${c.name} still holds ${plural(holding, "item")}. Transfer ${holding === 1 ? "it" : "them"} to another custodian before revoking.`, true);
    return;
  }
  if (!(await ensureUser())) return;
  revokeTarget = c.name;
  $("#revoke-name").textContent = c.name;
  $("#form-revoke").reset();
  openDialog($("#dlg-revoke"));
}

$("#form-revoke").addEventListener("submit", (ev) => attempt(() => {
  ev.preventDefault();
  setLedger(custody.revoke(ledgerJson, userName, nowIso(), revokeTarget, ev.target.reason.value));
  $("#dlg-revoke").close();
  toast(`${revokeTarget}'s authorization was revoked.`);
  if (sameName(revokeTarget, userName)) setUser("");
}, $("#dlg-revoke")));

// ============================================================ Verify a file
// How it works: a file's fingerprint (SHA-256) is calculated from every byte
// of the file. The same bytes always give the same fingerprint; changing even
// one byte gives a completely different one. Verifying = fingerprinting the
// copy you have now and comparing it with the fingerprint recorded at logging.

let checkItem = null; // null = compare against every item; otherwise one specific item

function openCheck(item = null) {
  if (!data?.evidence.length) {
    toast("Log some evidence first. Then you can verify copies of it.", true);
    return;
  }
  checkItem = item;
  $("#check-title").textContent = item ? `Verify a copy of ${item.file_name}` : "Verify a file";
  $("#check-intro").textContent = item
    ? `Choose the copy you want to check. It is compared with item ${item.evidence_id} exactly as it was when logged.`
    : "Choose a file. It is compared with every evidence item in this case to see whether it is an exact, unaltered copy.";
  const form = $("#form-check");
  form.reset();
  resetDrop(form);
  $("#check-result").hidden = true;
  openDialog($("#dlg-check"));
}
$("#act-check").addEventListener("click", () => openCheck());

$("#form-check").addEventListener("submit", (ev) => attempt(async () => {
  ev.preventDefault();
  const file = ev.target.file.files[0];
  if (!file) throw new Error("choose a file to verify");
  const hash = await fingerprint(file);
  const box = $("#check-result");
  box.hidden = false;
  store.set("custody.verified", "1");

  // Note: replaceChildren() would print a null as the text "null", so only real nodes go in.
  const fpLines = (logged) => [
    el("div", { className: "fp-label" }, "Fingerprint of the file you chose:"), el("code", {}, hash),
    ...(logged ? [el("div", { className: "fp-label" }, "Fingerprint recorded when logged:"), el("code", {}, logged)] : []),
  ];

  if (checkItem) {
    const r = JSON.parse(custody.checkFile(ledgerJson, checkItem.evidence_id, hash));
    box.className = "result " + (r.matches ? "ok" : "bad");
    box.replaceChildren(
      el("strong", {}, r.matches ? "✓ Verified: identical to the logged evidence." : "✗ Not identical to the logged evidence."),
      el("p", {}, r.matches
        ? `This copy is exactly item ${r.evidence_id} (${r.file_name}) as logged on ${when(checkItem.logged_at)}.`
        : (file.size !== checkItem.size_bytes
            ? `The file sizes differ (${size(file.size)} now, ${size(checkItem.size_bytes)} when logged), so the content has changed.`
            : "The size is the same but the content differs. Even a one-character edit, or re-saving the file in another program, changes it.")),
      ...fpLines(r.logged_hash),
    );
  } else {
    const match = JSON.parse(custody.findFile(ledgerJson, hash));
    if (match) {
      box.className = "result ok";
      box.replaceChildren(
        el("strong", {}, `✓ Verified: this is item ${match.evidence_id}, unaltered.`),
        el("p", {}, `It is an exact copy of ${match.file_name} (${match.category}), logged by ${match.logged_by} on ${when(match.logged_at)}.`),
        ...fpLines(null),
      );
    } else {
      const sameNameItem = data.evidence.find((e) => e.file_name === file.name);
      box.className = "result bad";
      box.replaceChildren(
        el("strong", {}, "✗ No matching evidence found."),
        el("p", {}, sameNameItem
          ? `Item ${sameNameItem.evidence_id} has the same name (${file.name}), but this copy's content is different, so it has been altered since it was logged.`
          : "This file is not one of the evidence items in this case, or its content has changed since it was logged."),
        el("p", { className: "muted small" }, "Note: opening and re-saving a file, or sending it through apps that compress attachments (e.g. some chat apps), changes its content even if it looks the same."),
        ...fpLines(sameNameItem?.file_hash),
      );
    }
  }
  renderOverview();
}, $("#dlg-check")));

// ============================================================ History / user

function openHistory(item) {
  $("#history-title").textContent = `Custody history: ${item.file_name}`;
  const records = data.records.filter((r) => r.event.evidence_id === item.evidence_id);
  renderActivity($("#history-list"), records, null);
  openDialog($("#dlg-history"));
}

$("#btn-change-user").addEventListener("click", openUserDialog);
$("#form-user").addEventListener("submit", (ev) => {
  ev.preventDefault();
  setUser(ev.target.name.value);
  $("#dlg-user").close();
});

// ============================================================ case-level actions

function afterOpen(tab = "overview") {
  showTab(tab);
  window.scrollTo({ top: 0 });
}

$("#form-open").addEventListener("submit", (ev) => attempt(() => {
  ev.preventDefault();
  const f = new FormData(ev.target);
  setUser(f.get("actor"));
  store.set("custody.verified", null);
  setLedger(custody.newLedger(f.get("caseId"), f.get("title"), userName, nowIso()));
  ev.target.reset();
  afterOpen();
  toast("Case opened. Follow the Getting started steps below.");
}));

$("#btn-export").addEventListener("click", () => {
  const parsed = JSON.parse(ledgerJson);
  const id = parsed.records?.[0]?.event?.case_id ?? "case";
  const blob = new Blob([JSON.stringify(parsed, null, 2)], { type: "application/json" });
  const a = el("a", { href: URL.createObjectURL(blob), download: `case-${id}.json` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  toast("Case file saved to your Downloads folder. Keep it somewhere safe.");
});

/** Open case-file text (from an upload or the sample case). */
function openCaseText(text, label) {
  JSON.parse(custody.summary(text)); // Rust checks the format and throws if it isn't a case file
  setLedger(text);
  if (!activeCustodians().some((c) => sameName(c.name, userName))) setUser(activeCustodians()[0]?.name ?? "");
  afterOpen();
  const ok = JSON.parse(custody.verify(text, "")).ok;
  toast(ok ? `Opened ${label}. Custody log verified.` : `Opened ${label}, but its custody log has been tampered with.`, !ok);
}

async function importFile(input) {
  await attempt(async () => {
    const file = input.files[0];
    if (file) openCaseText(await file.text(), file.name);
  });
  input.value = "";
}
$("#import-start").addEventListener("change", (e) => importFile(e.target));
$("#import-case").addEventListener("change", (e) => importFile(e.target));

$("#btn-close").addEventListener("click", () => {
  if (confirm("Close this case?\n\nIt will be removed from this browser. Use “Save case file” first if you want to keep it.")) closeCase();
});

$("#btn-copy-receipt").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText($("#receipt").textContent);
    toast("Receipt code copied.");
  } catch { toast("Couldn't copy automatically. Select the code and copy it.", true); }
});

$("#form-receipt").addEventListener("submit", (ev) => attempt(() => {
  ev.preventDefault();
  const rep = JSON.parse(custody.verify(ledgerJson, ev.target.code.value.trim()));
  const missing = rep.issues.some((i) => i.kind === "anchor_missing");
  const box = $("#receipt-result");
  box.hidden = false;
  box.className = "result " + (missing ? "bad" : "ok");
  box.replaceChildren(el("strong", {}, missing
    ? "✗ " + explain({ kind: "anchor_missing" })
    : "✓ Confirmed. The custody history up to this receipt is exactly as it was."));
}));

$("#tech-toggle").addEventListener("change", (e) => {
  document.body.classList.toggle("show-tech", e.target.checked);
  store.set(KEY.tech, e.target.checked ? "1" : null);
});

// ============================================================ tampering demonstration

function tamper(change) {
  attempt(() => {
    const parsed = JSON.parse(ledgerJson);
    const result = change(parsed);
    const json = typeof result === "object" ? result.json : JSON.stringify(parsed, null, 2);
    setLedger(json, { pristine: false });
    toast(typeof result === "object" ? result.text : result);
    window.scrollTo({ top: 0, behavior: "smooth" });
  });
}

const firstEvidence = (d) => {
  const r = d.records.find((x) => x.event.type === "evidence_added");
  if (!r) throw new Error("log some evidence first");
  return r;
};

$("#t-edit").addEventListener("click", () => tamper((d) => {
  const r = firstEvidence(d);
  r.event.description = "Unrelated document";
  return `Changed the description in log entry ${r.index} to “Unrelated document”.`;
}));

$("#t-swap").addEventListener("click", () => tamper((d) => {
  const r = firstEvidence(d);
  // Replace the file's fingerprint, then recompute that entry's own seal so it
  // looks untouched by itself. The NEXT entry still points at the old seal.
  r.event.file_hash = custody.hashBytes(new TextEncoder().encode("a different file"));
  return {
    json: custody.rehashRecord(JSON.stringify(d), r.index),
    text: `Substituted the file in log entry ${r.index} and resealed that entry. The entry after it still exposes the change.`,
  };
}));

$("#t-delete").addEventListener("click", () => tamper((d) => {
  if (d.records.length < 3) throw new Error("there must be at least 3 log entries to delete one from the middle");
  const i = Math.floor(d.records.length / 2);
  d.records.splice(i, 1);
  return `Deleted log entry ${i}.`;
}));

$("#t-restore").addEventListener("click", () => {
  if (pristineJson) { setLedger(pristineJson); toast("Original records restored."); }
});

$("#t-apply").addEventListener("click", () => attempt(() => {
  const text = $("#raw").value;
  JSON.parse(text);
  setLedger(text, { pristine: false });
  window.scrollTo({ top: 0, behavior: "smooth" });
}));

// ============================================================ sample case

async function openSampleCase() {
  await attempt(async () => {
    const res = await fetch(SAMPLE_CASE, { cache: "no-store" });
    if (!res.ok) throw new Error("could not load the sample case");
    store.set("custody.verified", null);
    setUser("");
    openCaseText(await res.text(), "the sample case");
    toast("Sample case opened. Try “Verify a file” with one of the sample copies.", false,
      el("a", { href: "sample-evidence/sample-evidence.zip", download: "sample-evidence.zip", textContent: "Download the sample files" }));
  });
}
$("#btn-demo").addEventListener("click", openSampleCase);
$("#btn-sample-case").addEventListener("click", openSampleCase);

// ============================================================ start

try {
  await init(); // load the Rust code (WebAssembly)
  setUser(store.get(KEY.user) ?? "");
  const tech = store.get(KEY.tech) === "1";
  $("#tech-toggle").checked = tech;
  document.body.classList.toggle("show-tech", tech);
  ledgerJson = store.get(KEY.ledger);
  pristineJson = store.get(KEY.pristine) ?? ledgerJson;
  render();
  if (ledgerJson) showTab(location.hash.slice(1) || store.get(KEY.tab) || "overview");
} catch (e) {
  $("#boot").textContent = "The app couldn't start: " + e;
}
