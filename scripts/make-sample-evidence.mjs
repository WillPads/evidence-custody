// Generates the fictional sample evidence in web/sample-evidence/ (served by the website):
//   1-originals/          files to LOG in the app (the "real" evidence)
//   2-copies-to-verify/   copies to VERIFY later: some untouched, some tampered
//   comparison.png        side-by-side picture of the image tampering, for presentations
//
// Images are drawn as HTML and photographed with headless Microsoft Edge
// (no extra libraries needed). Run:  node scripts/make-sample-evidence.mjs
//
// Everything here is made up. Names, numbers and places are fictional.

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync, copyFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "sample-evidence");
const ORIG = join(ROOT, "1-originals");
const COPY = join(ROOT, "2-copies-to-verify");
const EDGE_PATHS = [
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
  "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
];

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- text files

const lease = (days) => `FICTIONAL SAMPLE - FOR DEMONSTRATION ONLY

CONTRACT OF LEASE

This Contract of Lease is entered into on 1 October 2026 in Quezon City by:

  MARIA L. SANTOS, of legal age, hereinafter the "LESSOR"; and
  JUAN P. DELA CRUZ, of legal age, hereinafter the "LESSEE".

1. PROPERTY. The Lessor leases to the Lessee Unit 4B, Example Residences,
   Barangay Example, Quezon City.

2. TERM. The lease shall be for one (1) year, from 1 October 2026 to
   30 September 2027.

3. PAYMENT. The Lessee shall pay a monthly rent of Twenty-Five Thousand
   Pesos (PHP 25,000.00) within ${days} of receiving each billing statement.

4. DEPOSIT. The Lessee shall pay a security deposit equivalent to two (2)
   months' rent, refundable at the end of the lease less unpaid charges.

5. TERMINATION. Failure to pay rent within the period stated in Section 3
   shall be a ground for termination of this lease.

IN WITNESS WHEREOF, the parties have signed this Contract on the date above.

  (signed) Maria L. Santos            (signed) Juan P. Dela Cruz
           LESSOR                              LESSEE
`;

const chat = (friday) => `FICTIONAL SAMPLE - FOR DEMONSTRATION ONLY
Chat export: "Unit 4B Rent" (exported 4 Nov 2026)

[02/11/2026, 18:04] Maria Santos: Hi Juan, October rent is still unpaid.
[02/11/2026, 18:11] Juan Dela Cruz: Sorry po, I know. Payroll was delayed.
[02/11/2026, 18:12] Maria Santos: When can you settle it?
[02/11/2026, 18:20] Juan Dela Cruz: ${friday}
[02/11/2026, 18:21] Maria Santos: Okay. Please send the receipt after.
[03/11/2026, 21:40] Juan Dela Cruz: Paid at the hardware store counter, OR No. 004127.
[03/11/2026, 21:43] Maria Santos: Received, thank you.
`;

const bank = `date,description,reference,debit,credit,balance
2026-11-01,OPENING BALANCE,,,,"184,250.00"
2026-11-02,ATM WITHDRAWAL QC BRANCH,ATM-55120,"5,000.00",,"179,250.00"
2026-11-03,BILLS PAYMENT MERALCO,BP-88412,"3,412.75",,"175,837.25"
2026-11-03,CASH PAYMENT OR 004127,CP-004127,"12,500.00",,"163,337.25"
2026-11-05,PAYROLL CREDIT,PR-202611A,,"38,000.00","201,337.25"
2026-11-06,FUND TRANSFER TO M SANTOS,FT-77310,"25,000.00",,"176,337.25"
# FICTIONAL SAMPLE - FOR DEMONSTRATION ONLY
`;

// ---------------------------------------------------------------- images (HTML)

