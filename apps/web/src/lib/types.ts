// Shared shapes for the daemon's normalized transcript output.
// Keep in sync with services/orchestrator/daemon/session.mjs.

export type BlockKind = "text" | "thinking" | "tool_use" | "tool_result";

export type Block =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "tool_use"; id?: string; name?: string; input: unknown }
  | { kind: "tool_result"; tool_use_id?: string; is_error: boolean; text: string };

export type Role = "assistant" | "user";

export type Turn = {
  role: Role;
  blocks: Block[];
  ts: string | null;
};

/** A daemon-hosted session's lifecycle. `hibernated` = alive, but with no agent
 *  process held; the next reply wakes it (docs/architecture.md). */
export type SessionStatus = "starting" | "running" | "hibernated" | "done" | "error";

// One row in the sessions list (from GET /sessions).
export type SessionSummary = {
  id: string;
  projectLabel: string;
  projectName?: string;
  cwd?: string | null;
  lastTs?: string | null;
  lastRole?: Role | null;
  preview?: string;

  // Optional when an engine can expose repository metadata.
  gitBranch?: string | null;
  /**
   * The engine's OWN name for the conversation (a /rename, else Claude's generated title),
   * read from its store — so it matches `claude --resume`. Null until one exists
   * (docs/architecture.md); show the project name then.
   */
  title?: string | null;
  status?: SessionStatus;
  /** True while a decision is parked — the one field the whole product is about. */
  pending?: boolean;
  /**
   * Is a turn in flight — is it the agent's move? Owned by the daemon (PROBLEM 23):
   * `status` can't say it, because a session is "running" for 30 minutes after its last word.
   */
  busy?: boolean;
  /** ISO time the current turn began, so every client shows the same elapsed time. */
  busySince?: string | null;
  hibernated?: boolean;
  engine?: string;
  turnCount?: number;
  /**
   * Set when this session was ADOPTED from an engine's own store rather than started here
   * (docs/architecture.md). Present means replies write back into that original
   * conversation, which the human should know before typing.
   */
  adoptedFrom?: AdoptedFrom | null;
  /** A fresh provider conversation initialized from another Loop session. */
  handoffFrom?: HandoffFrom | null;
};

/** Where an adopted session came from. */
export type AdoptedFrom = {
  engine: string;
  ref: string;
  truncated?: boolean;
  total?: number;
};

export type HandoffFrom = {
  sessionId: string;
  engine: string;
  turnCount: number;
  createdAt: string;
};

/**
 * A conversation that exists in an ENGINE's own store, not ours — work started in the
 * terminal or an IDE (docs/architecture.md).
 *
 * `ref` is the engine's native handle and is OPAQUE: a Claude session UUID and a Codex
 * thread id both flow through unchanged. `lastTs` is an ISO string because the two engines
 * report epoch milliseconds and epoch seconds respectively — normalized in the adapter so
 * nothing above it has to know.
 */
export type ForeignConversation = {
  ref: string;
  engine: string;
  title: string;
  cwd: string | null;
  lastTs: string;
  gitBranch?: string | null;
  preview?: string;
  /** The loop-eng session id if this has already been imported, else null. */
  adoptedAs?: string | null;
};

// A decision an engine is waiting on right now. It uses the same shape as a historical
// question so both render through the same QuestionCard.
export type PendingQuestion = {
  header?: string;
  question: string;
  multiSelect: boolean;
  options: { label: string; description?: string }[];
};

// WebSocket stream messages (from WS /stream/:id).
export type StreamMessage =
  | { type: "history"; total: number; turns: Turn[] }
  | { type: "turn"; turn: Turn }
  | { type: "pending"; question: PendingQuestion | null }
  // In-flight text, DISPLAY ONLY (docs/architecture.md). `text` is the newest chunk,
  // `partial` the accumulated value. Never append these to `turns`.
  | { type: "delta"; kind: "text" | "thinking"; text: string; partial: { kind: "text" | "thinking"; text: string } }
  // The turn in flight was stopped by a human. The session is still usable.
  | { type: "interrupted" }
  // Whether a turn is in flight (PROBLEM 23). Sent on every change AND as part of the seed,
  // so a client that connects mid-turn — a notification tap — knows the agent is working.
  | { type: "busy"; busy: boolean; since: string | null; activityAt?: string | null }
  // Turn boundary: the agent stopped, the session is alive. Drives PATH B detection.
  | { type: "idle" }
  // The agent process was released on idle; the conversation was not. A reply wakes it.
  | { type: "hibernated" }
  | { type: "woke" }
  | { type: "done" }
  | { type: "error"; error: string };

// Response from POST /sessions/:id/reply.
export type ReplyResult = {
  ok: boolean;
  pane: string;
  cwd: string | null;
  paneCommand: string;
  submitted: boolean;
  warning: string | null;
};
