// REAL-AGENT PROOF for session lifecycle: hibernation (PROBLEM 15) and persistence
// (PROBLEM 16), against an actual `claude` run.
//
// WHY THIS EXISTS SEPARATELY FROM THE FREE SUITES. engine-test.mjs and store-test.mjs
// prove the state machine with a FakeEngine, which is what keeps them free. Neither can
// prove the thing both features are actually about: that a real OS process goes away,
// and that a real agent's MEMORY comes back. So this counts the daemon's child
// processes at every step — that count is the number that used to only ever go up — and
// makes the agent recall a word from before its predecessor exited.
//
//   node services/orchestrator/daemon/lifecycle-test.mjs
//
// Spends a handful of small turns. Runs its own daemon on a test port with a throwaway
// state dir, so the real :4318 daemon and the real ~/.loop-eng are untouched.

import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PORT = 4394; // inside the 4393–4397 test-port band (HANDOFF §7)
const HERE = dirname(fileURLToPath(import.meta.url));
// The daemon auto-allows every tool and inherits its launch cwd, so a test must never
// point it at the repo (AGENTS.md).
const CWD = join(tmpdir(), "loop-safe-cwd");
// The SAME state dir across restarts — that is what persistence is measured through.
const STATE = mkdtempSync(join(tmpdir(), "loop-lifecycle-"));
mkdirSync(CWD, { recursive: true });

const SECRET = "PELICAN";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};

const api = async (path, init) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  const body = await r.text();
  try { return { status: r.status, body: JSON.parse(body) }; } catch { return { status: r.status, body }; }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** How many agent processes is the daemon holding right now? */
function children(pid) {
  try {
    return execFileSync("pgrep", ["-P", String(pid)], { encoding: "utf8" })
      .split("\n").map((s) => s.trim()).filter(Boolean);
  } catch { return []; } // pgrep exits 1 when there are none
}

let daemon = null;
let log = "";

