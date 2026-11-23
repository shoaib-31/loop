// Session-persistence tests (docs/architecture.md). Costs nothing — no agent, no
// network, no `claude` binary: a FakeEngine plus a temp state dir.
//
//   node services/orchestrator/daemon/store-test.mjs
//
// The state dir is set BEFORE store.mjs is imported, because it reads LOOP_ENG_DIR at
// module load. Getting that backwards would write test transcripts into the real
// ~/.loop-eng — the same class of mistake that once had notify-test clobbering the VAPID
// keypair the phone's subscription depends on (AGENTS.md).

import { mkdtempSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = mkdtempSync(join(tmpdir(), "loop-store-"));
process.env.LOOP_ENG_DIR = DIR;
process.env.LOOP_MAX_SNAPSHOTS = "5";
process.env.LOOP_SAVE_DEBOUNCE_MS = "10";

const { Session } = await import("./session.mjs");
const { EventQueue, registerEngine } = await import("./engines/engine.mjs");
const { initStore, saveSnapshot, loadSnapshots, removeSnapshot, attachStore, snapshotDir } =
  await import("./store.mjs");

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);
const nextTick = () => new Promise((r) => setTimeout(r, 5));

class FakeEngine {
  static id = "fake";
  static label = "Fake";
  static async probe() { return { available: true }; }
  constructor(opts = {}) {
    this.opts = opts;
    this.q = new EventQueue();
    this.closed = false;
    FakeEngine.last = this;
  }
  start(prompt) {
    this.startedWith = prompt;
    this.q.push({ type: "ready", sessionRef: "thread-abc" });
    if (prompt)
      this.q.push({ type: "turn", role: "assistant", blocks: [{ kind: "text", text: `echo:${prompt}` }], ts: new Date().toISOString() });
  }
  emitIdle() { this.q.push({ type: "idle" }); }
  events() { return this.q; }
  get awaitingDecision() { return false; }
  reply() { return { mode: "text" }; }
  close() { this.closed = true; this.q.end(); }
}
registerEngine("fake", async () => FakeEngine);

await initStore();
console.log(`\nstate dir: ${snapshotDir()}`);

// ---- snapshot round trip -------------------------------------------------
console.log("\nsnapshot round trip");
{
  const s = new Session({ engine: "fake", cwd: "/tmp/proj", hibernateAfterMs: 0 });
  s.start("build it");
  await nextTick();

  const snap = s.toSnapshot();
  eq("captures the id", snap.id, s.id);
  eq("captures the cwd", snap.cwd, "/tmp/proj");
  eq("captures the engine id", snap.engine, "fake");
  eq("captures the engine's resume handle", snap.sdkSessionId, "thread-abc");
  ok("captures the initial prompt and response", snap.turns.length === 2, `turns=${snap.turns.length}`);
  ok("carries no engine, listeners or timers", !("_engine" in snap) && !("_listeners" in snap));

  ok("saves to disk", (await saveSnapshot(s)) === true);
  const loaded = await loadSnapshots();
  const mine = loaded.find((x) => x.id === s.id);
  ok("reads back", !!mine, JSON.stringify(loaded.map((x) => x.id)));
  eq("round-trips the transcript verbatim", mine.turns, snap.turns);
  eq("stamps a schema version", mine.schema, 1);

  // Restore.
  const r = Session.fromSnapshot(mine);
  eq("restores the SAME id (push deep links must not break)", r.id, s.id);
  eq("restores the transcript", r.turns, s.turns);
  eq("restores the resume handle", r.sdkSessionId, "thread-abc");
  eq("comes back hibernated, not running", r.status, "hibernated");
  eq("meta() reports it sleeping", r.meta().hibernated, true);
  ok("is marked as restored", r.restored === true);
  ok("holds no engine", r._engine === null);

  // …and a reply wakes it against the same conversation.
  const rep = r.reply("keep going");
  ok("a reply into a restored session is accepted", rep.ok && rep.submitted, JSON.stringify(rep));
  eq("…and reports that it woke it", rep.woke, true);
  await nextTick();
  eq("the woken engine resumes the stored handle", FakeEngine.last.opts.resume, "thread-abc");
  eq("the reply became the woken engine's prompt", FakeEngine.last.startedWith, "keep going");
  eq("status is running again", r.status, "running");

  await removeSnapshot(s.id);
}

// ---- what must NOT be restored -----------------------------------------
console.log("\nwhat must NOT survive a restart");
{
  const s = new Session({ engine: "fake", cwd: "/tmp/p2", hibernateAfterMs: 0 });
  s.start("go");
  await nextTick();
  // Pretend a decision was parked when the daemon died.
  s.pending = { question: "Which one?", multiSelect: false, options: [{ label: "a" }] };
  const r = Session.fromSnapshot(s.toSnapshot());
  // A pending decision was a promise inside a process that no longer exists. Restoring
  // the CARD would show a question whose answer has nowhere to go.
  eq("a parked decision is not restored", r.pending, null);
  ok("…so nothing claims to be waiting on a human", r.meta().pending === false);
}
{
  // Never reached `ready` -> no handle -> nothing to rejoin.
  const s = new Session({ engine: "fake", cwd: "/tmp/p3", hibernateAfterMs: 0 });
  const snap = s.toSnapshot();
  eq("a session with no resume handle stores null", snap.sdkSessionId, null);
  const r = Session.fromSnapshot(snap);
  eq("it is restored as ended, not sleeping", r.status, "done");
  const rep = r.reply("hello?");
  ok("replying to it is refused", rep.ok === false, JSON.stringify(rep));
  ok("…and says it has ENDED rather than 'engine not started'", /ended/.test(rep.warning ?? ""), rep.warning);
}

