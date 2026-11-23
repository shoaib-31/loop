// Engine-seam tests (docs/architecture.md).
//
// The POINT of this suite: prove Session works against an engine that is not Claude,
// using a fake that speaks only the normalized EngineEvent contract. If Session ever
// regrows a dependency on Anthropic shapes, `canUseTool`, or the SDK, these fail.
// It also costs nothing to run — no API, no `claude` binary, no network — so the seam
// stays covered on every change, which an e2e run against a real agent can't be.
//
//   node services/orchestrator/daemon/engine-test.mjs

import { Session, DECLINED } from "./session.mjs";
import { EventQueue, registerEngine, engineIds, probeEngines, getEngine } from "./engines/engine.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);

const nextTick = () => new Promise((r) => setTimeout(r, 5));

// ---- a deliberately non-Claude engine ------------------------------------
// Stands in for Codex: it pauses on a decision and un-pauses when replied to,
// which is the ONLY behavioral requirement the seam makes.
class FakeEngine {
  static id = "fake";
  static label = "Fake";
  static async probe() { return { available: true, version: "fake-1" }; }

  constructor(opts = {}) {
    this.opts = opts;
    this.q = new EventQueue();
    this.replies = [];
    this._resolver = null;
    this.closed = false;
    FakeEngine.last = this;
  }

  start(prompt) {
    this.startedWith = prompt;
    this.q.push({ type: "ready", sessionRef: "fake-thread-1" });
    if (prompt) this.q.push({ type: "turn", role: "assistant", blocks: [{ kind: "text", text: `echo:${prompt}` }], ts: new Date().toISOString() });
  }

  /** Park a decision, exactly like tool/requestUserInput would. */
  ask(question) {
    this.q.push({ type: "decision", question });
    return new Promise((resolve) => { this._resolver = resolve; });
  }

  emitIdle() { this.q.push({ type: "idle" }); }
  emitText(text) {
    this.q.push({ type: "turn", role: "assistant", blocks: [{ kind: "text", text }], ts: new Date().toISOString() });
  }
  emitDelta(text, kind = "text") { this.q.push({ type: "delta", kind, text }); }
  async interrupt() { this.interrupted = (this.interrupted ?? 0) + 1; return { ok: true }; }
  finish() { this.q.push({ type: "done" }); this.q.end(); }

  events() { return this.q; }
  get awaitingDecision() { return this._resolver !== null; }

  reply({ text, choices = null, decline = false }) {
    this.replies.push({ text, choices, decline });
    if (this._resolver && decline) {
      const r = this._resolver;
      this._resolver = null;
      r({ declined: true });
      return { mode: "declined" };
    }
    if (this._resolver) {
      const r = this._resolver;
      this._resolver = null;
      r({ text, choices });
      return { mode: "structured" };
    }
    return { mode: "text" };
  }

  close() { this.closed = true; this.q.end(); }
}

registerEngine("fake", async () => FakeEngine);

// ---- EventQueue ----------------------------------------------------------
console.log("\nEventQueue (the shared adapter primitive)");
{
  // Events pushed BEFORE iteration must not be lost — this is the bug that would
  // silently drop the first turn, or a decision, on a fast run.
  const q = new EventQueue();
  q.push({ type: "idle" });
  q.push({ type: "done" });
  q.end();
  const seen = [];
  for await (const e of q) seen.push(e.type);
  eq("buffers events pushed before iteration", seen, ["idle", "done"]);
}
{
  const q = new EventQueue();
  const seen = [];
  const done = (async () => { for await (const e of q) seen.push(e.type); })();
  await nextTick();
  q.push({ type: "idle" });
  await nextTick();
  q.end();
  await done;
  eq("delivers events pushed during iteration", seen, ["idle"]);
  q.push({ type: "turn" });
  eq("ignores pushes after end()", seen, ["idle"]);
}

