// Adopting foreign conversations (docs/architecture.md). Costs NOTHING — no agent, no
// network, no tokens, and it never touches the real `~/.claude` or `~/.loop-eng`.
//
//   node services/orchestrator/daemon/import-test.mjs
//
// HOW IT TESTS THE REAL CONVERTERS RATHER THAN A MOCK OF THEM:
//   Claude — `CLAUDE_CONFIG_DIR` is honoured by the SDK (verified 2026-08-26), so pointing
//     it at fixtures/claude-config runs the ACTUAL `listSessions()` /
//     `getSessionMessages()` against committed JSONL. That matters more than it looks:
//     the two things most likely to break are the parentUuid CHAIN resolution and the
//     block mapping, and a hand-rolled fake of the SDK would exercise neither.
//   Codex — its store is reachable only over JSON-RPC, so there is no equivalent
//     directory trick. The pure `threadToTurns()` is driven from a recorded Thread instead.
//
// Both env vars are set BEFORE any import, because these modules read them at load time.

import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "fixtures");

process.env.CLAUDE_CONFIG_DIR = join(FIXTURES, "claude-config");
process.env.LOOP_ENG_DIR = mkdtempSync(join(tmpdir(), "loop-import-"));
process.env.LOOP_SAVE_DEBOUNCE_MS = "10";
process.env.LOOP_NO_AUTH = "1";

const { Session } = await import("./session.mjs");
const { EventQueue, registerEngine, listConversations, readConversation, probeEngines, conversationTitle } =
  await import("./engines/engine.mjs");
const { threadToTurns } = await import("./engines/codex.mjs");

const RICH = "aaaaaaaa-1111-4111-8111-111111111111";
const SMALL = "bbbbbbbb-2222-4222-8222-222222222222";
const OURS = "cccccccc-3333-4333-8333-333333333333"; // entrypoint sdk-ts = a Loop run

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};
const eq = (name, actual, expected) =>
  ok(name, JSON.stringify(actual) === JSON.stringify(expected), `got ${JSON.stringify(actual)}`);

// Every block of a given kind, flattened — most assertions below are about shape, not order.
const blocksOf = (turns, kind) => turns.flatMap((t) => t.blocks).filter((b) => b.kind === kind);

// =====================================================================
console.log("\nlistConversations — Claude Code, against fixture JSONL");
// =====================================================================
{
  const r = await listConversations("claude-code", { limit: 50 });
  const refs = r.conversations.map((c) => c.ref);

  ok("finds both interactive fixtures", refs.includes(RICH) && refs.includes(SMALL), refs.join(","));

  // THE FILTER THAT KEEPS THE PICKER USEFUL. Our own daemon's runs are recorded in the same
  // store (entrypoint `sdk-ts`); on the dev machine that was 66 of 179 sessions. Listing
  // them back at the user would offer to import the thing they are already looking at.
  ok("EXCLUDES our own headless runs (entrypoint sdk-ts)", !refs.includes(OURS), refs.join(","));

  const rich = r.conversations.find((c) => c.ref === RICH);
  eq("title prefers the ai-title over the first prompt", rich.title, "Pick a fruit for the snack");
  eq("cwd comes through", rich.cwd, "/tmp/loop-fixture");
  eq("gitBranch comes through", rich.gitBranch, "main");
  ok("preview is the first prompt", rich.preview.startsWith("This session is being continued"), rich.preview.slice(0, 30));
  ok("every row is stamped with its engine", r.conversations.every((c) => c.engine === "claude-code"));

  // lastTs is an ISO STRING, not a number. Claude reports epoch ms and Codex epoch
  // seconds; a numeric field here would be a sort order wrong by 1000x on one engine.
  ok("lastTs is an ISO string", typeof rich.lastTs === "string" && rich.lastTs.endsWith("Z"), rich.lastTs);
  ok("lastTs parses to the fixture's own date", new Date(rich.lastTs).getUTCFullYear() === 2026, rich.lastTs);

  // Newest first — the ordering every client relies on rather than re-deriving.
  const ts = r.conversations.map((c) => Date.parse(c.lastTs));
  ok("newest first", ts.every((v, i) => i === 0 || ts[i - 1] >= v), JSON.stringify(ts));

  eq("no next page when everything fits", r.nextCursor, null);
  ok("no `reason` when the engine can do it", !r.reason);
}

