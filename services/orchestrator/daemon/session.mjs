// A daemon-HOSTED agent session — the north-star core (docs/architecture.md
// "NORTH STAR"). The daemon owns the session; every UI (TUI, phone) is just a
// client watching + replying.
//
// ENGINE-AGNOSTIC (docs/architecture.md). This file knows nothing about Claude,
// Anthropic content blocks, `canUseTool`, or Codex JSON-RPC. It consumes normalized
// EngineEvents from an Engine (engines/engine.mjs) and owns only what is genuinely
// session-shaped: transcript history, listener fan-out, reply routing, and the
// synthesized answered-question record.
//
// The two decision paths still exist, but they are now the ENGINE's job to surface:
//   A. a structured question -> `decision` event -> `pending` frame (options -> buttons)
//   B. a plain-text question -> an ordinary turn ending in "?" at an `idle` boundary
//
// Output turns match the app's normalized {role, blocks[], ts} schema exactly
// (apps/web/src/lib/types.ts), so the existing renderer works unchanged.

import { randomUUID } from "node:crypto";
import { getEngine, DEFAULT_ENGINE, conversationTitle } from "./engines/engine.mjs";

/** What a declined question's answer reads as, in history and in both UIs. */
export const DECLINED = "Declined";

export class Session {
  /**
   * `engine` is an id resolved lazily in start(), so constructing a Session never
   * spawns a process — the registry stays lazy and an unavailable engine surfaces
   * as a session error rather than a daemon crash.
   */
  constructor({
    cwd,
    maxTurns = Number(process.env.MAX_TURNS ?? 200),
    engine = process.env.LOOP_ENGINE ?? DEFAULT_ENGINE,
    model = null,
    resume = null,
    hibernateAfterMs = Number(process.env.LOOP_HIBERNATE_MS ?? 30 * 60_000),
    id = null,
    engineOptions = {},
  } = {}) {
    // `id` is overridable ONLY so a restored snapshot keeps its identity — the phone's
    // push deep link is `/session/<id>`, so a restart that renumbered sessions would
    // turn every already-delivered notification into a 404.
    this.id = id ?? randomUUID();
    this.cwd = cwd || process.cwd();
    this.maxTurns = maxTurns;
    this.engineId = engine;
    this.model = model;
    this.resumeRef = resume;
    /**
     * Engine-specific extras, passed through untouched (e.g. Codex's `mode: "plan"`).
     *
     * This is the seam's ONE concession to per-engine settings, and it is deliberately
     * opaque: Session must not learn what any of these mean. The alternative — a growing
     * union of named options on Session — is how an "engine-agnostic" host quietly
     * becomes a list of vendor special cases. Our own keys win, so an engineOption can
     * never silently override cwd or resume.
     */
    this.engineOptions = engineOptions;
    /** Idle time before the agent process is released. 0 or less disables it. */
    this.hibernateAfterMs = hibernateAfterMs;

    this.turns = []; // normalized Turn[] — the canonical transcript
    // In-flight text, for display only (docs/architecture.md). Never part of `turns`:
    // the completed `turn` is the record, and a client drops its scratch buffer when that
    // arrives. Deliberately NOT persisted — a half-sentence from before a restart is
    // noise, and the turn it belonged to either completed or never will.
    this.partial = null; // { kind: "text"|"thinking", text: string } | null
    this.pending = null; // Decision | null (the live decision)
    this.status = "starting"; // starting | running | hibernated | done | error
    /**
     * Is a turn IN FLIGHT right now — i.e. is it the agent's move? Distinct from `status`:
     * a "running" session is one whose process is alive, which it is for 30 minutes after
     * the last word (PROBLEM 15), so `status` cannot tell "thinking" from "waiting for you".
     *
     * It lives HERE, not in each client, because a client can only infer it from the
     * events it happened to see — and a phone opened from a notification mid-turn has seen
     * none, so it showed a silent screen with no Stop button. `busySince` is a timestamp,
     * not a duration, so every client renders the same elapsed time across reconnects.
     */
    this.busy = false;
    this.busySince = null; // ISO string while busy
    /**
     * When the agent last showed a sign of life (a turn or a delta). Sent in the seed so a
     * client opened mid-turn knows how long it has REALLY been silent — counting from the
     * moment it connected would hide exactly the long silence it was opened to check on.
     */
    this.activityAt = null;
    this.sdkSessionId = null; // engine's own resume handle (kept for API compat)
    this.lastError = null;

    this._engine = null;
    this._EngineClass = null; // cached so waking doesn't re-resolve the registry
    this._askIds = new Set();
    this._listeners = new Set();
    this._idleTimer = null;
    this._hibernating = false;
    /** Set by discard(): this session is deleted and must never be persisted again. */
    this.discarded = false;
    /**
     * Set when this session was ADOPTED from an engine's own store rather than started
     * here (docs/architecture.md): `{engine, ref, truncated, total}`.
     *
     * Purely informational — the resume handle in `sdkSessionId` is what makes the
     * conversation continuable, and nothing in the run path reads this. It exists so a UI
     * can say "imported, and you're writing back into the original", which is a thing the
     * human should know before typing.
     */
    this.adoptedFrom = null;
    /**
     * Set when this is a NEW native conversation created from another Loop session's
     * normalized transcript. Unlike `adoptedFrom`, replies do not write into the source
     * provider's conversation — Claude and Codex session ids are intentionally never
     * treated as interchangeable. `{sessionId, engine, turnCount, createdAt}` is display
     * metadata and a navigation link; the initial handoff prompt carries the context.
     */
    this.handoffFrom = null;
    /**
     * The name the ENGINE's own client shows for this conversation (docs/architecture.md PROBLEM
     * 21) — null until it has one, and the list then shows the project instead. Read
     * from the vendor store rather than generated here, so a session is called the same
     * thing in our list as in `claude --resume`, and a /rename in either shows up in both.
     */
    this.title = null;
    this._titleCheckedAt = 0;
  }

