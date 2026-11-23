// Daemon lifecycle — start it, or attach to the one already running.
//
// The daemon is an IMPLEMENTATION DETAIL the user never types (docs/architecture.md
// PROBLEM 12). `loop` must work whether or not one is already up, so the rule is:
// probe /health first, adopt what's there, and only spawn if nothing answers.
//
// Why adopt rather than always spawn: the daemon HOSTS the sessions. Killing and
// restarting it would destroy every running agent — the exact opposite of
// "survives disconnect" (PROBLEM 4b). A second `loop` in another terminal must
// attach, never take over.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const STATE_DIR = process.env.LOOP_ENG_DIR ?? join(homedir(), ".loop-eng");
const PID_FILE = join(STATE_DIR, "daemon.pid");
const LOG_FILE = join(STATE_DIR, "daemon.log");

export const DEFAULT_PORT = Number(process.env.LOOP_PORT ?? 4318);

/** The hidden subcommand a compiled binary uses to become the daemon. */
export const DAEMON_SUBCOMMAND = "__daemon";

/** Locate daemon/server.mjs when running from source. May not exist in a binary. */
export function daemonEntry() {
  // From apps/cli/src/ -> repo root -> services/orchestrator/daemon/server.mjs
  const here = dirname(fileURLToPath(import.meta.url));
  return (
    process.env.LOOP_DAEMON_ENTRY ??
    join(here, "..", "..", "..", "services", "orchestrator", "daemon", "server.mjs")
  );
}

/**
 * HOW TO START A DAEMON, in both worlds (docs/architecture.md).
 *
 * From source there is a `server.mjs` on disk, so spawn node against it. In a released
 * binary there is NO such file — the daemon is compiled INTO the executable — so `loop`
 * re-invokes ITSELF as `loop __daemon`. `process.execPath` is the right program either
 * way: node from source, the loop binary when compiled.
 *
 * The old code claimed "a compiled binary bundles the daemon" and then spawned a path
 * that cannot exist there, so the released artifact could never have started one.
 */
export function daemonSpawn() {
  const entry = daemonEntry();
  if (existsSync(entry)) return { argv: [entry], mode: "source", entry };
  return { argv: [DAEMON_SUBCOMMAND], mode: "self", entry: process.execPath };
}

/**
 * Is a daemon answering on this port? Returns its /health body, or null.
 *
 * Deliberately probes HTTP rather than trusting the pidfile: a stale pidfile after
 * a crash or reboot would otherwise make `loop` attach to nothing and hang.
 */
export async function probeDaemon(port = DEFAULT_PORT, { timeoutMs = 1500 } = {}) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.service === "loop-daemon" ? body : null;
  } catch {
    return null;
  }
}

async function readPid() {
  try {
    const n = Number((await readFile(PID_FILE, "utf8")).trim());
    return Number.isInteger(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

/** Is that pid actually alive? signal 0 tests existence without touching it. */
function alive(pid) {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

/**
 * Ensure a daemon is running on `port`. Returns { started, health, pid }.
 *
 * `cwd` is where the agent will run, and it matters: the daemon AUTO-ALLOWS EVERY
 * TOOL, so this is the directory an agent can freely edit. Passed explicitly rather
 * than inherited so the caller has to think about it.
 */
export async function ensureDaemon({ port = DEFAULT_PORT, cwd = process.cwd(), detached = true } = {}) {
  const existing = await probeDaemon(port);
  if (existing) return { started: false, health: existing, pid: await readPid() };

  await mkdir(STATE_DIR, { recursive: true });

  // Clean up a stale pidfile so `loop doctor` doesn't report a ghost.
  const oldPid = await readPid();
  if (oldPid && !alive(oldPid)) await unlink(PID_FILE).catch(() => {});

  const { argv } = daemonSpawn();

  // Detached + ignored stdio so the daemon OUTLIVES this terminal. That is the
  // whole point: close the laptop lid on the TUI and the run continues.
  const { openSync } = await import("node:fs");
  const log = openSync(LOG_FILE, "a");
  const child = spawn(process.execPath, argv, {
    cwd,
    detached,
    env: { ...process.env, PORT: String(port) },
    stdio: ["ignore", log, log],
  });
  child.unref();
  await writeFile(PID_FILE, String(child.pid) + "\n", { mode: 0o600 });

  // Wait for it to answer rather than sleeping a fixed amount: first boot has to
  // generate a VAPID keypair and a token, which is slower than a warm start.
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    const health = await probeDaemon(port, { timeoutMs: 500 });
    if (health) return { started: true, health, pid: child.pid };
    if (child.exitCode !== null)
      throw new Error(`daemon exited immediately (code ${child.exitCode}) — see ${LOG_FILE}`);
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`daemon did not come up on :${port} within 15s — see ${LOG_FILE}`);
}

/** Stop the daemon we started. Kills every hosted session, so it's opt-in only. */
export async function stopDaemon() {
  const pid = await readPid();
  if (!pid) return { stopped: false, reason: "no pidfile" };
  if (!alive(pid)) {
    await unlink(PID_FILE).catch(() => {});
    return { stopped: false, reason: "not running (stale pidfile removed)" };
  }
  process.kill(pid, "SIGTERM");
  await unlink(PID_FILE).catch(() => {});
  return { stopped: true, pid };
}

export const paths = { STATE_DIR, PID_FILE, LOG_FILE };
