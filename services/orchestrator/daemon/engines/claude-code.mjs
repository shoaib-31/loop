// Claude Code engine — the FIRST implementation of the seam, not the privileged one.
//
// Everything Claude-specific in the daemon lives in this file and nowhere else:
// the `query()` call, `canUseTool`, the `AskUserQuestion` tool name, Anthropic
// content-block shapes, and the streaming-input trick that holds stdin open.
// If a line here mentions Anthropic, it is in the right file; if a line anywhere
// else does, the seam has leaked.
//
// The two decision paths (both proven in combined-test.mjs, both preserved):
//   PATH A  structured AskUserQuestion, caught mid-turn by `canUseTool`, which
//           AWAITS our promise — that await is what pauses the agent, and is the
//           mechanism the entire USP rests on.
//   PATH B  a plain prose question: an ordinary turn that happens to end in "?".
//           Detected downstream at `idle`. We do NOT force the structured tool —
//           see "preserve Claude's native feel" in docs/architecture.md.

import {
  query,
  // The conversation-store read API (PROBLEM 20). Pure JS over `~/.claude/projects/**`,
  // so it works inside the compiled binary too — unlike the native CLI, which is why
  // `resolveCli()` below exists. These three are the only reason this file knows anything
  // about a transcript it did not itself produce.
  listSessions,
  getSessionMessages,
  getSessionInfo,
} from "@anthropic-ai/claude-agent-sdk";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createRequire } from "node:module";
import { EventQueue } from "./engine.mjs";

const run = promisify(execFile);

// What Claude reads when the human declines its question (PROBLEM 23). Worded as an
// instruction because it IS one: without "wait", a model told only "no answer" tends to
// pick a default and keep going — the thing a decline exists to prevent.
const DECLINE_MESSAGE =
  "The user declined to answer this question. Do not assume an answer or continue the " +
  "task — stop here and wait for their next message, which will tell you what to do instead.";

/**
 * THE BINARY THE SDK ACTUALLY SPAWNS — which is NOT the `claude` on your PATH.
 *
 * The SDK ships a native CLI per platform as an OPTIONAL dependency
 * (`@anthropic-ai/claude-agent-sdk-darwin-arm64` and friends, pinned to the SDK's own
 * version) and spawns that. Measured on this machine: the daemon's children are
 * `node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --output-format
 * stream-json --input-format stream-json --permission-prompt-tool stdio`, reporting
 * **2.1.226**, while `claude --version` on PATH reported **2.1.235**. Probing PATH
 * therefore reported a version that no session was running — fine as a liveness proxy,
 * actively misleading the moment a version-specific bug matters.
 *
 * What DOES come from the installed CLI is the **credentials** (`~/.claude`), which is
 * why agent auth is free and no API key is needed. The binary and the login are two
 * different things; only the login is shared.
 *
 * Returns null when the optional dep isn't installed (`--no-optional`, an unsupported
 * platform) or when resolution can't work at all — inside a `bun build --compile`
 * binary `import.meta.url` is a bunfs path. Callers fall back to PATH.
 */
function sdkBinaryPath() {
  // musl is a separate package and there's no cheap reliable libc probe, so try the
  // plain key first and the musl one as a fallback rather than detecting.
  const keys = [`${process.platform}-${process.arch}`];
  if (process.platform === "linux") keys.push(`${process.platform}-${process.arch}-musl`);
  let require;
  try { require = createRequire(import.meta.url); } catch { return null; }
  for (const key of keys) {
    try { return require.resolve(`@anthropic-ai/claude-agent-sdk-${key}/claude`); } catch { /* next */ }
  }
  return null;
}

/** First entry of `which claude`, or null. */
async function claudeOnPath() {
  try {
    const { stdout } = await run(process.platform === "win32" ? "where" : "which", ["claude"], { timeout: 5000 });
    return stdout.split("\n")[0].trim() || null;
  } catch {
    return null;
  }
}

let cliCache = null;

