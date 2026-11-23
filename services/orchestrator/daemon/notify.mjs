// Web Push notifier — the delivery half of the USP (buzz → tap → answer).
//
// Why web push and not APNs/ntfy/Telegram: docs/architecture.md. The key property is that
// this needs NO inbound route — we call OUT to the push service (Apple/Google) and
// the phone holds its own connection to it. So the buzz lands with the Mac asleep
// and the phone on cellular; the Funnel URL is only needed AFTERWARD, to open the
// session.
//
// State lives in ~/.loop-eng/ (NOT the repo): the VAPID keypair is this daemon's
// push identity — regenerating it invalidates every existing subscription — and
// subscriptions must survive daemon restarts or the phone would need re-pairing.

import webpush from "web-push";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = process.env.LOOP_ENG_DIR ?? join(homedir(), ".loop-eng");
const VAPID_FILE = join(STATE_DIR, "vapid.json");
const SUBS_FILE = join(STATE_DIR, "push-subs.json");

// The VAPID `sub` claim. Apple VALIDATES this domain and answers
// `403 BadJwtToken` if it isn't routable — `.local`, `.internal` and bare
// hostnames all fail. It never receives mail; it only has to look real.
// (This exact mistake cost us the first push attempt — see PROBLEM 8.)
const SUBJECT = process.env.VAPID_SUBJECT ?? "mailto:loop-eng@example.com";

let keys = null;
const subs = new Map(); // endpoint -> subscription

export async function initNotifier() {
  await mkdir(STATE_DIR, { recursive: true });

  try {
    keys = JSON.parse(await readFile(VAPID_FILE, "utf8"));
  } catch {
    keys = webpush.generateVAPIDKeys();
    // 0o600: this is a private key. Don't let other users on the box read it.
    await writeFile(VAPID_FILE, JSON.stringify(keys, null, 2), { mode: 0o600 });
    console.log(`[notify] generated VAPID keypair -> ${VAPID_FILE}`);
  }
  webpush.setVapidDetails(SUBJECT, keys.publicKey, keys.privateKey);

  try {
    for (const s of JSON.parse(await readFile(SUBS_FILE, "utf8"))) subs.set(s.endpoint, s);
    if (subs.size) console.log(`[notify] ${subs.size} push subscription(s) restored`);
  } catch { /* none yet */ }

  return { publicKey: keys.publicKey, subscriptions: subs.size };
}

export const publicKey = () => keys?.publicKey ?? null;
export const subscriptionCount = () => subs.size;

const persist = () =>
  writeFile(SUBS_FILE, JSON.stringify([...subs.values()], null, 2), { mode: 0o600 }).catch(
    (e) => console.error(`[notify] could not persist subscriptions: ${e.message}`)
  );

export async function addSubscription(sub) {
  if (!sub?.endpoint) throw new Error("subscription needs an endpoint");
  subs.set(sub.endpoint, sub);
  await persist();
  // The endpoint host names the push service — `web.push.apple.com` is the proof
  // iOS is genuinely wired up. Most useful single diagnostic we have.
  console.log(`[notify] subscribed: ${new URL(sub.endpoint).host} (${subs.size} total)`);
  return subs.size;
}

export async function removeSubscription(endpoint) {
  const had = subs.delete(endpoint);
  if (had) await persist();
  return had;
}

// Suppress a duplicate buzz for the same decision. `pending` can legitimately
// re-emit (reconnects, repeated polls) and re-notifying the same question is the
// fastest way to make notifications feel like spam.
let lastKey = null;
let lastAt = 0;
const DEDUP_MS = 30_000;

/**
 * Fire a notification at every subscribed device.
 * `url` is a path — the service worker turns it into a deep link on tap.
 * Best-effort by design: a push failure must never disturb the agent run.
 */
export async function notify({ title, body, url = "/", tag = "loop", key = null }) {
  if (!keys) return { skipped: "notifier not initialised" };
  if (!subs.size) return { skipped: "no subscriptions" };

  const now = Date.now();
  if (key && key === lastKey && now - lastAt < DEDUP_MS) return { skipped: "duplicate" };
  if (key) { lastKey = key; lastAt = now; }

  const payload = JSON.stringify({ title, body, url, tag });
  const results = [];

  for (const [endpoint, sub] of [...subs]) {
    try {
      const r = await webpush.sendNotification(sub, payload);
      results.push({ host: new URL(endpoint).host, status: r.statusCode });
    } catch (err) {
      const status = err?.statusCode;
      // 404/410 = the subscription is dead (PWA deleted, permission revoked).
      // Drop it, otherwise it fails forever on every future notification.
      if (status === 404 || status === 410) {
        subs.delete(endpoint);
        await persist();
        console.log(`[notify] dropped dead subscription (${status})`);
      } else {
        let reason = err?.body;
        try { reason = JSON.parse(err.body).reason; } catch { /* keep raw */ }
        console.error(`[notify] push failed ${status}: ${reason ?? err?.message}`);
      }
      results.push({ host: new URL(endpoint).host, error: status ?? String(err) });
    }
  }
  return { sent: results };
}

// ---- the actual decision-loop wiring -------------------------------------
// Attach to a Session's event stream and buzz when it's the human's move. The
// two detectors mirror docs/architecture.md's two-detector model, and neither reshapes
// what Claude does (see the "preserve Claude's native feel" decision):
//   PATH A - structured AskUserQuestion -> a `pending` frame.
//   PATH B - a plain-text question: assistant turn whose text ends in "?", at a
//            turn boundary (`idle`), so mid-turn narration doesn't trigger it.
export function attachNotifier(session, { label } = {}) {
  const name = label || session.meta?.().projectName || "session";
  let lastAssistantText = "";

  return session.addListener((evt) => {
    if (evt.type === "turn" && evt.turn?.role === "assistant") {
      const texts = evt.turn.blocks.filter((b) => b.kind === "text").map((b) => b.text);
      // Remember only the newest assistant prose, so the idle check below tests
      // what the user actually just read.
      if (texts.length) lastAssistantText = texts[texts.length - 1].trim();
    }

    // PATH A: a structured question is parked, waiting on a human.
    if (evt.type === "pending" && evt.question) {
      const q = evt.question;
      notify({
        title: `${name} needs a decision`,
        body: q.question ?? q.header ?? "Tap to answer.",
        url: `/session/${session.id}`,
        tag: `loop-${session.id}`,
        key: `${session.id}:${q.question}`,
      });
      return;
    }

    // PATH B: turn finished on a plain-text question. Dumb trailing-"?" test, on
    // purpose — Claude is free to ask however it likes, and we adapt to it.
    if (evt.type === "idle" && /\?\s*$/.test(lastAssistantText)) {
      notify({
        title: `${name} asked you something`,
        body: lastAssistantText.slice(-180),
        url: `/session/${session.id}`,
        tag: `loop-${session.id}`,
        key: `${session.id}:${lastAssistantText.slice(-80)}`,
      });
      lastAssistantText = ""; // one buzz per question
    }
  });
}