const receiptHtml = (amount) => `<!doctype html><html><head><style>
  body { margin:0; width:640px; height:420px; display:grid; place-items:center; background:#d9d4c7; font-family: "Times New Roman", serif; }
  .r { position:relative; width:600px; height:380px; box-sizing:border-box; padding:22px 30px;
       background: linear-gradient(180deg,#fffdf6,#f6f1e2); border:1px solid #b9b1a0; box-shadow: 0 2px 6px rgba(0,0,0,.25); color:#222; }
  .hd { text-align:center; border-bottom:2px solid #333; padding-bottom:8px; }
  .hd b { font-size:20px; letter-spacing:1px; } .hd div { font-size:13px; }
  .t { display:flex; justify-content:space-between; margin:12px 0 6px; font-weight:bold; }
  .no { color:#b3261e; font-size:18px; }
  .row { font-size:15px; margin:9px 0; } .row span { border-bottom:1px solid #666; padding:0 6px; font-style:italic; }
  .amt { position:absolute; right:30px; top:205px; font-size:22px; font-weight:bold; border:2px solid #333; padding:6px 14px; background:#fff; }
  .sig { position:absolute; right:40px; bottom:28px; text-align:center; font-size:13px; }
  .sig i { font-family:"Segoe Script", cursive; font-size:22px; display:block; border-bottom:1px solid #333; padding:0 18px; }
  .wm { position:absolute; left:30px; bottom:12px; font: 10px Arial, sans-serif; color:#a33; letter-spacing:1px; }
</style></head><body><div class="r">
  <div class="hd"><b>SAMPLE HARDWARE &amp; CONSTRUCTION SUPPLY</b><div>123 Example Avenue, Quezon City · TIN 000-000-000-000</div></div>
  <div class="t"><span>OFFICIAL RECEIPT</span><span class="no">No. 004127</span></div>
  <div class="row">Date: <span>November 3, 2026</span></div>
  <div class="row">Received from: <span>Juan P. Dela Cruz</span></div>
  <div class="row">the sum of: <span>Twelve Thousand Five Hundred Pesos Only</span></div>
  <div class="row">in payment of: <span>Rent, Unit 4B (October 2026)</span></div>
  <div class="amt" id="changed">₱ ${amount}</div>
  <div class="sig"><i>R. Santos</i>Cashier / Authorized Signature</div>
  <div class="wm">FICTIONAL SAMPLE · FOR DEMONSTRATION ONLY</div>
</div></body></html>`;

const cctvHtml = (time) => `<!doctype html><html><head><style>
  body { margin:0; width:640px; height:360px; overflow:hidden; background:#0b0f0c; font-family: Consolas, monospace; }
  .s { position:relative; width:640px; height:360px; filter: grayscale(.85) contrast(1.1);
       background: linear-gradient(#1b2420 0 55%, #262b27 55% 100%); }
  .b { position:absolute; background:#3a443e; } .w { position:absolute; width:18px; height:22px; background:#c9b765; opacity:.75; }
  .car { position:absolute; left:90px; top:228px; width:150px; height:46px; background:#77807a; border-radius:14px 22px 6px 6px; }
  .car:before { content:""; position:absolute; left:28px; top:-22px; width:84px; height:26px; background:#5d6560; border-radius:12px 18px 0 0; }
  .wh { position:absolute; top:262px; width:30px; height:30px; border-radius:50%; background:#111; }
  .p { position:absolute; left:430px; top:178px; } .p .h { width:22px; height:22px; border-radius:50%; background:#9a9f9b; margin-left:9px; }
  .p .bd { width:40px; height:74px; background:#555c57; border-radius:10px 10px 4px 4px; } .p .bag { position:absolute; left:28px; top:34px; width:22px; height:26px; background:#222; border-radius:4px; }
  .lamp { position:absolute; left:520px; top:40px; width:160px; height:220px; background: radial-gradient(closest-side, rgba(255,240,180,.22), transparent); }
  .scan { position:absolute; inset:0; background: repeating-linear-gradient(0deg, rgba(255,255,255,.03) 0 1px, transparent 1px 3px); }
  .o { position:absolute; color:#f2f2f2; font-size:15px; text-shadow:0 0 3px #000; letter-spacing:1px; }
  .rec { color:#ff4b4b; }
</style></head><body><div class="s">
  <div class="b" style="left:20px; top:30px; width:250px; height:170px"></div>
  <div class="b" style="left:300px; top:70px; width:180px; height:130px; background:#323b36"></div>
  <div class="w" style="left:50px; top:60px"></div><div class="w" style="left:110px; top:60px; opacity:.3"></div>
  <div class="w" style="left:170px; top:110px"></div><div class="w" style="left:340px; top:100px; opacity:.4"></div>
  <div class="lamp"></div>
  <div class="car"></div><div class="wh" style="left:110px"></div><div class="wh" style="left:195px"></div>
  <div class="p"><div class="h"></div><div class="bd"></div><div class="bag"></div></div>
  <div class="scan"></div>
  <div class="o" style="left:14px; top:12px">CAM 03 · NORTH GATE</div>
  <div class="o" style="right:14px; top:12px" id="changed">2026-11-03 ${time}</div>
  <div class="o rec" style="left:14px; bottom:12px">● REC</div>
  <div class="o" style="right:14px; bottom:12px; font-size:11px">FICTIONAL SAMPLE</div>
</div></body></html>`;

