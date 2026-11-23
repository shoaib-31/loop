// The ENGINE SEAM — the interface every agent backend implements.
//
// WHY THIS EXISTS (docs/architecture.md): the notification-decision loop is
// a feature, not a moat. The moat is neutral multi-agent orchestration — so Claude
// Code must be the FIRST engine behind a thin interface, never the hardwired one.
// Codex (`codex app-server`), and anything else with a request/approve channel, drop
// in here without the daemon, the protocol, the PWA or the TUI learning a new dialect.
//
// THE CONTRACT IS FIVE VERBS, and no more:
//   start(prompt)   begin (or continue) a run
//   events          async-iterate normalized EngineEvents
//   reply(...)      answer a surfaced decision, or send the next message
//   interrupt()     stop the turn in flight, keeping the session alive
//   close()         end the run
//
// `interrupt` was the fifth, added deliberately (docs/architecture.md). It earns a
// place in a contract this small because without it there is NO way to stop a running
// agent short of killing the daemon — which ends every other session too. Every backend
// worth adapting has the primitive (Claude Code: `Query.interrupt()`; Codex:
// `turn/interrupt`), and an engine that genuinely cannot stop should say so by returning
// `{ok:false}` rather than by pretending it did.
//
// PLUS THREE **STATIC, OPTIONAL** READ VERBS (docs/architecture.md + 21):
//   listConversations()     what conversations this backend already has on this machine
//   readConversation(ref)   one of them, as our normalized Turn[]
//   conversationTitle(ref)  the name the backend itself shows for it (PROBLEM 21)
//
// They are deliberately NOT instance verbs. The five above describe a
// RUN — they need a live process. These two describe the BACKEND's own store and answer
// before any process exists, which is why they are `static`: the daemon has to be able to
// list conversations — or name a HIBERNATED session — without starting an agent to ask.
//
// They are OPTIONAL for the same reason `interrupt` returns `{ok:false}` instead of
// throwing: an engine with no queryable history should SAY so, not make the seam pretend
// every backend keeps one. The base implementations below degrade with a `reason` a UI can
// print verbatim.
//
// Continuation needs NOTHING new. A conversation adopted from another client is a
// transcript plus a resume handle plus no process — which is exactly a restored snapshot
// (PROBLEM 16), so `Session.fromSnapshot()` already handles it and the existing `resume`
// constructor option already continues it. The one thing an engine MUST get right is that
// `readConversation` returns the SAME normalized shape a live run emits, because both feed
// the identical renderer and any drift shows up as history that looks wrong next to the
// turn appended after it.
//
// The load-bearing property every engine MUST preserve is that a decision BLOCKS the
// run until answered. That is the whole USP: if an engine auto-answers or races ahead,
// the phone buzzes about a question that has already been decided. Claude Code gets
// this from `canUseTool` (it awaits our promise); Codex gets it from a JSON-RPC
// server->client request that awaits our response. Both are pause-until-answered.
//
// WHAT AN ENGINE MUST NOT DO:
//   - Emit its own vendor message shapes. Normalize to EngineEvent here, at the edge,
//     so exactly one schema reaches the app (apps/web/src/lib/types.ts).
//   - Reshape the agent's behavior to fit us. "Preserve Claude's native feel" is a
//     decision, not a preference: detection adapts to the agent, never the reverse.
//     Concretely, an engine must NOT force a structured-question tool on the model —
//     PATH B (plain prose question) exists precisely because that would be coercion.
//   - Own transport, auth, push, or persistence. Those are daemon concerns.