// ---- Codex failure + decline, by FEEDING the adapter real wire shapes --------------
// No process: the constructor spawns nothing, so the notification and request handlers can
// be driven with the shapes `codex app-server generate-ts` (0.147.0) declares. This is where
// a wrong method name gets caught for free — the adapter used to listen for `turn/failed`
// and `thread/error`, neither of which exists, so a dead login ended a turn in SILENCE.
console.log("\nCodex adapter: failures are loud, declines answer then interrupt");
{
  const { CodexEngine } = await import("./engines/codex.mjs");
  const drain = (e) => { const out = []; while (e._q._items?.length) out.push(e._q._items.shift()); return out; };

  const e = new CodexEngine({ cwd: "/tmp" });
  e._onNotification({ method: "error", params: { error: { message: "token expired" }, willRetry: true, threadId: "t", turnId: "u" } });
  ok("a retrying error alone reports nothing (it may still succeed)", drain(e).length === 0);
  e._onNotification({ method: "turn/completed", params: { threadId: "t", turn: { id: "u", status: "failed", error: { message: "Your access token could not be refreshed." }, items: [] } } });
  const evs = drain(e);
  eq("a FAILED turn/completed is an error, then the boundary", evs.map((x) => x.type), ["error", "idle"]);
  eq("…carrying Codex's own message", evs[0].error, "Your access token could not be refreshed.");

  e._onNotification({ method: "turn/completed", params: { threadId: "t", turn: { id: "v", status: "completed", error: null, items: [] } } });
  eq("a completed turn is just the boundary", drain(e).map((x) => x.type), ["idle"]);

  const e2 = new CodexEngine({ cwd: "/tmp" });
  e2._onNotification({ method: "error", params: { error: { message: "rate limited" }, willRetry: false } });
  e2._onNotification({ method: "turn/completed", params: { turn: { status: "failed", error: null } } });
  eq("a failed turn with no error of its own reports the last one seen", drain(e2)[0].error, "rate limited");

  // Decline: respond to the parked request with an EMPTY answer map, then interrupt.
  const e3 = new CodexEngine({ cwd: "/tmp" });
  const wrote = [];
  e3._write = (m) => wrote.push(m);
  e3._threadId = "t"; e3._turnId = "u"; e3._turnActive = true;
  e3._request = async (method, params) => { wrote.push({ method, params }); return {}; };
  e3._onServerRequest({ id: 7, method: "item/tool/requestUserInput", params: { questions: [{ id: "q1", question: "Fruit?", options: [{ label: "Mango" }] }] } });
  ok("the structured question parks", e3.awaitingDecision === true);
  const r = e3.reply({ text: "", decline: true });
  await nextTick();
  eq("decline reports its own mode", r.mode, "declined");
  ok("the parked request is answered, with NO answers", JSON.stringify(wrote[0]) === JSON.stringify({ jsonrpc: "2.0", id: 7, result: { answers: {} } }), JSON.stringify(wrote[0]));
  ok("…and only THEN is the turn interrupted", wrote[1]?.method === "turn/interrupt", JSON.stringify(wrote[1]));
  ok("nothing is parked afterwards", e3.awaitingDecision === false);
}

// ---- registry -----------------------------------------------------------
console.log("\nregistry");
{
  ok("claude-code is registered", engineIds().includes("claude-code"));
  ok("a runtime-registered engine resolves", (await getEngine("fake")) === FakeEngine);
  let threw = null;
  try { await getEngine("nope"); } catch (e) { threw = e.message; }
  ok("unknown engine fails loudly", !!threw && /unknown engine/.test(threw), String(threw));
  ok("unknown-engine error lists valid ids", !!threw && threw.includes("claude-code"));
  const probes = await probeEngines();
  ok("probeEngines reports every engine", probes.length === engineIds().length);
  ok("probe result carries an id + available flag", probes.every((p) => p.id && "available" in p));
}

