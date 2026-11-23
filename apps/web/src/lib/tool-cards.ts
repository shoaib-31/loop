// Turn raw tool_use / tool_result blocks into compact, human-readable card
// summaries for the session view. Pure TS — no framework deps.
//
// The goal: on a phone you don't want to read a 40-line Bash tool_result. You
// want "Bash: list files → 12 lines" and the option to expand. This module
// produces the label + a short one-liner; the component owns expand/collapse.

import type { Block } from "./types";

// `icon` is a NAME, not a glyph — the component maps it to a lucide icon. Keeping
// this module free of React/JSX means the tool-name logic stays plain testable TS.
export type ToolIcon =
  | 'terminal'
  | 'file'
  | 'pencil'
  | 'search'
  | 'globe'
  | 'bot'
  | 'check'
  | 'question'
  | 'plug'
  | 'tool';

export type ToolCard = {
  title: string; // e.g. "Bash", "Edit", "Read"
  subtitle: string; // e.g. the command, the file path, the query
  icon: ToolIcon;
};

function firstLine(s: string, max = 120): string {
  const line = (s ?? "").split("\n").find((l) => l.trim()) ?? "";
  return line.length > max ? line.slice(0, max - 1) + "…" : line;
}

function str(v: unknown): string {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// Map a tool_use block to a card. Handles the common Claude Code tools by name;
// falls back to a generic label for anything else (incl. MCP tools).
export function toolUseCard(name: string | undefined, input: unknown): ToolCard {
  const n = name ?? "tool";
  const i = (input ?? {}) as Record<string, unknown>;

  switch (n) {
    case "Bash":
      return { title: "Bash", icon: "terminal", subtitle: firstLine(str(i.command ?? i.description)) };
    case "Read":
      return { title: "Read", icon: "file", subtitle: str(i.file_path) };
    case "Write":
      return { title: "Write", icon: "pencil", subtitle: str(i.file_path) };
    case "Edit":
      return { title: "Edit", icon: "pencil", subtitle: str(i.file_path) };
    case "Glob":
      return { title: "Glob", icon: "search", subtitle: str(i.pattern) };
    case "Grep":
      return { title: "Grep", icon: "search", subtitle: str(i.pattern) };
    case "Task":
    case "Agent":
      return { title: "Agent", icon: "bot", subtitle: firstLine(str(i.description ?? i.prompt)) };
    case "WebFetch":
      return { title: "WebFetch", icon: "globe", subtitle: str(i.url) };
    case "WebSearch":
      return { title: "WebSearch", icon: "globe", subtitle: str(i.query) };
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate":
      return { title: n, icon: "check", subtitle: "" };
    case "AskUserQuestion": {
      // the important one for us — Claude is asking the human to decide
      const qs = (i.questions as Array<{ question?: string }> | undefined) ?? [];
      return {
        title: "Question",
        icon: "question",
        subtitle: firstLine(qs.map((q) => q?.question).filter(Boolean).join(" · ")),
      };
    }
    default: {
      // MCP tools look like mcp__server__tool
      if (n.startsWith("mcp__")) {
        const parts = n.split("__");
        return { title: parts[2] ?? n, icon: "plug", subtitle: parts[1] ?? "" };
      }
      return { title: n, icon: "tool", subtitle: firstLine(str(input)) };
    }
  }
}

// --- AskUserQuestion: the decision moment ---------------------------------
// Claude asked the human to choose. We render these as tappable option buttons
// (not raw JSON), and tapping option i sends its 1-based number to the TUI —
// which is exactly the keypress the TUI's select menu expects.

export type QuestionOption = { label: string; description?: string };
export type ParsedQuestion = {
  question: string;
  header?: string;
  multiSelect: boolean;
  options: QuestionOption[];
};

export function parseQuestions(input: unknown): ParsedQuestion[] {
  const qs = (input as { questions?: unknown } | null)?.questions;
  if (!Array.isArray(qs)) return [];
  return qs
    .map((q): ParsedQuestion => {
      const opts = Array.isArray(q?.options) ? q.options : [];
      return {
        question: str(q?.question),
        header: q?.header ? str(q.header) : undefined,
        multiSelect: !!q?.multiSelect,
        options: opts.map((o: unknown) => {
          const oo = (o ?? {}) as Record<string, unknown>;
          return {
            label: str(oo.label),
            description: oo.description ? str(oo.description) : undefined,
          };
        }),
      };
    })
    .filter((q) => q.options.length > 0);
}

// A short preview line for a tool_result (the component can expand to full text).
export function toolResultPreview(text: string, isError: boolean): string {
  const trimmed = (text ?? "").trim();
  const lineCount = trimmed ? trimmed.split("\n").length : 0;
  const head = firstLine(trimmed, 100);
  const tag = isError ? "error" : `${lineCount} line${lineCount === 1 ? "" : "s"}`;
  return head ? `${head}${lineCount > 1 ? `  ·  ${tag}` : ""}` : tag;
}

// Convenience: does this block carry expandable detail worth a toggle?
export function isExpandable(block: Block): boolean {
  if (block.kind === "tool_result") return (block.text ?? "").split("\n").length > 1;
  if (block.kind === "tool_use") return true; // show full input on expand
  if (block.kind === "thinking") return true;
  return false;
}