/**
 * @typedef {{kind:"text",text:string}
 *   | {kind:"thinking",text:string}
 *   | {kind:"tool_use",id?:string,name?:string,input:unknown}
 *   | {kind:"tool_result",tool_use_id?:string,is_error:boolean,text:string}} Block
 *
 * One option on a surfaced decision.
 * @typedef {{label:string,description?:string}} DecisionOption
 *
 * A decision the agent is parked on. Shape is the app's PendingQuestion, unchanged —
 * Claude's AskUserQuestion and Codex's tool/requestUserInput both map onto it.
 * @typedef {{header?:string,question:string,multiSelect:boolean,
 *            options:DecisionOption[],free_form?:boolean}} Decision
 *
 * Normalized events. The daemon and both UIs understand ONLY these.
 *   ready    engine is up; `sessionRef` is the engine's own resume handle
 *   turn     a completed turn of normalized blocks — the CANONICAL transcript
 *   delta    in-flight text, for DISPLAY ONLY (see below)
 *   decision the human's move — the run is now PAUSED (question=null clears it)
 *   idle     turn boundary: agent stopped, session alive. PATH B needs this.
 *   error    engine-level failure
 *   done     the run is over
 *
 * `delta` is deliberately NOT part of the transcript. A partial is a thing to look at
 * while waiting; the `turn` that follows is the thing of record, and it arrives complete.
 * Keeping them separate means the transcript's shape, and every renderer built on it,
 * is unchanged by streaming — a client appends deltas to a scratch buffer and drops that
 * buffer when the real turn lands. Engines that cannot stream simply never emit one.
 *
 * @typedef {{type:"ready",sessionRef:string|null}
 *   | {type:"turn",role:"assistant"|"user",blocks:Block[],ts:string}
 *   | {type:"delta",kind:"text"|"thinking",text:string}
 *   | {type:"decision",question:Decision|null}
 *   | {type:"idle"}
 *   | {type:"error",error:string}
 *   | {type:"done"}} EngineEvent
 *
 * One completed turn — the unit both a live run and an imported transcript produce.
 * @typedef {{role:"assistant"|"user",blocks:Block[],ts:string}} Turn
 *
 * A conversation that exists in an engine's OWN store, not ours (PROBLEM 20).
 *
 * `ref` is the engine's native handle and is opaque to everyone above this layer — it goes
 * straight into `resume`, so a Claude session UUID and a Codex thread id both work without
 * the daemon knowing which it holds.
 *
 * `lastTs` is an ISO string. That is not incidental: Claude reports epoch MILLISECONDS and
 * Codex reports epoch SECONDS, so a numeric field here would be a unit bug waiting for
 * whichever engine the reader forgot about. Normalize inside the adapter.
 * @typedef {{ref:string, title:string, cwd:string|null, lastTs:string,
 *            gitBranch?:string|null, preview?:string, engine?:string}} ForeignConversation
 */

/**
 * What an engine implementation looks like. Documented as a base class rather than
 * enforced: these are plain ESM modules, and a duck-typed fake is what makes
 * engine-test.mjs able to exercise the seam with no API spend.
 *
 * @abstract
 */
export class Engine {
  /** Stable id used by `--engine` and the API. @type {string} */
  static id = "abstract";
  /** Human label for the TUI/app. @type {string} */
  static label = "Abstract";

  /**
   * @param {{cwd?:string, maxTurns?:number, resume?:string|null,
   *          model?:string|null, env?:Record<string,string>}} _opts
   */
  constructor(_opts = {}) {
    if (new.target === Engine) throw new Error("Engine is abstract");
  }

  /**
   * Is this engine usable on this machine right now? Used by `loop doctor` and by
   * the daemon to report available engines, so a missing CLI is a clear message
   * instead of a spawn crash mid-run.
   * @returns {Promise<{available:boolean, version?:string, reason?:string}>}
   */
  static async probe() {
    return { available: false, reason: "not implemented" };
  }

  /**
   * Conversations this engine already has on this machine, newest first (PROBLEM 20).
   *
   * PAGINATION IS BY OPAQUE CURSOR, NOT OFFSET. Codex's `thread/list` returns a cursor it
   * alone can interpret; Claude's `listSessions` takes limit/offset. A neutral `offset`
   * would therefore have been Claude's model leaking into the seam, and Codex's adapter
   * would have had to fake it. A cursor is the shape BOTH can honour — Claude's adapter
   * just encodes its offset into one.
   *
   * `dir` scopes to one project when given. Engines should exclude their own
   * programmatic/headless sessions by default: on this machine 66 of 179 Claude sessions
   * were ours, and a picker listing Loop-Eng's own runs back at the user is noise.
   *
   * @param {{dir?:string|null, cursor?:string|null, limit?:number}} _opts
   * @returns {Promise<{conversations:ForeignConversation[], nextCursor:string|null,
   *                    reason?:string}>}
   */
  static async listConversations(_opts = {}) {
    return {
      conversations: [],
      nextCursor: null,
      reason: `engine "${this.id}" cannot list conversations`,
    };
  }