// ---- Session over a non-Claude engine -----------------------------------
console.log("\nSession is engine-agnostic");
{
  const s = new Session({ engine: "fake", cwd: "/tmp/x" });
  const frames = [];
  s.addListener((e) => frames.push(e));
  s.start("hello");
  await nextTick();

  const fake = FakeEngine.last;
  ok("engine received the prompt", fake.startedWith === "hello");
  ok("engine got cwd through the seam", fake.opts.cwd === "/tmp/x");
  eq("meta reports the engine id", s.meta().engine, "fake");
  ok("sessionRef captured from ready", s.sdkSessionId === "fake-thread-1");
  ok("first turn reached listeners", frames.some((f) => f.type === "turn"));
  eq("the initial human prompt is in canonical history", s.turns[0].blocks[0].text, "hello");
  const echo = s.turns.find((t) => t.role === "assistant");
  eq("engine turn text passed through untouched", echo.blocks[0].text, "echo:hello");

  // --- PATH A: numeric tap on a parked decision ---
  const answered = fake.ask({
    question: "Which transport?",
    header: "Transport",
    multiSelect: false,
    options: [{ label: "serve" }, { label: "funnel" }],
  });
  await nextTick();
  ok("pending is exposed on the session", s.pending?.question === "Which transport?");
  ok("a pending frame was emitted", frames.some((f) => f.type === "pending" && f.question));

  const r = s.reply("2");
  eq("numeric tap routes as structured", r.mode, "structured");
  const got = await answered;
  eq("number resolved to the option LABEL", got.choices, ["funnel"]);
  ok("pending cleared after answering", s.pending === null);
  ok("a null pending frame was emitted", frames.some((f) => f.type === "pending" && f.question === null));

  // History must show the answered Q&A, so the phone shows it as answered rather
  // than as a question that vanished.
  const toolUse = s.turns.find((t) => t.blocks.some((b) => b.kind === "tool_use"));
  ok("answered question is synthesized into history", !!toolUse);
  const result = s.turns.find((t) => t.blocks.some((b) => b.kind === "tool_result"));
  eq("history records the chosen label", result.blocks[0].text, "funnel");

  // --- PATH A: free text on a parked decision ---
  const answered2 = fake.ask({
    question: "Name it?",
    multiSelect: false,
    options: [{ label: "a" }, { label: "b" }],
  });
  await nextTick();
  s.reply("something else");
  const got2 = await answered2;
  ok("free text is passed through, not coerced to an option", got2.choices === null);
  eq("free text reaches the engine verbatim", got2.text, "something else");

  // --- PATH A: multiSelect ---
  const answered3 = fake.ask({
    question: "Which?",
    multiSelect: true,
    options: [{ label: "x" }, { label: "y" }, { label: "z" }],
  });
  await nextTick();
  s.reply("1,3");
  const got3 = await answered3;
  eq("multiSelect resolves every index", got3.choices, ["x", "z"]);

  // --- a number that ISN'T an option index must stay text ---
  const answered4 = fake.ask({
    question: "How many?",
    multiSelect: false,
    options: [{ label: "one" }, { label: "two" }],
  });
  await nextTick();
  s.reply("42");
  const got4 = await answered4;
  ok("out-of-range number is treated as text", got4.choices === null, JSON.stringify(got4));

  // --- PATH B: no decision parked -> plain text message ---
  const before = s.turns.length;
  const r2 = s.reply("just talking");
  eq("reply with nothing parked routes as text", r2.mode, "text");
  ok("the human's text is shown immediately", s.turns.length === before + 1);
  eq("engine received the text reply", fake.replies.at(-1).text, "just talking");

  // --- idle passes through (PATH B detection depends on it) ---
  fake.emitIdle();
  await nextTick();
  ok("idle is forwarded to listeners", frames.some((f) => f.type === "idle"));

  // --- lifecycle ---
  s.close();
  ok("close() reaches the engine", fake.closed === true);
  await nextTick();
  eq("status is done after the stream ends", s.status, "done");
  ok("a done frame was emitted", frames.some((f) => f.type === "done"));
}