  /**
   * Re-read `title` from the engine. Called on every session-list read rather than on a
   * turn boundary, because the title is written ASYNCHRONOUSLY by the agent — it can land
   * after the turn that prompted it — and because a /rename can happen in another client
   * entirely. Throttled, since the TUI polls the list.
   */
  async refreshTitle({ maxAgeMs = 5000 } = {}) {
    if (!this.sdkSessionId || Date.now() - this._titleCheckedAt < maxAgeMs) return this.title;
    this._titleCheckedAt = Date.now();
    const t = await conversationTitle(this.engineId, this.sdkSessionId);
    // Never blank a known name: a lookup that fails (file mid-write, engine gone) is not
    // evidence that the conversation lost its title.
    if (t) this.title = t;
    return this.title;
  }

  // ---- event fan-out to WS clients ----
  addListener(fn) {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }
  _emit(evt) {
    for (const fn of this._listeners) {
      try { fn(evt); } catch { /* a dead listener must not break others */ }
    }
  }
  _pushTurn(turn) {
    this.turns.push(turn);
    this._emit({ type: "turn", turn });
  }
  _setPending(q) {
    this.pending = q;
    this._emit({ type: "pending", question: q });
  }
  /** Emits only on a CHANGE, so a run of turns doesn't spam every client with frames. */
  _setBusy(busy) {
    if (this.busy === busy) return;
    this.busy = busy;
    this.busySince = busy ? new Date().toISOString() : null;
    if (busy) this.activityAt = this.busySince; // a new turn starts the silence clock
    this._emit({ type: "busy", busy, since: this.busySince, activityAt: this.activityAt });
  }
  _touch() {
    this.activityAt = new Date().toISOString();
  }

  start(prompt) {
    // The adapters suppress their own echoed input because Session is the canonical
    // transcript owner. Record the FIRST prompt here just like reply() records every later
    // human message. Without this, a cross-engine handoff loses the task that started the
    // conversation — often the most important context — and a fresh session's UI begins
    // with the agent answering an invisible request.
    const initial = String(prompt ?? "");
    if (initial)
      this._pushTurn({
        role: "user",
        blocks: [{ kind: "text", text: initial }],
        ts: new Date().toISOString(),
      });
    this.status = "running";
    this._setBusy(true);
    this._boot(initial).catch((e) => {
      this.status = "error";
      this.lastError = String(e?.message ?? e);
      this._setBusy(false);
      this._emit({ type: "error", error: this.lastError });
    });
    return this;
  }