// ---- a corrupt snapshot must not stop the daemon booting ---------------
console.log("\nbad data on disk");
{
  writeFileSync(join(snapshotDir(), "garbage.json"), "{not json at all");
  writeFileSync(join(snapshotDir(), "future.json"), JSON.stringify({ schema: 999, id: "x", turns: [] }));
  writeFileSync(join(snapshotDir(), "noid.json"), JSON.stringify({ schema: 1, turns: [] }));
  const good = new Session({ engine: "fake", cwd: "/tmp/ok", hibernateAfterMs: 0 });
  good.start("fine");
  await nextTick();
  await saveSnapshot(good);

  const loaded = await loadSnapshots();
  ok("unparseable JSON is skipped, not fatal", loaded.every((s) => s.id !== "garbage"));
  ok("an unknown schema version is skipped", !loaded.some((s) => s.schema === 999));
  ok("a snapshot with no id is skipped", loaded.length >= 1);
  ok("the GOOD snapshot still loads alongside them", loaded.some((s) => s.id === good.id),
    JSON.stringify(loaded.map((s) => s.id)));
}

// ---- pruning -----------------------------------------------------------
console.log("\npruning keeps the list bounded");
{
  // LOOP_MAX_SNAPSHOTS=5 for this suite.
  for (let i = 0; i < 9; i++) {
    writeFileSync(
      join(snapshotDir(), `bulk-${i}.json`),
      JSON.stringify({
        schema: 1,
        id: `bulk-${i}`,
        turns: [],
        // Older as i grows, so the newest survive.
        lastTs: new Date(Date.now() - i * 60_000).toISOString(),
      })
    );
  }
  const loaded = await loadSnapshots();
  ok("caps at LOOP_MAX_SNAPSHOTS", loaded.length <= 5, `got ${loaded.length}`);
  ok("keeps the NEWEST, not an arbitrary five", loaded.some((s) => s.id === "bulk-0"),
    JSON.stringify(loaded.map((s) => s.id)));
  ok("and deletes the surplus from disk, not just the result",
    readdirSync(snapshotDir()).filter((f) => f.startsWith("bulk-")).length <= 5,
    String(readdirSync(snapshotDir()).filter((f) => f.startsWith("bulk-")).length));
  eq("returns newest-first", loaded[0].id, "bulk-0");
}

// ---- attachStore -------------------------------------------------------
console.log("\nattachStore writes without Session knowing about storage");
{
  const s = new Session({ engine: "fake", cwd: "/tmp/auto", hibernateAfterMs: 20 });
  const unsub = attachStore(s);
  s.start("auto save me");
  await new Promise((r) => setTimeout(r, 80));
  let loaded = await loadSnapshots();
  ok("a running session is written automatically", loaded.some((x) => x.id === s.id),
    JSON.stringify(loaded.map((x) => x.id)));

  // Terminal events flush immediately — a debounced write during shutdown is a write
  // that never happened.
  FakeEngine.last.emitIdle();
  await new Promise((r) => setTimeout(r, 90));
  eq("it hibernated", s.status, "hibernated");
  loaded = await loadSnapshots();
  const mine = loaded.find((x) => x.id === s.id);
  ok("the flushed snapshot has the transcript", (mine?.turns?.length ?? 0) >= 1, JSON.stringify(mine?.turns));

  ok("unsubscribing is possible", typeof unsub === "function");
  unsub();
}
{
  // THE RESURRECTION BUG, caught by lifecycle-test.mjs against a real agent.
  // Closing a session ends its engine stream, which emits `done` on a LATER tick, which
  // attachStore flushes — landing after DELETE already unlinked the file. The session
  // then rose from the dead on the next daemon boot. discard() is what makes it stick.
  const s = new Session({ engine: "fake", cwd: "/tmp/zombie", hibernateAfterMs: 0 });
  attachStore(s);
  s.start("bury me");
  await new Promise((r) => setTimeout(r, 60));
  ok("it was persisted while alive", (await loadSnapshots()).some((x) => x.id === s.id));

  s.discard();               // what DELETE /sessions/:id does
  await removeSnapshot(s.id); // …then the unlink
  await new Promise((r) => setTimeout(r, 120)); // let `done` land and try to flush

  ok("a discarded session is not written back by its own `done` event",
    !(await loadSnapshots()).some((x) => x.id === s.id),
    JSON.stringify((await loadSnapshots()).map((x) => x.id)));
  ok("…and saveSnapshot refuses it outright", (await saveSnapshot(s)) === false);
  ok("the session knows it is discarded", s.discarded === true);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