// ---- busy: is it the agent's move? (PROBLEM 23) ----------------------------
// `status` can't answer this — a session is "running" for 30 minutes after its last word —
// and a client can't infer it from events it never saw (a notification tap mid-turn). So
// the daemon owns it, and every transition is asserted here.
console.log("\nbusy is owned by the daemon, not guessed by clients");
{
  const s = new Session({ engine: "fake", hibernateAfterMs: 0 });
  const busy = [];
  s.addListener((e) => { if (e.type === "busy") busy.push(e); });
  s.start("go");
  ok("busy from the moment a run starts", s.busy === true);
  ok("…with a timestamp every client can count from", typeof s.busySince === "string" && !Number.isNaN(Date.parse(s.busySince)));
  await nextTick();
  const fake = FakeEngine.last;
  fake.emitText("working on it");
  fake.emitText("still going");
  await nextTick();
  eq("a run of turns emits ONE busy frame, not one per turn", busy.length, 1);
  fake.emitIdle();
  await nextTick();
  ok("idle clears it", s.busy === false && s.busySince === null);
  ok("…with a frame saying so", busy.at(-1).busy === false && busy.at(-1).since === null, JSON.stringify(busy.at(-1)));
  ok("activityAt survives the boundary, so a late client knows how long it's been quiet",
    typeof s.activityAt === "string" && s.meta().activityAt === s.activityAt);

  s.reply("next");
  ok("a text reply makes it the agent's move again", s.busy === true);
  const answered = fake.ask({ question: "Pick", multiSelect: false, options: [{ label: "a" }, { label: "b" }] });
  await nextTick();
  ok("a parked decision is NOT busy — the agent is waiting on you", s.busy === false);
  s.reply("1");
  await answered;
  ok("answering it un-pauses the agent", s.busy === true);
  eq("meta carries busy for list clients (the TUI polls this)", s.meta().busy, true);
  ok("meta carries busySince", s.meta().busySince === s.busySince);
  await s.interrupt();
  ok("an interrupt that landed clears it", s.busy === false);

  // A turn arriving while we think it's idle (an engine that auto-continues) must not
  // leave a working agent shown as idle.
  fake.emitText("unprompted");
  await nextTick();
  ok("an engine turn self-heals a stale idle", s.busy === true);
  s.close();
  await nextTick();
  ok("the end of the stream clears it", s.busy === false);
}

// ---- decline: refuse the question, stop the turn (PROBLEM 23) --------------
console.log("\ndecline");
{
  const s = new Session({ engine: "fake", hibernateAfterMs: 0 });
  const frames = [];
  s.addListener((e) => frames.push(e));
  s.start("go");
  await nextTick();
  const fake = FakeEngine.last;

  const none = s.decline();
  ok("declining with nothing parked is refused", none.ok === false && none.mode === "none");
  ok("…and says why", /no question/.test(none.warning ?? ""));
  ok("…without touching the engine", !fake.replies.some((r) => r.decline));

  const outcome = fake.ask({ question: "Which DB?", header: "DB", multiSelect: false,
    options: [{ label: "Postgres" }, { label: "SQLite" }] });
  await nextTick();
  const before = s.turns.length;
  const r = s.decline();
  eq("decline routes as its own mode", r.mode, "declined");
  eq("the engine was told to DECLINE, not handed an answer", await outcome, { declined: true });
  ok("…with no option chosen", fake.replies.at(-1).choices === null && fake.replies.at(-1).decline === true);
  ok("the live question is cleared", s.pending === null);
  ok("…and clients are told", frames.some((f) => f.type === "pending" && f.question === null));
  eq("history keeps the question AND the refusal (two turns)", s.turns.length, before + 2);
  const res = s.turns.at(-1).blocks[0];
  ok("recorded as a refused tool result", res.kind === "tool_result" && res.is_error === true, JSON.stringify(res));
  eq("…that reads as declined", res.text, DECLINED);
  ok("…answering the synthesized question by id", res.tool_use_id === s.turns.at(-2).blocks[0].id);
  ok("still busy until the engine reaches its turn boundary", s.busy === true);
  fake.emitIdle();
  await nextTick();
  ok("idle after a decline leaves it the human's move", s.busy === false);

  const again = s.decline();
  ok("a second decline finds nothing to decline", again.ok === false);
  const typed = s.reply("use the existing schema instead");
  eq("the next message goes as an ordinary message", typed.mode, "text");
  ok("…not as an answer to the declined question", fake.replies.at(-1).decline === false && fake.replies.at(-1).choices === null);

  // A typed word must never be able to decline: only the route does.
  const outcome2 = fake.ask({ question: "Again?", multiSelect: false, options: [{ label: "yes" }] });
  await nextTick();
  s.reply(DECLINED);
  eq("typing the word 'Declined' is an ANSWER, not a decline", (await outcome2).text, DECLINED);
  s.close();
}