const comparisonHtml = (rows) => `<!doctype html><html><head><style>
  body { margin:0; width:1400px; background:#f4f5f7; font-family: "Segoe UI", Arial, sans-serif; color:#17202b; }
  h1 { margin:0; padding:26px 32px 4px; font-size:26px; } p.sub { margin:0; padding:0 32px 18px; color:#5d6877; font-size:15px; }
  .row { display:grid; grid-template-columns: 1fr 1fr; gap:24px; padding:10px 32px 26px; }
  .cell { background:#fff; border:1px solid #dde1e7; border-radius:12px; padding:14px; }
  .lab { display:flex; justify-content:space-between; align-items:center; margin-bottom:10px; font-weight:600; }
  .ok { color:#17663f; } .bad { color:#b42318; }
  .img { position:relative; } .img img { display:block; width:100%; border-radius:6px; }
  .hl { position:absolute; border:4px solid #e11d48; border-radius:50%; box-shadow:0 0 0 3px rgba(255,255,255,.7); }
  .fp { font-family: Consolas, monospace; font-size:13px; color:#5d6877; margin-top:10px; word-break:break-all; }
  .fp b { color:#17202b; } .note { font-size:14px; margin-top:6px; }
</style></head><body>
  <h1>Same-looking evidence, different fingerprints</h1>
  <p class="sub">Left: the file as logged. Right: a copy that was altered afterwards. One changed detail produces a completely different SHA-256 fingerprint, so verification fails. (Fictional samples.)</p>
  ${rows.map((r) => `
  <div class="row">
    <div class="cell"><div class="lab"><span>${r.title}: original (logged)</span><span class="ok">✓ matches log</span></div>
      <div class="img"><img src="${r.origSrc}"></div>
      <div class="fp">SHA-256 <b>${r.origHash.slice(0, 32)}</b>${r.origHash.slice(32)}</div></div>
    <div class="cell"><div class="lab"><span>${r.title}: altered copy</span><span class="bad">✗ verification fails</span></div>
      <div class="img"><img src="${r.tampSrc}"><div class="hl" style="left:${r.box.x}%; top:${r.box.y}%; width:${r.box.w}%; height:${r.box.h}%"></div></div>
      <div class="fp">SHA-256 <b>${r.tampHash.slice(0, 32)}</b>${r.tampHash.slice(32)}</div>
      <div class="note bad">${r.note}</div></div>
  </div>`).join("")}
</body></html>`;

// ---------------------------------------------------------------- headless Edge

async function startEdge() {
  const exe = EDGE_PATHS.find(existsSync);
  if (!exe) throw new Error("Microsoft Edge not found");
  const port = 9340;
  const profile = join(tmpdir(), "custody-sample-edge");
  const proc = spawn(exe, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--hide-scrollbars", "--force-device-scale-factor=1", "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 50 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
  }
  if (!target) throw new Error("could not connect to Edge");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg.result); pending.delete(msg.id); }
  });
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  await send("Page.enable");
  return { send, close: () => { ws.close(); proc.kill(); } };
}

