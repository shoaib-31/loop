// REAL-AGENT PROOF for declining a question, and for the daemon-owned busy flag
// (PROBLEM 23).
//
// The free suite proves the plumbing with a FakeEngine. It cannot prove the claims that
// matter, all of which are about how a REAL agent reacts:
//   1. a decline STOPS the turn — the agent neither guesses an answer nor asks again;
//   2. the session is still usable, and the next message is what it acts on;
//   3. a client that connects mid-turn is TOLD the agent is working (the notification-tap
//      case that used to show a silent screen with no Stop button).
// On BOTH engines, because they decline completely differently: Claude denies-and-
// interrupts in one permission result; Codex has no refusal in its protocol at all.
//
//   node services/orchestrator/daemon/decline-test.mjs
//
// Spends a few turns per engine. Own daemon, own test port, throwaway state dir.

import { spawn } from "node:child_process";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocket } from "ws";

const PORT = 4398;
const HERE = dirname(fileURLToPath(import.meta.url));
const CWD = join(tmpdir(), "loop-safe-cwd");
const STATE = mkdtempSync(join(tmpdir(), "loop-decline-"));
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

const assistantText = (frames, after = 0) =>
  frames
    .filter((f) => f.type === "turn" && f.turn.role === "assistant" && f.at >= after)
    .flatMap((f) => f.turn.blocks.filter((b) => b.kind === "text").map((b) => b.text))
    .join("\n");

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

/**
 * One engine, the whole story: ask → decline → it stops → a different message → it acts
 * on THAT, with a second client joining mid-turn to check the busy seed.
 */
async function declineStory({ label, create, timeoutMs }) {
  console.log(`\n${label}`);
  const created = await post("/sessions", create);
  const id = created.body.id;
  ok("session created", !!id, JSON.stringify(created.body).slice(0, 200));
  const w = watch(id);
  try {
    // Fail FAST, and with the engine's own words, when the run dies instead of asking —
    // an expired login used to cost the whole timeout and then say only "timed out".
    await waitFor(() => w.frames.find((f) => (f.type === "pending" && f.question) || f.type === "error"), timeoutMs, "the question");
    const died = w.frames.find((f) => f.type === "error");
    if (died) throw new Error(`the run failed before asking anything: ${died.error}`);
    const busyAtQuestion = w.frames.filter((f) => f.type === "busy").at(-1);
    ok("parked on a question = NOT busy (it's waiting on you)", busyAtQuestion?.busy === false,
      JSON.stringify(busyAtQuestion));

    const tDecline = Date.now();
    const r = await post(`/sessions/${id}/decline`);
    ok("POST /decline is accepted", r.status === 200 && r.body.mode === "declined", JSON.stringify(r.body));

    // THE CLAIM: it stops. A turn boundary must follow — and promptly, since stopping is
    // the whole point — with no fresh question and no guessed answer in between.
    await waitFor(() => w.frames.find((f) => f.type === "idle" && f.at >= tDecline), 60000, "the turn to end");
    const stoppedMs = w.frames.find((f) => f.type === "idle" && f.at >= tDecline).at - tDecline;
    ok(`*** THE TURN ENDED AFTER THE DECLINE (${stoppedMs}ms) ***`, true);
    await sleep(3000); // give a misbehaving agent the chance to carry on regardless
    const after = assistantText(w.frames, tDecline);
    ok("it did NOT guess an answer", !/picked/i.test(after), after.slice(0, 300));
    ok("it did NOT ask again", !w.frames.some((f) => f.type === "pending" && f.question && f.at >= tDecline));
    const busyNow = w.frames.filter((f) => f.type === "busy").at(-1);
    ok("busy is false: it's the human's move", busyNow?.busy === false, JSON.stringify(busyNow));

    const hist = (await api(`/sessions/${id}/history`)).body.turns ?? [];
    const declined = hist.flatMap((t) => t.blocks).find((b) => b.kind === "tool_result" && b.is_error && b.text === "Declined");
    ok("history records the question as declined", !!declined);

    const again = await post(`/sessions/${id}/decline`);
    ok("a second decline is a 409, not an error", again.status === 409, `${again.status} ${JSON.stringify(again.body)}`);

    // The follow-up: the session must still work, and act on THIS message.
    const tReply = Date.now();
    await post(`/sessions/${id}/reply`, { text: "Forget the fruit. Reply with exactly the word BANANAS and nothing else." });
    // A client joining mid-turn (the notification tap). Its seed must say "working".
    const late = watch(id);
    await waitFor(() => late.frames.find((f) => f.type === "busy"), 10000, "the busy seed");
    const seed = late.frames.find((f) => f.type === "busy");
    ok("a client joining mid-turn is told it's working", seed.busy === true, JSON.stringify(seed));
    ok("…and since when", typeof seed.since === "string" && Date.parse(seed.since) >= tReply - 1000, String(seed.since));
    late.close();
    await waitFor(() => /BANANAS/.test(assistantText(w.frames, tReply)), timeoutMs, "the follow-up answer");
    ok("*** THE NEXT MESSAGE IS WHAT IT ACTED ON ***", true);
    await waitFor(() => w.frames.find((f) => f.type === "idle" && f.at >= tReply), 60000, "the follow-up turn to end");
    ok("…and it went quiet again afterwards",
      w.frames.filter((f) => f.type === "busy").at(-1)?.busy === false);
  } finally {
    w.close();
    await api(`/sessions/${id}`, { method: "DELETE" });
  }
}

try {
  for (let i = 0; i < 120; i++) {
    try { if ((await api("/health")).body?.ok) break; } catch { /* booting */ }
    await sleep(250);
  }
  console.log(`\ndaemon pid=${daemon.pid} on :${PORT}`);

  await declineStory({
    label: "Claude Code — deny + interrupt in one permission result",
    create: {
      prompt:
        "Use the AskUserQuestion tool to ask me which fruit I want, with options Apple, Mango " +
        "and Kiwi. After I answer, reply with exactly: You picked <fruit>.",
      cwd: CWD,
    },
    timeoutMs: 120000,
  });

  const engines = (await api("/engines")).body.engines ?? [];
  if (engines.find((e) => e.id === "codex")?.available) {
    await declineStory({
      label: "Codex — no refusal in the protocol: empty answer, then turn/interrupt",
      create: {
        engine: "codex",
        engineOptions: { mode: "plan" }, // the structured question tool needs plan mode (PROBLEM 19)
        prompt:
          "I want a fruit for a snack. Use your request_user_input tool to ask me whether I " +
          "prefer Mango, Guava or Papaya. Do not guess. After I answer, reply with exactly: You picked <fruit>.",
        cwd: CWD,
      },
      timeoutMs: 180000,
    });
  } else {
    console.log("\nCodex — SKIPPED (not available on this machine)");
  }
} catch (e) {
  fail++;
  console.log(`  ✗ ${e.message}`);
  console.log(`\n--- daemon log (tail) ---\n${log.slice(-2000)}`);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
cleanup();
process.exit(fail === 0 ? 0 : 1);