// ---- deltas + interrupt (docs/architecture.md) -----------------------
console.log("\nstreaming deltas are DISPLAY ONLY, never the transcript");
{
  const s = new Session({ engine: "fake", hibernateAfterMs: 0 });
  const frames = [];
  s.addListener((e) => frames.push(e));
  s.start(""); // no prompt, so no echo turn — this section is only about deltas
  await nextTick();
  const fake = FakeEngine.last;
  const turnsAtStart = s.turns.length;

  fake.emitDelta("Hel");
  fake.emitDelta("lo ");
  fake.emitDelta("there");
  await nextTick();
  eq("deltas accumulate into `partial`", s.partial, { kind: "text", text: "Hello there" });
  ok("each delta reaches listeners", frames.filter((f) => f.type === "delta").length === 3);
  eq("a delta frame carries the accumulated text too", frames.filter((f) => f.type === "delta").at(-1).partial.text, "Hello there");

  // THE INVARIANT: streaming must not touch history, or the same words render twice —
  // once as in-flight text and once as a turn.
  eq("deltas do NOT enter the transcript", s.turns.length, turnsAtStart);

  // A different kind starts a new buffer rather than smearing into the last one.
  fake.emitDelta("pondering", "thinking");
  await nextTick();
  eq("a new kind starts a fresh buffer", s.partial, { kind: "thinking", text: "pondering" });

  // The canonical turn supersedes the partial.
  fake.emitText("Hello there");
  await nextTick();
  eq("the completed turn clears the partial", s.partial, null);
  eq("…and IS in the transcript", s.turns.at(-1).blocks[0].text, "Hello there");

  fake.emitDelta("half a thou");
  await nextTick();
  ok("a partial can start again", s.partial?.text === "half a thou");
  fake.emitIdle();
  await nextTick();
  eq("a turn boundary clears the partial too", s.partial, null);
}
console.log("\ninterrupt: stop the turn, KEEP the session");
{
  const s = new Session({ engine: "fake", hibernateAfterMs: 0 });
  const frames = [];
  s.addListener((e) => frames.push(e));
  s.start("long job");
  await nextTick();
  const fake = FakeEngine.last;

  fake.emitDelta("working on it");
  await nextTick();
  const r = await s.interrupt();
  ok("interrupt reports success", r.ok === true, JSON.stringify(r));
  eq("it reached the engine", fake.interrupted, 1);
  eq("in-flight text is dropped", s.partial, null);
  ok("an interrupted frame was emitted", frames.some((f) => f.type === "interrupted"));

  // THE DISTINCTION FROM close(): the session is still usable, because "stop" is almost
  // always followed by a correction.
  eq("the session is still alive", s.status, "running");
  ok("its engine was NOT closed", fake.closed === false);
  const rep = s.reply("do it differently");
  ok("it accepts the correction that follows", rep.ok && rep.submitted, JSON.stringify(rep));
  eq("…which reaches the engine", fake.replies.at(-1).text, "do it differently");
}
{
  // An engine with no interrupt support must say so, not pretend.
  class MuteEngine extends FakeEngine {
    constructor(o) { super(o); this.interrupt = undefined; }
  }
  registerEngine("mute", async () => MuteEngine);
  const s = new Session({ engine: "mute", hibernateAfterMs: 0 });
  s.start("go");
  await nextTick();
  const r = await s.interrupt();
  ok("an engine that cannot interrupt reports ok:false", r.ok === false, JSON.stringify(r));
  ok("…and names the engine in the reason", /mute/.test(r.reason ?? ""), r.reason);
}
{
  // Nothing running -> a normal refusal, not a throw.
  const s = new Session({ engine: "fake", hibernateAfterMs: 0 });
  const r = await s.interrupt();
  ok("interrupting a session with no engine is refused gracefully", r.ok === false, JSON.stringify(r));
}

