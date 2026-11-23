# Architecture

Loop has three product surfaces around one local daemon:

- The daemon owns provider processes, normalized sessions, persistence, notifications, and the
  authenticated HTTP/WebSocket API.
- The terminal UI starts or adopts the daemon and controls sessions without owning provider state.
- The installable PWA consumes the same API for remote viewing, replies, decisions, and handoffs.

## Engine boundary

Claude Code and Codex adapters translate vendor events into normalized turns containing text,
tool calls, tool results, and decision requests. Session and UI code operate on that normalized
model. Native provider conversation identifiers are opaque and never treated as interchangeable.

## Cross-engine handoff

A handoff is not a vendor-session conversion. Loop creates a fresh target-provider session in
the same working directory and supplies recent normalized turns plus a compact Git worktree
snapshot. Hidden reasoning is excluded, context is bounded, and the original session remains
available. Handoffs are allowed only when the source is idle and has no unanswered decision.

## Persistence and transport

Session snapshots are stored outside the repository under `~/.loop-eng/`. A restored session is
initially process-free and wakes through its provider's native resume handle when possible.

The daemon serves both the API and built PWA. Tailscale Serve is the preferred remote transport;
Funnel is an explicit public-sharing mode. Pairing places a generated token in a QR URL, exchanges
it for an HttpOnly cookie, and removes the token from the visible URL.