// =====================================================================
console.log("\nlistConversations — cursor pagination");
// =====================================================================
{
  const p1 = await listConversations("claude-code", { limit: 1 });
  eq("page 1 honours the limit", p1.conversations.length, 1);
  ok("page 1 offers a next cursor", typeof p1.nextCursor === "string", String(p1.nextCursor));

  const p2 = await listConversations("claude-code", { limit: 1, cursor: p1.nextCursor });
  eq("page 2 honours the limit", p2.conversations.length, 1);
  ok("page 2 does NOT repeat page 1",
    p2.conversations[0].ref !== p1.conversations[0].ref,
    `${p1.conversations[0].ref} vs ${p2.conversations[0].ref}`);

  // The cursor is OPAQUE by contract (engine.mjs): Codex's encodes a sort anchor, not an
  // index, so nothing above the adapter may do arithmetic on it. Asserting only that it
  // round-trips keeps this test honest about that.
  const p3 = await listConversations("claude-code", { limit: 1, cursor: "not-a-real-cursor" });
  eq("a malformed cursor restarts at the top rather than throwing",
    p3.conversations[0].ref, p1.conversations[0].ref);
}

// =====================================================================
console.log("\nreadConversation — Claude Code block mapping");
// =====================================================================
{
  const r = await readConversation("claude-code", RICH, { limit: 400 });
  eq("cwd", r.cwd, "/tmp/loop-fixture");
  ok("not truncated at limit 400", r.truncated === false, JSON.stringify({ total: r.total, kept: r.turns.length }));

  const kinds = {};
  for (const b of r.turns.flatMap((t) => t.blocks)) kinds[b.kind] = (kinds[b.kind] ?? 0) + 1;
  eq("all four block kinds map 1:1", Object.keys(kinds).sort(), ["text", "thinking", "tool_result", "tool_use"]);

  ok("roles are only user/assistant", r.turns.every((t) => t.role === "user" || t.role === "assistant"));
  ok("every turn carries a parseable ts", r.turns.every((t) => !Number.isNaN(Date.parse(t.ts))));
  // `timestamp` is absent from the SDK's SessionMessage typedef but present at runtime, so
  // the real per-turn times survive rather than everything collapsing onto the file mtime.
  ok("per-turn ts are DISTINCT (real timestamps, not the file mtime)",
    new Set(r.turns.map((t) => t.ts)).size > 1,
    JSON.stringify(r.turns.map((t) => t.ts)));

  // A blocks-only-whitespace message must not become an empty turn: blocks.mjs would draw a
  // bare glyph with nothing after it.
  ok("a whitespace-only message is dropped, not rendered empty",
    r.turns.every((t) => t.blocks.length > 0) && !blocksOf(r.turns, "text").some((b) => !b.text.trim()));

  const th = blocksOf(r.turns, "thinking");
  eq("thinking maps to kind:thinking", th.length, 1);
  ok("thinking text survives", th[0].text.includes("ask rather than guess"), th[0].text);

  const bash = blocksOf(r.turns, "tool_use").find((b) => b.name === "Bash");
  eq("tool_use keeps its name and input", [bash.name, bash.input.command], ["Bash", "npm test"]);
  const bashRes = blocksOf(r.turns, "tool_result").find((b) => b.tool_use_id === "tu_bash1");
  eq("tool_result content flattens to text", bashRes.text, "41 passed, 0 failed");
  eq("tool_result is_error is a real boolean", bashRes.is_error, false);

  // A compact boundary is an ordinary user turn, deliberately not special-cased: it IS what
  // the conversation currently starts with, and inventing a marker turn would be fabrication.
  ok("the compact-summary opener is an ordinary user turn",
    r.turns[0].role === "user" && r.turns[0].blocks[0].text.startsWith("This session is being continued"));
}

