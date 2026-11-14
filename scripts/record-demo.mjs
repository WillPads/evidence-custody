// Records the demo video shown on the website (web/demo/).
//
// How: a headless Microsoft Edge opens the real app, a script performs a
// walkthrough with a visible cursor and captions, and every repaint is captured
// (Chrome DevTools "screencast"). The frames are then replayed onto a canvas in
// a second page and encoded with the browser's own MediaRecorder. No ffmpeg or
// other tools needed.
//
// Usage: start the local server first (python scripts/serve.py 4180), then
//        node scripts/record-demo.mjs [http://127.0.0.1:4180/]

import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { fixMp4Duration } from "./fix-mp4-duration.mjs";

const APP = process.argv[2] ?? "http://127.0.0.1:4180/";
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "web", "demo");
const FRAMES = join(tmpdir(), "custody-demo-frames");
const W = 1280, H = 720;
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ CDP

async function launch(port) {
  const profile = join(tmpdir(), "custody-demo-profile-" + port);
  rmSync(profile, { recursive: true, force: true });
  const proc = spawn(EDGE, ["--headless=new", `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    "--no-first-run", "--hide-scrollbars", "--force-device-scale-factor=1", "--autoplay-policy=no-user-gesture-required",
    "--force-dark-mode", "about:blank"], { stdio: "ignore" });
  let target;
  for (let i = 0; i < 60 && !target; i++) {
    await sleep(200);
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === "page"); } catch {}
  }
  if (!target) throw new Error("could not connect to Edge");
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  let id = 0;
  const pending = new Map();
  const listeners = [];
  ws.addEventListener("message", (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
    if (msg.method) listeners.forEach((fn) => fn(msg));
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const i = ++id;
    pending.set(i, (msg) => (msg.error ? reject(new Error(method + ": " + msg.error.message)) : resolve(msg.result)));
    ws.send(JSON.stringify({ id: i, method, params }));
  });
  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
    return r.result.value;
  };
  return { send, evaluate, on: (fn) => listeners.push(fn), close: () => { ws.close(); proc.kill(); } };
}

// ------------------------------------------------------------------ the walkthrough (runs inside the app page)

const WALKTHROUGH = String.raw`
(async () => {
  const q = (s) => document.querySelector(s);
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));

  // ---- overlay: cursor + captions, kept above dialogs via the popover top layer
  const root = document.createElement("div");
  root.setAttribute("popover", "manual");
  root.style.cssText = "position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;overflow:visible;pointer-events:none;";
  root.innerHTML = '<div id="d-cap" style="position:absolute;left:50%;bottom:26px;transform:translateX(-50%);max-width:980px;padding:14px 24px;border-radius:14px;background:rgba(8,12,18,.88);color:#fff;font:600 21px/1.4 Segoe UI,system-ui,sans-serif;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.4);opacity:0;transition:opacity .35s"></div>' +
    '<div id="d-cur" style="position:absolute;left:640px;top:400px;width:28px;height:28px;transition:left .75s cubic-bezier(.4,0,.2,1),top .75s cubic-bezier(.4,0,.2,1)"><svg viewBox="0 0 24 24" width="28" height="28"><path d="M4 2l15 11-6.5 1.2 3.8 7.3-2.6 1.3-3.8-7.3L5 20z" fill="#fff" stroke="#000" stroke-width="1.4" stroke-linejoin="round"/></svg></div>' +
    '<div id="d-ring" style="position:absolute;width:44px;height:44px;margin:-22px 0 0 -22px;border-radius:50%;border:3px solid #ffd54a;opacity:0;transform:scale(.4)"></div>';
  document.body.append(root);
  const front = () => { try { root.hidePopover(); } catch {} root.showPopover(); };
  front();
  const cap = root.querySelector("#d-cap"), cur = root.querySelector("#d-cur"), ring = root.querySelector("#d-ring");

  async function say(text, hold = 2600) {
    cap.style.opacity = 0; await wait(250);
    cap.textContent = text; cap.style.opacity = 1;
    await wait(hold);
  }
  const hush = () => (cap.style.opacity = 0);

  async function move(target) {
    const el = typeof target === "string" ? q(target) : target;
    if (!el) throw new Error("demo: not found " + target);
    const r0 = el.getBoundingClientRect();
    if (r0.top < 70 || r0.bottom > innerHeight - 120) { el.scrollIntoView({ block: "center", behavior: "smooth" }); await wait(700); }
    const r = el.getBoundingClientRect();
    cur.style.left = (r.left + Math.min(r.width / 2, 60)) + "px";
    cur.style.top = (r.top + r.height / 2) + "px";
    await wait(850);
    return el;
  }
  async function click(target, after = 500) {
    const el = await move(target);
    ring.style.transition = "none"; ring.style.left = cur.style.left; ring.style.top = cur.style.top;
    ring.style.opacity = 1; ring.style.transform = "scale(.4)";
    await wait(30);
    ring.style.transition = "transform .45s ease-out, opacity .45s ease-out"; ring.style.transform = "scale(1.4)"; ring.style.opacity = 0;
    el.click();
    await wait(120); front(); await wait(after);
    return el;
  }
  async function type(target, text) {
    const el = await click(target, 150);
    el.focus();
    for (const ch of text) { el.value += ch; el.dispatchEvent(new Event("input", { bubbles: true })); await wait(55); }
    await wait(300);
  }
  async function choose(target, value) {
    const el = await click(target, 250);
    el.value = value; el.dispatchEvent(new Event("change", { bubbles: true }));
    el.style.outline = "3px solid #ffd54a"; await wait(600); el.style.outline = "";
    await wait(250);
  }
  async function file(target, url, name) {
    const input = q(target);
    await move(input.closest(".drop"));
    const bytes = await (await fetch(url, { cache: "no-store" })).arrayBuffer();
    const dt = new DataTransfer(); dt.items.add(new File([bytes], name)); input.files = dt.files;
    input.dispatchEvent(new Event("change"));
    await wait(700);
  }
  const scrollTo = async (y) => { window.scrollTo({ top: y, behavior: "smooth" }); await wait(900); };

  // ================================================================ script
  localStorage.clear(); window.confirm = () => true;
  // Pattern: the caption appears first and describes what happens next,
  // then the action plays out underneath it, then a pause to read the result.
  await wait(600);
  await say("Custody Ledger keeps a tamper-evident chain of custody for digital evidence.", 3200);
  await say("Let's open the sample case: five fictional evidence files, already logged.", 1400);
  await click("#btn-demo", 1600);
  await say("The green panel confirms that nothing in the custody log has been altered.", 3400);
  await say("The Overview shows the main actions, a summary and the latest activity.", 500);
  await move("#stats"); await wait(2400);

  await say("Evidence tab: every file, its category, and who holds it right now.", 500);
  await click("[data-tab=evidence]", 3000);

  await say("Only authorized custodians may hold evidence. Let's add one.", 500);
  await click("[data-tab=custodians]", 1200);
  await click("#btn-add-custodian", 500);
  await type("#form-custodian [name=name]", "Clerk of Court, RTC Branch 12");
  await choose("#form-custodian [name=role]", "Court / clerk of court");
  await type("#form-custodian [name=note]", "Receiving clerk");
  await click("#form-custodian button.primary", 600);
  await say("Added to the list. The change is recorded permanently in the custody log.", 3000);

  await say("Transfer custody: pick an item and an authorized receiver.", 500);
  await click("[data-tab=overview]", 400);
  await click("#act-transfer", 500);
  await choose("#form-transfer [name=id]", "2");
  await choose("#form-transfer [name=to]", "Clerk of Court, RTC Branch 12");
  await type("#form-transfer [name=reason]", "Submission as Exhibit B");
  await click("#btn-confirm-transfer", 600);
  await say("Only the current custodian can release an item, and only to someone on the list.", 3200);

  await say("Log new evidence: choose a category, then the file.", 500);
  await click("#act-add", 500);
  await choose("#form-add [name=category]", "Photograph");
  await file("#form-add [name=file]", "sample-evidence/comparison.png", "site_inspection_photo.png");
  await type("#form-add [name=desc]", "Photo taken during site inspection");
  await click("#form-add button.primary", 600);
  await say("The app records the file's digital fingerprint. The file itself is never uploaded.", 3200);

  await say("Someone sends you a copy of the receipt. Is it genuine?", 500);
  await click("#act-check", 500);
  await file("#form-check [name=file]", "sample-evidence/2-copies-to-verify/payment_receipt.png", "payment_receipt.png");
  await click("#form-check button.primary", 300);
  await say("Altered! The amount was changed, so the fingerprints don't match.", 3800);
  await say("Next: a chat export with one invisible extra space.", 500);
  await file("#form-check [name=file]", "sample-evidence/2-copies-to-verify/chat_export.txt", "chat_export.txt");
  await click("#form-check button.primary", 300);
  await say("Caught. Even a change you can't see breaks the fingerprint.", 3400);
  await say("Now an exact copy of the bank statement…", 500);
  await file("#form-check [name=file]", "sample-evidence/2-copies-to-verify/bank_statement.csv", "bank_statement.csv");
  await click("#form-check button.primary", 300);
  await say("Verified. Exact copies pass, even when renamed.", 3000);
  await click("#dlg-check [data-close]", 300);

  await say("Every action is recorded in the custody log, newest first.", 500);
  await click("[data-tab=log]", 800);
  await scrollTo(360); await wait(1000); await scrollTo(0);

  await say("What if someone edits the saved records directly? Let's try.", 500);
  await click("[data-tab=integrity]", 800);
  await click("#t-edit", 200);
  await scrollTo(0); await move("#status");
  await say("Detected immediately. The warning names the exact entry that was changed.", 4000);
  await say("Restore the original records…", 300);
  await click("#t-restore", 300);
  await scrollTo(0); await move("#status");
  await say("…and the custody log is verified again.", 2600);
  await say("Share the integrity receipt with your client so they can confirm the history later.", 300);
  await move("#receipt"); await wait(3000);
  await say("Save the case file to keep it. Try it yourself with the sample files on the start page.", 300);
  await scrollTo(0); await move("#btn-export"); await wait(3400);
  hush(); await wait(800);
  return "done";
})()`;

// ------------------------------------------------------------------ encoder page code

const ENCODER = String.raw`
window.enc = {
  frames: [],
  add(list) { for (const [b64, t] of list) { const bin = atob(b64); const u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); this.frames.push({ blob: new Blob([u], { type: "image/jpeg" }), t }); } return this.frames.length; },
  card(ctx, title, sub, foot, alpha) {
    ctx.globalAlpha = 1; ctx.fillStyle = "#0f141a"; ctx.fillRect(0, 0, 1280, 720);
    ctx.globalAlpha = alpha;
    ctx.fillStyle = "#8fb4e3"; ctx.beginPath(); ctx.roundRect(592, 170, 96, 96, 20); ctx.fill();
    ctx.strokeStyle = "#0f141a"; ctx.lineWidth = 7; ctx.strokeRect(618, 205, 18, 18); ctx.strokeRect(644, 205, 18, 18);
    ctx.textAlign = "center"; ctx.fillStyle = "#e8edf3";
    ctx.font = "700 58px Segoe UI, sans-serif"; ctx.fillText(title, 640, 345);
    ctx.font = "400 28px Segoe UI, sans-serif"; ctx.fillStyle = "#a0abba"; ctx.fillText(sub, 640, 400);
    ctx.font = "400 20px Segoe UI, sans-serif"; ctx.fillText(foot, 640, 640);
    ctx.globalAlpha = 1;
  },
  async run(mime, intro, outro) {
    // Not attached to the page on purpose: in a headless browser, an on-page canvas only
    // hands frames to the recorder when the page repaints, which a hidden page never does.
    const c = document.createElement("canvas"); c.width = 1280; c.height = 720;
    const ctx = c.getContext("2d");
    const rec = new MediaRecorder(c.captureStream(30), { mimeType: mime, videoBitsPerSecond: 1_600_000 });
    const chunks = []; rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
    const hold = async (ms, draw) => { const end = performance.now() + ms; while (performance.now() < end) { draw(); await sleep(66); } };
    const fadeCard = async (args, ms) => {
      const t0 = performance.now();
      await hold(ms, () => { const t = performance.now() - t0; const a = Math.min(1, t / 500, (ms - t) / 500); this.card(ctx, ...args, Math.max(0, a)); });
    };
    rec.start(1000);
    await fadeCard(intro, 3600);
    const t0 = this.frames[0].t, start = performance.now();
    let current = null;
    for (let i = 0; i < this.frames.length; i++) {
      const bmp = await createImageBitmap(this.frames[i].blob);
      const due = start + (this.frames[i].t - t0) * 1000;
      while (performance.now() < due - 5) { if (current) ctx.drawImage(current, 0, 0, 1280, 720); await sleep(Math.min(66, due - performance.now())); }
      if (current) current.close();
      current = bmp; ctx.drawImage(current, 0, 0, 1280, 720);
      this.frames[i].blob = null;
    }
    await hold(1200, () => ctx.drawImage(current, 0, 0, 1280, 720));
    await fadeCard(outro, 4200);
    rec.stop(); await new Promise((r) => (rec.onstop = r));
    this.result = new Blob(chunks, { type: mime });
    this.bytes = new Uint8Array(await this.result.arrayBuffer());
    return this.bytes.length;
  },
  chunk(i, size) { let s = ""; const part = this.bytes.subarray(i * size, (i + 1) * size); for (let j = 0; j < part.length; j += 0x8000) s += String.fromCharCode(...part.subarray(j, j + 0x8000)); return btoa(s); },
};`;

// ------------------------------------------------------------------ main

mkdirSync(OUT, { recursive: true });
rmSync(FRAMES, { recursive: true, force: true });
mkdirSync(FRAMES, { recursive: true });

console.log("1/4 Recording walkthrough…");
const app = await launch(9351);
await app.send("Page.enable");
await app.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 1, mobile: false });
await app.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });
await app.send("Page.navigate", { url: APP });
await sleep(2500);

const frames = [];
app.on(async (msg) => {
  if (msg.method !== "Page.screencastFrame") return;
  const { data, metadata, sessionId } = msg.params;
  const file = join(FRAMES, String(frames.length).padStart(5, "0") + ".jpg");
  writeFileSync(file, Buffer.from(data, "base64"));
  frames.push({ file, t: metadata.timestamp });
  app.send("Page.screencastFrameAck", { sessionId }).catch(() => {});
});
await app.send("Page.startScreencast", { format: "jpeg", quality: 82, maxWidth: W, maxHeight: H, everyNthFrame: 2 });
await sleep(500);
console.log("   walkthrough:", await app.evaluate(WALKTHROUGH));
await sleep(500);
await app.send("Page.stopScreencast");

// Poster image: the sample case overview, without the demo overlay.
await app.send("Page.navigate", { url: APP });
await sleep(1500);
await app.evaluate(`(async () => { localStorage.clear(); document.querySelector("#btn-demo").click(); await new Promise(r => setTimeout(r, 1200)); document.querySelector("#toast").hidden = true; window.scrollTo(0, 0); })()`);
await sleep(400);
const poster = await app.send("Page.captureScreenshot", { format: "png", clip: { x: 0, y: 0, width: W, height: H, scale: 1 } });
writeFileSync(join(OUT, "poster.png"), Buffer.from(poster.data, "base64"));
app.close();
console.log(`   ${frames.length} frames, ${(frames.at(-1).t - frames[0].t).toFixed(1)} s`);

console.log("2/4 Loading frames into the encoder…");
const enc = await launch(9352);
await enc.send("Page.navigate", { url: APP + "sample-evidence/README.md" }); // any same-origin page works
await sleep(1200);
await enc.evaluate(ENCODER);
const mime = await enc.evaluate(`["video/mp4;codecs=avc1.42E01F", "video/mp4", "video/webm;codecs=vp9", "video/webm"].find((m) => MediaRecorder.isTypeSupported(m))`);
if (!mime) throw new Error("no supported video format");
for (let i = 0; i < frames.length; i += 40) {
  const batch = frames.slice(i, i + 40).map((f) => [readFileSync(f.file).toString("base64"), f.t]);
  await enc.evaluate(`window.enc.add(${JSON.stringify(batch)})`);
}

console.log(`3/4 Encoding in real time as ${mime}…`);
const size = await enc.evaluate(`window.enc.run(${JSON.stringify(mime)},
  ["Custody Ledger", "How to use it, in about two minutes", "Chain of custody for digital evidence · sample data is fictional"],
  ["Try it yourself", "Open the sample case and download the sample files on the start page", "Custody Ledger · Rust + WebAssembly"])`);

console.log("4/4 Saving…");
const parts = [];
const CH = 3 * 1024 * 1024;
for (let i = 0; i * CH < size; i++) parts.push(Buffer.from(await enc.evaluate(`window.enc.chunk(${i}, ${CH})`), "base64"));
enc.close();
const ext = mime.startsWith("video/mp4") ? "mp4" : "webm";
for (const old of ["mp4", "webm"]) rmSync(join(OUT, `custody-ledger-demo.${old}`), { force: true });
const outFile = join(OUT, `custody-ledger-demo.${ext}`);
let video = Buffer.concat(parts);
if (ext === "mp4") video = fixMp4Duration(video).buffer; // MediaRecorder leaves the total length unset
writeFileSync(outFile, video);
rmSync(FRAMES, { recursive: true, force: true });
console.log(`Done: ${outFile} (${(size / 1024 / 1024).toFixed(1)} MB)`);