  async _boot(prompt) {
    this._EngineClass = await getEngine(this.engineId);
    this._engine = this._newEngine(this.resumeRef);
    this._engine.start(prompt);
    await this._consume();
  }

  _newEngine(resume) {
    return new this._EngineClass({
      ...this.engineOptions, // first, so the fields below always win
      cwd: this.cwd,
      maxTurns: this.maxTurns,
      model: this.model,
      resume,
    });
  }

  // ---- hibernation (docs/architecture.md) --------------------------
  // WHY THIS EXISTS: an agent run is a real OS process, and streaming input holds its
  // stdin open for the life of the conversation — which is what makes a Session a
  // durable chat rather than a series of one-shots. The cost is that the process is
  // pinned for as long as the Session exists, and because that iterator never ends,
  // `done` never fires either. Measured on the dev daemon: two `claude` children alive
  // for 3 days and 2.5 hours, one ~280MB binary each, for conversations nobody was
  // reading.
  //
  // So: release the PROCESS on idle, keep the CONVERSATION. The next reply starts a
  // fresh engine with `resume: sdkSessionId`. That this is lossless is measured, not
  // assumed — a resumed run recalled a word from before its predecessor exited, and
  // emitted NO replayed turns, so the transcript doesn't double.

  _armHibernation() {
    if (!(this.hibernateAfterMs > 0)) return; // disabled
    this._cancelHibernation();
    this._idleTimer = setTimeout(() => this.hibernate(), this.hibernateAfterMs);
    // unref: a pending 30-minute timer must never be the thing keeping a process
    // alive. The daemon's HTTP server holds the loop open on its own, and a test
    // process would otherwise sit idle for half an hour after its last assertion.
    this._idleTimer.unref?.();
  }

  _cancelHibernation() {
    if (this._idleTimer) {
      clearTimeout(this._idleTimer);
      this._idleTimer = null;
    }
  }

  /**
   * THE KILL SWITCH (docs/architecture.md): stop the turn in flight, keep the
   * session. Not the same as close() — the agent stays available for the correction
   * that almost always follows "stop".
   *
   * Async because it is a control request the backend acknowledges. A refusal is a
   * normal answer, not an error: there is nothing to interrupt between turns.
   */
  async interrupt() {
    if (!this._engine) return { ok: false, reason: `nothing running (status ${this.status})` };
    if (typeof this._engine.interrupt !== "function")
      return { ok: false, reason: `engine "${this.engineId}" cannot interrupt` };
    const r = await this._engine.interrupt();
    if (r?.ok) {
      this.partial = null; // whatever was mid-sentence is not coming
      this._setBusy(false);
      this._emit({ type: "interrupted" });
    }
    return r ?? { ok: false, reason: "engine returned nothing" };
  }

  /**
   * Release the agent process, keeping the transcript. Refuses whenever letting go
   * would lose something: mid-turn work, or — the one that matters — a parked
   * decision, which is the entire product waiting on a human.
   */
  hibernate() {
    if (this.status !== "running") return { ok: false, reason: `status is ${this.status}` };
    if (this.pending) return { ok: false, reason: "parked on a decision" };
    if (!this._engine) return { ok: false, reason: "no engine running" };
    this._hibernating = true;
    // Closing ends the engine's event stream, so _consume() finishes the transition.
    // Doing it there rather than here means there is exactly ONE place that decides
    // what a finished stream meant.
    this._engine.close();
    return { ok: true };
  }

  async _wake(prompt) {
    if (!this._EngineClass) this._EngineClass = await getEngine(this.engineId);
    this._engine = this._newEngine(this.sdkSessionId);
    this._emit({ type: "woke" });
    this._engine.start(prompt);
    await this._consume();
  }