// =====================================================================
console.log("\nreadConversation — THE ANSWERED QUESTION (the product's centrepiece)");
// =====================================================================
{
  const r = await readConversation("claude-code", RICH, { limit: 400 });

  // `extractBlocks` SUPPRESSES AskUserQuestion on the live path, because session.mjs
  // synthesizes the answered pair when the human replies. Import must do the OPPOSITE: this
  // conversation was answered in someone else's client, so the pair is already complete and
  // suppressing it would delete the one thing the product exists to show.
  const asks = blocksOf(r.turns, "tool_use").filter((b) => b.name === "AskUserQuestion");
  eq("the AskUserQuestion tool_use is KEPT on import", asks.length, 1);

  const q = asks[0].input.questions[0];
  eq("input.questions survives verbatim", [q.question, q.header, q.multiSelect], ["Which fruit should I use?", "Fruit", false]);
  eq("options survive with labels and descriptions",
    q.options.map((o) => o.label), ["Mango", "Guava", "Papaya"]);
  ok("option descriptions survive", q.options[0].description === "Sweet and in season");

  const answer = blocksOf(r.turns, "tool_result").find((b) => b.tool_use_id === asks[0].id);
  ok("the answering tool_result is KEPT too", !!answer);

  // BOTH renderers decide "which option was chosen" by substring-matching the option label
  // inside the answer text — turn-view.tsx's `answerText.includes(opt.label)`, and
  // blocks.mjs's `answered:` line. The vendor's answer is a prose sentence that contains the
  // label, so it works with no conversion. This assertion is what would catch that changing.
  ok("the answer text contains the chosen label (what both renderers match on)",
    answer.text.includes("Guava"), answer.text);
  ok("and does NOT contain the labels that were not chosen",
    !answer.text.includes("Papaya"), answer.text);

  // The shape must equal what session.mjs:334 synthesizes on a live reply, or an imported
  // question renders differently from one answered here — the drift PROBLEM 16 warned about.
  ok("the pair is shaped exactly like a synthesized one (tool_use{questions} + tool_result)",
    asks[0].kind === "tool_use" && Array.isArray(asks[0].input.questions) &&
    answer.kind === "tool_result" && typeof answer.text === "string");
}

// =====================================================================
console.log("\nextractBlocks — the keepAsk default is the LIVE behaviour");
// =====================================================================
{
  // Both branches of the one flag that import inverts. Getting this default wrong would
  // render every live question TWICE — once as the surfaced decision card and once as raw
  // history — and nothing but a real-agent run would reveal it.
  const { extractBlocks } = await import("./engines/claude-code.mjs");
  const content = [
    { type: "tool_use", id: "tu_q", name: "AskUserQuestion", input: { questions: [{ question: "Which?", options: [{ label: "A" }] }] } },
  ];
  const answerContent = [{ type: "tool_result", tool_use_id: "tu_q", content: "…=\"A\"." }];

  const liveIds = new Set();
  const live = extractBlocks(content, liveIds);
  eq("LIVE (default): the AskUserQuestion tool_use is suppressed", live, []);
  ok("…and its id is remembered so the answer can be suppressed too", liveIds.has("tu_q"));
  eq("LIVE: the answering tool_result is suppressed as well",
    extractBlocks(answerContent, liveIds), []);

  const importIds = new Set();
  const kept = extractBlocks(content, importIds, { keepAsk: true });
  eq("IMPORT (keepAsk): the tool_use is kept", kept.length, 1);
  eq("…as an AskUserQuestion tool_use", [kept[0].kind, kept[0].name], ["tool_use", "AskUserQuestion"]);
  ok("…and the id is NOT added to askIds, so the answer survives too", !importIds.has("tu_q"));
  eq("IMPORT: the answering tool_result is kept",
    extractBlocks(answerContent, importIds, { keepAsk: true }).length, 1);

  // Non-question tools are unaffected by the flag in either direction.
  const bash = [{ type: "tool_use", id: "b1", name: "Bash", input: { command: "ls" } }];
  eq("an ordinary tool_use is kept either way",
    [extractBlocks(bash, new Set()).length, extractBlocks(bash, new Set(), { keepAsk: true }).length], [1, 1]);
}

