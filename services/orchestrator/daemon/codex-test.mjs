// REAL-CODEX PROOF for the second engine (docs/architecture.md).
//
// Drives `engines/codex.mjs` through a real `Session` — the same object the daemon uses —
// against a real `codex app-server`. What this exists to prove is the moat claim: that the
// notification-decision loop is a property of the SEAM, not of Claude. Specifically:
//
//   * a Codex run streams deltas and completed turns through the normalized events;
//   * `item/tool/requestUserInput` surfaces as an ordinary `pending` decision and PAUSES
//     the run until answered — the same mechanism, a different vendor;
//   * a prose question (PATH B) still lands at an `idle` boundary in default mode, which is
//     what carries the USP when the structured tool is refused;
//   * `turn/interrupt` stops a run and leaves the thread usable.
//
//   node services/orchestrator/daemon/codex-test.mjs
//
// Needs `codex` on PATH and `codex login`. Spends Codex usage, so it is not in `npm test`.

import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Session } from "./session.mjs";
import { getEngine } from "./engines/engine.mjs";

const CWD = join(tmpdir(), "loop-safe-cwd");
mkdirSync(CWD, { recursive: true });

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * `frames` is optional but worth passing: an engine-level error otherwise shows up as a
 * bare timeout, and "timed out waiting for the structured question" is a far worse
 * diagnosis than the rejection that actually happened. (Exactly how the first run of this
 * test hid a `turn/start` validation failure.)
 */
