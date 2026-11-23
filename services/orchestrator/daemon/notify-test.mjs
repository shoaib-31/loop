// Verifies the notifier fires on BOTH decision paths, without needing a phone.
//
// It registers a FAKE push subscription pointed at a local HTTP server, so a real
// `notify()` call lands here and we can assert on it. That exercises the whole
// chain — session event -> attachNotifier -> webpush.sendNotification — and only
// stubs the push service itself (whose behaviour the spike already proved on a
// real iPhone).
//
// Run: node services/orchestrator/daemon/notify-test.mjs

import { createServer } from "node:https";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate state BEFORE importing notify.mjs, which reads LOOP_ENG_DIR at module
// load. Without this the test writes its fake 127.0.0.1 subscription into the real
// ~/.loop-eng/push-subs.json, so every run leaves a dead endpoint behind that the
// daemon then tries to push to forever (and it would clobber the real VAPID
// keypair, invalidating the actual phone's subscription).
process.env.LOOP_ENG_DIR = mkdtempSync(join(tmpdir(), "loop-eng-test-"));

const { Session } = await import("./session.mjs");
const { initNotifier, attachNotifier, addSubscription } = await import("./notify.mjs");

// Real push services are HTTPS-only and `web-push` enforces it, so the stand-in
// must speak TLS too. Self-signed cert, generated fresh into a temp dir.
const certDir = mkdtempSync(join(tmpdir(), "loop-push-cert-"));
const keyPath = join(certDir, "k.pem");
const certPath = join(certDir, "c.pem");
execFileSync("openssl", [
  "req", "-x509", "-newkey", "rsa:2048", "-nodes",
  "-keyout", keyPath, "-out", certPath,
  "-days", "1", "-subj", "/CN=127.0.0.1",
], { stdio: "ignore" });
// Only safe because the endpoint is our own localhost stub.
process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const received = [];
// Stand-in for web.push.apple.com. The body is AES-GCM encrypted to the
// subscription keys, so we only assert that a push was ATTEMPTED — the payload
// contents are the service worker's business.
const fake = createServer({ key: readFileSync(keyPath), cert: readFileSync(certPath) }, (req, res) => {
  let n = 0;
  req.on("data", (c) => { n += c.length; });
  req.on("end", () => {
    received.push({ path: req.url, bytes: n, ttl: req.headers.ttl });
    res.writeHead(201).end();
  });
});
await new Promise((r) => fake.listen(0, "127.0.0.1", r));
const port = fake.address().port;

await initNotifier();

// A valid subscription needs real P-256 + auth material or web-push refuses to
// encrypt. Generate a throwaway keypair the same way a browser would.
import { createECDH, randomBytes } from "node:crypto";
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const b64u = (b) => b.toString("base64url");
await addSubscription({
  endpoint: `https://127.0.0.1:${port}/push/fake-device`,
  keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(randomBytes(16)) },
});

const wait = (ms) => new Promise((r) => setTimeout(r, ms));
let failures = 0;
const check = (name, ok, extra = "") => {
  console.log(`${ok ? "  PASS" : "  FAIL"}  ${name}${extra ? ` — ${extra}` : ""}`);
  if (!ok) failures++;
};

// ---- PATH A: structured AskUserQuestion -> `pending` -> buzz ----
console.log("\nPATH A — structured question");
{
  const s = new Session({ cwd: process.cwd() });
  attachNotifier(s, { label: "path-a" });
  const before = received.length;
  // Drive the event directly: we're testing the notifier, not the SDK (the SDK
  // capture path is already proven by combined-test.mjs / e2e-test.mjs).
  s._setPending({ header: "Auth", question: "Which auth approach?", multiSelect: false,
    options: [{ label: "Token", description: "random token in the QR" }] });
  await wait(600);
  check("pending fires a push", received.length === before + 1,
    `${received.length - before} push(es)`);

  // Dedup: the same question re-emitting (reconnect, poll) must NOT re-buzz.
  const mid = received.length;
  s._setPending({ header: "Auth", question: "Which auth approach?", multiSelect: false,
    options: [{ label: "Token", description: "random token in the QR" }] });
  await wait(600);
  check("duplicate question is suppressed", received.length === mid);
}

// ---- PATH B: plain-text question at a turn boundary -> buzz ----
console.log("\nPATH B — plain-text question");
{
  const s = new Session({ cwd: process.cwd() });
  attachNotifier(s, { label: "path-b" });

  const before = received.length;
  // Mid-turn narration must NOT buzz — only the `idle` boundary counts.
  s._pushTurn({ role: "assistant", blocks: [{ kind: "text", text: "Working on it…" }], ts: new Date().toISOString() });
  await wait(300);
  check("statement mid-turn does not buzz", received.length === before);

  // A turn ending in "?" then going idle = your move.
  s._pushTurn({ role: "assistant", blocks: [{ kind: "text", text: "Should I use Ink for the TUI?" }], ts: new Date().toISOString() });
  s._emit({ type: "idle" });
  await wait(600);
  check("text question + idle fires a push", received.length === before + 1,
    `${received.length - before} push(es)`);

  // A second idle with no new question must stay quiet.
  const mid = received.length;
  s._emit({ type: "idle" });
  await wait(400);
  check("idle without a new question stays quiet", received.length === mid);
}

// ---- a turn that ends WITHOUT a question -> silence ----
console.log("\nNEGATIVE — completed work, no question");
{
  const s = new Session({ cwd: process.cwd() });
  attachNotifier(s, { label: "quiet" });
  const before = received.length;
  s._pushTurn({ role: "assistant", blocks: [{ kind: "text", text: "Done. All tests pass." }], ts: new Date().toISOString() });
  s._emit({ type: "idle" });
  await wait(500);
  check("statement + idle does not buzz", received.length === before);
}

console.log(`\n${received.length} push(es) delivered to the fake push service.`);
console.log(failures ? `\n${failures} CHECK(S) FAILED\n` : "\nALL CHECKS PASSED\n");
fake.close();
process.exit(failures ? 1 : 0);
