// API client for the Loop daemon. Plain fetch + WebSocket, no framework deps.
//
// The base URL is normally just the origin we were served from — the daemon hosts
// this app (docs/architecture.md). It can be set explicitly in Settings for the
// dev-server case, e.g. http://100.x.y.z:4318 (see lib/config.ts).

import { authHeaders, tokenQuery } from "./token";
import type {
  ForeignConversation,
  PendingQuestion,
  ReplyResult,
  SessionSummary,
  StreamMessage,
  Turn,
} from "./types";

export class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function trimBase(base: string) {
  return base.replace(/\/+$/, "");
}

async function getJson<T>(base: string, path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${trimBase(base)}${path}`, {
    ...init,
    // The daemon authenticates with an HttpOnly cookie set during QR pairing
    // (docs/architecture.md). Same-origin requests would send it anyway, but the
    // dev server on :8082 talking to a daemon elsewhere is cross-origin, where the
    // cookie is omitted unless credentials are explicitly included.
    credentials: "include",
    headers: { ...(init?.headers ?? {}), ...authHeaders() },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const msg = (body && (body.error as string)) || `HTTP ${res.status}`;
    throw new ApiError(msg, res.status);
  }
  return body as T;
}

export async function health(base: string): Promise<{ ok: boolean; service: string }> {
  return getJson(base, "/health");
}

export async function listSessions(base: string, limit = 50): Promise<SessionSummary[]> {
  const data = await getJson<{ sessions: SessionSummary[] }>(
    base,
    `/sessions?limit=${encodeURIComponent(String(limit))}`
  );
  return data.sessions ?? [];
}

// Start a new daemon-hosted session and return its id for navigation.
export async function startSession(
  base: string,
  prompt: string,
  cwd?: string
): Promise<string> {
  const data = await getJson<{ id: string }>(base, `/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt, ...(cwd ? { cwd } : {}) }),
  });
  return data.id;
}

// ---- foreign conversations (docs/architecture.md) ----------------------

/**
 * Conversations that already exist in an engine's own store — work started in the terminal
 * or an IDE rather than here.
 *
 * `cursor` is OPAQUE: pass back whatever `nextCursor` came with, and never construct one.
 * Codex's encodes a sort anchor rather than an index, so arithmetic on it silently returns
 * the wrong page.
 */
export async function listConversations(
  base: string,
  opts: { engine: string; dir?: string | null; cursor?: string | null; limit?: number }
): Promise<{ conversations: ForeignConversation[]; nextCursor: string | null; reason?: string | null }> {
  const qs = new URLSearchParams({ engine: opts.engine, limit: String(opts.limit ?? 50) });
  if (opts.dir) qs.set("dir", opts.dir);
  if (opts.cursor) qs.set("cursor", opts.cursor);
  const data = await getJson<{
    conversations: ForeignConversation[];
    nextCursor: string | null;
    reason?: string | null;
  }>(base, `/conversations?${qs.toString()}`);
  return { conversations: data.conversations ?? [], nextCursor: data.nextCursor ?? null, reason: data.reason ?? null };
}

/** Which engines this machine has, and which of them can list conversations at all. */
export async function listEngines(
  base: string
): Promise<{ id: string; label?: string; available?: boolean; canListConversations?: boolean }[]> {
  const data = await getJson<{ engines: { id: string }[] }>(base, "/engines");
  return data.engines ?? [];
}

/**
 * Adopt a foreign conversation: it becomes a real (hibernated) session, and replies write
 * back INTO the original conversation. Returns the new session id to navigate to.
 *
 * A 409 means the conversation's working directory no longer exists — a statement about
 * state rather than a bad request, so it surfaces as an ApiError the caller shows verbatim.
 */
export async function adoptConversation(
  base: string,
  opts: { engine: string; ref: string; cwd?: string }
): Promise<{ id: string; alreadyAdopted?: boolean; truncated?: boolean }> {
  return getJson(base, "/sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ adopt: { engine: opts.engine, ref: opts.ref }, ...(opts.cwd ? { cwd: opts.cwd } : {}) }),
  });
}

export async function getHistory(base: string, id: string): Promise<Turn[]> {
  const data = await getJson<{ id: string; turns: Turn[] }>(
    base,
    `/sessions/${encodeURIComponent(id)}/history`
  );
  return data.turns ?? [];
}

// HTTP fallback for the WS `pending` frame: the question Claude is waiting on
// right now, or null. Used when the socket is blocked but HTTP works.
export async function getPending(base: string, id: string): Promise<PendingQuestion | null> {
  const data = await getJson<{ id: string; question: PendingQuestion | null }>(
    base,
    `/sessions/${encodeURIComponent(id)}/pending`
  );
  return data.question ?? null;
}

export async function sendReply(
  base: string,
  id: string,
  text: string,
  submit = true
): Promise<ReplyResult> {
  return getJson<ReplyResult>(base, `/sessions/${encodeURIComponent(id)}/reply`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text, submit }),
  });
}

/** Start a fresh native conversation on another engine, initialized with the source
 * session's normalized transcript and current workspace state. */
export async function handoffSession(
  base: string,
  id: string,
  engine: string,
  instruction?: string
): Promise<{ id: string; handoff: { includedTurns: number; omittedTurns: number } }> {
  return getJson(base, `/sessions/${encodeURIComponent(id)}/handoff`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ engine, ...(instruction?.trim() ? { instruction: instruction.trim() } : {}) }),
  });
}

