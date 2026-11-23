// Cross-engine handoff: turn one normalized Loop session into the starting context for
// another engine without pretending their native conversation ids are compatible.
//
// The normalized transcript is the boundary. Claude and Codex can both READ this brief,
// even though neither can resume the other's vendor session. The target starts a fresh
// native conversation in the SAME working directory, while the source remains readable
// and resumable.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Session } from "./session.mjs";

const run = promisify(execFile);

export const HANDOFF_CONTEXT_LIMIT = 48_000;
const BLOCK_LIMIT = 6_000;
const WORKSPACE_LIMIT = 20_000;

const engineLabel = (id) => id === "claude-code" ? "Claude Code" : id === "codex" ? "Codex" : id;

function clipped(value, limit = BLOCK_LIMIT) {
  const text = String(value ?? "").trim();
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[…${text.length - limit} characters omitted…]`;
}

function stableJson(value) {
  try { return JSON.stringify(value, null, 2); }
  catch { return String(value); }
}

/** Render one normalized turn as provider-neutral handoff notes. Thinking is deliberately
 * omitted: it is display/debug material, not a durable claim the next agent should inherit. */
export function renderHandoffTurn(turn) {
  const parts = [`[${turn?.role === "user" ? "HUMAN" : "AGENT"}]`];
  for (const block of Array.isArray(turn?.blocks) ? turn.blocks : []) {
    if (block?.kind === "text" && block.text?.trim()) parts.push(clipped(block.text));
    else if (block?.kind === "tool_use") {
      const name = block.name || "tool";
      parts.push(`[TOOL CALL: ${name}]\n${clipped(stableJson(block.input))}`);
    } else if (block?.kind === "tool_result") {
      parts.push(`[TOOL RESULT${block.is_error ? " — ERROR" : ""}]\n${clipped(block.text)}`);
    }
  }
  return parts.length > 1 ? parts.join("\n") : "";
}

/** Keep the newest complete turns that fit. The latest intent is more useful than the
 * first greeting, and cutting only between turns keeps role attribution unambiguous. */
export function renderHandoffTranscript(turns, { limit = HANDOFF_CONTEXT_LIMIT } = {}) {
  const rendered = (Array.isArray(turns) ? turns : [])
    .map(renderHandoffTurn)
    .filter(Boolean);
  const kept = [];
  let size = 0;
  for (let i = rendered.length - 1; i >= 0; i--) {
    const next = rendered[i];
    if (kept.length && size + next.length + 2 > limit) break;
    // One giant latest turn is still more useful clipped than an empty handoff.
    const value = !kept.length && next.length > limit ? clipped(next, limit) : next;
    kept.unshift(value);
    size += value.length + 2;
  }
  const omitted = rendered.length - kept.length;
  return {
    text: `${omitted ? `[${omitted} earlier turn${omitted === 1 ? "" : "s"} omitted]\n\n` : ""}${kept.join("\n\n")}`,
    includedTurns: kept.length,
    omittedTurns: omitted,
  };
}

async function git(cwd, args) {
  try {
    const { stdout } = await run("git", args, { cwd, timeout: 5000, maxBuffer: WORKSPACE_LIMIT });
    return stdout.trim();
  } catch (error) {
    // Not being a Git repository is a normal state. A timeout or a very large response is
    // also not allowed to block a handoff; the target can inspect the directory itself.
    return error?.code === 128 || error?.code === "ENOENT" ? "" : "(could not read Git state)";
  }
}

/** A small factual snapshot, not a diff dump. The target is in the same cwd and can inspect
 * files directly; this just makes branch and uncommitted work impossible to overlook. */
export async function workspaceSnapshot(cwd) {
  const [status, unstaged, staged] = await Promise.all([
    git(cwd, ["status", "--short", "--branch"]),
    git(cwd, ["diff", "--stat"]),
    git(cwd, ["diff", "--cached", "--stat"]),
  ]);
  if (!status && !unstaged && !staged) return "No Git worktree information available.";
  return [
    status && `git status --short --branch:\n${status}`,
    unstaged && `unstaged diff stat:\n${unstaged}`,
    staged && `staged diff stat:\n${staged}`,
  ].filter(Boolean).join("\n\n");
}

export function buildHandoffPrompt({ source, targetEngine, workspace, instruction = null }) {
  const transcript = renderHandoffTranscript(source.turns);
  const extra = typeof instruction === "string" && instruction.trim()
    ? `\n\nHUMAN HANDOFF INSTRUCTION\n${clipped(instruction, 4_000)}`
    : "";
  return {
    prompt: `You are taking over an existing coding task from ${engineLabel(source.engineId)}.

This is a cross-engine handoff into a NEW ${engineLabel(targetEngine)} conversation. You do not
have the source provider's native session. Treat the material below as handoff notes, then verify
it against the actual repository. Work in the current directory: ${source.cwd}

Continue the latest human intent. Do not merely summarize the handoff and do not redo completed
work. Inspect the relevant files and current worktree before editing. If the notes conflict with
the repository, the repository is authoritative.${extra}

WORKSPACE SNAPSHOT
${clipped(workspace, WORKSPACE_LIMIT)}

RECENT CONVERSATION
${transcript.text}

Continue the task from here.`,
    includedTurns: transcript.includedTurns,
    omittedTurns: transcript.omittedTurns,
  };
}

/** Validate and prepare the target Session, but do not start it. The server must attach push
 * and persistence listeners first or a fast first event could be lost. */
export async function prepareHandoff({
  source,
  targetEngine,
  model = null,
  engineOptions = {},
  instruction = null,
  SessionClass = Session,
  inspectWorkspace = workspaceSnapshot,
}) {
  if (!source) throw Object.assign(new Error("source session not found"), { status: 404 });
  if (!targetEngine) throw Object.assign(new Error("target engine is required"), { status: 400 });
  if (targetEngine === source.engineId)
    throw Object.assign(new Error(`session already uses engine "${targetEngine}"`), { status: 409 });
  if (!source.turns?.length)
    throw Object.assign(new Error("session has no completed conversation to hand off"), { status: 409 });
  if (source.pending)
    throw Object.assign(new Error("answer or decline the pending question before handing off"), { status: 409 });
  if (source.busy)
    throw Object.assign(new Error("the agent is still working — wait for it or stop it before handing off"), { status: 409 });

  const workspace = await inspectWorkspace(source.cwd);
  const context = buildHandoffPrompt({ source, targetEngine, workspace, instruction });
  const target = new SessionClass({
    cwd: source.cwd,
    engine: targetEngine,
    model,
    engineOptions: engineOptions && typeof engineOptions === "object" ? engineOptions : {},
  });
  target.handoffFrom = {
    sessionId: source.id,
    engine: source.engineId,
    turnCount: source.turns.length,
    createdAt: new Date().toISOString(),
  };
  // Useful immediately, before the target provider generates its own title.
  target.title = `${source.title || source.cwd.split("/").filter(Boolean).pop() || "Session"} → ${engineLabel(targetEngine)}`;

  return { session: target, ...context };
}

export { engineLabel };