/**
 * WHICH `claude` THIS ENGINE WILL ACTUALLY RUN — the single source of truth, used by
 * both `probe()` and the run itself, so what `loop doctor` reports and what gets spawned
 * cannot drift apart. (They used to: probe measured PATH while runs used the bundled
 * build, two different versions.)
 *
 * Order, and why:
 *   1. The SDK's own bundled native CLI, when node_modules is present. Version-locked to
 *      the SDK JS, so it's the safest pairing — this is the dev path.
 *   2. The `claude` on PATH. THIS IS WHAT MAKES A RELEASED BINARY POSSIBLE (PROBLEM 18):
 *      bun does NOT embed the SDK's 280MB native CLI, and inside a compiled binary
 *      `import.meta.url` is a `$bunfs` path, so the SDK's own resolution throws
 *      "Native CLI binary for <platform> not found" and names this exact escape hatch.
 *      The user necessarily has Claude Code installed anyway, because that install is
 *      where the LOGIN lives — agent auth is free precisely because we piggyback on it.
 *
 * MEASURED: a compiled binary run from a directory with no node_modules drove SDK JS
 * 0.3.226 against a PATH CLI at 2.1.235 successfully, so the version skew this admits is
 * tolerated in practice. It is still skew — which is why `probe()` reports the binary and
 * its version, and why `loop doctor` prints both.
 */
async function resolveCli() {
  if (cliCache) return cliCache;
  const bundled = sdkBinaryPath();
  if (bundled) return (cliCache = { path: bundled, source: "sdk-bundled" });
  const onPath = await claudeOnPath();
  if (onPath) return (cliCache = { path: onPath, source: "path" });
  return (cliCache = { path: null, source: "none" });
}

// Anthropic content blocks -> normalized Block[]. AskUserQuestion tool_use (and the
// tool_result that answers it) are SUPPRESSED: the live question is surfaced as a
// `decision` event, and an answered one is synthesized into history on reply. That
// way the UI is deterministic regardless of when the SDK happens to emit them.
//
// `keepAsk` INVERTS that, and only importing sets it (PROBLEM 20). A conversation that
// happened in someone else's client was never routed through our `decision` path, so there
// is nothing to synthesize — its AskUserQuestion pair is already complete in the
// transcript, and suppressing it would delete the single most important thing on the
// screen. Measured against a real pair: the vendor's `input` is `{questions:[{question,
// header, multiSelect, options:[{label,description}]}]}`, i.e. byte-identical to what
// session.mjs synthesizes, and its answering `tool_result` is a prose sentence that
// CONTAINS the chosen label — which is exactly what both renderers substring-match on
// (`turn-view.tsx`'s `answerText.includes(opt.label)`, and blocks.mjs's `answered:` line).
// So the raw pair renders correctly with no conversion at all.
//
// EXPORTED for import-test.mjs. The `keepAsk: false` default is load-bearing in a way no
// build or type check would notice: flipping it would make every LIVE question render twice
// — once as the surfaced decision and once as raw history — and only a real-agent run would
// show that. A free assertion on both branches is worth the widened surface.
export function extractBlocks(content, askIds, { keepAsk = false } = {}) {
  const blocks = [];
  if (typeof content === "string") {
    if (content.trim()) blocks.push({ kind: "text", text: content });
    return blocks;
  }
  if (!Array.isArray(content)) return blocks;
  for (const b of content) {
    if (typeof b === "string") {
      if (b.trim()) blocks.push({ kind: "text", text: b });
      continue;
    }
    switch (b?.type) {
      case "text":
        if (b.text?.trim()) blocks.push({ kind: "text", text: b.text });
        break;
      case "thinking":
        if (b.thinking?.trim()) blocks.push({ kind: "thinking", text: b.thinking });
        break;
      case "tool_use":
        if (b.name === "AskUserQuestion" && !keepAsk) {
          if (b.id) askIds.add(b.id);
          break;
        }
        blocks.push({ kind: "tool_use", id: b.id, name: b.name, input: b.input ?? {} });
        break;
      case "tool_result": {
        if (!keepAsk && b.tool_use_id && askIds.has(b.tool_use_id)) break;
        let text = "";
        if (typeof b.content === "string") text = b.content;
        else if (Array.isArray(b.content))
          text = b.content.map((c) => (typeof c === "string" ? c : c?.text ?? "")).join("");
        blocks.push({ kind: "tool_result", tool_use_id: b.tool_use_id, is_error: !!b.is_error, text });
        break;
      }
      default:
        break;
    }
  }
  return blocks;
}

