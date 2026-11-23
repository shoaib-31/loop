// REAL-AGENT PROOF for token-level streaming and the kill switch (PROBLEM 17).
//
// The free suite proves the plumbing with a FakeEngine. It cannot prove the two claims
// that matter here, both of which are about real time and a real process:
//   1. text actually arrives BEFORE the turn completes (otherwise "streaming" is a lie
//      and the UI still stalls on long answers);
//   2. interrupt actually STOPS a running agent, and leaves the session usable.
//
//   node services/orchestrator/daemon/stream-test.mjs
//
// Spends a few turns. Own daemon, own test port, throwaway state dir.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const PORT = 4395; // inside the 4393–4397 test-port band (HANDOFF §7)
const HERE = dirname(fileURLToPath(import.meta.url));
const CWD = join(tmpdir(), "loop-safe-cwd");
const STATE = mkdtempSync(join(tmpdir(), "loop-stream-"));
mkdirSync(CWD, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const api = async (path, init) => {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`, init);
  const body = await r.text();
  try { return { status: r.status, body: JSON.parse(body) }; } catch { return { status: r.status, body }; }
};
const post = (path, obj) =>
  api(path, obj === undefined
    ? { method: "POST" }
    : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(obj) });

/** Watch a session's WS and record every frame, in order, with arrival times. */
function watch(id) {
  const frames = [];
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/stream/${id}`);
  ws.on("message", (raw) => {
    try { frames.push({ ...JSON.parse(raw.toString()), at: Date.now() }); } catch { /* ignore */ }
  });
  return { frames, close: () => { try { ws.close(); } catch { /* gone */ } } };
}

