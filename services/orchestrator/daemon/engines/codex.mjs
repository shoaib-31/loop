// Codex engine — the SECOND implementation of the seam, and the proof that the
// notification-decision loop is not Claude-specific (docs/architecture.md).
//
// Everything Codex-specific lives in this file and nowhere else: `codex app-server`,
// JSON-RPC framing, thread/turn ids, and Codex's item shapes. The daemon, the PWA and the
// TUI learn nothing new — they still see only `ready·turn·delta·decision·idle·error·done`.
//
// WRITTEN AGAINST THE REAL CLI (codex-cli 0.147.0), not against docs. PROBLEM 13 mapped
// this protocol from documentation while the CLI wasn't installed; probing the actual
// binary corrected it in three places, each of which would have been a silent failure:
//
//   1. The decision method is `item/tool/requestUserInput`, NOT `tool/requestUserInput`.
//   2. `isOther` is a property of the QUESTION (meaning "free text is allowed"), not of an
//      option, and the answer is keyed by question **id** with an ARRAY of strings:
//      `{answers: {<id>: {answers: ["Mango"]}}}`.
//   3. THE TOOL IS REFUSED IN DEFAULT MODE. `codex_core::tools::router` logs
//      "request_user_input is unavailable in Default mode" and the model falls back to
//      asking in prose. Getting the structured channel needs BOTH the `experimentalApi`
//      capability at `initialize` AND `collaborationMode: {mode:"plan", settings:{…}}` on
//      the turn. Measured end to end: the request arrived with `isBlocking: true`, we
//      answered `{fruit: {answers:["Mango"]}}`, and Codex replied "You picked Mango." —
//      the same sentence the Claude proof produced in PROBLEM 8c.
//
// WHICH IS WHY THE DEFAULT MODE HERE IS "default", NOT "plan". Plan mode is Codex's
// planning mode; forcing it on every run to unlock a nicer question widget would trade
// away the agent's ability to do the work. In default mode a question still reaches the
// phone — as PATH B, the prose question, which is exactly the path that exists because we
// refuse to reshape an agent's behaviour to suit us. `mode: "plan"` is opt-in.

import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { EventQueue } from "./engine.mjs";

const run = promisify(execFile);

/** Codex question -> the neutral Decision shape the app already renders. */
function toDecision(raw) {
  if (!raw) return null;
  return {
    header: raw.header,
    question: raw.question,
    // Codex has no multi-select flag; its answer field is an array, so multiple values are
    // *representable*, but nothing declares a question to be multi-select. Claim false
    // rather than guess — a wrong `true` turns one tap into a two-step form.
    multiSelect: false,
    options: (raw.options ?? []).map((o) => ({ label: o.label, description: o.description })),
    // `isOther` means "free text is acceptable here", which is our free_form.
    free_form: !!raw.isOther,
  };
}

/** Codex ThreadItem -> normalized Block[]. Unknown item types are dropped, not guessed. */
function itemToBlocks(item) {
  switch (item?.type) {
    case "agentMessage":
      return item.text?.trim() ? [{ kind: "text", text: item.text }] : [];
    case "plan":
      return item.text?.trim() ? [{ kind: "text", text: item.text }] : [];
    case "reasoning": {
      // `summary` is the readable form; `content` is the raw chain when exposed at all.
      const text = [...(item.summary ?? []), ...(item.content ?? [])].filter(Boolean).join("\n");
      return text.trim() ? [{ kind: "thinking", text }] : [];
    }
    case "commandExecution": {
      const cmd = item.command ?? item.parsedCommand?.map?.((p) => p.text).join(" ") ?? "";
      const blocks = [{ kind: "tool_use", id: item.id, name: "Bash", input: { command: cmd } }];
      // Output may be absent while running; a completed item usually carries it.
      const out = item.aggregatedOutput ?? item.output ?? "";
      if (out || item.exitCode !== undefined && item.exitCode !== null)
        blocks.push({
          kind: "tool_result",
          tool_use_id: item.id,
          is_error: !!item.exitCode,
          text: String(out ?? ""),
        });
      return blocks;
    }
    case "fileChange": {
      const paths = (item.changes ?? []).map((c) => c.path ?? c).filter(Boolean);
      return [{ kind: "tool_use", id: item.id, name: "Edit", input: { paths } }];
    }
    case "webSearch":
      return [{ kind: "tool_use", id: item.id, name: "WebSearch", input: { query: item.query ?? "" } }];
    case "toolCall":
    case "mcpToolCall":
      return [{ kind: "tool_use", id: item.id, name: item.name ?? "tool", input: item.arguments ?? {} }];
    // `userMessage` is our OWN input echoed back — already in history upstream.
    case "userMessage":
    default:
      return [];
  }
}