  // Translate normalized EngineEvents into the wire protocol the app already speaks.
  // Deliberately dumb: any per-engine cleverness belongs in the adapter, not here.
  async _consume() {
    for await (const evt of this._engine.events()) {
      switch (evt.type) {
        case "ready":
          this.sdkSessionId = evt.sessionRef;
          break;
        case "turn":
          this._cancelHibernation(); // the agent is working again
          // Only a working agent emits turns (our own echoes never come through here), so
          // this also self-heals a flag that a missed transition left false.
          this._setBusy(true);
          this._touch();
          // The canonical turn supersedes whatever was streaming, so the scratch buffer
          // goes. Clients clear on `turn` too, which is what keeps the partial from
          // being rendered twice — once as a delta and once as history.
          this.partial = null;
          this._pushTurn({ role: evt.role, blocks: evt.blocks, ts: evt.ts });
          break;
        case "delta": {
          // Accumulate per contiguous kind: a thinking block followed by a text block
          // must not concatenate into one smear.
          const same = this.partial && this.partial.kind === evt.kind;
          this.partial = { kind: evt.kind, text: (same ? this.partial.text : "") + evt.text };
          this._setBusy(true);
          this._touch();
          this._emit({ type: "delta", kind: evt.kind, text: evt.text, partial: this.partial });
          break;
        }
        case "decision":
          // A parked decision must NEVER be hibernated out from under the human.
          // The timer is also refused inside hibernate(); two belts, because getting
          // this wrong drops the run the notification just told someone to answer.
          this._cancelHibernation();
          // Parked on the human: the agent is not working, it's waiting — so there is
          // nothing to show a spinner for, and nothing for Stop to interrupt.
          if (evt.question) this._setBusy(false);
          this._setPending(evt.question);
          break;
        case "idle":
          // Turn boundary — the agent stopped and the session is idle-but-alive.
          // The notifier uses this for PATH B. WS clients ignore unknown types.
          this.partial = null; // nothing is in flight at a turn boundary, by definition
          this._setBusy(false);
          this._emit({ type: "idle" });
          this._armHibernation(); // nobody's move but the human's: start the clock
          break;
        case "error":
          this.status = "error";
          this.lastError = evt.error;
          this._setBusy(false);
          this._emit({ type: "error", error: evt.error });
          break;
        case "done":
          break;
        default:
          break;
      }
    }

    // THE ONE PLACE THAT DECIDES WHAT A FINISHED STREAM MEANT. A closed engine looks
    // identical whether we hibernated it, the human closed the session, or the run
    // genuinely ended — so the intent has to be recorded before close() and read here.
    this._cancelHibernation();
    this._setBusy(false); // whatever the stream's end meant, nothing is in flight now
    if (this._hibernating) {
      this._hibernating = false;
      this._engine = null; // drop the reference; the process is already gone
      this.status = "hibernated";
      this._emit({ type: "hibernated" });
      return;
    }
    if (this.status !== "error") this.status = "done";
    this._emit({ type: "done" });
  }