/** Claude's AskUserQuestion question -> the neutral Decision shape. */
function toDecision(raw) {
  if (!raw) return null;
  return {
    header: raw.header,
    question: raw.question,
    multiSelect: !!raw.multiSelect,
    options: (raw.options ?? []).map((o) => ({ label: o.label, description: o.description })),
  };
}

// The seam paginates by OPAQUE CURSOR because that is the shape both engines can honour
// (engine.mjs's listConversations). Claude's store is offset-addressed, so this adapter's
// cursor is just an offset in a wrapper — the wrapper is the point: nothing above this file
// may do arithmetic on it, or Codex's genuinely opaque cursor would break the caller.
const offsetToCursor = (n) => `cc:${n}`;
const cursorToOffset = (c) => {
  if (typeof c !== "string") return 0;
  const n = Number.parseInt(c.startsWith("cc:") ? c.slice(3) : "", 10);
  // A malformed cursor restarts at the top rather than becoming NaN, which listSessions
  // would silently treat as "skip nothing" on one engine and throw on another.
  return Number.isInteger(n) && n >= 0 ? n : 0;
};

export class ClaudeCodeEngine {
  static id = "claude-code";
  static label = "Claude Code";

  /**
   * The SDK piggybacks on the logged-in `claude` CLI's CREDENTIALS, so "available"
   * means a runnable binary exists — no API key needed (and none should be
   * introduced: agent auth being free is a property worth keeping).
   *
   * Measures the binary `resolveCli()` picked, i.e. the one a run will actually spawn.
   * `binary` and `source` are reported so `loop doctor` can say WHICH claude it just
   * measured — reporting a version without saying whose it was is what made this
   * misleading before.
   */
  static async probe() {
    const cli = await resolveCli();
    if (!cli.path)
      return {
        available: false,
        source: "none",
        reason: "no `claude` CLI found (not bundled with the SDK here, and none on PATH) — install Claude Code and log in",
      };
    try {
      const { stdout } = await run(cli.path, ["--version"], { timeout: 5000 });
      return { available: true, version: stdout.trim(), binary: cli.path, source: cli.source };
    } catch (err) {
      // SAY WHICH FAILURE THIS IS. Only ENOENT means "not installed"; everything else
      // (the CLI auto-updating and swapping its binary out from under us, a hung
      // `--version`, a non-zero exit) is TRANSIENT and the answer is "run it again" —
      // but a blanket "not found on PATH" sends you off installing something that is
      // already there, first on your PATH. Cost real time on 2026-08-15.
      if (err?.code === "ENOENT")
        return {
          available: false,
          binary: cli.path,
          source: cli.source,
          reason: `\`claude\` was resolved to ${cli.path} but nothing is there — reinstall Claude Code`,
        };
      const detail = String(err?.stderr || err?.message || err).trim().split("\n")[0];
      return {
        available: false,
        transient: true,
        binary: cli.path,
        source: cli.source,
        reason: `\`${cli.path} --version\` failed (${detail}) — if Claude Code is mid-update, try again`,
      };
    }
  }

  // ---- the conversation store (PROBLEM 20) --------------------------------
  // Claude Code keeps every conversation as JSONL under `~/.claude/projects/<escaped-cwd>/
  // <id>.jsonl`, and the SDK exposes a read API over it. We use that API rather than
  // parsing the files: `getSessionMessages` resolves the `parentUuid` CHAIN, and a
  // transcript file is a TREE, not a list — one measured here had 2140 entries whose
  // active chain was 6 messages, the rest being abandoned branches and compaction
  // history. Hand-parsing would have shown all 2140 in some arbitrary order.