async function startDaemon() {
  daemon = spawn(process.execPath, [join(HERE, "server.mjs")], {
    cwd: CWD,
    env: { ...process.env, PORT: String(PORT), LOOP_ENG_DIR: STATE, LOOP_NO_AUTH: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  daemon.stdout.on("data", (c) => { log += c; });
  daemon.stderr.on("data", (c) => { log += c; });
  for (let i = 0; i < 120; i++) {
    try { const h = await api("/health"); if (h.body?.ok) return daemon; } catch { /* booting */ }
    await sleep(250);
  }
  throw new Error("daemon never became healthy");
}

async function stopDaemon() {
  if (!daemon) return;
  const d = daemon;
  daemon = null;
  d.kill("SIGTERM");
  // Wait for the port to actually free, or the next bind races it.
  for (let i = 0; i < 60; i++) {
    if (d.exitCode !== null || d.signalCode) break;
    await sleep(100);
  }
  await sleep(600);
}

const cleanup = () => { try { daemon?.kill("SIGKILL"); } catch { /* gone */ } };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { cleanup(); process.exit(1); });

/**
 * Wait until the agent has actually ANSWERED and then gone quiet.
 *
 * `minTurns` and the `lastRole === "assistant"` requirement are both load-bearing. A
 * reply pushes the human's text into history INSTANTLY and only then boots a CLI, so a
 * naive "turn count stopped changing" check reports settled during the seconds of cold
 * start, and the assertion after it reads an empty answer. That is exactly how this test
 * failed the first time it ran.
 */
async function waitAnswer(id, minTurns, ms = 150000) {
  const started = Date.now();
  let last = -1, stable = 0;
  while (Date.now() - started < ms) {
    const { body } = await api("/sessions");
    const meta = body.sessions?.find((s) => s.id === id);
    if (meta) {
      const settled = meta.turnCount >= minTurns && meta.turnCount === last && meta.lastRole === "assistant";
      stable = settled ? stable + 1 : 0;
      last = meta.turnCount;
      if (stable >= 3) return meta;
    }
    await sleep(700);
  }
  throw new Error(`session ${id} never reached ${minTurns} turns ending in an assistant reply`);
}

const historyOf = async (id) => (await api(`/sessions/${id}/history`)).body.turns ?? [];
const remembered = (turns) => new RegExp(SECRET, "i").test(JSON.stringify(turns.slice(-3)));

try {
  // ================= PHASE 1: a real run holds a real process =================
  await startDaemon();
  console.log(`\ndaemon pid=${daemon.pid} on :${PORT}, state=${STATE}\n`);
  console.log("PHASE 1 — start a real run");
  ok("daemon holds no agent processes before any session", children(daemon.pid).length === 0,
    `children=${children(daemon.pid).length}`);

  const created = await api("/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: `Remember this word: ${SECRET}. Reply with just: ok`, cwd: CWD }),
  });
  const id = created.body.id;
  ok("session created", !!id, JSON.stringify(created.body).slice(0, 200));
  await waitAnswer(id, 1);
  ok("a real agent process is now held", children(daemon.pid).length === 1,
    `children=${children(daemon.pid).length}`);
  ok("/health reports 1 live session", (await api("/health")).body.sessions?.live === 1,
    JSON.stringify((await api("/health")).body.sessions));

  // ================= PHASE 2: hibernate frees the process ====================
  console.log("\nPHASE 2 — hibernate: release the process, keep the conversation");
  const hib = await api(`/sessions/${id}/hibernate`, { method: "POST" });
  ok("hibernate accepted", hib.status === 200 && hib.body.ok === true, JSON.stringify(hib.body));
  await sleep(2500); // let the child actually exit

  // ***THE ASSERTION THE HIBERNATION WORK EXISTS FOR***
  ok("THE AGENT PROCESS IS GONE", children(daemon.pid).length === 0,
    `children=${children(daemon.pid).length}`);
  const h2 = (await api("/health")).body.sessions;
  ok("/health reports it sleeping, not dead", h2?.hibernated === 1 && h2?.live === 0, JSON.stringify(h2));

  const afterHibernate = await historyOf(id);
  ok("the transcript survived the process", afterHibernate.length >= 1, `turns=${afterHibernate.length}`);

  console.log("\n         …and a reply wakes it, with its memory");
  const rep = await api(`/sessions/${id}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "What word did I ask you to remember? Reply with just that word." }),
  });
  ok("reply into a hibernated session accepted", rep.body.ok === true, JSON.stringify(rep.body));
  ok("the reply reports it woke the session", rep.body.woke === true, JSON.stringify(rep.body));

  await waitAnswer(id, afterHibernate.length + 2);
  ok("an agent process is held again", children(daemon.pid).length === 1,
    `children=${children(daemon.pid).length}`);
  const afterWake = await historyOf(id);
  // ***THE OTHER ASSERTION THAT MATTERS***: memory crossed a process boundary.
  ok(`THE AGENT REMEMBERED ACROSS THE PROCESS RESTART (said ${SECRET})`, remembered(afterWake),
    JSON.stringify(afterWake.slice(-2)).slice(0, 300));
  ok("the transcript did not double", afterWake.length < afterHibernate.length * 2 + 4,
    `before=${afterHibernate.length} after=${afterWake.length}`);

  // ================= PHASE 3: survive a DAEMON restart =======================
  console.log("\nPHASE 3 — restart the whole daemon");
  await stopDaemon();
  await startDaemon();
  console.log(`         new daemon pid=${daemon.pid}`);
  ok("the restarted daemon restored the session list", !!(await api("/sessions")).body.sessions?.length,
    JSON.stringify((await api("/sessions")).body.sessions?.map((s) => s.id)));

  const restoredMeta = (await api("/sessions")).body.sessions.find((s) => s.id === id);
  ok("the SAME session id came back (push deep links still resolve)", !!restoredMeta,
    JSON.stringify((await api("/sessions")).body.sessions?.map((s) => s.id)));
  ok("it came back sleeping, holding no process", restoredMeta?.hibernated === true,
    JSON.stringify(restoredMeta));
  ok("a fresh daemon holds no agent processes", children(daemon.pid).length === 0,
    `children=${children(daemon.pid).length}`);
  const restoredHist = await historyOf(id);
  ok("its full transcript came back", restoredHist.length === afterWake.length,
    `before=${afterWake.length} after=${restoredHist.length}`);

  console.log("\n         …and it can still continue the conversation");
  const rep2 = await api(`/sessions/${id}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text: "Once more: what was the word? Reply with just that word." }),
  });
  ok("reply into a RESTORED session accepted", rep2.body.ok === true, JSON.stringify(rep2.body));
  await waitAnswer(id, restoredHist.length + 2);
  const afterRestart = await historyOf(id);
  // ***THE ASSERTION THE PERSISTENCE WORK EXISTS FOR***
  ok(`THE AGENT REMEMBERED ACROSS A DAEMON RESTART (said ${SECRET})`, remembered(afterRestart),
    JSON.stringify(afterRestart.slice(-2)).slice(0, 300));

  // ================= PHASE 4: DELETE means DELETE ============================
  console.log("\nPHASE 4 — end it for good");
  const del = await api(`/sessions/${id}`, { method: "DELETE" });
  ok("DELETE closes the session", del.status === 200 && del.body.closed === true, JSON.stringify(del.body));
  await sleep(2500);
  ok("its process is released", children(daemon.pid).length === 0, `children=${children(daemon.pid).length}`);
  ok("it is gone from the session list",
    !(await api("/sessions")).body.sessions.some((s) => s.id === id));
  ok("its history 404s afterwards", (await api(`/sessions/${id}/history`)).status === 404);

  // The snapshot must be gone too, or the next boot would resurrect it — which would
  // make DELETE look like it worked and then quietly undo itself.
  await stopDaemon();
  await startDaemon();
  ok("A DELETED SESSION DOES NOT COME BACK ON THE NEXT BOOT",
    !(await api("/sessions")).body.sessions.some((s) => s.id === id),
    JSON.stringify((await api("/sessions")).body.sessions?.map((s) => s.id)));
} catch (e) {
  fail++;
  console.log(`\n  ✗ THREW: ${e?.message ?? e}`);
  console.log(log.slice(-2500));
} finally {
  cleanup();
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