  /**
   * Route a human reply. Resolving a parked decision is the engine's job (only it
   * knows how its backend un-pauses); this method owns turning raw human input into
   * option labels and recording the Q&A in history.
   */
  reply(text) {
    const t = String(text ?? "");

    // WAKE. The process was released while nobody was watching; the conversation was
    // not. Show the human's text immediately (so the UI never looks like it dropped
    // the message while a CLI boots), then restart the engine against the same
    // sessionRef. Deliberately fire-and-forget: reply() is synchronous because every
    // caller is an HTTP handler that must answer now, and waking takes seconds.
    if (this.status === "hibernated") {
      this._pushTurn({ role: "user", blocks: [{ kind: "text", text: t }], ts: new Date().toISOString() });
      this.status = "running";
      // Busy from the moment of the reply, not from the first token: booting a CLI and
      // resuming takes seconds, and that gap is exactly when a silent screen reads as stuck.
      this._setBusy(true);
      this._wake(t).catch((e) => {
        this.status = "error";
        this.lastError = String(e?.message ?? e);
        this._setBusy(false);
        this._emit({ type: "error", error: this.lastError });
      });
      return { ok: true, submitted: true, warning: null, mode: "text", woke: true };
    }

    if (!this._engine)
      return {
        ok: false,
        submitted: false,
        mode: "none",
        // Distinguish "never started" from "ended", because a RESTORED session with no
        // resume handle lands here and "engine not started" would read as a bug rather
        // than as the honest answer: this transcript is readable, not continuable.
        warning: this.status === "done" ? "this session has ended — start a new one" : "engine not started",
      };

    const parked = this._engine.awaitingDecision ? this.pending : null;

    // PATH A: a structured decision is waiting.
    if (parked) {
      // The app sends the option NUMBER (1-based) for a tap; a TUI/human may type
      // free text. Number in range -> that option's label; otherwise use raw text.
      const opts = parked.options ?? [];
      let choices = null;
      // multiSelect taps arrive comma-separated ("1,3").
      const parts = t.split(",").map((p) => p.trim()).filter(Boolean);
      const nums = parts.map((p) => Number.parseInt(p, 10));
      const allValid =
        parts.length > 0 &&
        nums.every((n) => Number.isInteger(n) && n >= 1 && n <= opts.length) &&
        parts.every((p, i) => String(nums[i]) === p); // reject "1 apple"
      if (allValid) choices = nums.map((n) => opts[n - 1].label);

      const chosen = choices?.length ? choices.join(", ") : t;
      const result = this._engine.reply({ text: t, choices });
      this._recordAnswer(parked, result, { text: chosen, isError: false });
      this._setBusy(true); // un-paused: it's the agent's move again
      return { ok: true, submitted: true, warning: null, mode: "structured" };
    }

    // PATH B: normal text reply -> show it immediately, feed as next user message.
    this._pushTurn({ role: "user", blocks: [{ kind: "text", text: t }], ts: new Date().toISOString() });
    this._engine.reply({ text: t });
    this._setBusy(true);
    return { ok: true, submitted: true, warning: null, mode: "text" };
  }

  /**
   * Refuse the parked question WITHOUT answering it, and stop the turn — so the human's
   * next message is what the agent acts on (docs/architecture.md).
   *
   * Not the same as typing a free-text answer. Free text is recorded as THE ANSWER and
   * the agent carries on with it; a decline tells it there is no answer and to wait.
   * That's the difference between "Other: use Postgres" and "wrong question — stop".
   *
   * A separate method (and route), not a magic reply string: a refusal must never be
   * something you can trigger by typing a particular word.
   */
  decline() {
    const parked = this._engine?.awaitingDecision ? this.pending : null;
    if (!parked)
      return { ok: false, submitted: false, mode: "none", warning: "no question is waiting" };
    const result = this._engine.reply({ text: "", decline: true });
    // is_error, because that's what it is to the agent too (a refused tool), and so a
    // decline made in Claude's own TUI and later imported renders the same way.
    this._recordAnswer(parked, result, { text: DECLINED, isError: true });
    // Still busy until the engine reaches its turn boundary: the agent is winding the
    // turn down, and `idle` is what says it has.
    this._setBusy(true);
    return { ok: true, submitted: true, warning: null, mode: "declined" };
  }

  /**
   * Synthesize the Q&A into history so it stays visible (renders as an answered
   * QuestionCard via the app's buildQuestionState). Engine-neutral: built from the
   * normalized Decision, not from any vendor payload.
   */
  _recordAnswer(parked, result, { text, isError }) {
    const askId = "ask_" + randomUUID();
    const questions = result?.questions ?? [
      {
        question: parked.question,
        header: parked.header,
        multiSelect: parked.multiSelect,
        options: parked.options,
      },
    ];
    this._pushTurn({
      role: "assistant",
      blocks: [{ kind: "tool_use", id: askId, name: "AskUserQuestion", input: { questions } }],
      ts: new Date().toISOString(),
    });
    this._pushTurn({
      role: "user",
      blocks: [{ kind: "tool_result", tool_use_id: askId, is_error: isError, text }],
      ts: new Date().toISOString(),
    });
    this._askIds.add(askId);
    this._setPending(null); // clear the live question
  }