// =====================================================================
console.log("\nreadConversation — truncation keeps the TAIL");
// =====================================================================
{
  const full = await readConversation("claude-code", SMALL, { limit: 400 });
  eq("the small fixture has 6 turns", full.turns.length, 6);

  const cut = await readConversation("claude-code", SMALL, { limit: 2 });
  eq("limit is honoured", cut.turns.length, 2);
  eq("total still reports the real length", cut.total, 6);
  eq("truncated is flagged", cut.truncated, true);

  // The SDK's own `limit` counts from the OLDEST message, so passing it through would return
  // the START of the conversation — the opposite of what someone opening a transcript wants.
  eq("the TAIL is kept, not the head",
    cut.turns.map((t) => t.blocks[0].text), ["three", "third"]);

  ok("a full read is not flagged truncated", full.truncated === false);
}

// =====================================================================
console.log("\nthreadToTurns — Codex, against a recorded thread/read");
// =====================================================================
{
  const thread = JSON.parse(await readFile(join(FIXTURES, "codex-thread.json"), "utf8"));
  const turns = threadToTurns(thread);

  // ONE CODEX TURN CAN BE TWO OF OURS: a Codex Turn bundles the human's message with the
  // agent's items, so a `userMessage` has to FLUSH the assistant blocks and emit its own
  // turn. Without that the whole conversation renders as one giant assistant turn.
  eq("roles alternate instead of collapsing into one turn",
    turns.map((t) => t.role), ["user", "assistant", "user", "assistant", "user"]);

  // itemToBlocks drops `userMessage` on the live path (the daemon already has it upstream).
  // On import there is no upstream, which is why threadToTurns handles it itself.
  eq("the human's first message survives", turns[0].blocks[0].text, "I want a fruit for a snack.");

  const kinds = {};
  for (const b of turns.flatMap((t) => t.blocks)) kinds[b.kind] = (kinds[b.kind] ?? 0) + 1;
  eq("reasoning -> thinking, commandExecution -> tool_use+tool_result, agentMessage -> text",
    Object.keys(kinds).sort(), ["text", "thinking", "tool_result", "tool_use"]);

  const cmd = turns.flatMap((t) => t.blocks).find((b) => b.kind === "tool_use" && b.name === "Bash");
  eq("commandExecution becomes a Bash tool_use", cmd.input.command, "ls /pantry");
  const cmdRes = turns.flatMap((t) => t.blocks).find((b) => b.kind === "tool_result");
  eq("exitCode 0 is not an error", cmdRes.is_error, false);

  // SECONDS -> ISO. Codex reports epoch seconds; treating them as ms would date every
  // imported Codex conversation to 1970 and sort it below everything else.
  ok("epoch SECONDS become a sane ISO date",
    new Date(turns[0].ts).getUTCFullYear() === 2026, turns[0].ts);
  ok("all Codex ts parse", turns.every((t) => !Number.isNaN(Date.parse(t.ts))));

  // A turn with null startedAt falls back to the thread's own time rather than NaN.
  ok("a turn with no timestamps still gets a valid ts",
    !Number.isNaN(Date.parse(turns[turns.length - 1].ts)), turns[turns.length - 1].ts);

  // A message whose only content is an attachment must not vanish — an empty turn reads as
  // data loss, so non-text inputs get a short marker.
  eq("a mention renders as @name alongside the text", turns[2].blocks[0].text, "Guava please, see @notes.md");
  eq("an image-only message becomes a marker, not an empty turn", turns[4].blocks[0].text, "[image]");
}