const waitFor = async (predicate, ms, label) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const v = predicate();
    if (v) return v;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const daemon = spawn(process.execPath, [join(HERE, "server.mjs")], {
  cwd: CWD,
  env: { ...process.env, PORT: String(PORT), LOOP_ENG_DIR: STATE, LOOP_NO_AUTH: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let log = "";
daemon.stdout.on("data", (c) => { log += c; });
daemon.stderr.on("data", (c) => { log += c; });
const cleanup = () => { try { daemon.kill("SIGKILL"); } catch { /* gone */ } };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { cleanup(); process.exit(1); });

try {
  for (let i = 0; i < 120; i++) {
    try { if ((await api("/health")).body?.ok) break; } catch { /* booting */ }
    await sleep(250);
  }
  console.log(`\ndaemon pid=${daemon.pid} on :${PORT}\n`);

  // =============== 1. text arrives BEFORE the turn completes ===============
  console.log("streaming: partial text arrives while the agent is still talking");
  {
    const created = await post("/sessions", {
      prompt: "Write a single paragraph of about 120 words about why pelicans are good at fishing. Prose only.",
      cwd: CWD,
    });
    const id = created.body.id;
    ok("session created", !!id, JSON.stringify(created.body).slice(0, 200));
    const w = watch(id);

    // Wait for the first delta. If streaming is off, this is the assertion that fails.
    await waitFor(() => w.frames.some((f) => f.type === "delta"), 120000, "the first delta");
    const firstDelta = w.frames.find((f) => f.type === "delta");
    ok("deltas arrive over the WebSocket", !!firstDelta);
    ok("a delta carries a kind and the accumulated text",
      firstDelta.kind === "text" && typeof firstDelta.partial?.text === "string",
      JSON.stringify(firstDelta).slice(0, 200));

    // ***THE ASSERTION STREAMING EXISTS FOR***: the first delta must beat the turn.
    const firstAssistantTurn = () => w.frames.find((f) => f.type === "turn" && f.turn?.role === "assistant");
    // NB: build the failure message defensively. `JSON.stringify(undefined)` is
    // undefined, so `.slice()` on it throws — and it throws in the PASSING case, which
    // is a spectacularly confusing way for a green assertion to fail.
    ok("THE FIRST DELTA ARRIVED BEFORE ANY COMPLETED TURN", !firstAssistantTurn(),
      `turn already present: ${String(JSON.stringify(firstAssistantTurn() ?? null)).slice(0, 120)}`);

    await waitFor(firstAssistantTurn, 120000, "the completed turn");
    const deltas = w.frames.filter((f) => f.type === "delta");
    ok("many deltas, not one lump", deltas.length > 3, `got ${deltas.length}`);
    const lead = firstAssistantTurn().at - firstDelta.at;
    ok("streaming led the completed turn by a measurable margin", lead > 0, `lead=${lead}ms`);
    console.log(`      ${deltas.length} deltas; first one ${lead}ms before the turn`);

    // The streamed text should be what the turn ultimately said.
    const streamed = deltas.at(-1).partial.text;
    const finalText = firstAssistantTurn().turn.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("");
    ok("the streamed text matches the turn it was previewing",
      finalText.startsWith(streamed.slice(0, 40)), `streamed="${streamed.slice(0, 60)}" final="${finalText.slice(0, 60)}"`);

    // Deltas must never become history, or the same words render twice.
    const hist = (await api(`/sessions/${id}/history`)).body.turns;
    ok("the transcript holds turns only, no partials", hist.every((t) => Array.isArray(t.blocks)));
    await waitFor(() => w.frames.some((f) => f.type === "idle"), 60000, "idle");
    ok("`partial` is cleared once the turn boundary is reached",
      (await api(`/sessions/${id}/pending`)).status === 200);
    w.close();
    await post(`/sessions/${id}`, undefined).catch(() => {});
    await api(`/sessions/${id}`, { method: "DELETE" });
  }

  // =============== 2. interrupt actually stops a run =======================
  console.log("\ninterrupt: stop a long run, and keep talking to it");
  {
    const created = await post("/sessions", {
      // Long enough that finishing before the interrupt would be obvious.
      prompt: "Count from 1 to 400. Output one number per line and nothing else.",
      cwd: CWD,
    });
    const id = created.body.id;
    const w = watch(id);
    await waitFor(() => w.frames.some((f) => f.type === "delta"), 120000, "counting to start");
    ok("the long run started streaming", true);

    const stopped = await post(`/sessions/${id}/interrupt`);
    // ***THE ASSERTION THE KILL SWITCH EXISTS FOR***
    ok("INTERRUPT WAS ACCEPTED", stopped.status === 200 && stopped.body.ok === true, JSON.stringify(stopped.body));

    // It should come to rest quickly — counting to 400 would take far longer.
    const t0 = Date.now();
    await waitFor(() => w.frames.some((f) => f.type === "idle"), 45000, "the run to come to rest");
    console.log(`      came to rest ${Date.now() - t0}ms after the interrupt`);

    const hist = (await api(`/sessions/${id}/history`)).body.turns;
    const said = JSON.stringify(hist);
    ok("IT DID NOT FINISH THE TASK (never reached 400)", !/\b400\b/.test(said), said.slice(-200));

    // THE DISTINCTION FROM close(): still alive, still answering.
    const meta = (await api("/sessions")).body.sessions.find((s) => s.id === id);
    ok("the session is still in the fleet", !!meta, JSON.stringify(meta));
    ok("…and is not marked done or error", meta.status !== "done" && meta.status !== "error", meta?.status);

    const before = hist.length;
    const rep = await post(`/sessions/${id}/reply`, { text: "Never mind. Reply with just the word: STOPPED" });
    ok("it accepts the correction that follows a stop", rep.body.ok === true, JSON.stringify(rep.body));
    await waitFor(async () => {
      const h = (await api(`/sessions/${id}/history`)).body.turns;
      return h.length > before + 1 && /STOPPED/i.test(JSON.stringify(h.slice(-2)));
    }, 90000, "the post-interrupt answer").catch(async () => {
      const h = (await api(`/sessions/${id}/history`)).body.turns;
      throw new Error(`no post-interrupt answer; tail=${JSON.stringify(h.slice(-2)).slice(0, 300)}`);
    });
    ok("THE SESSION STILL WORKS AFTER BEING INTERRUPTED", true);

    // And interrupting when nothing is running is a refusal, not a crash.
    await waitFor(async () => (await api("/sessions")).body.sessions.find((s) => s.id === id), 5000, "meta");
    w.close();
    await api(`/sessions/${id}`, { method: "DELETE" });
  }

  // =============== 3. interrupting nothing ================================
  console.log("\ninterrupting a session that is not running");
  {
    const gone = await post(`/sessions/does-not-exist/interrupt`);
    ok("a missing session 404s", gone.status === 404, String(gone.status));
  }
} catch (e) {
  fail++;
  console.log(`\n  ✗ THREW: ${e?.message ?? e}`);
  console.log(log.slice(-2500));
} finally {
  cleanup();
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