// ---- hibernation (docs/architecture.md) ------------------------------
// The leak this fixes: streaming input holds the agent's stdin open, so the event
// stream never ends, `done` never fires, and the OS process is pinned for the life of
// the Session. Measured on the dev daemon: two `claude` children alive for 3 days and
// 2.5 hours, for conversations nobody was reading.
console.log("\nhibernation: release the process, keep the conversation");
{
  const s = new Session({ engine: "fake", cwd: "/tmp/h", hibernateAfterMs: 15 });
  const frames = [];
  s.addListener((e) => frames.push(e));
  s.start("first prompt");
  await nextTick();
  const first = FakeEngine.last;
  eq("starts out running", s.status, "running");

  // Mid-turn work must not be interrupted by the idle clock.
  first.emitText("still working");
  await nextTick();
  ok("a turn cancels the idle clock", s.status === "running" && !first.closed);

  // idle -> the clock starts -> the process goes.
  first.emitIdle();
  await new Promise((r) => setTimeout(r, 60));
  eq("idle for long enough hibernates", s.status, "hibernated");
  ok("the engine was closed (process released)", first.closed === true);
  ok("a hibernated frame was emitted", frames.some((f) => f.type === "hibernated"));
  ok("it did NOT report itself done", !frames.some((f) => f.type === "done"));
  eq("meta() says hibernated", s.meta().hibernated, true);

  // THE WHOLE POINT: the conversation survived.
  const turnsBefore = s.turns.length;
  ok("the transcript was kept", turnsBefore >= 2, `turns=${turnsBefore}`);

  // Waking: a new engine, resumed against the SAME ref, and the reply gets there.
  const r = s.reply("carry on");
  ok("a reply into a hibernated session is accepted", r.ok && r.submitted, JSON.stringify(r));
  eq("the reply reports that it woke the session", r.woke, true);
  ok("the human's text shows immediately, before the engine boots", s.turns.length === turnsBefore + 1);
  await nextTick();
  const second = FakeEngine.last;
  ok("a NEW engine was created", second !== first);
  eq("the new engine resumes the same conversation", second.opts.resume, "fake-thread-1");
  eq("status is running again", s.status, "running");
  ok("a woke frame was emitted", frames.some((f) => f.type === "woke"));
  eq("the reply was delivered as the new engine's prompt", second.startedWith, "carry on");

  // And it can hibernate again — this is a cycle, not a one-shot.
  second.emitIdle();
  await new Promise((r2) => setTimeout(r2, 60));
  eq("it hibernates a second time", s.status, "hibernated");
}
{
  // THE ONE THAT WOULD BREAK THE PRODUCT: never hibernate a run parked on a decision.
  // The notification has already told a human to go answer it.
  const s = new Session({ engine: "fake", hibernateAfterMs: 15 });
  s.start("go");
  await nextTick();
  const fake = FakeEngine.last;
  fake.ask({ question: "Which one?", multiSelect: false, options: [{ label: "a" }, { label: "b" }] });
  fake.emitIdle(); // idle WHILE parked — the clock must not survive this
  await new Promise((r) => setTimeout(r, 60));
  eq("a parked decision is never hibernated", s.status, "running");
  ok("its engine is still alive", fake.closed === false);
  ok("the question is still there to answer", s.pending?.question === "Which one?");

  // …and the direct call refuses too, not just the timer.
  const refused = s.hibernate();
  ok("hibernate() refuses outright while parked", refused.ok === false, JSON.stringify(refused));
  ok("…and says why", /decision/.test(refused.reason ?? ""), refused.reason);
}
{
  // Disabled by config, and an explicit close is final rather than a nap.
  const s = new Session({ engine: "fake", hibernateAfterMs: 0 });
  s.start("go");
  await nextTick();
  const fake = FakeEngine.last;
  fake.emitIdle();
  await new Promise((r) => setTimeout(r, 50));
  eq("hibernateAfterMs=0 disables it entirely", s.status, "running");

  s.close();
  await nextTick();
  eq("an explicit close ends the session, it does not hibernate it", s.status, "done");
  ok("close() reached the engine", fake.closed === true);
}