// =====================================================================
console.log("\nthe verbs are OPTIONAL — a capability-less engine degrades");
// =====================================================================
{
  // The base Engine class is DOCUMENTATION, not inheritance (the real engines are
  // standalone classes), so "optional" has to mean "the static may be absent entirely".
  class BareEngine {
    static id = "bare";
    static label = "Bare";
    static async probe() { return { available: true }; }
    constructor() { this.q = new EventQueue(); }
    start() {}
    events() { return this.q; }
    reply() { return { mode: "text" }; }
    close() { this.q.end(); }
  }
  registerEngine("bare", async () => BareEngine);

  const l = await listConversations("bare", {});
  eq("listConversations returns an empty list, not a throw", l.conversations, []);
  ok("…with a printable reason", /cannot list conversations/.test(l.reason ?? ""), l.reason);
  eq("nextCursor is null", l.nextCursor, null);

  const rd = await readConversation("bare", "whatever");
  eq("readConversation returns no turns, not a throw", rd.turns, []);
  ok("…with a printable reason", /cannot read conversations/.test(rd.reason ?? ""), rd.reason);

  const probes = await probeEngines();
  const byId = Object.fromEntries(probes.map((p) => [p.id, p]));
  eq("probeEngines reports the capability as false for a bare engine", byId.bare.canListConversations, false);
  eq("…and true for Claude Code", byId["claude-code"].canListConversations, true);
  eq("…and true for Codex", byId.codex.canListConversations, true);
}

// =====================================================================
console.log("\nadoption — a foreign conversation IS a restored snapshot");
// =====================================================================
{
  // The whole continuation mechanism is Session.fromSnapshot() with the foreign ref as
  // sdkSessionId (PROBLEM 16 + 20). No new lifecycle state, no second resume path.
  const engines = [];
  class SpyEngine {
    static id = "spy";
    static label = "Spy";
    static async probe() { return { available: true }; }
    constructor(opts = {}) {
      this.opts = opts;
      this.q = new EventQueue();
      engines.push(this);
    }
    start(prompt) {
      this.startedWith = prompt;
      this.q.push({ type: "ready", sessionRef: this.opts.resume ?? "fresh-ref" });
      this.q.push({ type: "turn", role: "assistant", blocks: [{ kind: "text", text: "woke" }], ts: new Date().toISOString() });
    }
    events() { return this.q; }
    reply() { return { mode: "text" }; }
    close() { this.q.end(); }
  }
  registerEngine("spy", async () => SpyEngine);

  const imported = await readConversation("claude-code", RICH, { limit: 400 });
  const s = Session.fromSnapshot({
    cwd: "/tmp/loop-fixture",
    engine: "spy",
    sdkSessionId: RICH, // the FOREIGN ref is the resume handle
    turns: imported.turns,
  });
  s.adoptedFrom = { engine: "claude-code", ref: RICH, truncated: false, total: imported.total };

  eq("an adopted session lands HIBERNATED", s.status, "hibernated");
  eq("…and reports itself as such in meta", s.meta().hibernated, true);
  eq("it holds the imported transcript", s.turns.length, imported.turns.length);
  eq("it keeps the foreign ref as its resume handle", s.sdkSessionId, RICH);
  ok("it holds NO engine, so no process (the thing that used to leak)", s._engine === null || s._engine === undefined);
  eq("it gets its OWN loop-eng id, not the foreign ref", s.id === RICH, false);
  ok("the id is a uuid", /^[0-9a-f-]{36}$/.test(s.id), s.id);
  eq("meta advertises where it came from", s.meta().adoptedFrom.ref, RICH);

  // A reply is what wakes it — and it must resume the FOREIGN conversation, not start fresh.
  const before = s.turns.length;
  const r = s.reply("and then?");
  eq("reply reports a wake", [r.ok, r.woke], [true, true]);
  eq("the human's text is appended immediately", s.turns.length, before + 1);
  await new Promise((res) => setTimeout(res, 30));
  eq("exactly one engine was constructed", engines.length, 1);
  eq("THE ENGINE WAS GIVEN THE FOREIGN REF TO RESUME", engines[0].opts.resume, RICH);
  eq("…and the cwd of the conversation, not the daemon's", engines[0].opts.cwd, "/tmp/loop-fixture");
  s.close();
}