  /**
   * Claude conversations on this machine, newest first.
   *
   * `includeProgrammatic: false` is what keeps OUR OWN runs out of the list. The daemon's
   * sessions are recorded here too (entrypoint `sdk-ts`), and on this machine that was 66
   * of 179 — a picker that offers to import the thing you are already looking at.
   */
  static async listConversations({ dir = null, cursor = null, limit = 50 } = {}) {
    const offset = cursorToOffset(cursor);
    // Ask for one MORE than we need: that extra row is how we know whether a next page
    // exists without a second count query.
    const rows = await listSessions({
      ...(dir ? { dir } : {}),
      limit: limit + 1,
      offset,
      includeProgrammatic: false,
    });
    const more = rows.length > limit;
    return {
      conversations: (more ? rows.slice(0, limit) : rows).map((s) => ({
        ref: s.sessionId,
        // `summary` is Claude's own display title (a /rename, an auto-title, or the first
        // prompt). Prefer an explicit rename over a generated one.
        title: (s.customTitle || s.summary || s.firstPrompt || "(untitled)").trim(),
        cwd: s.cwd ?? null,
        // MILLISECONDS here. Codex reports seconds — see ForeignConversation's typedef.
        lastTs: new Date(s.lastModified ?? 0).toISOString(),
        gitBranch: s.gitBranch ?? null,
        preview: (s.firstPrompt ?? "").slice(0, 200),
      })),
      nextCursor: more ? offsetToCursor(offset + limit) : null,
    };
  }

  /**
   * Claude's own name for a conversation: a /rename, else its generated title.
   *
   * `customTitle`, NOT `summary`. In the SDK (0.3.226, read from sdk.mjs) `customTitle` is
   * the rename falling back to the `ai-title` entry, while `summary` falls back further to
   * the LAST PROMPT — so `summary` would name a fresh session after whatever was typed
   * into it most recently. `null` until the title lands, and the caller shows the project.
   * Headless runs DO get titled: a daemon session on the box carried
   * `{"type":"ai-title","aiTitle":"Repository context"}` (2026-10-15).
   */
  static async conversationTitle(ref) {
    return (await getSessionInfo(ref))?.customTitle ?? null;
  }

  /**
   * One Claude conversation as normalized Turn[].
   *
   * WE READ THE WHOLE CHAIN AND KEEP THE TAIL, rather than passing `limit` through. The
   * SDK's `limit` counts from the START of the conversation, so passing it would return
   * the OLDEST n messages — the opposite of what anyone opening a transcript wants.
   *
   * Truncation is DISPLAY-ONLY and that distinction matters: the agent's memory is the
   * vendor file, which `resume` hands it in full. So a truncated import shows less than
   * the agent knows, never the reverse — which is the safe direction.
   */
  static async readConversation(ref, { limit = 400 } = {}) {
    const [all, info] = await Promise.all([
      getSessionMessages(ref),
      getSessionInfo(ref).catch(() => undefined), // metadata is nice-to-have; cwd is the point
    ]);

    const askIds = new Set();
    const turns = [];
    for (const m of all) {
      // `system` messages are compaction boundaries and notices; we never ask for them,
      // but a future SDK default flip shouldn't start injecting them into a transcript.
      if (m.type !== "user" && m.type !== "assistant") continue;
      const blocks = extractBlocks(m.message?.content, askIds, { keepAsk: true });
      if (!blocks.length) continue; // e.g. a message whose only block was an empty string
      turns.push({
        role: m.type,
        blocks,
        // `timestamp` is NOT in the SDK's SessionMessage typedef but IS present at runtime,
        // as an ISO string (verified 2026-08-26 — a doc is not a protocol). Falling back to
        // the file mtime keeps a turn from carrying `Invalid Date` if that ever changes.
        ts: m.timestamp ?? new Date(info?.lastModified ?? Date.now()).toISOString(),
      });
    }

    const kept = turns.length > limit ? turns.slice(-limit) : turns;
    return {
      ref,
      cwd: info?.cwd ?? null,
      turns: kept,
      total: turns.length,
      truncated: kept.length < turns.length,
    };
  }

