// Daemon client for the CLI/TUI.
//
// THE INVARIANT (docs/architecture.md, non-negotiable): the TUI is a PURE CLIENT.
// It never hosts a session, never touches an engine, never imports the agent SDK. It
// speaks the same HTTP+WS protocol the phone speaks — which is what makes "start in
// the terminal, walk away, finish on the phone" work, and what keeps a closed
// terminal from killing a run.
//
// Talks to 127.0.0.1, which auth.mjs exempts from the token, so no credential
// handling is needed here. `LOOP_TOKEN` is still honored for a remote daemon.

import { WebSocket } from "ws";

export class DaemonClient {
  constructor({ port = 4318, host = "127.0.0.1", token = process.env.LOOP_TOKEN ?? null } = {}) {
    this.base = `http://${host}:${port}`;
    this.wsBase = `ws://${host}:${port}`;
    this.token = token;
  }

  get _headers() {
    const h = { "content-type": "application/json" };
    if (this.token) h["x-loop-token"] = this.token;
    return h;
  }

  /**
   * `allowStatus` exists for the state-refusal codes. `POST /interrupt` on a session
   * that isn't running answers 409 — that is the honest answer to a fair question, not a
   * failure, and throwing it would force every caller to parse an Error's message back
   * into a state check.
   */
  async _req(path, init = {}, { allowStatus = [] } = {}) {
    const res = await fetch(`${this.base}${path}`, { ...init, headers: this._headers });
    const body = await res.json().catch(() => ({}));
    if (!res.ok && !allowStatus.includes(res.status)) throw new Error(body?.error || `HTTP ${res.status}`);
    return body;
  }

  health() { return this._req("/health"); }
  engines() { return this._req("/engines"); }
  sessions() { return this._req("/sessions").then((b) => b.sessions ?? []); }
  history(id) { return this._req(`/sessions/${encodeURIComponent(id)}/history`); }

  createSession({ prompt, cwd, engine }) {
    return this._req("/sessions", {
      method: "POST",
      body: JSON.stringify({ prompt, cwd, engine }),
    });
  }

  reply(id, text) {
    return this._req(`/sessions/${encodeURIComponent(id)}/reply`, {
      method: "POST",
      body: JSON.stringify({ text }),
    });
  }

  /** Continue a session on another provider. The daemon creates the context package and
   * returns the new target session; the source remains available. */
  handoff(id, engine, instruction = null) {
    return this._req(`/sessions/${encodeURIComponent(id)}/handoff`, {
      method: "POST",
      body: JSON.stringify({ engine, ...(instruction?.trim() ? { instruction: instruction.trim() } : {}) }),
    });
  }

  // ---- foreign conversations (docs/architecture.md) ---------------------

  /**
   * Conversations that already exist in an engine's own store — work started in the
   * terminal or an IDE rather than here. Read-only.
   *
   * `cursor` is OPAQUE: pass back whatever `nextCursor` came with and never compute one.
   * Codex's encodes a sort anchor rather than an index, so arithmetic on it silently
   * returns the wrong page.
   */
  conversations({ engine, dir = null, cursor = null, limit = 50 } = {}) {
    const qs = new URLSearchParams();
    if (engine) qs.set("engine", engine);
    if (dir) qs.set("dir", dir);
    if (cursor) qs.set("cursor", cursor);
    qs.set("limit", String(limit));
    return this._req(`/conversations?${qs}`);
  }

  /** One foreign conversation as normalized turns, for a preview before adopting. */
  conversation(engine, ref) {
    return this._req(`/conversations/${encodeURIComponent(engine)}/${encodeURIComponent(ref)}`);
  }

  /**
   * Adopt one: it becomes a real (hibernated) session that replies write back INTO the
   * original conversation. Returns the same shape as createSession.
   *
   * 409 is allowed through because it is a statement about state, not a bad request: the
   * conversation's working directory no longer exists, and the honest response is to show
   * the human that message rather than a thrown Error.
   */
  adoptConversation({ engine, ref, cwd = null }) {
    return this._req(
      "/sessions",
      { method: "POST", body: JSON.stringify({ adopt: { engine, ref }, ...(cwd ? { cwd } : {}) }) },
      { allowStatus: [409] }
    );
  }

  /**
   * Stop the turn in flight, keeping the session usable (docs/architecture.md).
   * 409 means there was nothing running — a normal answer, not a failure.
   */
  interrupt(id) {
    return this._req(`/sessions/${encodeURIComponent(id)}/interrupt`, { method: "POST" }, { allowStatus: [409] });
  }

  /**
   * Refuse the parked question without answering it, and stop the turn (docs/architecture.md
   * PROBLEM 23). 409 = nothing was waiting — most likely answered from the phone a moment
   * ago — which is a statement about state, not a failure.
   */
  decline(id) {
    return this._req(`/sessions/${encodeURIComponent(id)}/decline`, { method: "POST" }, { allowStatus: [409] });
  }

  /** End a session for good: the agent process dies and the transcript is dropped. */
  closeSession(id) {
    return this._req(`/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  }

  /**
   * Free the agent process now, keeping the conversation (docs/architecture.md).
   * Replying later transparently wakes it. 409 when the session is parked on a
   * decision — which is a refusal about state, so it is not an error worth throwing at
   * the user; callers get the message and can say "answer it first".
   */
  hibernateSession(id) {
    return this._req(`/sessions/${encodeURIComponent(id)}/hibernate`, { method: "POST" }, { allowStatus: [409] });
  }

  /**
   * Stream one session. Returns a closer.
   *
   * Auto-reconnects: the daemon outliving the client is the whole design, so a
   * dropped socket is normal (laptop sleep, daemon restart) and must not require
   * restarting the TUI. The daemon replays full history on connect, so the caller
   * resets its transcript on `history` rather than appending duplicates.
   */
  stream(id, onEvent, { onStatus } = {}) {
    let ws = null;
    let closed = false;
    let retry = null;
    let attempt = 0;

    const connect = () => {
      if (closed) return;
      const qs = this.token ? `?token=${encodeURIComponent(this.token)}` : "";
      ws = new WebSocket(`${this.wsBase}/stream/${encodeURIComponent(id)}${qs}`);

      ws.on("open", () => { attempt = 0; onStatus?.("connected"); });
      ws.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(raw.toString()); } catch { return; }
        onEvent(msg);
      });
      ws.on("error", () => { /* surfaced via close */ });
      ws.on("close", () => {
        if (closed) return;
        onStatus?.("reconnecting");
        // Backoff caps at 5s: fast enough to feel instant after a blip, slow enough
        // not to spin if the daemon is genuinely gone.
        const delay = Math.min(5000, 250 * 2 ** attempt++);
        retry = setTimeout(connect, delay);
      });
    };

    connect();
    return () => {
      closed = true;
      if (retry) clearTimeout(retry);
      try { ws?.close(); } catch { /* already gone */ }
    };
  }
}