const waitFor = async (predicate, ms, label, frames = null) => {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const v = predicate();
    if (v) return v;
    const err = frames?.find((f) => f.type === "error");
    if (err) throw new Error(`engine errored while waiting for ${label}: ${err.error}`);
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${label}`);
};

const textOf = (session) =>
  session.turns.flatMap((t) => t.blocks).filter((b) => b.kind === "text").map((b) => b.text).join("\n");

const open = [];
const closeAll = () => { for (const s of open) { try { s.close(); } catch { /* gone */ } } };
process.on("exit", closeAll);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { closeAll(); process.exit(1); });

try {
  // ---- the engine is registered and available ------------------------------
  console.log("\nthe engine is a first-class member of the registry");
  {
    const { engineIds, probeEngines } = await import("./engines/engine.mjs");
    ok("codex is registered", engineIds().includes("codex"), engineIds().join(","));
    const probes = await probeEngines();
    const codex = probes.find((p) => p.id === "codex");
    ok("it probes as available", codex?.available === true, JSON.stringify(codex));
    ok("…and reports a version", /\d+\.\d+/.test(codex?.version ?? ""), String(codex?.version));
    const C = await getEngine("codex");
    ok("it implements all five verbs",
      ["start", "events", "reply", "interrupt", "close"].every((v) => typeof C.prototype[v] === "function"));
  }

  // ---- a plain run, through Session, with streaming ------------------------
  console.log("\na real Codex run, through the SAME Session the daemon uses");
  {
    const s = new Session({ engine: "codex", cwd: CWD, hibernateAfterMs: 0 });
    open.push(s);
    const frames = [];
    s.addListener((e) => frames.push(e));
    s.start("Reply with exactly the word CODEXSEAM and nothing else.");

    await waitFor(() => s.sdkSessionId, 60000, "the thread to start");
    ok("a thread id came back as the resume handle", !!s.sdkSessionId, String(s.sdkSessionId));
    ok("meta reports the engine", s.meta().engine === "codex");

    await waitFor(() => /CODEXSEAM/.test(textOf(s)), 120000, "the answer");
    ok("THE ANSWER ARRIVED AS A NORMALIZED TURN", /CODEXSEAM/.test(textOf(s)), textOf(s).slice(0, 120));
    ok("deltas streamed before the turn completed",
      frames.some((f) => f.type === "delta"), `frames=${frames.map((f) => f.type).join(",")}`);
    ok("delta text is normalized like Claude's", frames.filter((f) => f.type === "delta").every((f) => f.kind === "text"));

    await waitFor(() => frames.some((f) => f.type === "idle"), 30000, "the turn boundary");
    ok("turn/completed became an `idle` event", frames.some((f) => f.type === "idle"));
    ok("the partial was cleared at the boundary", s.partial === null);

    // A second message after the turn ended must open a NEW turn, not fail a steer
    // precondition — the case a steer-only implementation gets wrong.
    const before = s.turns.length;
    s.reply("Now reply with exactly: SECONDTURN");
    await waitFor(() => /SECONDTURN/.test(textOf(s)), 120000, "the second turn");
    ok("a reply AFTER the turn ended starts a new one", s.turns.length > before);
    s.close();
  }

  // ---- PATH B: a prose question in default mode ----------------------------
  console.log("\nPATH B — a prose question, which is what default mode gives you");
  {
    const s = new Session({ engine: "codex", cwd: CWD, hibernateAfterMs: 0 });
    open.push(s);
    const frames = [];
    s.addListener((e) => frames.push(e));
    s.start(
      "I want a fruit for a snack but I haven't told you which I like. Ask me which " +
      "of Mango, Guava or Papaya I prefer. Ask, don't guess. End your message with a question mark."
    );
    await waitFor(() => frames.some((f) => f.type === "idle"), 150000, "the question turn");
    const said = textOf(s);
    ok("Codex asked rather than guessing", /\?/.test(said), said.slice(-200));
    // This is precisely the shape notify.mjs PATH B looks for: an assistant turn whose
    // text ends in "?" at an idle boundary. Same detector, different engine, no changes.
    const lastText = s.turns.filter((t) => t.role === "assistant").flatMap((t) => t.blocks)
      .filter((b) => b.kind === "text").map((b) => b.text).at(-1) ?? "";
    ok("THE PATH B DETECTOR FIRES UNCHANGED (turn ends in '?')", /\?\s*$/.test(lastText.trim()), lastText.slice(-120));
    s.close();
  }

  // ---- PATH A: the structured decision channel, in plan mode ---------------
  console.log("\nPATH A — the structured decision channel (plan mode)");
  {
    // `mode: "plan"` rides through as an opaque engineOption — the same route the daemon
    // exposes on POST /sessions, so this exercises the real path rather than internals.
    const s = new Session({
      engine: "codex",
      cwd: CWD,
      hibernateAfterMs: 0,
      engineOptions: { mode: "plan" },
    });
    open.push(s);
    const frames = [];
    s.addListener((e) => frames.push(e));
    s.start(
      "I want a fruit for a snack. Use your request_user_input tool to ask me whether I " +
      "prefer Mango, Guava or Papaya. Do not guess. After I answer, reply with exactly: You picked <fruit>."
    );

    await waitFor(() => s.pending, 180000, "the structured question", frames);
    ok("*** THE DECISION CHANNEL SURFACED AS AN ORDINARY `pending` ***", !!s.pending, JSON.stringify(s.pending));
    ok("it carries a question", typeof s.pending.question === "string" && s.pending.question.length > 0);
    ok("it carries tappable options", (s.pending.options ?? []).length >= 2, JSON.stringify(s.pending.options));
    ok("isOther became free_form", typeof s.pending.free_form === "boolean", String(s.pending.free_form));
    ok("a pending frame reached listeners", frames.some((f) => f.type === "pending" && f.question));
    ok("the engine reports itself parked", s._engine.awaitingDecision === true);

    // THE MECHANISM: the run is paused, and a numeric tap un-pauses it — the identical
    // reply path the phone uses for Claude.
    const optionOne = s.pending.options[0].label;
    const r = s.reply("1");
    ok("a numeric tap routes as structured", r.mode === "structured", JSON.stringify(r));
    ok("the answered Q&A was synthesized into history",
      s.turns.some((t) => t.blocks.some((b) => b.kind === "tool_use" && b.name === "AskUserQuestion")));
    ok("pending was cleared", s.pending === null);

    await waitFor(() => new RegExp(optionOne, "i").test(textOf(s)) && /picked/i.test(textOf(s)), 150000,
      "the resumed answer");
    ok(`*** CODEX RESUMED AND ACTED ON THE ANSWER (${optionOne}) ***`,
      new RegExp(optionOne, "i").test(textOf(s)), textOf(s).slice(-200));
    s.close();
  }

  // ---- interrupt ----------------------------------------------------------
  console.log("\ninterrupt stops a Codex turn and keeps the thread");
  {
    const s = new Session({ engine: "codex", cwd: CWD, hibernateAfterMs: 0 });
    open.push(s);
    const frames = [];
    s.addListener((e) => frames.push(e));
    s.start("Count from 1 to 400. One number per line, nothing else.");
    await waitFor(() => frames.some((f) => f.type === "delta"), 120000, "counting to start");

    const r = await s.interrupt();
    ok("INTERRUPT WAS ACCEPTED", r.ok === true, JSON.stringify(r));
    ok("an interrupted frame was emitted", frames.some((f) => f.type === "interrupted"));
    await sleep(4000);
    ok("it did not finish the task (never reached 400)", !/\b400\b/.test(textOf(s)), textOf(s).slice(-120));
    ok("the session is still alive, not done", s.status === "running", s.status);
    s.close();
  }
} catch (e) {
  fail++;
  console.log(`\n  ✗ THREW: ${e?.message ?? e}`);
} finally {
  closeAll();
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