  meta() {
    const last = this.turns[this.turns.length - 1];
    const lastText =
      [...this.turns].reverse().flatMap((tn) => tn.blocks).find((b) => b.kind === "text")?.text ?? "";
    return {
      id: this.id,
      cwd: this.cwd,
      engine: this.engineId,
      projectLabel: this.cwd,
      projectName: this.cwd.split("/").filter(Boolean).pop() ?? this.cwd,
      title: this.title,
      status: this.status,
      // Surfaced separately from `status` so a client can show "sleeping" without
      // having to know the status vocabulary — and so it never reads as an error.
      hibernated: this.status === "hibernated",
      pending: !!this.pending,
      busy: this.busy,
      busySince: this.busySince,
      activityAt: this.activityAt,
      lastRole: last?.role ?? null,
      lastTs: last?.ts ?? null,
      preview: lastText.slice(0, 200),
      turnCount: this.turns.length,
      // Null for an ordinary session. Present means the transcript above the input box
      // started life in another client, and replies write back into it (PROBLEM 20).
      adoptedFrom: this.adoptedFrom,
      // Present on a cross-engine continuation. The source session stays intact, so the
      // user can inspect or resume either side of the handoff.
      handoffFrom: this.handoffFrom,
    };
  }

  close() {
    // Cancel first: a fired timer after close() would call hibernate() on a dead
    // session, and an un-cleared one keeps a handle to `this` for up to 30 minutes.
    this._cancelHibernation();
    this._engine?.close();
  }

  /**
   * End this session PERMANENTLY — the delete path, as opposed to close()'s "stop the
   * process".
   *
   * The flag is the whole point. Closing the engine ends its stream, which emits `done`
   * on a later tick, and anything listening — notably the snapshot writer — reacts to
   * that by flushing. So a DELETE that merely closed and unlinked would have the file
   * WRITTEN BACK a moment later and the session would rise again on the next daemon
   * boot. (Measured: lifecycle-test.mjs caught exactly this.) Marking the session
   * discarded is what makes the deletion stick, whatever order the ticks land in.
   */
  discard() {
    this.discarded = true;
    this.close();
  }

  // ---- persistence (docs/architecture.md) --------------------------
  // Only DATA crosses this boundary — no engine, no listeners, no timers. The stored
  // shape is the same normalized transcript the app already renders, so restoring is a
  // read rather than a conversion (see store.mjs for why we don't read the SDK's own).

  toSnapshot() {
    return {
      id: this.id,
      cwd: this.cwd,
      engine: this.engineId,
      model: this.model,
      maxTurns: this.maxTurns,
      // The engine's own resume handle. Without it a restored session is history-only,
      // because there is nothing to reattach the conversation to.
      sdkSessionId: this.sdkSessionId,
      status: this.status,
      turns: this.turns,
      lastTs: this.turns[this.turns.length - 1]?.ts ?? null,
      lastError: this.lastError,
      // Survives a restart so a restored session still knows it was imported — otherwise
      // the badge disappears on reboot while the write-back behaviour stays.
      adoptedFrom: this.adoptedFrom,
      handoffFrom: this.handoffFrom,
      title: this.title,
    };
  }

  /**
   * Rebuild a session from disk. It comes back **hibernated** — transcript present,
   * no agent process — which is exactly the state the measured wake path already
   * handles, so a restart needs no second resume mechanism.
   *
   * A snapshot with no `sdkSessionId` never reached `ready`, so there is no
   * conversation to rejoin: it is restored `done`, i.e. readable but not continuable.
   * Pretending otherwise would silently start a FRESH agent with no memory of the
   * transcript sitting above the input box.
   */
  static fromSnapshot(snap, opts = {}) {
    const s = new Session({
      id: snap.id,
      cwd: snap.cwd,
      engine: snap.engine,
      model: snap.model ?? null,
      maxTurns: snap.maxTurns,
      ...opts,
    });
    s.turns = Array.isArray(snap.turns) ? snap.turns : [];
    s.sdkSessionId = snap.sdkSessionId ?? null;
    s.lastError = snap.lastError ?? null;
    s.adoptedFrom = snap.adoptedFrom ?? null;
    s.handoffFrom = snap.handoffFrom ?? null;
    s.title = snap.title ?? null;
    // A decision cannot survive a restart: `pending` was a promise held open inside a
    // process that no longer exists. Restoring it would show a card whose answer had
    // nowhere to go. The synthesized Q&A already in `turns` is what remains.
    s.pending = null;
    s.status = s.sdkSessionId ? "hibernated" : "done";
    s.restored = true;
    return s;
  }
}
