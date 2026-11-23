// Exposure control — `tailscale serve` (default) and `funnel` (opt-in).
//
// Exposure is part of STARTUP, not a subcommand (docs/architecture.md): a QR
// pointing at a URL that doesn't resolve is worse than no QR, because it looks like
// it should work. So `loop` brings up `serve` itself.
//
// `serve` = tailnet only, every request is an authenticated device. `funnel` =
// anonymous public internet. Both publish the SAME hostname, so switching between
// them preserves the origin — and therefore the PWA install, the service worker and
// the push subscription (PROBLEM 11). That's why escalating to Funnel is cheap.
//
// THE NON-STICKY RULE (PROBLEM 12): `tailscale funnel --bg` outlives the terminal,
// which is exactly how a machine ends up publicly exposed for days unnoticed. So
// when WE turn Funnel on, we register a process-exit teardown that puts it back.
//
// `serve` is DELIBERATELY STICKY — it lives as long as the daemon, not the terminal
// (docs/architecture.md). The rule above was only ever about the PUBLIC internet,
// but serve inherited the same teardown, and that broke the product: the daemon
// outlives `loop` precisely so it can buzz the phone, and the buzz deep-links to a URL
// that serve no longer forwarded. On the EC2 box (2026-10-15) a `loop serve` reset it
// the instant it exited, and an SSH drop took the TUI — and the phone's only route —
// with it. Tailnet-only exposure of a token-gated daemon is the steady state.

import { execFile, execFileSync } from "node:child_process";
import { watch as fsWatch } from "node:fs";
import { promisify } from "node:util";

const run = promisify(execFile);

const ts = (args, timeout = 8000) => run("tailscale", args, { timeout });

/** Is the tailscale CLI even here? `loop doctor` needs to say so precisely. */
export async function tailscaleAvailable() {
  try {
    const { stdout } = await ts(["version"], 5000);
    return { available: true, version: stdout.trim().split("\n")[0] };
  } catch (e) {
    return {
      available: false,
      reason: /ENOENT/.test(String(e?.code ?? e))
        ? "tailscale CLI not found on PATH"
        : String(e?.message ?? e),
    };
  }
}

/** This machine's stable HTTPS name (same for serve and funnel). */
export async function hostname() {
  try {
    const { stdout } = await ts(["status", "--json"], 5000);
    const status = JSON.parse(stdout);
    const dns = status?.Self?.DNSName;
    if (dns) return dns.replace(/\.$/, ""); // trailing dot is valid FQDN, bad in a URL
    return status?.CertDomains?.[0] ?? null;
  } catch {
    return null;
  }
}

/**
 * Current exposure: "funnel" | "serve" | "local".
 * Never throws — a missing Tailscale is just "local", which is a legitimate state
 * (the TUI shows LOCAL and the QR falls back to a localhost URL).
 */
export async function currentMode() {
  try {
    const { stdout } = await ts(["serve", "status"], 5000);
    if (/Funnel on/i.test(stdout)) return "funnel";
    if (/proxy\s+http/i.test(stdout)) return "serve";
    return "local";
  } catch {
    return "local";
  }
}