  /**
   * One foreign conversation, as the same normalized Turn[] a live run emits.
   *
   * `cwd` comes back because it is where continuing the conversation will RUN, and the
   * daemon auto-allows every tool — so the caller has to be able to show the human which
   * directory they are about to point an agent at.
   *
   * @param {string} _ref
   * @param {{limit?:number}} _opts
   * @returns {Promise<{ref:string, cwd:string|null, turns:Turn[], reason?:string}>}
   */
  static async readConversation(_ref, _opts = {}) {
    return { ref: _ref, cwd: null, turns: [], reason: `engine "${this.id}" cannot read conversations` };
  }

  /**
   * The display name the backend's OWN client shows for this conversation — a /rename, else
   * an auto-generated title — so a session reads the same in our list as in theirs.
   *
   * Asked by the daemon on every session-list read, so it must be CHEAP (Claude's answers
   * in <3ms off a 1.8MB transcript) and must not need a live process. `null` = no name;
   * the caller falls back to the project directory.
   *
   * @param {string} _ref  the engine's resume handle (`Session.sdkSessionId`)
   * @returns {Promise<string|null>}
   */
  static async conversationTitle(_ref) {
    return null;
  }

  /**
   * Begin the run. Must be safe to call once. `prompt` may be empty when resuming.
   * @param {string} _prompt
   * @returns {void}
   */
  start(_prompt) {
    throw new Error("not implemented");
  }

  /**
   * The event stream. Iterated exactly once by Session.
   * @returns {AsyncIterable<EngineEvent>}
   */
  events() {
    throw new Error("not implemented");
  }

  /**
   * Answer the parked decision if there is one, otherwise send `text` as the next
   * user message. The engine decides which — it is the only layer that knows whether
   * a decision is currently outstanding.
   *
   * `choices` carries the resolved option labels for a structured answer; `text` is
   * the raw human input (free-form, or a typed number already resolved upstream).
   * An engine with no structured channel can ignore `choices` and send `text`.
   *
   * `decline: true` REFUSES the parked decision instead of answering it, and must leave
   * the agent STOPPED at a turn boundary (an `idle` follows) rather than carrying on with
   * a guess — the human's next message is what it should act on (PROBLEM 23). Declining
   * is a kind of answer, which is why it is a flag here and not a sixth verb. Backends
   * differ completely in how they say it: Claude's permission callback can deny AND
   * interrupt in one result; Codex's request has no refusal at all, so its adapter sends
   * an empty answer and then `turn/interrupt`s. Only meaningful while a decision is parked.
   *
   * @param {{text:string, choices?:string[]|null, decline?:boolean}} _reply
   * @returns {{mode:"structured"|"text"|"declined"}}
   */
  reply(_reply) {
    throw new Error("not implemented");
  }

  /**
   * Stop the turn in flight WITHOUT ending the session — the kill switch.
   *
   * The distinction from close() is the whole point: after an interrupt the engine must
   * still be able to take the next message, because "that's not what I meant, stop" is
   * a thing a human says mid-run and then follows with a correction. Expect an `idle`
   * shortly after, since the turn boundary is real.
   *
   * Async, unlike the other verbs, because every backend implements this as a control
   * request that has to be acknowledged.
   *
   * @returns {Promise<{ok:boolean, reason?:string}>}
   */
  async interrupt() {
    return { ok: false, reason: "not implemented" };
  }

  /** End the run and release the child process / stream. @returns {void} */
  close() {
    throw new Error("not implemented");
  }
}

/**
 * A tiny async queue: the shared adapter primitive.
 *
 * Every engine has the same shape — a callback or stdout handler pushes events from
 * OUTSIDE an async generator, and `events()` must yield them in order without
 * dropping any that arrive before iteration starts. Getting this wrong loses the
 * first turn (or worse, a decision) on a fast run, so it lives here once rather
 * than being re-derived per engine.
 */
export class EventQueue {
  constructor() {
    this._items = [];
    this._resolve = null;
    this._done = false;
  }

  push(evt) {
    if (this._done) return;
    if (this._resolve) {
      const r = this._resolve;
      this._resolve = null;
      r({ value: evt, done: false });
    } else {
      this._items.push(evt);
    }
  }