/**
 * Codex reports every timestamp in epoch SECONDS. Claude Code reports MILLISECONDS. The
 * seam's ForeignConversation.lastTs is an ISO string precisely so that difference dies here
 * instead of becoming a sort order that is wrong by a factor of 1000 on one engine.
 */
function secondsToIso(secs, fallbackSecs = null) {
  for (const v of [secs, fallbackSecs]) {
    if (typeof v === "number" && Number.isFinite(v) && v > 0) return new Date(v * 1000).toISOString();
  }
  return new Date().toISOString();
}

/** A Codex userMessage item's `content: UserInput[]` -> one readable string. */
function userInputText(item) {
  const parts = [];
  for (const c of item?.content ?? []) {
    switch (c?.type) {
      case "text": parts.push(c.text ?? ""); break;
      // A message whose only content is an attachment must not render as an EMPTY turn —
      // that reads as data loss. A short marker is honest about what was there.
      case "mention": parts.push(`@${c.name ?? "file"}`); break;
      case "skill": parts.push(`/${c.name ?? "skill"}`); break;
      case "image": case "localImage": parts.push("[image]"); break;
      case "audio": case "localAudio": parts.push("[audio]"); break;
      default: break;
    }
  }
  return parts.join(" ").trim();
}

/**
 * A Codex `Thread` (as returned by `thread/read`) -> our normalized Turn[].
 *
 * ONE CODEX TURN CAN BE TWO OF OURS. A Codex `Turn` bundles the human's message and the
 * agent's work into a single object with an `items[]` list, whereas our transcript
 * alternates user and assistant turns — so a `userMessage` item FLUSHES the assistant
 * blocks accumulated so far and emits a user turn of its own. Without that, an imported
 * conversation renders as one enormous assistant turn with the human's words buried in it.
 *
 * Note the inversion, exactly parallel to `keepAsk` in claude-code.mjs: `itemToBlocks`
 * DROPS `userMessage`, because in a live run the daemon already has the human's text from
 * upstream. On import there is no upstream — that item IS the history — so this function
 * handles it explicitly rather than asking itemToBlocks to behave differently.
 *
 * EXPORTED because it is the only way to test this for free. Codex's store is reachable
 * only over JSON-RPC — there is no fixture-directory trick like Claude's
 * `CLAUDE_CONFIG_DIR` — so the free test drives this directly from a recorded Thread.
 */
export function threadToTurns(thread) {
  const turns = [];
  for (const t of thread?.turns ?? []) {
    const ts = secondsToIso(t.startedAt ?? t.completedAt, thread?.updatedAt);
    let acc = [];
    const flush = () => {
      if (acc.length) turns.push({ role: "assistant", blocks: acc, ts });
      acc = [];
    };
    for (const item of t.items ?? []) {
      if (item?.type === "userMessage") {
        flush();
        const text = userInputText(item);
        if (text) turns.push({ role: "user", blocks: [{ kind: "text", text }], ts });
        continue;
      }
      acc.push(...itemToBlocks(item));
    }
    flush();
  }
  return turns;
}