// =====================================================================
console.log("\nconversationTitle — the engine's OWN name for a session (PROBLEM 21)");
// =====================================================================
{
  eq("a titled conversation returns its ai-title", await conversationTitle("claude-code", RICH), "Pick a fruit for the snack");
  // The trap: the SDK's `summary` falls back to the LAST PROMPT. Using it would name every
  // untitled session after a fragment of whatever was typed into it most recently.
  eq("an UNtitled one is null — never a prompt dressed up as a title", await conversationTitle("claude-code", SMALL), null);
  eq("an unknown ref is null, not a throw", await conversationTitle("claude-code", "nope-nope"), null);
  eq("an engine without the verb is null", await conversationTitle("spy", RICH), null);

  const s = Session.fromSnapshot({ cwd: "/tmp/loop-fixture", engine: "claude-code", sdkSessionId: RICH, turns: [] });
  eq("a hibernated session learns its title with no process", await s.refreshTitle(), "Pick a fruit for the snack");
  eq("…and reports it in meta()", s.meta().title, "Pick a fruit for the snack");
  eq("…and it survives a restart", Session.fromSnapshot(s.toSnapshot()).title, "Pick a fruit for the snack");
  s.sdkSessionId = "nope-nope";
  s._titleCheckedAt = 0;
  eq("a failed lookup never BLANKS a known title", await s.refreshTitle(), "Pick a fruit for the snack");
}

// =====================================================================
console.log("\nadoption survives a restart, and stays readable without a ref");
// =====================================================================
{
  const imported = await readConversation("claude-code", SMALL, { limit: 400 });
  const s = Session.fromSnapshot({
    cwd: "/tmp/loop-fixture", engine: "spy", sdkSessionId: SMALL, turns: imported.turns,
  });
  s.adoptedFrom = { engine: "claude-code", ref: SMALL, truncated: true, total: 99 };

  const snap = s.toSnapshot();
  ok("adoptedFrom is persisted", !!snap.adoptedFrom, JSON.stringify(snap.adoptedFrom));
  const back = Session.fromSnapshot(snap);
  eq("…and restored, so the badge doesn't vanish on reboot", back.adoptedFrom.ref, SMALL);
  eq("…still hibernated after the round trip", back.status, "hibernated");
  eq("…transcript intact", back.turns.length, imported.turns.length);

  // A snapshot with no resume handle is readable but NOT continuable — pretending otherwise
  // would start a fresh agent with no memory of the transcript above the input box.
  const noRef = Session.fromSnapshot({ cwd: "/tmp/loop-fixture", engine: "spy", turns: imported.turns });
  eq("no resume handle -> restored `done`, i.e. readable not continuable", noRef.status, "done");
  const rr = noRef.reply("hello?");
  eq("…and replying says so instead of silently starting a new conversation", rr.ok, false);
  ok("…with an honest message", /has ended/.test(rr.warning ?? ""), rr.warning);
}