/**
 * Stop the turn in flight, keeping the session usable (docs/architecture.md).
 *
 * A 409 means there was nothing running — an answer about state, not a failure — so it
 * resolves rather than throwing. Anything else is a real error and propagates.
 */
export async function interruptSession(
  base: string,
  id: string
): Promise<{ ok: boolean; reason?: string }> {
  const res = await fetch(`${base.replace(/\/$/, "")}/sessions/${encodeURIComponent(id)}/interrupt`, {
    method: "POST",
    credentials: "include",
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; reason?: string; error?: string };
  if (!res.ok && res.status !== 409) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return { ok: body?.ok === true, reason: body?.reason };
}

/**
 * Refuse the parked question WITHOUT answering it, and stop the turn (docs/architecture.md PROBLEM
 * 23) — so the next message is what the agent acts on. Its own route, never a reply string.
 *
 * A 409 means nothing was waiting (most likely answered from the other client a moment
 * ago) — an answer about state, so it resolves rather than throwing.
 */
export async function declineQuestion(
  base: string,
  id: string
): Promise<{ ok: boolean; warning?: string }> {
  const res = await fetch(`${base.replace(/\/$/, "")}/sessions/${encodeURIComponent(id)}/decline`, {
    method: "POST",
    credentials: "include",
  });
  const body = (await res.json().catch(() => ({}))) as { ok?: boolean; warning?: string; error?: string };
  if (!res.ok && res.status !== 409) throw new Error(body?.error ?? `HTTP ${res.status}`);
  return { ok: body?.ok === true, warning: body?.warning };
}

// Convert an http(s) base URL to a ws(s) stream URL for a session.
//
// The token goes in the QUERY STRING here because a browser WebSocket cannot send
// custom headers — there is no other option. On the installed same-origin app the
// cookie covers it and tokenQuery() is empty, so nothing lands in the URL.
export function streamUrl(base: string, id: string, since = 0): string {
  const b = trimBase(base).replace(/^http/, "ws");
  const parts = [];
  if (since > 0) parts.push(`since=${encodeURIComponent(String(since))}`);
  const tq = tokenQuery();
  if (tq) parts.push(tq);
  const q = parts.length ? `?${parts.join("&")}` : "";
  return `${b}/stream/${encodeURIComponent(id)}${q}`;
}

// Open a live stream. Returns a close() function. Callbacks handle each message.
// Auto-reconnects with backoff unless close() was called explicitly.
export function openStream(
  base: string,
  id: string,
  handlers: {
    onHistory?: (turns: Turn[], total: number) => void;
    onTurn?: (turn: Turn) => void;
    onPending?: (question: PendingQuestion | null) => void;
    /**
     * In-flight text (docs/architecture.md). `partial` is the accumulated text so
     * far; null means whatever was streaming is finished or abandoned. Never append this
     * to `turns` — the completed turn arrives separately and is the record.
     */
    onPartial?: (partial: { kind: "text" | "thinking"; text: string } | null) => void;
    /**
     * The agent stopped working — turn boundary, interrupted, or finished. Distinct from
     * `onPartial(null)` because a Stop control needs to know the agent is busy even
     * during a long tool call, which produces no text deltas at all.
     */
    onQuiet?: () => void;
    /**
     * The daemon's own verdict on whether a turn is in flight (PROBLEM 23), including on
     * connect. Authoritative where present; onQuiet/onTurn remain the fallback for a daemon
     * that predates it.
     */
    onBusy?: (busy: boolean, since: string | null, activityAt: string | null) => void;
    onError?: (err: string) => void;
    onStatus?: (status: "connecting" | "open" | "closed") => void;
  },
  opts: { since?: number } = {}
): () => void {
  let ws: WebSocket | null = null;
  let closedByUs = false;
  let attempt = 0;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = () => {
    if (closedByUs) return;
    handlers.onStatus?.("connecting");
    ws = new WebSocket(streamUrl(base, id, opts.since ?? 0));

    ws.onopen = () => {
      attempt = 0;
      handlers.onStatus?.("open");
    };
    ws.onmessage = (evt) => {
      let msg: StreamMessage;
      try {
        msg = JSON.parse(typeof evt.data === "string" ? evt.data : "");
      } catch {
        return;
      }
      if (msg.type === "history") { handlers.onHistory?.(msg.turns, msg.total); handlers.onPartial?.(null); }
      // The completed turn supersedes the partial. Clearing here is what keeps the same
      // sentence from being rendered twice — once streaming, once as history.
      else if (msg.type === "turn") { handlers.onTurn?.(msg.turn); handlers.onPartial?.(null); }
      else if (msg.type === "delta") handlers.onPartial?.(msg.partial ?? null);
      else if (msg.type === "idle" || msg.type === "interrupted" || msg.type === "done") {
        handlers.onPartial?.(null);
        handlers.onQuiet?.();
      }
      else if (msg.type === "pending") handlers.onPending?.(msg.question);
      else if (msg.type === "busy") handlers.onBusy?.(msg.busy, msg.since, msg.activityAt ?? null);
      else if (msg.type === "error") handlers.onError?.(msg.error);
    };
    ws.onerror = () => {
      // onclose will follow and drive reconnect
    };
    ws.onclose = () => {
      handlers.onStatus?.("closed");
      if (closedByUs) return;
      attempt += 1;
      const delay = Math.min(1000 * 2 ** (attempt - 1), 15000);
      reconnectTimer = setTimeout(connect, delay);
    };
  };

  connect();

  return () => {
    closedByUs = true;
    if (reconnectTimer) clearTimeout(reconnectTimer);
    try {
      ws?.close();
    } catch {
      /* already closed */
    }
  };
}