/**
 * A SHORT-LIVED `codex app-server`, for the two static read verbs (PROBLEM 20).
 *
 * Listing and reading answer BEFORE any run exists, but Codex's conversation store is only
 * reachable over the same JSON-RPC channel a run uses — there is no `codex list --json`.
 * So these spawn their own server, ask, and kill it.
 *
 * Deliberately NOT the instance's channel. A read must neither depend on a live
 * conversation nor be able to disturb one, and a static has no instance to borrow from
 * anyway. The cost is a process per read, which is why the results are paginated rather
 * than streamed.
 */
async function withAppServer(fn, { timeoutMs = 20_000 } = {}) {
  const child = spawn("codex", ["app-server"], { stdio: ["pipe", "pipe", "pipe"] });
  const pending = new Map();
  let buf = "", nextId = 1, settled = false;

  const failAll = (err) => {
    settled = true;
    for (const p of pending.values()) p.reject(err);
    pending.clear();
  };

  child.stdout.on("data", (chunk) => {
    buf += chunk.toString();
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      let msg;
      try { msg = JSON.parse(line); } catch { continue; } // log noise, not protocol
      // We drive nothing here, so server->client requests and notifications are ignored;
      // only responses to our own requests matter.
      if (msg.id === undefined || msg.method !== undefined) continue;
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error?.message ?? JSON.stringify(msg.error)));
      else p?.resolve(msg.result);
    }
  });
  child.stderr.on("data", () => {}); // Rust tracing, not protocol
  child.on("error", (e) => failAll(new Error(`codex app-server: ${e.message}`)));
  child.on("exit", (code, signal) => {
    if (!settled)
      failAll(new Error(`codex app-server exited (code ${code}${signal ? ` signal ${signal}` : ""})`));
  });

  const request = (method, params) => {
    if (!child.stdin.writable) return Promise.reject(new Error("codex app-server is not writable"));
    const id = nextId++;
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    return new Promise((resolve, reject) => pending.set(id, { resolve, reject }));
  };

  // A hung app-server must not hang the daemon's HTTP handler. unref'd so the timer itself
  // can never be the thing keeping a process alive (the same rule as the idle timer).
  const timer = setTimeout(() => failAll(new Error("codex app-server timed out")), timeoutMs);
  timer.unref?.();

  try {
    await request("initialize", {
      clientInfo: { name: "loop-eng", title: "Loop", version: "0.0.1" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method: "initialized", params: {} }) + "\n");
    return await fn(request);
  } finally {
    clearTimeout(timer);
    settled = true; // the exit below is ours, not a failure
    child.kill();
  }
}

export class CodexEngine {
  static id = "codex";
  static label = "Codex";

  static async probe() {
    try {
      const { stdout } = await run("codex", ["--version"], { timeout: 5000 });
      return { available: true, version: stdout.trim(), binary: "codex", source: "path" };
    } catch (err) {
      if (err?.code === "ENOENT")
        return { available: false, reason: "`codex` CLI not found on PATH — install Codex and `codex login`" };
      const detail = String(err?.stderr || err?.message || err).trim().split("\n")[0];
      return { available: false, transient: true, reason: `\`codex --version\` failed (${detail}) — try again` };
    }
  }

  // ---- the conversation store (PROBLEM 20) --------------------------------
  // Codex's four store methods mirror Claude's read API one for one — `thread/list`,
  // `thread/read`, `thread/resume`, `thread/fork` — which is what turned "the seam is
  // pluggable" from a claim into a second data point for importing, not just for running.
  // Mapped from `codex app-server generate-ts`, not from prose.