  constructor({ cwd, maxTurns = 200, resume = null, model = null, streamDeltas = true } = {}) {
    this.cwd = cwd || process.cwd();
    this.maxTurns = maxTurns;
    this.resume = resume;
    this.model = model;
    this.streamDeltas = streamDeltas;
    this.sessionRef = null;
    // The Query handle, kept ONLY so interrupt() has something to talk to. The SDK's
    // control requests hang off this object, not off the module-level query() function.
    this._query = null;

    this._q = new EventQueue();
    this._askIds = new Set();
    this._input = this._makeInput();
    this._answerResolver = null; // resolves canUseTool -> unblocks the agent
    this._answerQuestions = null; // the raw questions awaiting an answer
    this._started = false;
  }

  // Streaming input: keep stdin open for the whole session so a reply can be
  // injected as the next user message instead of starting a new run. This is what
  // makes one Session a durable conversation rather than a series of one-shots.
  _makeInput() {
    const queue = [];
    let resolveNext = null;
    let closed = false;
    const push = (text) => {
      const msg = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
      if (resolveNext) { resolveNext({ value: msg, done: false }); resolveNext = null; }
      else queue.push(msg);
    };
    const close = () => {
      closed = true;
      if (resolveNext) { resolveNext({ value: undefined, done: true }); resolveNext = null; }
    };
    const iterable = {
      [Symbol.asyncIterator]() {
        return {
          next() {
            if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
            if (closed) return Promise.resolve({ value: undefined, done: true });
            return new Promise((res) => { resolveNext = res; });
          },
        };
      },
    };
    return { iterable, push, close };
  }

  // canUseTool fires for BOTH tool-permission asks AND AskUserQuestion, and it
  // PAUSES THE RUN until it returns. Non-question tools are auto-allowed (the
  // bypass-like feel); AskUserQuestion is parked as a decision.
  _canUseTool = async (toolName, input) => {
    if (toolName === "AskUserQuestion") {
      this._answerQuestions = input.questions ?? [];
      this._q.push({ type: "decision", question: toDecision(this._answerQuestions[0]) });
      const outcome = await new Promise((resolve) => { this._answerResolver = resolve; });
      // DECLINED (PROBLEM 23): deny the tool AND end the turn. `interrupt: true` is the
      // half that matters — a bare deny lets Claude carry on with an assumption, which is
      // the opposite of "wrong question, wait for me". The message is what Claude reads.
      if (outcome.decline)
        return { behavior: "deny", message: DECLINE_MESSAGE, interrupt: true };
      return { behavior: "allow", updatedInput: { questions: input.questions, answers: outcome.answers } };
    }
    return { behavior: "allow", updatedInput: input };
  };

  start(prompt) {
    if (this._started) return;
    this._started = true;
    if (prompt) this._input.push(prompt);
    this._pump().catch((e) => {
      this._q.push({ type: "error", error: String(e?.message ?? e) });
      this._q.end();
    });
  }