// =====================================================================
console.log("\nthe HTTP surface — GET /conversations, POST /sessions {adopt}");
// =====================================================================
{
  // The real server, with CLAUDE_CONFIG_DIR still pointing at the fixtures. Adoption spawns
  // nothing (an adopted session is hibernated), so this whole section is free.
  const PORT = 4396;
  process.env.PORT = String(PORT);
  const cwdForAdopt = mkdtempSync(join(tmpdir(), "loop-adopt-cwd-"));
  // main() EXPLICITLY, not just the import. server.mjs only auto-listens when argv[1] ends
  // with server.mjs, precisely so `loop __daemon` can import it and call main() itself
  // (PROBLEM 18) — so importing it from a test starts nothing at all.
  const { main } = await import("./server.mjs");
  await main();

  const B = `http://127.0.0.1:${PORT}`;
  // POLL for readiness rather than sleeping a guessed interval: boot also generates a VAPID
  // keypair on a fresh state dir, and listen() resolves after main() returns.
  let up = false;
  for (let i = 0; i < 100 && !up; i++) {
    try { up = (await fetch(`${B}/health`)).ok; } catch { /* not yet */ }
    if (!up) await new Promise((r) => setTimeout(r, 100));
  }
  ok("the daemon came up", up);
  const get = async (p) => { const r = await fetch(B + p); return { status: r.status, body: await r.json() }; };
  const post = async (p, b) => {
    const r = await fetch(B + p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(b) });
    return { status: r.status, body: await r.json() };
  };

  const list = await get("/conversations?engine=claude-code&limit=50");
  eq("GET /conversations is 200", list.status, 200);
  const refs = list.body.conversations.map((c) => c.ref);
  ok("it lists the interactive fixtures", refs.includes(RICH) && refs.includes(SMALL), refs.join(","));
  ok("and not our own runs", !refs.includes(OURS));
  eq("nothing is adopted yet", list.body.conversations.every((c) => c.adoptedAs === null), true);

  eq("an unknown engine is rejected up front", (await get("/conversations?engine=nope")).status, 400);
  const clamp = await get("/conversations?engine=claude-code&limit=99999");
  eq("limit is clamped rather than trusted", clamp.status, 200);

  const prev = await get(`/conversations/claude-code/${RICH}`);
  eq("GET /conversations/:engine/:ref previews turns", prev.status, 200);
  ok("…with the AskUserQuestion intact",
    prev.body.turns.flatMap((t) => t.blocks).some((b) => b.name === "AskUserQuestion"));
  // 404, not a 200 with an empty list: "no such conversation" and "an empty conversation"
  // are different claims and a client shows them differently.
  eq("a missing ref is 404, not an empty 200", (await get("/conversations/claude-code/nope-nope")).status, 404);

  const ad = await post("/sessions", { adopt: { engine: "claude-code", ref: RICH }, cwd: cwdForAdopt });
  eq("adopt is 200", ad.status, 200);
  eq("…and the session is hibernated, holding no process", ad.body.meta.status, "hibernated");
  ok("…with the transcript already loaded", ad.body.meta.turnCount > 0, String(ad.body.meta.turnCount));
  eq("…and knows it was adopted", ad.body.adopted.ref, RICH);
  const listed = (await get("/sessions")).body.sessions.find((x) => x.id === ad.body.id);
  eq("GET /sessions names it with Claude's own title", listed?.title, "Pick a fruit for the snack");

  // DEDUPE. Two sessions resuming one transcript means two writers on the same file, and
  // writing back in place is the whole point of the feature.
  const again = await post("/sessions", { adopt: { engine: "claude-code", ref: RICH }, cwd: cwdForAdopt });
  eq("adopting the same ref twice returns the FIRST session", again.body.id, ad.body.id);
  eq("…and says so", again.body.alreadyAdopted, true);
  const all = await get("/sessions");
  eq("…leaving exactly one session", all.body.sessions.length, 1);

  const list2 = await get("/conversations?engine=claude-code&limit=50");
  eq("the list now reports it as already adopted",
    list2.body.conversations.find((c) => c.ref === RICH).adoptedAs, ad.body.id);

  eq("adopt without a ref is 400", (await post("/sessions", { adopt: { engine: "claude-code" } })).status, 400);
  eq("adopt with an unknown engine is 400", (await post("/sessions", { adopt: { engine: "nope", ref: "x" } })).status, 400);
  eq("adopt of an unknown ref is 404", (await post("/sessions", { adopt: { engine: "claude-code", ref: "no-such" } })).status, 404);

  // A conversation can outlive its directory (deleted temp dir, moved repo). Refuse with
  // something actionable rather than failing the spawn minutes later on the first reply.
  const gone = await post("/sessions", { adopt: { engine: "claude-code", ref: SMALL }, cwd: "/definitely/not/here" });
  eq("adopting into a directory that does not exist is 409", gone.status, 409);
  ok("…with an actionable hint", /cwd/.test(gone.body.hint ?? ""), gone.body.hint);
  ok("…and it did NOT silently fall back to the daemon's cwd",
    (await get("/sessions")).body.sessions.length === 1);

  // The ordinary start path must be untouched by the adopt branch sitting in front of it.
  eq("POST /sessions with no prompt and no adopt is still 400", (await post("/sessions", {})).status, 400);
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed`);
console.log(`state dir: ${process.env.LOOP_ENG_DIR}`);
process.exit(fail === 0 ? 0 : 1);