/** Render HTML at a fixed size and return { png, box } where box is #changed's rect in %. */
async function render(edge, html, width, height) {
  await edge.send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 1, mobile: false });
  await edge.send("Page.navigate", { url: "data:text/html;charset=utf-8;base64," + Buffer.from(html).toString("base64") });
  await sleep(700);
  const rect = await edge.send("Runtime.evaluate", {
    expression: `(() => { const e = document.getElementById("changed"); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, w: r.width, h: r.height }; })()`,
    returnByValue: true,
  });
  const shot = await edge.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width, height, scale: 1 } });
  const r = rect.result.value;
  const pad = 10;
  const box = r && {
    x: ((r.x - pad) / width) * 100, y: ((r.y - pad) / height) * 100,
    w: ((r.w + pad * 2) / width) * 100, h: ((r.h + pad * 2) / height) * 100,
  };
  return { png: Buffer.from(shot.data, "base64"), box };
}

// ---------------------------------------------------------------- main

rmSync(ROOT + "/1-originals", { recursive: true, force: true });
rmSync(ROOT + "/2-copies-to-verify", { recursive: true, force: true });
mkdirSync(ORIG, { recursive: true });
mkdirSync(COPY, { recursive: true });

// Text evidence
writeFileSync(join(ORIG, "lease_agreement.txt"), lease("thirty (30) days"));
writeFileSync(join(COPY, "lease_agreement.txt"), lease("ninety (90) days"));
writeFileSync(join(ORIG, "chat_export.txt"), chat("I will pay on Friday."));
writeFileSync(join(COPY, "chat_export.txt"), chat("I will pay on Friday. ")); // one invisible trailing space
writeFileSync(join(ORIG, "bank_statement.csv"), bank);
copyFileSync(join(ORIG, "bank_statement.csv"), join(COPY, "bank_statement.csv")); // exact copy

// Image evidence
const edge = await startEdge();
try {
  const recO = await render(edge, receiptHtml("12,500.00"), 640, 420);
  const recT = await render(edge, receiptHtml("72,500.00"), 640, 420);
  const camO = await render(edge, cctvHtml("21:42:17"), 640, 360);
  const camT = await render(edge, cctvHtml("19:42:17"), 640, 360);
  writeFileSync(join(ORIG, "payment_receipt.png"), recO.png);
  writeFileSync(join(COPY, "payment_receipt.png"), recT.png);
  writeFileSync(join(COPY, "receipt_copy_for_client.png"), recO.png); // exact copy, renamed
  writeFileSync(join(ORIG, "cctv_still.png"), camO.png);
  writeFileSync(join(COPY, "cctv_still.png"), camT.png);

  const src = (png) => "data:image/png;base64," + png.toString("base64");
  const rows = [
    { title: "Official receipt", origSrc: src(recO.png), tampSrc: src(recT.png), origHash: sha256(recO.png), tampHash: sha256(recT.png),
      box: recT.box, note: "Amount changed from ₱12,500.00 to ₱72,500.00 (the amount in words still says twelve thousand five hundred)." },
    { title: "CCTV still", origSrc: src(camO.png), tampSrc: src(camT.png), origHash: sha256(camO.png), tampHash: sha256(camT.png),
      box: camT.box, note: "Timestamp changed from 21:42:17 to 19:42:17 to create a false alibi." },
  ];
  const html = comparisonHtml(rows);
  await edge.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: 1200, deviceScaleFactor: 1, mobile: false });
  await edge.send("Page.navigate", { url: "data:text/html;charset=utf-8;base64," + Buffer.from(html).toString("base64") });
  await sleep(900);
  const h = (await edge.send("Runtime.evaluate", { expression: "document.body.scrollHeight", returnByValue: true })).result.value;
  await edge.send("Emulation.setDeviceMetricsOverride", { width: 1400, height: h, deviceScaleFactor: 1, mobile: false });
  await sleep(300);
  const cmp = await edge.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: 1400, height: h, scale: 1 } });
  writeFileSync(join(ROOT, "comparison.png"), Buffer.from(cmp.data, "base64"));
} finally {
  edge.close();
}

// Print the fingerprints for the README table
for (const dir of [ORIG, COPY]) {
  for (const name of ["lease_agreement.txt", "chat_export.txt", "bank_statement.csv", "payment_receipt.png", "receipt_copy_for_client.png", "cctv_still.png"]) {
    const p = join(dir, name);
    if (existsSync(p)) console.log(`${dir.endsWith("originals") ? "orig" : "copy"}  ${name.padEnd(30)} ${sha256(readFileSync(p))}`);
  }
}
console.log("Done: " + ROOT);