// ---- failure paths ------------------------------------------------------
console.log("\nfailure paths");
{
  const s = new Session({ engine: "definitely-not-real" });
  const frames = [];
  s.addListener((e) => frames.push(e));
  s.start("hi");
  await nextTick();
  eq("unknown engine -> session error, no crash", s.status, "error");
  ok("error frame explains why", frames.some((f) => f.type === "error" && /unknown engine/.test(f.error)));
}
{
  // An engine that errors mid-run must surface, not hang.
  class BoomEngine extends FakeEngine {
    start() { this.q.push({ type: "error", error: "engine exploded" }); this.q.end(); }
  }
  registerEngine("boom", async () => BoomEngine);
  const s = new Session({ engine: "boom" });
  const frames = [];
  s.addListener((e) => frames.push(e));
  s.start("hi");
  await nextTick();
  eq("engine error sets status", s.status, "error");
  eq("engine error is recorded", s.lastError, "engine exploded");
  ok("error frame reached listeners", frames.some((f) => f.type === "error"));
  ok("status stays error after stream end (not overwritten by done)", s.status === "error");
}
{
  // Replying before the engine booted must not throw — the phone can POST a reply
  // at any moment, including into a session that just failed.
  const s = new Session({ engine: "fake" });
  const r = s.reply("too early");
  ok("reply before start is refused gracefully", r.ok === false && !r.submitted, JSON.stringify(r));
}

// ---- the real Claude adapter, without running it ------------------------
console.log("\nclaude-code adapter (static surface only)");
{
  const C = await getEngine("claude-code");
  eq("declares its id", C.id, "claude-code");
  ok("declares a label", typeof C.label === "string" && C.label.length > 0);
  const p = await C.probe();
  ok("probe() answers with an availability verdict", typeof p.available === "boolean");
  ok("probe() finds the installed claude CLI", p.available === true, p.reason ?? "");

  // PROBE THE BINARY THAT ACTUALLY RUNS, NOT THE ONE ON PATH. The SDK spawns its own
  // bundled native CLI from an optional per-platform dep; on this machine that build
  // and the PATH build were different versions (2.1.226 vs 2.1.235), so a probe of
  // PATH reported a version no session was using. `binary`+`source` are what make
  // `loop doctor` able to say which one it measured.
  ok("probe() says WHICH binary it measured", typeof p.binary === "string" && p.binary.length > 0, JSON.stringify(p));
  ok("probe() labels where that binary came from", p.source === "sdk-bundled" || p.source === "path", String(p.source));
  ok(
    "a sdk-bundled verdict points at the SDK's own optional dep",
    p.source !== "sdk-bundled" || /claude-agent-sdk-[a-z0-9-]+\/claude$/.test(p.binary),
    p.binary
  );
  ok(
    "a version was reported for that binary",
    typeof p.version === "string" && /\d+\.\d+\.\d+/.test(p.version),
    String(p.version)
  );
  const e = new C({ cwd: "/tmp" });
  ok("implements the seam", typeof e.start === "function" && typeof e.events === "function" &&
    typeof e.reply === "function" && typeof e.close === "function");
  ok("exposes awaitingDecision for reply routing", "awaitingDecision" in e);
  ok("starts with no decision parked", e.awaitingDecision === false);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