  /** No more events. Buffered ones are still drained first. */
  end() {
    this._done = true;
    if (this._resolve) {
      const r = this._resolve;
      this._resolve = null;
      r({ value: undefined, done: true });
    }
  }

  [Symbol.asyncIterator]() {
    return {
      next: () => {
        if (this._items.length) return Promise.resolve({ value: this._items.shift(), done: false });
        if (this._done) return Promise.resolve({ value: undefined, done: true });
        return new Promise((res) => { this._resolve = res; });
      },
    };
  }
}

// ---- registry -------------------------------------------------------------
// Lazy so that adding an engine never costs startup time, and so a broken or
// half-installed engine module can't stop the daemon from booting with the others.

const REGISTRY = new Map([
  ["claude-code", () => import("./claude-code.mjs").then((m) => m.ClaudeCodeEngine)],
  ["codex", () => import("./codex.mjs").then((m) => m.CodexEngine)],
]);

export const DEFAULT_ENGINE = "claude-code";

export function engineIds() {
  return [...REGISTRY.keys()];
}

/**
 * Resolve an engine class by id. Unknown ids fail LOUDLY with the valid list —
 * silently falling back to Claude would make a `--engine codex` typo look like
 * Codex is running when it isn't.
 * @param {string} [id]
 */
export async function getEngine(id = DEFAULT_ENGINE) {
  const load = REGISTRY.get(id);
  if (!load) throw new Error(`unknown engine "${id}" (have: ${engineIds().join(", ")})`);
  return load();
}

/** For tests and future plugins: register an engine at runtime. */
export function registerEngine(id, loader) {
  REGISTRY.set(id, loader);
}

/** Probe every registered engine — backs `loop doctor` and GET /engines. */
export async function probeEngines() {
  const out = [];
  for (const id of engineIds()) {
    try {
      const E = await getEngine(id);
      out.push({
        id,
        label: E.label ?? id,
        // So a UI can hide or grey the "import" affordance instead of offering a button
        // that answers with an empty list (PROBLEM 20).
        canListConversations: canList(E),
        ...(await E.probe()),
      });
    } catch (e) {
      out.push({ id, available: false, canListConversations: false, reason: String(e?.message ?? e) });
    }
  }
  return out;
}

// ---- the optional read verbs, resolved for you ----------------------------
// These wrap the two statics because the base class above is DOCUMENTATION, not
// inheritance — the real engines are standalone classes (`class ClaudeCodeEngine {}`), and
// engine-test's fakes are duck-typed on purpose. So "optional" has to mean "the method may
// be absent entirely", not just "it may return the default". Doing that check here means
// there is ONE copy of it rather than one per caller in server.mjs, the TUI, and the tests.

const canList = (E) => typeof E?.listConversations === "function";

/**
 * List one engine's own conversations. Never throws for a missing capability — an engine
 * that can't do this is a normal answer with a printable `reason`.
 * @param {string} engineId
 */
export async function listConversations(engineId, opts = {}) {
  const E = await getEngine(engineId);
  if (!canList(E))
    return { conversations: [], nextCursor: null, reason: `engine "${engineId}" cannot list conversations` };
  const r = await E.listConversations(opts);
  // Stamp the engine on every row: a merged list from several engines has to be able to
  // route an adopt back to the one that owns the ref.
  return { ...r, conversations: (r?.conversations ?? []).map((c) => ({ ...c, engine: engineId })) };
}

/**
 * The backend's own name for a conversation, or null. Never throws: a title is decoration,
 * and a failed lookup must not take the session list down with it.
 * @param {string} engineId
 */
export async function conversationTitle(engineId, ref) {
  if (!ref) return null;
  try {
    const E = await getEngine(engineId);
    if (typeof E?.conversationTitle !== "function") return null;
    const t = await E.conversationTitle(ref);
    return typeof t === "string" && t.trim() ? t.trim() : null;
  } catch {
    return null;
  }
}

/** Read one foreign conversation as normalized Turn[]. @param {string} engineId */
export async function readConversation(engineId, ref, opts = {}) {
  const E = await getEngine(engineId);
  if (typeof E?.readConversation !== "function")
    return { ref, cwd: null, turns: [], reason: `engine "${engineId}" cannot read conversations` };
  return E.readConversation(ref, opts);
}