// ---- watching for exposure changes, instead of asking every few seconds --------
//
// WHY A WATCHER AT ALL: the badge is the safety signal — "is this box on the public
// internet?" — and exposure moves without us (another `loop` exits and runs `serve reset`,
// `tailscale down`, a `loop share` in another terminal). A 5s poll means up to 5 seconds of
// a badge that's lying, and a `tailscale serve status` process spawn every 5s forever.
//
// WHAT TAILSCALE ACTUALLY OFFERS (measured on 1.98.5, 2026-08-19 — don't re-derive this):
//   * `tailscale debug watch-ipn` streams the IPN bus and DOES report backend state
//     (Running/Stopped) and prefs. But toggling `serve` on and off produced **only Engine
//     byte-counter messages** — 12 of them, zero mention of serve or config. `ipn.Notify`
//     has no ServeConfig field, so the bus cannot tell us about serve/funnel at all.
//   * `/localapi/v0/serve-config` returns the config, but it's a GET — polling again, just
//     cheaper. (LocalAPI lives on 127.0.0.1 at the port in `<statedir>/ipnport`, with a
//     password in `sameuserproof-<port>`. `tailscale debug local-creds` prints both.)
//   * The state itself is under `<statedir>/profile-data/`, mode 700 root — unreadable.
//
// SO WE WATCH THE STATE DIRECTORY, which is world-readable even though its contents are
// not. tailscaled writes its own log there, and it logs on config change: toggling `serve`
// produced an fs event within milliseconds, every time. We can't read WHY it changed, and
// we don't need to — the event is a hint, and `currentMode()` remains the source of truth.
//
// IT IS A HINT, NOT A CONTRACT, and the numbers matter: watching the real directory for 60
// idle seconds produced **8 debounced events** — tailscaled writes its log every ~7s whether
// or not anything changed. So this is NOT "no work when nothing happens"; it's a latency
// trade. A real change shows up in ~0.3s instead of up to 5s, and the spawn count goes from
// ~12/min (a 5s poll) to ~8/min plus one every 30s. `minGapMs` is what stops the noise from
// costing more than the poll it replaced.
//
// If those spawns ever matter, the next step is a cheaper PROBE rather than a better signal:
// `GET /localapi/v0/serve-config` over 127.0.0.1 (port in `<statedir>/ipnport`, password in
// `sameuserproof-<port>`) is milliseconds and no fork. Not done here because parsing the
// serve config ourselves puts "is Funnel on?" — the safety-critical bit — on us, and the
// CLI's own answer is the thing already trusted for that.

/** Where tailscaled keeps its state. Asked once — the path differs per install type. */
export async function stateDir() {
  try {
    const { stdout } = await ts(["debug", "statedir"], 5000);
    const dir = stdout.trim().split("\n")[0];
    return dir || null;
  } catch {
    return null; // no CLI, or a build that doesn't answer — the caller falls back to polling
  }
}

/**
 * Call `onChange` shortly after anything happens inside Tailscale's state directory.
 *
 * Returns `{ watching, stop() }`. `watching: false` means fall back to polling — a missing
 * directory, an unreadable one, or a platform where recursive watching isn't supported.
 * That's a real case (the sandboxed App Store build), so it must degrade rather than throw.
 */
export function watchStateDir(dir, onChange, { debounceMs = 250, minGapMs = 3000, watch = fsWatch } = {}) {
  if (!dir) return { watching: false, stop() {} };
  let timer = null;
  let watcher = null;
  let last = 0;
  const fire = () => {
    // DEBOUNCED, then RATE-LIMITED. Debounce because one config change touches the log twice
    // (measured); rate-limit because the log also gets written ~8 times a minute for reasons
    // that have nothing to do with us, and each callback costs a process spawn. Together they
    // keep the noisy case cheaper than the 5s poll this replaces, without adding latency to
    // the case that matters (the first event after a quiet spell fires after `debounceMs`).
    clearTimeout(timer);
    const wait = Math.max(debounceMs, last + minGapMs - Date.now());
    timer = setTimeout(() => {
      last = Date.now();
      try { onChange(); } catch { /* never take the TUI down */ }
    }, wait);
  };
  try {
    watcher = watch(dir, { recursive: true, persistent: false }, fire);
    // A watcher that dies later (the directory is removed, the daemon is reinstalled) must
    // not be a crash: the poll backstop is what covers us from then on.
    watcher.on?.("error", () => {});
  } catch {
    return { watching: false, stop() {} };
  }
  return {
    watching: true,
    stop() {
      clearTimeout(timer);
      try { watcher.close(); } catch { /* already gone */ }
    },
  };
}

