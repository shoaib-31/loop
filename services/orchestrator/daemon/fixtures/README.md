# Import fixtures (docs/architecture.md)

Recorded input for `import-test.mjs`, which is why that suite costs **nothing** — no agent,
no network, no `claude` or `codex` binary.

- `claude-project/**.jsonl` — Claude Code transcripts, in the on-disk shape from
  `~/.claude/projects/<escaped-cwd>/<session-id>.jsonl`. The test points
  **`CLAUDE_CONFIG_DIR`** at this directory's parent, which the SDK honours (verified
  2026-08-26), so `listSessions()` / `getSessionMessages()` run their REAL implementations
  against these files. That matters: the thing most likely to break is the chain
  resolution and block mapping, and a hand-rolled fake of the SDK would test neither.
- `codex-thread.json` — one `Thread` as `thread/read` returns it. Codex's store is only
  reachable over JSON-RPC, so there is no equivalent directory trick; the test drives the
  exported `threadToTurns()` directly instead.

**These are trimmed by hand, not captured wholesale.** Every field present is a field one of
the adapters reads. Shapes were taken from real data (`codex app-server generate-ts` for the
Codex side, a live session for the Claude side) — the point of a fixture is to be a faithful
sample, so if a shape here disagrees with the installed CLI, the CLI is right.