  async _pump() {
    const options = {
      canUseTool: this._canUseTool,
      // Token-level output. Off, this waits for a whole turn before anything appears,
      // which on a long answer looks indistinguishable from a hang.
      includePartialMessages: this.streamDeltas,
      maxTurns: this.maxTurns,
      cwd: this.cwd,
    };
    if (this.model) options.model = this.model;
    if (this.resume) options.resume = this.resume;

    // POINT THE SDK AT THE CLI WE RESOLVED, always — not only when we must. Letting the
    // SDK resolve it itself works from source and fails inside a compiled binary, and a
    // difference that only shows up in the shipped artifact is the worst kind. Passing it
    // explicitly means dev and release take the same code path (PROBLEM 18).
    const cli = await resolveCli();
    if (cli.path) options.pathToClaudeCodeExecutable = cli.path;

    this._query = query({ prompt: this._input.iterable, options });
    for await (const msg of this._query) {
      // Partial output. `event` is a raw Anthropic stream event, so this is the one
      // place that knows that shape — deltas leave here already normalized.
      if (msg.type === "stream_event") {
        const ev = msg.event;
        if (ev?.type === "content_block_delta") {
          const d = ev.delta;
          if (d?.type === "text_delta" && d.text)
            this._q.push({ type: "delta", kind: "text", text: d.text });
          else if (d?.type === "thinking_delta" && d.thinking)
            this._q.push({ type: "delta", kind: "thinking", text: d.thinking });
        }
        continue;
      }
      if (msg.type === "system" && msg.subtype === "init") {
        this.sessionRef = msg.session_id;
        this._q.push({ type: "ready", sessionRef: this.sessionRef });
        continue;
      }
      if (msg.type === "assistant" || msg.type === "user") {
        const content = msg.message?.content;
        // Drop our own injected text echoed back as a user message: real user
        // messages in the stream are tool_results (arrays of blocks), never a
        // plain string or text-only turn — those are ours, already in history.
        if (msg.type === "user") {
          const isEcho =
            typeof content === "string" ||
            (Array.isArray(content) && content.every((b) => b?.type === "text" || typeof b === "string"));
          if (isEcho) continue;
        }
        const blocks = extractBlocks(content, this._askIds);
        if (blocks.length)
          this._q.push({ type: "turn", role: msg.type, blocks, ts: new Date().toISOString() });
      }
      // `result` = turn boundary: the agent stopped but the session is alive (it
      // only truly ends on close()). PATH B detection hangs off this.
      if (msg.type === "result") this._q.push({ type: "idle" });
    }
    this._q.push({ type: "done" });
    this._q.end();
  }

  events() {
    return this._q;
  }

  /**
   * A parked AskUserQuestion is answered by resolving the canUseTool promise —
   * that resolution is literally what un-pauses Claude. Otherwise the text becomes
   * the next user message.
   */
  reply({ text, choices = null, decline = false }) {
    if (this._answerResolver && decline) {
      const questions = this._answerQuestions ?? [];
      const resolve = this._answerResolver;
      this._answerResolver = null;
      this._answerQuestions = null;
      resolve({ decline: true });
      return { mode: "declined", questions };
    }
    if (this._answerResolver) {
      const questions = this._answerQuestions ?? [];
      const q = questions[0];
      const answers = {};
      // multiSelect answers join with ", " — the shape the SDK expects back.
      const chosen = choices?.length ? choices.join(", ") : text;
      if (q) answers[q.question] = chosen;

      const resolve = this._answerResolver;
      this._answerResolver = null;
      this._answerQuestions = null;
      resolve({ answers });
      return { mode: "structured", questions, chosen };
    }
    this._input.push(text);
    return { mode: "text" };
  }

  /**
   * Stop the turn in flight. The SDK routes this as a control request to the CLI, so it
   * is a request the agent acknowledges rather than a signal — the process stays up and
   * the session stays usable, which is the difference between this and close().
   *
   * Only valid in streaming-input mode, which is the only mode we run.
   */
  async interrupt() {
    if (!this._query) return { ok: false, reason: "run not started" };
    try {
      const receipt = await this._query.interrupt();
      return { ok: true, receipt: receipt ?? null };
    } catch (e) {
      // A refusal here is normal, not exceptional: interrupting between turns has
      // nothing to interrupt. Report it instead of throwing into the event stream.
      return { ok: false, reason: String(e?.message ?? e) };
    }
  }

  /** True while a structured decision is parked — Session needs this to route a reply. */
  get awaitingDecision() {
    return this._answerResolver !== null;
  }

  /** The raw questions currently parked (for synthesizing answered history). */
  get parkedQuestions() {
    return this._answerQuestions;
  }

  close() {
    this._input.close();
  }
}