// Track what WE changed, so teardown only ever reverts our own doing. Funnel only —
// serve is sticky (see the header).
let weEnabledFunnel = false;
let teardownRegistered = false;

function registerTeardown() {
  if (teardownRegistered) return;
  teardownRegistered = true;
  // `exit` handlers must be SYNCHRONOUS — an async teardown would never run, which
  // is exactly the bug that leaves a machine publicly exposed. Hence execFileSync.
  // Best-effort: never block or throw on the way out.
  const teardown = () => {
    try {
      if (weEnabledFunnel) execFileSync("tailscale", ["funnel", "--https=443", "off"], { timeout: 5000, stdio: "ignore" });
    } catch { /* exiting anyway */ }
  };
  process.on("exit", teardown);
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => { teardown(); process.exit(sig === "SIGINT" ? 0 : 1); });
  }
}

/**
 * Bring up `tailscale serve` for `port` unless something is already exposed.
 * Returns the live mode. Never throws: exposure failing must degrade to LOCAL, not
 * stop the daemon or the TUI — you can still drive an agent from the terminal.
 */
export async function ensureServe(port) {
  const existing = await currentMode();
  if (existing !== "local") return existing; // don't disturb what the user set up
  const avail = await tailscaleAvailable();
  if (!avail.available) return "local";
  try {
    await ts(["serve", "--bg", String(port)]);
    // NO teardown: serve outlives this process on purpose (header, PROBLEM 22).
    return await currentMode();
  } catch {
    return "local";
  }
}

/**
 * Escalate to Funnel — public internet. NON-STICKY: we register teardown so it ends
 * when this process does (PROBLEM 12).
 */
export async function enableFunnel(port) {
  const avail = await tailscaleAvailable();
  if (!avail.available) return { ok: false, mode: "local", error: avail.reason };
  try {
    await ts(["funnel", "--bg", String(port)]);
    weEnabledFunnel = true;
    registerTeardown();
    return { ok: true, mode: await currentMode() };
  } catch (e) {
    // The likeliest cause by far is the Funnel grant not being enabled in the admin
    // console — surface tailscale's own message, which contains the pre-scoped link.
    return { ok: false, mode: await currentMode(), error: String(e?.stderr || e?.message || e).trim() };
  }
}

/** Drop back to tailnet-only. */
export async function disableFunnel(port) {
  try {
    await ts(["funnel", "--https=443", "off"]);
    weEnabledFunnel = false;
  } catch { /* already off */ }
  // Funnel off can take serve down with it; re-assert tailnet exposure.
  const mode = await currentMode();
  if (mode === "local") return { ok: true, mode: await ensureServe(port) };
  return { ok: true, mode };
}

/**
 * The pairing URL. Prefers HTTPS because push REQUIRES a secure context.
 *
 * `mode` matters and must not be omitted when known: the `.ts.net` name resolves
 * only while `serve`/`funnel` is actually up. Printing it in LOCAL mode is the exact
 * failure PROBLEM 12 calls out — a QR that looks like it should work but 404s. So in
 * LOCAL mode we fall back to the loopback URL, which at least honestly works here.
 */
export async function pairingUrl({ port, token, host = null, mode = null }) {
  const exposed = mode ? mode !== "local" : true;
  const h = exposed ? host ?? (await hostname()) : null;
  const base = h ? `https://${h}` : `http://localhost:${port}`;
  return token ? `${base}/?token=${encodeURIComponent(token)}` : `${base}/`;
}

/** Render a QR as terminal text (half-blocks stay scannable at normal width). */
export async function qrLines(url) {
  try {
    const QRCode = (await import("qrcode")).default;
    const s = await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "L" });
    return s.replace(/\n$/, "").split("\n");
  } catch {
    return null; // the URL itself is the load-bearing part
  }
}

export const MODE_LABEL = { local: "LOCAL", serve: "TAILNET", funnel: "PUBLIC" };