  /**
   * Codex threads on this machine, newest first.
   *
   * `sourceKinds` is the Codex equivalent of Claude's `includeProgrammatic: false` — it is
   * what keeps OUR OWN threads out of the list, since the daemon's runs are recorded with
   * source `appServer`. Subagent threads and ephemeral ones are dropped too: neither is a
   * conversation a human had.
   */
  static async listConversations({ dir = null, cursor = null, limit = 50 } = {}) {
    return withAppServer(async (request) => {
      const res = await request("thread/list", {
        // Codex's cursor is GENUINELY opaque — it encodes a sort anchor, not an index. It
        // is passed straight back, which is the reason the seam's contract is a cursor and
        // not an offset (see engine.mjs).
        cursor: cursor ?? null,
        limit,
        sourceKinds: ["cli", "vscode"],
      });
      let rows = (res?.data ?? []).filter((t) => t && !t.ephemeral && !t.parentThreadId);
      // `thread/list` has no dir filter, so scoping is ours to do. Done AFTER the request,
      // which means a scoped page can come back short — acceptable, and the cursor still
      // walks the whole store.
      if (dir) rows = rows.filter((t) => t.cwd === dir);
      return {
        conversations: rows.map((t) => ({
          ref: t.id,
          // `name` is a user-set thread name; `preview` is usually the first user message.
          title: (t.name || t.preview || "(untitled)").trim().slice(0, 200),
          cwd: t.cwd ?? null,
          lastTs: secondsToIso(t.recencyAt ?? t.updatedAt, t.createdAt),
          // Codex does not record a git branch on the thread.
          gitBranch: null,
          preview: (t.preview ?? "").slice(0, 200),
        })),
        nextCursor: res?.nextCursor ?? null,
      };
    });
  }

  /** One Codex thread as normalized Turn[]. The mapping lives in `threadToTurns` above. */
  static async readConversation(ref, { limit = 400 } = {}) {
    return withAppServer(async (request) => {
      const res = await request("thread/read", { threadId: ref, includeTurns: true });
      const thread = res?.thread ?? {};
      const turns = threadToTurns(thread);
      // Tail, not head: the recent end of a conversation is what a reader wants. Truncation
      // is display-only — `thread/resume` gives the agent the whole thread regardless.
      const kept = turns.length > limit ? turns.slice(-limit) : turns;
      return {
        ref,
        cwd: thread.cwd ?? null,
        turns: kept,
        total: turns.length,
        truncated: kept.length < turns.length,
      };
    });
  }

  /**
   * @param {object} o
   * @param {"default"|"plan"} [o.mode] `plan` unlocks the structured question channel;
   *   `default` (the default) keeps Codex able to do work and relies on PATH B.
   */
  constructor({ cwd, maxTurns = 200, resume = null, model = null, mode = process.env.LOOP_CODEX_MODE ?? "default", sandbox = "workspace-write" } = {}) {
    this.cwd = cwd || process.cwd();
    this.maxTurns = maxTurns; // Codex has no turn cap of its own; kept for the seam.
    this.resume = resume;
    this.model = model;
    this.mode = mode;
    this.sandbox = sandbox;
    this.sessionRef = null; // threadId

    this._q = new EventQueue();
    this._child = null;
    this._nextId = 1;
    this._pending = new Map(); // our request id -> {resolve, reject}
    this._buf = "";
    this._started = false;
    this._closed = false;

    this._threadId = null;
    this._turnId = null; // the ACTIVE turn, needed by steer and interrupt
    this._lastError = null; // the latest retry-loop error, reported only if the turn fails
    this._turnActive = false;
    this._planMode = null; // a full CollaborationMode object, when mode === "plan"

    // A parked decision: the JSON-RPC request we owe a response to.
    this._decisionRequestId = null;
    this._decisionQuestions = null;
  }

  // ---- JSON-RPC over stdio (newline-delimited, measured) -------------------

  _write(obj) {
    if (!this._child?.stdin?.writable) return;
    this._child.stdin.write(JSON.stringify(obj) + "\n");
  }

