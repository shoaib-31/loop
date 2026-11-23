import assert from "node:assert/strict";
import { buildHandoffPrompt, prepareHandoff, renderHandoffTranscript, renderHandoffTurn } from "./handoff.mjs";
import { Session } from "./session.mjs";

let passed = 0;
function ok(name, value, detail = "") {
  try { assert.ok(value); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); throw e; }
}
async function rejects(name, fn, pattern) {
  let error = null;
  try { await fn(); } catch (e) { error = e; }
  ok(name, error && pattern.test(error.message), error?.message ?? "did not reject");
}

console.log("\nhandoff transcript");
const turn = {
  role: "assistant",
  blocks: [
    { kind: "thinking", text: "private scratch work" },
    { kind: "text", text: "Implemented the route." },
    { kind: "tool_use", name: "Bash", input: { command: "npm test" } },
    { kind: "tool_result", is_error: false, text: "12 suites passed" },
  ],
};
const rendered = renderHandoffTurn(turn);
ok("keeps agent prose", rendered.includes("Implemented the route."));
ok("keeps tool calls", rendered.includes("npm test"));
ok("keeps tool results", rendered.includes("12 suites passed"));
ok("omits thinking", !rendered.includes("private scratch work"));

const many = Array.from({ length: 8 }, (_, i) => ({ role: i % 2 ? "assistant" : "user", blocks: [{ kind: "text", text: `turn-${i} ${"x".repeat(30)}` }] }));
const tail = renderHandoffTranscript(many, { limit: 120 });
ok("keeps the newest turn", tail.text.includes("turn-7"));
ok("drops old turns at the boundary", !tail.text.includes("turn-0"));
ok("says how many were omitted", tail.omittedTurns > 0 && tail.text.includes("omitted"));

console.log("\nhandoff prompt");
const source = {
  id: "source-1",
  cwd: "/tmp/project",
  engineId: "claude-code",
  title: "Fix the stream",
  turns: [
    { role: "user", blocks: [{ kind: "text", text: "Fix reconnects" }] },
    { role: "assistant", blocks: [{ kind: "text", text: "The reconnect test now passes." }] },
  ],
  pending: null,
  busy: false,
};
const built = buildHandoffPrompt({ source, targetEngine: "codex", workspace: "## dev\n M server.mjs", instruction: "Check the edge case." });
ok("names both providers", built.prompt.includes("Claude Code") && built.prompt.includes("Codex"));
ok("carries the working directory", built.prompt.includes(source.cwd));
ok("carries Git state", built.prompt.includes("M server.mjs"));
ok("carries the latest intent", built.prompt.includes("Fix reconnects"));
ok("carries an optional instruction", built.prompt.includes("Check the edge case."));
ok("tells the target to continue, not summarize", built.prompt.includes("Do not merely summarize"));

console.log("\npreparing the target");
class FakeSession {
  constructor(opts) { this.opts = opts; this.title = null; this.handoffFrom = null; }
}
const prepared = await prepareHandoff({
  source,
  targetEngine: "codex",
  SessionClass: FakeSession,
  inspectWorkspace: async () => "clean",
});
ok("uses the same working directory", prepared.session.opts.cwd === source.cwd);
ok("uses the target engine", prepared.session.opts.engine === "codex");
ok("links back to the source session", prepared.session.handoffFrom.sessionId === source.id);
ok("records the source engine", prepared.session.handoffFrom.engine === "claude-code");
ok("gives the target an immediate handoff title", prepared.session.title.includes("Codex"));
ok("returns an unstarted session", typeof prepared.session.start === "undefined");

const fresh = new Session({ engine: "codex", cwd: "/tmp/project" });
// Prevent engine startup: this assertion is specifically about the synchronous canonical
// history write that happens before Session boots an adapter.
fresh._boot = async () => {};
fresh.start("the task that began the session");
ok("a fresh session records its initial prompt for future handoff", fresh.turns[0].blocks[0].text === "the task that began the session");

const persisted = new Session({ id: "target-1", cwd: "/tmp/project", engine: "codex" });
persisted.handoffFrom = prepared.session.handoffFrom;
const restored = Session.fromSnapshot(persisted.toSnapshot());
ok("handoff origin survives a restart", restored.handoffFrom.sessionId === source.id);
ok("restored metadata still exposes the link", restored.meta().handoffFrom.engine === "claude-code");

await rejects("rejects a handoff to the same engine", () => prepareHandoff({ source, targetEngine: "claude-code", SessionClass: FakeSession }), /already uses/);
await rejects("rejects an empty source", () => prepareHandoff({ source: { ...source, turns: [] }, targetEngine: "codex", SessionClass: FakeSession }), /no completed conversation/);
await rejects("rejects a parked decision", () => prepareHandoff({ source: { ...source, pending: {} }, targetEngine: "codex", SessionClass: FakeSession }), /pending question/);
await rejects("rejects a moving source", () => prepareHandoff({ source: { ...source, busy: true }, targetEngine: "codex", SessionClass: FakeSession }), /still working/);

console.log(`\n${passed} passed, 0 failed\n`);