  _request(method, params) {
    const id = this._nextId++;
    this._write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => this._pending.set(id, { resolve, reject }));
  }

  _notify(method, params) {
    this._write({ jsonrpc: "2.0", method, params });
  }

  _respond(id, result) {
    this._write({ jsonrpc: "2.0", id, result });
  }

  _onLine(line) {
    let msg;
    try { msg = JSON.parse(line); } catch { return; } // a non-JSON line is log noise

    // A response to one of our requests.
    if (msg.id !== undefined && msg.method === undefined) {
      const p = this._pending.get(msg.id);
      this._pending.delete(msg.id);
      if (msg.error) p?.reject(new Error(msg.error?.message ?? JSON.stringify(msg.error)));
      else p?.resolve(msg.result);
      return;
    }

    // A SERVER -> CLIENT REQUEST. This is the channel that can pause the run, and it is
    // the structural equivalent of Claude's `canUseTool`: Codex waits for our response.
    if (msg.id !== undefined && msg.method) return this._onServerRequest(msg);

    return this._onNotification(msg);
  }

  _onServerRequest(msg) {
    const { id, method, params } = msg;

    if (method === "item/tool/requestUserInput") {
      const questions = params?.questions ?? [];
      this._decisionRequestId = id;
      this._decisionQuestions = questions;
      // Surface the FIRST question, exactly as the Claude engine does — one card, one
      // decision. The others are answered alongside it on reply (see `reply`).
      this._q.push({ type: "decision", question: toDecision(questions[0]) });
      return; // NOT responding is what holds the run open. That's the whole mechanism.
    }

    // Approvals: auto-allow, matching the daemon's existing posture (it auto-allows every
    // tool and runs in its launch cwd — AGENTS.md says start it somewhere safe). The two
    // generations of approval request want DIFFERENT response shapes; sending the wrong
    // one leaves the agent blocked forever with nothing on screen.
    if (method === "item/commandExecution/requestApproval" ||
        method === "item/fileChange/requestApproval" ||
        method === "item/permissions/requestApproval") {
      return this._respond(id, { decision: "accept" });
    }
    if (method === "execCommandApproval" || method === "applyPatchApproval") {
      return this._respond(id, { decision: "approved" });
    }

    // Politeness: cheap requests we can just answer.
    if (method === "currentTime/read") return this._respond(id, { currentTime: new Date().toISOString() });

    // Anything else: answer with an empty object rather than ignoring it. An unanswered
    // server request is a hung agent, and a hang is far worse to debug than a rejection.
    return this._respond(id, {});
  }

  _onNotification(msg) {
    const { method, params } = msg;
    switch (method) {
      case "turn/started":
        this._turnId = params?.turn?.id ?? this._turnId;
        this._turnActive = true;
        break;

      case "item/agentMessage/delta":
        if (params?.delta) this._q.push({ type: "delta", kind: "text", text: params.delta });
        break;

      case "item/completed": {
        const blocks = itemToBlocks(params?.item);
        if (blocks.length)
          this._q.push({ type: "turn", role: "assistant", blocks, ts: new Date().toISOString() });
        break;
      }

      case "turn/completed": {
        // Turn boundary: the agent stopped, the thread is alive. PATH B hangs off this,
        // and so does hibernation's idle clock.
        this._turnActive = false;
        // A FAILED turn arrives HERE, as a status — not as a separate method. PROBED
        // (`codex app-server generate-ts`, 0.147.0): `turn/failed` and `thread/error`,
        // which this adapter used to listen for, do not exist. The cost of that was
        // silence: an expired login produced a turn that ended with no text and no error,
        // which on screen is indistinguishable from an agent that is stuck (PROBLEM 23).
        const turn = params?.turn;
        if (turn?.status === "failed")
          this._q.push({
            type: "error",
            error: turn.error?.message ?? this._lastError ?? "codex reported a failed turn",
          });
        this._lastError = null;
        this._q.push({ type: "idle" });
        break;
      }

      // `{error: {message}, willRetry}` — Codex's own retry loop narrating itself. Only
      // remembered: if it gives up, the failed `turn/completed` carries the verdict, and
      // reporting every retry as an error would flag a run that then succeeded.
      case "error":
        this._lastError = params?.error?.message ?? this._lastError;
        break;

      default:
        // Deliberately quiet. Codex emits a great deal (token usage, rate limits, MCP
        // startup, thread status) and normalizing noise into the transcript would make
        // every UI show things no human asked for.
        break;
    }
  }

  // ---- the seam -----------------------------------------------------------

  start(prompt) {
    if (this._started) return;
    this._started = true;
    this._boot(prompt).catch((e) => {
      this._q.push({ type: "error", error: String(e?.message ?? e) });
      this._q.end();
    });
  }

  async _boot(prompt) {
    this._child = spawn("codex", ["app-server"], {
      cwd: this.cwd,
      stdio: ["pipe", "pipe", "pipe"],
    });

    this._child.stdout.on("data", (chunk) => {
      this._buf += chunk.toString();
      let nl;
      while ((nl = this._buf.indexOf("\n")) >= 0) {
        const line = this._buf.slice(0, nl).trim();
        this._buf = this._buf.slice(nl + 1);
        if (line) this._onLine(line);
      }
    });
    // stderr is Rust tracing output, not protocol. Surfacing it as session errors would
    // turn ordinary INFO lines into red text on someone's phone.
    this._child.stderr.on("data", () => {});
    this._child.on("error", (e) => {
      this._q.push({ type: "error", error: `codex app-server: ${e.message}` });
      this._q.end();
    });
    this._child.on("exit", (code, signal) => {
      if (!this._closed && code !== 0)
        this._q.push({ type: "error", error: `codex app-server exited (code ${code}${signal ? ` signal ${signal}` : ""})` });
      this._q.push({ type: "done" });
      this._q.end();
    });

    // `experimentalApi` is REQUIRED for collaborationMode/list and the question tool;
    // without it those methods answer -32600 "requires experimentalApi capability".
    await this._request("initialize", {
      clientInfo: { name: "loop-eng", title: "Loop", version: "0.0.1" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    this._notify("initialized", {});

    // Resuming a thread vs. starting one. Both answer with the thread, so `ready` is
    // emitted the same way and Session's resume handle keeps working unchanged.
    const startParams = { cwd: this.cwd, sandbox: this.sandbox, approvalPolicy: "never" };
    if (this.model) startParams.model = this.model;
    const res = this.resume
      ? await this._request("thread/resume", { threadId: this.resume })
      : await this._request("thread/start", startParams);

    this._threadId = res?.thread?.id ?? res?.threadId ?? null;
    // The thread reports the model it actually resolved, and plan mode NEEDS a concrete
    // one (see _resolvePlanMode) — which is why this is read before the mode is built.
    this._threadModel = res?.model ?? null;
    this.sessionRef = this._threadId;
    this._q.push({ type: "ready", sessionRef: this.sessionRef });

    // AFTER thread/start, deliberately: `Settings.model` is a non-nullable string, and the
    // mode descriptor's own `model` is null, so the only real model name available is the
    // one the thread just resolved. Building the mode first sent `model: null` and
    // `turn/start` rejected the whole turn — which looked exactly like the model declining
    // to use the tool.
    if (this.mode === "plan") this._planMode = await this._resolvePlanMode();

    if (prompt) await this._startTurn(prompt);
  }

  /**
   * Build a full CollaborationMode. `collaborationMode/list` returns DESCRIPTORS
   * (`{name, mode, model, reasoning_effort}`) while `turn/start` wants
   * `{mode, settings:{model, reasoning_effort, developer_instructions}}` — passing the
   * descriptor straight through fails with "missing field `settings`".
   */
  async _resolvePlanMode() {
    try {
      const modes = await this._request("collaborationMode/list", {});
      const desc = (modes?.data ?? []).find((m) => m?.mode === "plan");
      const model = desc?.model ?? this.model ?? this._threadModel;
      if (!model) return null; // no concrete model -> the request would be rejected
      return {
        mode: "plan",
        settings: {
          model,
          reasoning_effort: desc?.reasoning_effort ?? null,
          developer_instructions: null,
        },
      };
    } catch {
      // Not fatal: without plan mode the structured question tool is refused and Codex
      // asks in prose instead, which PATH B already handles.
      return null;
    }
  }

  _turnInput(text) {
    return [{ type: "text", text, text_elements: [] }];
  }

  async _startTurn(text) {
    const params = { threadId: this._threadId, input: this._turnInput(text) };
    if (this._planMode) params.collaborationMode = this._planMode;
    const res = await this._request("turn/start", params);
    this._turnId = res?.turn?.id ?? this._turnId;
    this._turnActive = true;
  }

  events() {
    return this._q;
  }

  /**
   * Three destinations, decided here because this is the only layer that knows which
   * applies:
   *   a parked question -> respond to its JSON-RPC request (un-pausing the run);
   *   a turn in flight  -> `turn/steer` (which REQUIRES `expectedTurnId`);
   *   otherwise         -> a fresh `turn/start`.
   *
   * The third case is why this isn't just "steer": once `turn/completed` has arrived there
   * is no turn to steer, and steering would fail its precondition.
   */
  reply({ text, choices = null, decline = false }) {
    // DECLINED (PROBLEM 23). Codex's requestUserInput has NO refusal in its schema
    // (probed: `codex app-server generate-ts`, 0.147.0 — the response is only
    // `{answers: {[id]?: {answers: string[]}}}`). Every key is optional, so an EMPTY map
    // is the honest "no answer", and turn/interrupt is what stops it acting on nothing.
    // Respond FIRST: interrupting with the request unanswered leaves a dangling server
    // request, which is how an agent ends up hung with nothing on screen.
    if (this._decisionRequestId !== null && decline) {
      const id = this._decisionRequestId;
      const questions = this._decisionQuestions ?? [];
      this._decisionRequestId = null;
      this._decisionQuestions = null;
      this._respond(id, { answers: {} });
      this.interrupt().then((r) => {
        if (!r.ok) this._q.push({ type: "error", error: `decline could not stop the turn: ${r.reason}` });
      });
      return { mode: "declined", questions };
    }
    if (this._decisionRequestId !== null) {
      const id = this._decisionRequestId;
      const questions = this._decisionQuestions ?? [];
      this._decisionRequestId = null;
      this._decisionQuestions = null;

      // Answers are keyed by question ID and each is an ARRAY.
      const answers = {};
      const chosen = choices?.length ? choices : [text];
      questions.forEach((q, i) => {
        if (i === 0) answers[q.id] = { answers: chosen };
        // Codex may ask up to three at once while our card shows one. Answering only the
        // first risks a run parked on an incomplete response, so the rest take their first
        // option — visible in the transcript, and better than a hang.
        else answers[q.id] = { answers: [q.options?.[0]?.label ?? text] };
      });

      this._respond(id, { answers });
      return { mode: "structured", questions, chosen: chosen.join(", ") };
    }

    if (this._turnActive && this._turnId) {
      this._request("turn/steer", {
        threadId: this._threadId,
        input: this._turnInput(text),
        expectedTurnId: this._turnId,
      }).catch((e) => this._q.push({ type: "error", error: `steer failed: ${e.message}` }));
      return { mode: "text" };
    }

    this._startTurn(text).catch((e) =>
      this._q.push({ type: "error", error: `could not start a turn: ${e.message}` })
    );
    return { mode: "text" };
  }

  /** True while a structured decision is parked — Session needs this to route a reply. */
  get awaitingDecision() {
    return this._decisionRequestId !== null;
  }

  async interrupt() {
    if (!this._threadId || !this._turnId) return { ok: false, reason: "no turn in flight" };
    try {
      await this._request("turn/interrupt", { threadId: this._threadId, turnId: this._turnId });
      this._turnActive = false;
      return { ok: true };
    } catch (e) {
      return { ok: false, reason: String(e?.message ?? e) };
    }
  }

  close() {
    if (this._closed) return;
    this._closed = true;
    // A parked decision would otherwise leave Codex waiting on a response that is never
    // coming, and the child would sit there until killed.
    this._decisionRequestId = null;
    this._decisionQuestions = null;
    try { this._child?.stdin?.end(); } catch { /* already gone */ }
    try { this._child?.kill("SIGTERM"); } catch { /* already gone */ }
    this._q.push({ type: "done" });
    this._q.end();
  }
}
