// The dashboard TUI — what bare `loop` drops you into (docs/architecture.md).
//
// FULLSCREEN, TWO VIEWS. It owns the whole terminal (`alternateScreen` is set at the
// render() call in main.mjs), the input is pinned to the bottom edge, and whatever
// vertical space is left over goes to the thing you came to look at:
//
//   LIST (→ to enter)                      SESSION (← to go back)
//   ┌ header ─ exposure + QR + ● count ┐   loop-eng · a1b2 · working      ← just the name
//   ├ sessions ────────────────────────┤   ⏺ Read(server.mjs)
//   │  ▸ 1 ● loop-eng  needs you       │     ⎿  1200 lines
//   │    2 ◐ api       working         │   ⏺ Adding the route now.
//   │                                  │   ┌ ● WAITING FOR YOU ──────────┐
//   │       (all the spare rows)       │   └─────────────────────────────┘
//   └──────────────────────────────────┘   (transcript takes the spare rows)
//   ┌ input ─ starts a NEW session ────┐   ┌ input ─ reply / answer ─────┐
//   └──────────────────────────────────┘   └─────────────────────────────┘
//
// WHY THE HEIGHTS ARE COMPUTED, NOT JUST flexGrow'd: the transcript is rendered from a
// pre-wrapped LINE list (tui/blocks.mjs), so to show its tail — or to scroll it — we
// need to know exactly how many rows the viewport has. Every line is rendered with
// wrap="truncate" so Ink can never re-flow it behind our back and desynchronise the
// count. `chromeRows` is therefore load-bearing: it must match what's actually drawn.
//
// ←/→ only navigate when the input is EMPTY: they move the text cursor otherwise, and
// stealing that would break editing a half-typed prompt.
//
// THE WHEEL SCROLLS (tui/mouse.mjs). Ink has no mouse support, so reports arrive as typed
// text; the input ignores them and this file acts on them.
//
// A PARKED QUESTION OVERRIDES THE LIST VIEW. Hiding the one thing this product exists
// to surface — because you happened to be on the other screen — isn't a tradeoff worth
// making. The single exception is `^N` ("new"), where you've said explicitly that you're
// writing a fresh prompt and a stray "1" must not be swallowed as an answer.
//
// PURE CLIENT (PROBLEM 9): every mutation is an HTTP call to the daemon. This file
// holds zero session state that isn't a cache of what the daemon streamed.
//
// NO JSX ON PURPOSE: the CLI ships as a compiled binary with no build step, so a
// transform would be one more thing to keep working. `h` is React.createElement.

import React, { useState, useEffect, useCallback, useRef, useMemo } from "react";
import { Box, Text, useApp, useInput, useWindowSize } from "ink";
// OUR text input, not `ink-text-input` — that one inserts any key it doesn't recognise,
// which typed "r" for ^R, typed mouse reports into the prompt, and made the workaround for
// both corrupt the cursor. tui/text-input.mjs inverts the rule: it inserts only
// recognisable typed text. That's what makes this file free of undo tricks.
import { TextInput } from "./text-input.mjs";
import { MODE_LABEL } from "../expose.mjs";
import {
  transcriptLines, transcriptWindow, wrapSpans, truncate, cellWidth,
  workingLabel, workingLine,
} from "./blocks.mjs";
import { parseMouse } from "./mouse.mjs";

const h = React.createElement;

const MODE_COLOR = { local: "gray", serve: "green", funnel: "yellow" };

/** SGR colour escapes, which the QR renderer emits and which occupy no columns. */
const ANSI = /\x1b\[[0-9;]*m/g;

// How often the exposure badge re-asks Tailscale. With a watcher (the normal case) this is
// only a backstop for an event that never came; without one it IS the mechanism.
//
// The env override exists so a test can prove the WATCH path: leave the poll at 5s and a
// "the badge updated" assertion passes either way, which is no test at all.
const POLL_PROBE_MS = Number(process.env.LOOP_EXPOSURE_POLL_MS ?? 5000);
const BACKSTOP_PROBE_MS = Number(process.env.LOOP_EXPOSURE_BACKSTOP_MS ?? 30000);

// Fixed heights, in rows. These are what `chromeRows` adds up — change a border or a
// line here and the matching number below has to move with it, or the transcript will
// either overflow the screen or leave a dead band at the bottom.
const ROWS = {
  header: 5,     // round border (2) + name/engine, url, push  (list view only)
  title: 1,      // the session name                           (session view only)
  listLabel: 1,  // " sessions  ↑↓ move"
  listBorder: 2,
  input: 3,      // round border (2) + the line itself
  footer: 1,
};

// ---- helpers -------------------------------------------------------------

const ago = (ts) => {
  if (!ts) return "";
  const s = Math.max(0, (Date.now() - new Date(ts).getTime()) / 1000);
  if (s < 60) return `${Math.floor(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h`;
  return `${Math.floor(s / 86400)}d`;
};

/** Hide the pairing token in the on-screen URL, keeping enough to recognise it. */
const redactToken = (u) =>
  String(u ?? "").replace(/([?&]token=)([^&]+)/, (_, p, t) => `${p}${t.slice(0, 4)}…`);

const oneLine = (v, max = 80) => {
  const s = typeof v === "string" ? v : JSON.stringify(v ?? "");
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? flat.slice(0, max) + "…" : flat;
};

// ---- the footer ----------------------------------------------------------

/**
 * The keys for a view, MOST IMPORTANT FIRST — because a narrow terminal drops from the
 * right. `^C detach` is last on purpose: it's the one key every terminal user already
 * knows, so it's the cheapest one to lose.
 */
function keysFor({ answering, inSession, inImport = false, armed = false, expanded = false, working = false }) {
  // "wheel/PgUp scroll" names the wheel FIRST because it's the gesture people try before
  // reading anything — and it did nothing until it was wired up, which is precisely the
  // failure this footer exists to prevent.
  //
  // `^O` is labelled with what it will DO, not with the state it's in — "^O collapse"
  // while expanded. A toggle labelled with its current state reads backwards to
  // everyone who hasn't read the source.
  const detail = expanded ? "^O collapse" : "^O expand";
  // `^X stop` is advertised ONLY while the agent is actually working, and placed high
  // because that is exactly when it's urgent. Listing it permanently would push a real
  // key off a narrow footer to advertise one that has nothing to do.
  const stop = working ? ["^X stop"] : [];
  // The import view gets its OWN key list, and the labels change once a row is armed —
  // "⏎ confirm" is the only honest name for a key that is about to point an agent at a
  // directory, and it must not read the same as the ⏎ that merely armed it.
  if (inImport)
    return armed
      ? ["⏎ CONFIRM import", "↑↓ cancel", "⇥ close", "^C detach"]
      : ["⏎ adopt", "↑↓ select", "type to filter", "⇥ close", "^C detach"];
  if (answering)
    return ["⏎ answer", "esc decline", "← back", "↑↓ session", "wheel/PgUp scroll", detail, "^N new", "^E expose", "^R qr", "^C detach"];
  if (inSession)
    return ["⏎ reply", ...stop, "^T handoff", "← back", "↑↓ session", "wheel/PgUp/PgDn scroll", detail, "^N new", "^E expose", "^R qr", "^C detach"];
  return ["⏎ start", "→ open", "↑↓ select", "⇥ import", "^N new", "^E expose", "^R qr", "^C detach"];
}

/**
 * Fit as many whole keys as the width allows, and say how many were dropped.
 *
 * Truncating the string instead would leave a mangled `^C deta…`, which reads as a
 * rendering bug and — worse — silently hides keys with no sign that anything is
 * missing. An unadvertised key may as well not exist; that's the whole lesson of the
 * arrows being reported "broken".
 */
function footer(keys, cols) {
  const SEP = "   ";
  let line = "";
  for (const [i, k] of keys.entries()) {
    const next = line ? line + SEP + k : k;
    const left = keys.length - i - 1;
    const tail = left > 0 ? `  +${left}` : "";
    if (next.length + tail.length > cols) {
      const dropped = keys.length - i;
      return line ? `${line}  +${dropped}` : k.slice(0, cols);
    }
    line = next;
  }
  return line;
}

/** Render one { spans } line as a single non-reflowable terminal row. */
const Line = ({ line }) =>
  h(
    Text,
    { wrap: "truncate" },
    // A blank line needs a space, or Ink can collapse the row and every offset below
    // it shifts by one — which is exactly the desync the line list exists to avoid.
    line.spans.length === 0
      ? " "
      : line.spans.map((s, i) =>
          h(
            Text,
            {
              key: i,
              color: s.color,
              dimColor: s.dimColor,
              bold: s.bold,
              italic: s.italic,
              // Every style the formatter can produce has to be listed here, or it is
              // silently dropped: `~~struck~~` and `[links](…)` render as plain text with no
              // sign that anything was meant to be different.
              underline: s.underline,
              strikethrough: s.strikethrough,
            },
            s.text || " "
          )
        )
  );

// ---- header (list view) --------------------------------------------------

function Header({ mode, url, push, sessionCount, engine, waiting = 0 }) {
  const label = MODE_LABEL[mode] ?? "LOCAL";
  return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1, flexShrink: 0 },
    h(
      Box,
      { justifyContent: "space-between" },
      h(Text, { bold: true, color: "cyan" }, "loop"),
      h(
        Box,
        null,
        h(Text, { dimColor: true }, `${engine}  ·  `),
        h(Text, { color: MODE_COLOR[mode] ?? "gray", bold: true }, `${label} ●`)
      )
    ),
    // The token is REDACTED here. It's a bearer credential for every session on this
    // machine, and the dashboard is the one surface likely to end up in a screenshot or
    // a screen share. The QR (^R) still carries the real thing — that's what pairing is
    // for — and `loop` prints the full URL once at startup, above the TUI.
    h(Text, { dimColor: true, wrap: "truncate" }, redactToken(url)),
    h(
      Text,
      { wrap: "truncate" },
      h(
        Text,
        { dimColor: true },
        `push: ${push == null ? "?" : push === 0 ? "no devices" : `${push} device${push === 1 ? "" : "s"}`}` +
          `   sessions: ${sessionCount}` +
          (mode === "local" ? "   (phone unreachable — ^E to expose)" : "")
      ),
      // A parked question in an UNSELECTED session is otherwise invisible — and that's
      // the one thing this whole product exists to surface.
      waiting > 0
        ? h(Text, { color: "yellow", bold: true }, `   ● ${waiting} waiting on you`)
        : null
    )
  );
}

// The QR is ~25 rows: essential on first pair, pure noise afterwards. It's a separate
// block from the header so it can be toggled in BOTH views — a `^R` that silently did
// nothing in the session view would read as a broken key.
function QrPanel({ qr }) {
  return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: "cyan", paddingX: 1, flexShrink: 0 },
    qr.map((line, i) => h(Text, { key: i }, line)),
    h(Text, { dimColor: true }, "scan to pair your phone  ·  ^R to hide")
  );
}

// ---- the session title (session view) -----------------------------------

// "just show its name on top" — one row. You already know which session you're in;
// spending five rows restating the fleet's exposure state is space the conversation
// wants.
// ONE definition of what a session's state is CALLED, because two places say it — the
// fleet row and the in-session title — and a disagreement between them reads as a bug.
//
// "sleeping" is deliberately not folded into "idle". A hibernated session has no agent
// process (docs/architecture.md), so the next reply spends a few seconds booting one;
// a reader who was told "idle" would read that pause as the wrapper having hung.
function stateLabel(session, status = session.status) {
  if (session.pending) return "needs a decision";
  if (status === "error") return "error";
  if (status === "hibernated" || session.hibernated) return "sleeping";
  // A live process is not a working agent — it stays up for 30 minutes after its last word
  // (PROBLEM 15). `busy` says which; a daemon too old to send it keeps the old reading.
  if (status === "running") return session.busy === false ? "idle" : "working";
  return "idle";
}

function SessionTitle({ session, conn, waiting, status }) {
  const state = stateLabel(session, status);
  return h(
    Box,
    { flexShrink: 0 },
    h(Text, { color: "cyan", bold: true }, `  ${session.projectName ?? "session"}`),
    session.title ? h(Text, { bold: true, wrap: "truncate" }, `  ${oneLine(session.title, 50)}`) : null,
    h(Text, { dimColor: true }, `  ${session.id.slice(0, 4)}`),
    h(Text, { color: session.pending ? "yellow" : "gray" }, `  ${state}`),
    h(Text, { dimColor: true }, `  ${conn}`),
    // Another session needing you must survive being inside this one.
    waiting > (session.pending ? 1 : 0)
      ? h(Text, { color: "yellow", bold: true }, `   ● ${waiting} waiting  (← list)`)
      : null
  );
}

// ---- session list --------------------------------------------------------

// `rows` is [{ s, n }] — n is the session's position in the WHOLE fleet, passed in
// rather than derived from the array index, because a windowed list would otherwise
// renumber its rows as you scroll and `Alt+n` would stop matching the screen.
function SessionList({ rows, selectedId, height, hiddenAbove = 0, hiddenBelow = 0 }) {
  if (!rows.length)
    return h(
      Box,
      { flexGrow: 1, paddingX: 1 },
      h(Text, { dimColor: true }, "no sessions yet — type a prompt below to start one")
    );

  return h(
    Box,
    // flexGrow so the box keeps the spare rows even when there are only two sessions:
    // the list IS the workspace, and a two-row island in an empty screen doesn't read
    // as one.
    { flexDirection: "column", flexGrow: 1, height },
    hiddenAbove > 0 ? h(Text, { dimColor: true }, `   ↑ ${hiddenAbove} more`) : null,
    rows.map(({ s, n }) => {
      const isSel = s.id === selectedId;
      // ● = needs you. This is the single most important glyph in the UI.
      const dot = s.pending ? "●" : s.status === "running" ? "◐" : "○";
      const dotColor = s.pending ? "yellow" : s.status === "error" ? "red" : "gray";
      const state = stateLabel(s);
      return h(
        Box,
        { key: s.id, paddingX: 1 },
        h(Text, { color: "cyan", bold: true }, isSel ? "▸ " : "  "),
        // A number per row, so switching is one keystroke and needs no hunting.
        h(Text, { dimColor: !isSel }, n <= 9 ? `${n} ` : "  "),
        h(Text, { color: dotColor }, dot + " "),
        h(Text, { bold: isSel, wrap: "truncate" }, (s.projectName ?? "session").padEnd(12).slice(0, 12)),
        // The project name is just the cwd basename, so two runs in the SAME repo look
        // identical — which is the common case. The id prefix is what tells them apart.
        h(Text, { dimColor: true }, " " + s.id.slice(0, 4)),
        h(Text, { color: s.pending ? "yellow" : "gray" }, " " + state.padEnd(16).slice(0, 16)),
        h(Text, { dimColor: true }, ago(s.lastTs).padStart(4)),
        // Claude's own title first (docs/architecture.md) — it is what tells two runs in
        // one repo apart at a glance; the preview trails it, dimmed, in whatever room is left.
        h(
          Text,
          { wrap: "truncate" },
          s.title ? "  " + oneLine(s.title, 40) : "",
          h(Text, { dimColor: true }, s.preview ? "  " + oneLine(s.preview, 60) : "")
        )
      );
    }),
    hiddenBelow > 0 ? h(Text, { dimColor: true }, `   ↓ ${hiddenBelow} more`) : null
  );
}

// ---- the import picker (docs/architecture.md) --------------------------
//
// Conversations that already exist in an engine's own store. Two things make this row
// layout different from the fleet list above, and both are deliberate:
//
//  1. THE CWD IS SHOWN ON EVERY ROW, not just the project basename. Adopting a conversation
//     adopts its working directory, and the daemon auto-allows every tool — so "which
//     directory am I about to point an agent at" is the single most important fact here, and
//     two different repos can easily share a basename.
//  2. ⏎ ARMS, it does not adopt. Everywhere else in this TUI ⏎ means go; here it asks first,
//     for the same reason.
function ImportList({ rows, selectedRef, height, hiddenAbove = 0, hiddenBelow = 0, armedRef = null, cols = 80 }) {
  if (!rows.length)
    return h(
      Box,
      { flexDirection: "column", flexGrow: 1, paddingX: 1 },
      h(Text, { dimColor: true }, "no conversations found — nothing to import")
    );

  // The cwd gets whatever the title doesn't. Budgeted in columns rather than left to wrap,
  // because a wrapped row is an extra row the layout never allocated (PROBLEM 14f).
  const titleW = Math.max(16, Math.min(40, Math.floor(cols * 0.34)));
  const cwdW = Math.max(12, cols - titleW - 22);

  return h(
    Box,
    { flexDirection: "column", flexGrow: 1, height },
    hiddenAbove > 0 ? h(Text, { dimColor: true }, `   ↑ ${hiddenAbove} more`) : null,
    rows.map((c) => {
      const isSel = c.ref === selectedRef;
      const isArmed = c.ref === armedRef;
      return h(
        Box,
        { key: `${c.engine}:${c.ref}`, paddingX: 1 },
        h(Text, { color: isArmed ? "yellow" : "cyan", bold: true }, isArmed ? "? " : isSel ? "▸ " : "  "),
        // Which engine owns it — the whole point of the seam is that this list is mixed.
        h(Text, { dimColor: !isSel, color: c.engine === "codex" ? "magenta" : "blue" },
          (c.engine === "codex" ? "codex" : "claude").padEnd(6)),
        h(Text, { bold: isSel, wrap: "truncate" }, " " + oneLine(c.title, titleW).padEnd(titleW).slice(0, titleW)),
        h(Text, { dimColor: true }, " " + ago(c.lastTs).padStart(4)),
        // Already imported: ⏎ opens it rather than adopting a second writer onto one file.
        c.adoptedAs
          ? h(Text, { color: "green" }, "  ✓ imported")
          : h(Text, { dimColor: true, wrap: "truncate" }, "  " + tailPath(c.cwd, cwdW))
      );
    }),
    hiddenBelow > 0 ? h(Text, { dimColor: true }, `   ↓ ${hiddenBelow} more`) : null
  );
}

/** Keep the END of a path — the leaf directories are what identify a project, not `/Users`. */
function tailPath(p, max) {
  const s = String(p ?? "");
  if (!s) return "(no directory)";
  return s.length <= max ? s : "…" + s.slice(-(max - 1));
}

// ---- transcript ----------------------------------------------------------

// Renders a WINDOW of the pre-wrapped line list. `offset` counts lines up from the
// bottom, so 0 is "live, pinned to the newest output" — the state you want 95% of the
// time, and the one a stream must not knock you out of.
function Transcript({ lines, rows, offset }) {
  if (!lines.length)
    return h(
      Box,
      { height: rows, paddingX: 1 },
      h(Text, { dimColor: true }, "waiting for the agent…")
    );

  // The SAME window function the click handler hit-tests with (blocks.mjs). Two copies of
  // this arithmetic would not crash — they'd open a different tool call than the one you
  // clicked, which is far harder to notice.
  const { start, end, textRows, below } = transcriptWindow({ total: lines.length, rows, offset });
  const visible = lines.slice(start, end);

  return h(
    Box,
    { flexDirection: "column", height: rows, paddingX: 1, overflow: "hidden" },
    visible.map((line, i) => h(Line, { key: start + i, line })),
    // Pad AFTER the text, so a short conversation reads top-down from under the title
    // instead of being pushed to the bottom of an empty screen. A long one is unaffected
    // (there's no slack to pad), so it stays anchored to the newest line.
    ...Array.from({ length: Math.max(0, textRows - visible.length) }, (_, i) =>
      h(Text, { key: `pad${i}` }, " ")
    ),
    // Scrolled up = you are NOT seeing the latest. Say so, or a stale screen looks like
    // a stalled agent.
    below > 0
      ? h(Text, { color: "yellow", wrap: "truncate" },
          `   ↓ ${below} more line${below === 1 ? "" : "s"}  ·  PgDn / End`)
      : null
  );
}

// ---- the decision card = the USP in the terminal -------------------------

/**
 * The card's lines, pre-wrapped, so its height is known before layout. Guessing it
 * would mean the transcript either overlaps the card or leaves a gap above the input.
 */
function cardLines(question, cols) {
  const body = Math.max(8, cols - 4); // border + paddingX
  const lines = [];
  lines.push({ spans: [
    { text: "● WAITING FOR YOU", color: "yellow", bold: true },
    question.header ? { text: `  [${question.header}]`, dimColor: true } : { text: "" },
  ] });
  lines.push(...wrapSpans([{ text: String(question.question ?? ""), bold: true }], body));
  for (const [i, o] of (question.options ?? []).entries())
    lines.push({ spans: [
      { text: `  ${i + 1}. `, color: "green" },
      { text: truncate(String(o.label ?? ""), body - 6) },
      o.description
        ? { text: truncate(` — ${oneLine(o.description, 200)}`, Math.max(0, body - 8 - String(o.label ?? "").length)), dimColor: true }
        : { text: "" },
    ] });
  // Truncated, never wrapped: the card's height is counted from this array, so a wrapped
  // row would be one the budget never allocated — the overflow-and-strobe of PROBLEM 14b.
  lines.push({ spans: [{
    text: truncate(
      (question.multiSelect ? "type numbers (e.g. 1,3), or free text" : "type a number, or free text") +
        "  ·  esc to decline",
      body
    ),
    dimColor: true,
  }] });
  return lines;
}

function DecisionCard({ lines }) {
  return h(
    Box,
    { flexDirection: "column", borderStyle: "round", borderColor: "yellow", paddingX: 1, flexShrink: 0 },
    lines.map((line, i) => h(Line, { key: i, line }))
  );
}

// ---- the dashboard -------------------------------------------------------

export function Dashboard({
  client, initialUrl, initialMode, qr, cwd, engine, onExpose,
  // Re-probe the LIVE exposure state — see the effect below for why the header can't
  // just trust `initialMode`. Optional: without it the badge simply stays as it was,
  // which is what the layout test wants (it stubs the daemon, not Tailscale).
  onProbeMode = null,
  // Subscribe to exposure changes instead of asking on a timer: `cb => ({watching, stop})`.
  // Optional — without it the badge falls back to polling, which is what the tests that
  // don't care about this path get.
  onWatchExposure = null,
  // `loop "<prompt>"` already started a run, so open inside it — you asked for that
  // one thing, not for a fleet overview.
  initialView = "list",
}) {
  const { exit } = useApp();
  // Reactive: a resized terminal must re-budget the rows, or the input drifts off the
  // bottom edge and the transcript window stops matching what's drawn.
  const { columns, rows: termRows } = useWindowSize();
  const cols = Math.max(40, columns || 80);
  const totalRows = Math.max(10, termRows || 24);

  const [sessions, setSessions] = useState([]);
  // Selection is by ID, never by array index. The 2s poll re-sorts this list, so an
  // index silently starts pointing at a DIFFERENT session the moment one is added or
  // starts waiting — and back when text was routed by selection, that meant replying
  // into the wrong run.
  const [selectedId, setSelectedId] = useState(null);
  // "list" = the fleet; "session" = inside one conversation. → enters, ← leaves.
  const [view, setView] = useState(initialView);
  const [turns, setTurns] = useState([]);
  // In-flight text (docs/architecture.md). Kept OUT of `turns` so the transcript stays
  // the record and nothing renders twice.
  const [partial, setPartial] = useState(null);
  const [pending, setPending] = useState(null);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState(initialMode);
  const [url, setUrl] = useState(initialUrl);
  const [push, setPush] = useState(null);
  const [showQr, setShowQr] = useState(false);
  const [conn, setConn] = useState("connecting");
  // Lines scrolled up from the bottom. 0 = live.
  const [scroll, setScroll] = useState(0);
  // ^O: false = tool output collapsed to a row each (the prose is what you came for),
  // true = every result opened in full. Collapsed is the default because that's the
  // reading experience; expanding is the deliberate act.
  const [expanded, setExpanded] = useState(false);
  // Block keys CLICKED to differ from that default (see transcriptLines' XOR). Kept
  // separately so `^O` stays "all of them" without having to enumerate every step.
  const [toggled, setToggled] = useState(() => new Set());
  // ---- the import picker (PROBLEM 20) ----
  // Foreign conversations, fetched on demand: listing them means reading another tool's
  // store (and for Codex, spawning a short-lived app-server), which is far too expensive to
  // sit in the 2s fleet poll.
  const [conversations, setConversations] = useState([]);
  const [convState, setConvState] = useState("idle"); // idle | loading | ready | error
  const [convNote, setConvNote] = useState(null); // e.g. "stopped at 500"
  const [selectedRef, setSelectedRef] = useState(null);
  // The ref whose adoption is awaiting a second ⏎. Everywhere else in this TUI ⏎ means go;
  // here it asks, because adopting points a fully-permissioned agent at that conversation's
  // directory.
  const [armedRef, setArmedRef] = useState(null);
  // A handoff starts another provider process, so ^T is deliberately two-step. The arm
  // belongs to one session and is cancelled by navigation or typing.
  const [handoffArmedId, setHandoffArmedId] = useState(null);
  // { text, tone }. A dead-end keypress and a failed reply both belong on this line,
  // but painting "only one session" in red ⚠ would teach you to distrust the colour.
  const [notice, setNotice] = useState(null);
  const [busy, setBusy] = useState(false);
  // THE AGENT's busy, as opposed to `busy` above (= one of OUR requests is in flight). The
  // daemon's own verdict for the session on screen (PROBLEM 23), arriving on its stream —
  // null until it has spoken, which is how a pre-PROBLEM-23 daemon is told apart.
  const [agent, setAgent] = useState({ busy: null, since: null });
  // Last sign of life on the stream, for "no output for 2m". See workingLine().
  const lastActivity = useRef(0);
  // A once-a-second re-render while the agent works, so the elapsed time counts.
  const [, setTick] = useState(0);
  const say = useCallback((text) => setNotice(text ? { text, tone: "hint" } : null), []);
  const warn = useCallback((text) => setNotice(text ? { text, tone: "error" } : null), []);


  const closeStream = useRef(null);
  const watching = useRef(null);
  // ^N: you've said you're writing a NEW prompt, so a question arriving in the
  // highlighted session must not drag the view (and your keystrokes) back into it.
  const composingNew = useRef(false);
  const current = sessions.find((s) => s.id === selectedId) ?? null;

  useEffect(() => { setHandoffArmedId(null); }, [selectedId, view, input]);

  // Poll the daemon for the session list + push state. Polling (not a socket)
  // because it's a whole-fleet view and 2s of staleness is invisible; the
  // per-session socket carries anything latency-sensitive.
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      try {
        const [list, health] = await Promise.all([client.sessions(), client.health()]);
        if (stop) return;
        setSessions(list);
        // Keep the selection pointing at something real: hold it if it's still in the
        // list, otherwise fall to the top row (which is the most urgent one — the
        // daemon sorts waiting-on-you first). Selection is only a HIGHLIGHT now; the
        // view decides where typed text goes, so re-selecting can't misroute a reply.
        setSelectedId((id) => (id && list.some((s) => s.id === id) ? id : list[0]?.id ?? null));
        setPush(health?.push?.subscriptions ?? 0);
        // Show the QR automatically until a device has actually subscribed — that's
        // the only reliable signal that pairing succeeded.
        if ((health?.push?.subscriptions ?? 0) === 0 && list.length === 0) setShowQr(true);
      } catch {
        if (!stop) setConn("daemon unreachable");
      }
      if (!stop) setTimeout(tick, 2000);
    };
    tick();
    return () => { stop = true; };
  }, [client]);

  // RE-PROBE THE EXPOSURE BADGE. `initialMode` is a snapshot taken once during startup,
  // and until now only `^E` ever replaced it — so the header kept asserting TAILNET long
  // after that stopped being true, and the only thing that appeared to "fix" it was
  // restarting the CLI (which just took a fresh snapshot).
  //
  // It goes stale on its own because exposure is not ours alone to control: a
  // `tailscale serve reset` in another shell, `tailscale down`/a logout
  // drops it, and a `loop share` in another terminal flips it to PUBLIC and back. The
  // badge is a safety signal — it's how you know whether the box is on the public
  // internet — so a stale one is the one kind of wrong that actually matters here.
  //
  // Slower than the session poll (`tailscale serve status` is a process spawn, not an
  // HTTP call) and deliberately never touching state when the answer is unchanged, so
  // the mode is not a re-render trigger every few seconds.
  // PUSHED, NOT POLLED, when Tailscale gives us something to listen to. `onWatchExposure`
  // fires whenever Tailscale's state directory changes (expose.mjs explains why that's the
  // only available signal — the IPN bus says nothing about serve/funnel), and each event
  // costs one probe instead of one probe every few seconds forever.
  //
  // THE POLL STAYS, SLOWED DOWN. The watch is a hint from a directory, not a contract: an
  // event we never get would leave the badge wrong indefinitely, and this badge is the one
  // that says whether the machine is on the public internet. So watching buys latency
  // (sub-second instead of up-to-5s) and quiet (no work when nothing moves) — not the right
  // to stop checking. Without a watcher it degrades to exactly the old behaviour.
  useEffect(() => {
    if (!onProbeMode) return;
    let stop = false;
    let timer = null;

    const probe = async () => {
      try {
        const live = await onProbeMode();
        if (!stop && live) {
          setMode((m) => (m === live.mode ? m : live.mode));
          if (live.url) setUrl((u) => (u === live.url ? u : live.url));
        }
      } catch { /* exposure probing must never take the TUI down */ }
    };

    // Subscribe FIRST, so the interval can be chosen from whether it worked.
    const sub = onWatchExposure?.((() => { if (!stop) probe(); })) ?? { watching: false, stop() {} };
    const every = sub.watching ? BACKSTOP_PROBE_MS : POLL_PROBE_MS;

    const tick = async () => {
      await probe();
      if (!stop) timer = setTimeout(tick, every);
    };
    tick();
    return () => { stop = true; clearTimeout(timer); sub.stop?.(); };
  }, [onProbeMode, onWatchExposure]);

  // Follow the selected session. Re-subscribes whenever the selection changes.
  useEffect(() => {
    if (!current) return;
    if (watching.current === current.id) return;
    watching.current = current.id;
    closeStream.current?.();
    setTurns([]);
    setPartial(null);
    setPending(null);
    setAgent({ busy: null, since: null }); // that verdict was about the OLD session
    setScroll(0); // a different conversation starts at ITS latest, not your old offset
    setToggled(new Set()); // …and with nothing clicked open; those keys were that session's

    closeStream.current = client.stream(
      current.id,
      (msg) => {
        if (msg.type === "history") { setTurns(msg.turns ?? []); setPartial(null); } // replace: reconnect replays
        // The completed turn supersedes what was streaming. Clearing here is what stops
        // the same sentence appearing twice — once as in-flight text, once as history.
        else if (msg.type === "turn") { setTurns((t) => [...t, msg.turn]); setPartial(null); lastActivity.current = Date.now(); }
        else if (msg.type === "delta") { setPartial(msg.partial ?? null); lastActivity.current = Date.now(); }
        else if (msg.type === "busy") {
          setAgent({ busy: !!msg.busy, since: msg.since ?? null });
          // The daemon's clock for the silence, not ours — or opening a session mid-silence
          // would show it as fresh (PROBLEM 23).
          if (msg.busy) lastActivity.current = msg.activityAt ? Date.parse(msg.activityAt) : Date.now();
        }
        else if (msg.type === "idle" || msg.type === "interrupted") setPartial(null);
        else if (msg.type === "pending") setPending(msg.question ?? null);
        else if (msg.type === "error") warn(msg.error);
      },
      { onStatus: setConn }
    );
    return () => { closeStream.current?.(); };
  }, [client, current?.id]);

  // A parked question PULLS YOU IN. The whole product is "the agent needs you, here's
  // the question" — so it must never sit behind a keystroke you didn't know to press.
  // Only for the session you're already on: yanking the screen away from a run you're
  // actively reading, because a different one asked something, would be worse than the
  // header's "● n waiting on you" and an ↑↓ away.
  useEffect(() => {
    // …and NOT while you're picking a conversation to import. That view's ⏎ confirms an
    // adoption, so switching under you would leave the next keystroke meaning something
    // else entirely — the same "text lands somewhere you weren't looking" failure that
    // made routing-by-selection wrong in PROBLEM 14a. The row keeps its ● regardless.
    if (view === "import") return;
    if (pending && !composingNew.current) { setView("session"); setScroll(0); }
    // DEPS ARE `[pending]` ONLY, deliberately — do not add `view`. This must fire when a
    // question ARRIVES, not when you navigate: with `view` in the deps, pressing ← or ^N
    // while a question is parked would immediately drag you back into the session.
  }, [pending]);

  // STREAMING TEXT GOES THROUGH THE TRANSCRIPT, NOT BESIDE IT.
  //
  // Appending the in-flight text as a synthetic final turn means it renders through the
  // exact same formatter as real output (so a partial sentence looks like the sentence it
  // becomes) and — the load-bearing part — it occupies the body's EXISTING row budget.
  // A separate "streaming" panel would be extra chrome rows, and one row more than the
  // terminal has is what makes the whole screen strobe (PROBLEM 14f).
  const displayTurns = useMemo(() => {
    if (!partial?.text) return turns;
    return [
      ...turns,
      {
        role: "assistant",
        blocks: [{ kind: partial.kind === "thinking" ? "thinking" : "text", text: partial.text }],
        ts: null,
      },
    ];
  }, [turns, partial]);

  // The formatted transcript. Recomputed only when the content or the width changes —
  // wrapping every turn on each 2s poll tick would be wasted work.
  const baseLines = useMemo(
    () => transcriptLines(displayTurns, { cols: cols - 2, expanded, toggled }),
    [displayTurns, cols, expanded, toggled]
  );

  // IS IT THE AGENT'S MOVE? The stream's verdict for the session on screen; else the polled
  // list's (same daemon field); else — a daemon from before PROBLEM 23 — the old guess,
  // which reads every live process as working for 30 minutes after its last word.
  const working =
    !!current && !pending &&
    (agent.busy ?? current.busy ?? current.status === "running");
  useEffect(() => {
    if (!working) return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [working]);

  // "✻ Running Bash… 13s" as the LAST TRANSCRIPT LINE, where Claude Code puts its own
  // spinner — and, being a line rather than a new piece of chrome, it costs the row budget
  // nothing, and the click/scroll arithmetic (which reads `lines`) stays the one copy.
  const startedAt = agent.since ? Date.parse(agent.since) : current?.busySince ? Date.parse(current.busySince) : null;
  const lines =
    working && view === "session"
      ? [
          ...baseLines,
          ...(baseLines.length ? [{ spans: [{ text: "" }] }] : []),
          workingLine({
            label: workingLabel(partial, turns),
            elapsedMs: startedAt ? Date.now() - startedAt : 0,
            quietMs: lastActivity.current ? Date.now() - lastActivity.current : 0,
            cols: cols - 2,
          }),
        ]
      : baseLines;

  /**
   * Load every page of foreign conversations, from every engine that can list them.
   *
   * ALL PAGES, not the first one, because the input FILTERS this list client-side — and a
   * filter that searches only the newest 50 of 179 conversations silently fails to find
   * things, which is worse than not offering a filter. The cap is a runaway guard, and when
   * it bites it SAYS so rather than quietly truncating.
   */
  const loadConversations = useCallback(async () => {
    setConvState("loading");
    setConvNote(null);
    try {
      const { engines: probes = [] } = await client.engines();
      const usable = probes.filter((e) => e.available && e.canListConversations);
      if (!usable.length) {
        setConversations([]);
        setConvState("ready");
        setConvNote("no engine on this machine can list conversations");
        return;
      }

      const MAX_ROWS = 500, MAX_PAGES = 12;
      const all = [];
      let capped = false;
      for (const e of usable) {
        let cursor = null;
        for (let page = 0; page < MAX_PAGES; page++) {
          // The cursor is OPAQUE — pass back exactly what came, never compute one.
          const r = await client.conversations({ engine: e.id, cursor, limit: 100 });
          all.push(...(r.conversations ?? []));
          cursor = r.nextCursor ?? null;
          if (!cursor) break;
          if (all.length >= MAX_ROWS || page === MAX_PAGES - 1) { capped = true; break; }
        }
      }
      all.sort((a, b) => Date.parse(b.lastTs ?? 0) - Date.parse(a.lastTs ?? 0));
      setConversations(all);
      setConvState("ready");
      if (capped) setConvNote(`stopped after ${all.length} — older conversations are not listed`);
      setSelectedRef((prev) => (all.some((c) => c.ref === prev) ? prev : all[0]?.ref ?? null));
    } catch (err) {
      setConvState("error");
      setConvNote(String(err?.message ?? err));
    }
  }, [client]);

  const submit = useCallback(async (value) => {
    const text = value.trim();
    // In the import view the text is a FILTER, not a command — ⏎ there is handled as a key
    // (arm/confirm) rather than as a submission, so there is nothing to do here.
    if (view === "import") return;
    if (!text || busy) return;
    setInput("");
    setBusy(true);
    try {
      // WHERE THE TEXT GOES IS THE VIEW'S JOB, and it's exactly what the footer says:
      // "⏎ reply" in a session, "⏎ start" in the list. The alternative — infer it from
      // whichever row the poll left highlighted — makes identical keystrokes mean
      // different things, and the dangerous reading ("reply") is the silent one, because
      // the text lands in a conversation you weren't even looking at.
      if (current && view === "session") {
        await client.reply(current.id, text);
        setScroll(0); // you just spoke; jump back to live output
      } else {
        // From the list -> this prompt starts a run, in the cwd `loop` launched from.
        const { id } = await client.createSession({ prompt: text, cwd, engine });
        composingNew.current = false;
        setSessions(await client.sessions());
        setSelectedId(id);  // follow what you just started…
        setView("session"); // …and watch it, which is why you started it
      }
      say(null);
    } catch (e) {
      warn(String(e?.message ?? e));
    } finally {
      setBusy(false);
    }
  }, [client, current, cwd, engine, busy, view, pending]);

  /** Move the selection by ±1 through the live list, by id. */
  const step = useCallback((delta) => {
    // Say so when there's nowhere to move. A silent no-op is exactly why the arrows
    // read as "broken" with a single session — the key WAS working, it just had
    // nothing to do, and the UI gave no hint which of the two it was.
    if (sessions.length < 2) {
      say(sessions.length ? "only one session — ^N starts another" : "no sessions yet");
      return;
    }
    composingNew.current = false;
    const at = sessions.findIndex((s) => s.id === selectedId);
    const next = at < 0 ? 0 : Math.min(sessions.length - 1, Math.max(0, at + delta));
    setSelectedId(sessions[next].id);
    say(null); // clear the "only one session" hint once there's somewhere to go
  }, [sessions, selectedId]);

  const inSession = view === "session";
  const inImport = view === "import";
  const waiting = sessions.filter((s) => s.pending).length;

  // In the import view the prompt is a filter. Matching the CWD as well as the title is the
  // point: "the conversation about the daemon" and "the conversations in Loop" are both
  // things you'd type, and only one of them is a title.
  const convRows = useMemo(() => {
    const q = inImport ? input.trim().toLowerCase() : "";
    if (!q) return conversations;
    return conversations.filter((c) =>
      `${c.title ?? ""} ${c.cwd ?? ""} ${c.engine ?? ""}`.toLowerCase().includes(q)
    );
  }, [conversations, input, inImport]);

  // THE SELECTION MUST FOLLOW THE FILTER. Narrowing the list can strand `selectedRef` on a
  // row that is no longer visible, and then ⏎ answers "nothing selected" while a row sits
  // highlighted on screen — which reads as a broken key. (Caught by layout-test.)
  useEffect(() => {
    if (!inImport || !convRows.length) return;
    if (!convRows.some((c) => c.ref === selectedRef)) {
      setSelectedRef(convRows[0].ref);
      setArmedRef(null); // never leave an arm pointing at something you can't see
    }
  }, [inImport, convRows, selectedRef]);

  /** Move the selection through the FILTERED import list, by ref. */
  const stepImport = useCallback((delta) => {
    if (convRows.length < 2) {
      say(convRows.length ? "only one match — clear the filter for more" : "nothing to select");
      return;
    }
    const at = convRows.findIndex((c) => c.ref === selectedRef);
    const next = at < 0 ? 0 : Math.min(convRows.length - 1, Math.max(0, at + delta));
    setSelectedRef(convRows[next].ref);
    setArmedRef(null); // moving off an armed row cancels it — never adopt what isn't highlighted
    say(null);
  }, [convRows, selectedRef, say]);

  /**
   * Adopt the highlighted conversation. Two-step by design (see ImportList): the first ⏎
   * arms and shows the directory, the second commits.
   */
  const adoptSelected = useCallback(async () => {
    const c = convRows.find((x) => x.ref === selectedRef);
    if (!c) { say("nothing selected"); return; }

    // Already imported: ⏎ just opens it. Nothing is being pointed anywhere new, so there is
    // nothing to confirm — and adopting again would only return the same session anyway.
    if (c.adoptedAs) {
      setSelectedId(c.adoptedAs);
      setArmedRef(null);
      setView("session");
      setScroll(0);
      say("already imported — opened it");
      return;
    }

    if (armedRef !== c.ref) {
      setArmedRef(c.ref);
      // ↑↓ is named as the cancel rather than ←, because ← belongs to the text cursor
      // whenever a filter has been typed (PROBLEM 14) and would not cancel anything.
      warn(`adopt into ${c.cwd ?? "(unknown directory)"} — ⏎ again to confirm, ↑↓ or ⇥ cancels`);
      return;
    }

    setArmedRef(null);
    setBusy(true);
    say("importing…");
    try {
      const r = await client.adoptConversation({ engine: c.engine, ref: c.ref });
      // A 409 comes back as a body, not a throw (client.mjs) — the conversation's directory
      // is gone, which is a fact about state and belongs on the notice line, not in a stack.
      if (r?.error) { warn(r.error + (r.hint ? ` — ${r.hint}` : "")); return; }
      setSessions(await client.sessions());
      setSelectedId(r.id);
      setInput("");
      setView("session");
      setScroll(0);
      say(
        r.alreadyAdopted
          ? "already imported — opened it"
          : `imported — replies write back into the original${r.truncated ? " (showing the most recent turns)" : ""}`
      );
    } catch (e) {
      warn(`could not import: ${e.message}`);
    } finally {
      setBusy(false);
    }
  }, [client, convRows, selectedRef, armedRef, say, warn]);
  // A question is only ANSWERABLE where ⏎ actually answers it — i.e. in the session
  // view. Keeps the card, the prompt colour and the footer from disagreeing.
  const answering = !!pending && inSession && !!current;

  // ---- row budget -------------------------------------------------------
  //
  // Everything that is NOT the scrollable body. Kept as one expression so it's obvious
  // when a new element is added and this wasn't updated.
  const noticeRows = notice ? 1 : 0;
  const fixedRows =
    (inSession ? ROWS.title : ROWS.header + ROWS.listLabel + ROWS.listBorder) +
    noticeRows + ROWS.input + ROWS.footer;

  // NOTHING MAY OVERFLOW THE SCREEN — that is the rule this whole block enforces.
  //
  // Ink falls back to `clearTerminal` + a full repaint for ANY frame taller than the
  // viewport (ink.js `shouldClearTerminalForFrame`, the `isOverflowing` branch), and it also
  // clears the frame after it. So one row too many doesn't clip: it makes the entire screen
  // blink, and it scrolls the app's own header out of reach. `Math.max(3, …)` below looks
  // like a guard but does the opposite — it hands out rows that don't exist — so the two
  // variable-height pieces have to be budgeted BEFORE it, against what's actually left.
  const ROOM_FOR_BODY = 3;
  let spare = Math.max(0, totalRows - fixedRows - ROOM_FOR_BODY);

  // The card is the USP and gets first claim on the spare rows. If the question is too tall
  // even for all of them it is CUT rather than allowed to overflow — with a line saying so,
  // because a silently half-shown question is one you might answer wrongly.
  const cardAll = answering ? cardLines(pending, cols) : null;
  let card = cardAll;
  if (cardAll && cardAll.length + 2 > spare) {
    const room = Math.max(1, spare - 2 - 1);
    card = [
      ...cardAll.slice(0, room),
      { spans: [{ text: `… +${cardAll.length - room} more rows — the phone shows all of it`, color: "yellow" }] },
    ];
  }
  const cardRows = card ? card.length + 2 : 0;
  spare -= cardRows;

  // THE QR ONLY OPENS IF IT FITS. It's ~25 rows, so in a short terminal it alone exceeds the
  // screen. A hint line beats a blinking one, and the URL is printed above the TUI anyway.
  const wantQr = showQr && qr?.length > 0;
  // WIDTH COUNTS TOO. A QR row is ~53 columns and its Text isn't truncatable (a clipped QR
  // is an unscannable QR), so in a narrow terminal each row WRAPS — and every wrapped row is
  // an extra row the budget never allocated, which is the same overflow-and-strobe as being
  // too short. Both dimensions or nothing.
  // MEASURE WHAT IS DISPLAYED. `qrcode`'s terminal renderer emits colour escapes, so a row's
  // `.length` is ~53 for 39 visible columns (and one row came out 718). Comparing that to
  // `cols` refuses a QR that fits perfectly well.
  const qrWidth = wantQr ? Math.max(...qr.map((l) => cellWidth(String(l).replace(ANSI, "")))) : 0;
  const qrFits = wantQr && qr.length + 1 + 2 <= spare && qrWidth + 4 <= cols;
  // Two rows when it doesn't fit: what happened, and the pairing URL IN FULL. Without the
  // URL there'd be no way to pair from a short terminal at all — the QR is the only place
  // the token is otherwise shown, and the screen was cleared on the way into the alternate
  // screen, so it isn't in the scrollback either. It carries the token, exactly like the QR
  // it stands in for, and only when you press ^R.
  const qrRows = qrFits ? qr.length + 1 + 2 : wantQr ? 2 : 0;  // lines + hint + border

  const chromeRows = fixedRows + cardRows + qrRows;
  const bodyRows = Math.max(ROOM_FOR_BODY, totalRows - chromeRows);
  // The screen row the transcript STARTS on, 0-based: everything drawn above it. Only the
  // title and the QR panel are above the body — the card, the input and the footer are all
  // below — so this is what turns a click's row into a line in the transcript.
  const bodyTop = (inSession ? ROWS.title : ROWS.header + ROWS.listLabel + ROWS.listBorder) + qrRows;

  // A fleet bigger than the screen scrolls with the selection, keeping it in view. The
  // arrows are the only way to reach an off-screen row, so it must follow them.
  const listWindow = useMemo(() => {
    const at = Math.max(0, sessions.findIndex((s) => s.id === selectedId));
    const numbered = sessions.map((s, i) => ({ s, n: i + 1 }));
    if (numbered.length <= bodyRows) return { rows: numbered, above: 0, below: 0 };
    // -2 leaves room for the "↑ n more" / "↓ n more" markers.
    const win = Math.max(1, bodyRows - 2);
    let start = Math.min(Math.max(0, at - Math.floor(win / 2)), numbered.length - win);
    return {
      rows: numbered.slice(start, start + win),
      above: start,
      below: numbered.length - start - win,
    };
  }, [sessions, selectedId, bodyRows]);

  // Same windowing rule as the fleet list: the selection must stay on screen, because the
  // arrows are the only way to reach an off-screen row.
  const convWindow = useMemo(() => {
    const at = Math.max(0, convRows.findIndex((c) => c.ref === selectedRef));
    if (convRows.length <= bodyRows) return { rows: convRows, above: 0, below: 0 };
    const win = Math.max(1, bodyRows - 2); // -2 for the "↑ n more" / "↓ n more" markers
    const start = Math.min(Math.max(0, at - Math.floor(win / 2)), convRows.length - win);
    return { rows: convRows.slice(start, start + win), above: start, below: convRows.length - start - win };
  }, [convRows, selectedRef, bodyRows]);

  /**
   * A left-click in the transcript: open or close the step it landed on.
   *
   * The row arithmetic is the whole risk here, so it's spelled out. The terminal counts
   * from 1; `bodyTop` is how many rows are drawn above the transcript; and the visible
   * slice starts at `start`, which comes from the SAME `transcriptWindow` the renderer
   * uses — a second copy of that sum would open a different block than the one clicked.
   */
  const clickTranscript = useCallback(({ row }) => {
    if (!inSession) return; // the list has no collapsible anything; clicking it is a no-op
    const win = transcriptWindow({ total: lines.length, rows: bodyRows, offset: scroll });
    const i = win.start + (row - 1 - bodyTop);
    if (i < win.start || i >= win.end) return; // above or below the transcript: not ours

    const blockId = lines[i]?.block;
    if (!blockId) {
      // Landing on prose is not a mistake worth an error, but silence would read as a dead
      // gesture — the same failure as the arrows in PROBLEM 14. Say what IS clickable.
      say("click a ⏺ tool line or its ⎿ output to open it   (^O opens everything)");
      return;
    }

    const next = new Set(toggled);
    next.has(blockId) ? next.delete(blockId) : next.add(blockId);

    // KEEP THE LINE YOU CLICKED WHERE IT IS. Opening a step inserts rows *below* the click,
    // and the viewport is anchored to the BOTTOM — so at live output those rows shove the
    // step you just opened straight off the top of the screen, and the click looks like it
    // did nothing. Re-rendering here to measure the delta is worth it: it's one extra pass
    // over an already-cheap pure function, on a keypress, and without it the feature is
    // invisible in exactly the case people will try it in.
    // displayTurns, not turns — it must measure the SAME content `lines` was built from,
    // or the scroll compensation below is computed against a different line count.
    const grown = transcriptLines(displayTurns, { cols: cols - 2, expanded, toggled: next });
    const delta = grown.length - lines.length;
    const maxScroll = Math.max(0, grown.length - bodyRows);
    setScroll((s) => Math.max(0, Math.min(maxScroll, s + delta)));
    setToggled(next);
    say(null);
  }, [inSession, lines, bodyRows, bodyTop, scroll, toggled, displayTurns, cols, expanded, say]);

  useInput((ch, key) => {
    // THE MOUSE WHEEL. Ink has no mouse support at all, so a report arrives here as
    // ordinary `input` TEXT (`[<64;10;5M`, ESC already stripped). Our text input ignores
    // anything that isn't recognisable typing, so it never lands in the prompt and there
    // is nothing to undo here — see tui/text-input.mjs for why that's a whole file.
    //
    // The wheel matters because the alternate screen took the terminal's scrollback away,
    // and the wheel is what a hand actually reaches for — PgUp/PgDn being the only way in
    // is the "unadvertised key reads as broken" lesson from PROBLEM 14 all over again.
    {
      const mouse = parseMouse(ch, { page: Math.max(1, bodyRows - 1) });
      if (mouse) {
        // A CLICK OPENS OR CLOSES ONE STEP. `^O` is all-or-nothing; this is the "just show
        // me THAT command's output" gesture, and it's the one people try first.
        if (mouse.type === "click") { clickTranscript(mouse); return; }
        if (mouse.type !== "wheel") return; // release / right button / motion: swallowed
        if (!inSession) {
          // On the fleet list the wheel moves the SELECTION. Scrolling a list you can't
          // scroll is meaningless, but the list does window around the selection, so this
          // is the same gesture reaching the same content.
          step(mouse.direction === "up" ? -1 : +1);
          return;
        }
        const maxScroll = Math.max(0, lines.length - bodyRows);
        if (mouse.direction === "up") {
          if (!maxScroll) { say("nothing above — this is the whole conversation"); return; }
          setScroll((s) => Math.min(maxScroll, s + mouse.lines));
          say(null);
        } else {
          if (!scroll) { say("already at the latest output"); return; }
          setScroll((s) => Math.max(0, s - mouse.lines));
          say(null);
        }
        return;
      }
    }

    // NOTE: no buffer-restoring dance here any more. `ink-text-input` used to insert the
    // letter of any key it didn't recognise — ^R typed an "r", ^E an "e" — so every ctrl
    // shortcut had to write the pre-keypress value back. That workaround is what corrupted
    // the cursor (see tui/text-input.mjs). Our input ignores modified keys outright.

    if (key.ctrl && ch === "c") { closeStream.current?.(); exit(); return; }
    if (key.ctrl && ch === "r") { setShowQr((v) => !v); return; }
    if (key.escape) { // DECLINE the parked question (docs/architecture.md)
      // Esc, because that is what dismisses a question in Claude Code's own TUI. Only where
      // the card is ANSWERABLE — the same rule as ⏎ — and it says why everywhere else.
      if (!answering) {
        say(pending ? "open the session with → to decline its question" : "nothing to decline — esc dismisses a question the agent is asking you");
        return;
      }
      say("declining…");
      client
        .decline(current.id)
        .then((r) =>
          // Declining is step one of "do this instead", so the notice points at step two.
          say(r?.ok ? "declined — the agent stopped; type what you want instead and press ⏎" : `nothing to decline (${r?.warning ?? "already answered"})`)
        )
        .catch((e) => warn(`could not decline: ${e.message}`));
      return;
    }
    // ⇥ TOGGLES THE IMPORT PICKER (docs/architecture.md).
    //
    // Tab, not ^I: they are the SAME BYTE (0x09), so Ink reports `key.tab` and a
    // `key.ctrl && ch === "i"` binding would never fire once. Tab is safe to claim because
    // tui/text-input.mjs explicitly ignores it (`applyKey`), so it can never type itself in.
    if (key.tab) {
      if (inImport) {
        // Always closes — the filter text is disposable, and being stuck in a view because
        // you typed something is worse than losing a search term.
        setView("list");
        setInput("");
        setArmedRef(null);
        say(null);
        return;
      }
      // Opening is gated on an EMPTY prompt, the same rule ←/→ follow: Tab is a key people
      // hit reflexively mid-sentence, and yanking a half-written prompt into a picker that
      // then discards it would be the worst kind of surprise.
      if (input.length > 0) { say("⇥ opens the import picker — clear the prompt first"); return; }
      composingNew.current = false;
      setArmedRef(null);
      setView("import");
      say("import: type to filter, ⏎ to adopt");
      // Refetch on every open rather than caching: conversations appear while you work, and
      // a stale list is exactly the one that won't contain the thing you came to import.
      loadConversations();
      return;
    }

    // ⏎ in the import view ARMS, then adopts. Handled here rather than through the input's
    // onSubmit because the text there is a filter — pressing ⏎ is about the highlighted row,
    // not about the characters typed.
    if (inImport && key.return) { adoptSelected(); return; }
    if (key.ctrl && ch === "n") { // compose a fresh session: back to the list
      // The selection is left alone — the VIEW decides where text goes now, so there's
      // no longer any risk of this prompt landing in the highlighted session as a reply.
      // The flag only stops a pending question from dragging the view back in mid-typing.
      composingNew.current = true;
      setView("list");
      setInput("");
      say(null);
      return;
    }
    if (key.ctrl && ch === "o") { // tool output: collapsed <-> full
      // Jump back to live. The line count changes by hundreds, so an offset measured
      // from the bottom would land you somewhere unrelated to what you were reading —
      // "it scrolled away on its own" is worse than "it went back to the newest".
      const next = !expanded;
      setScroll(0);
      setExpanded(next);
      // ^O means ALL of them, so the per-click exceptions are dropped. Keeping them would
      // make "expand everything" leave a few steps mysteriously shut.
      setToggled(new Set());
      // SAY IT IN BOTH VIEWS. On the fleet list this key changes nothing you can see,
      // and a key that appears dead is the failure this TUI keeps relearning.
      say(
        !inSession
          ? next
            ? "tool output expanded — you'll see it inside a session (→ to open one)"
            : "tool output collapsed"
          : next
            ? "tool output expanded — ^O to collapse"
            : "tool output collapsed to a line each"
      );
      return;
    }
    if (key.ctrl && ch === "t") { // hand the task to the other provider
      if (!inSession || !current) {
        say("nothing to hand off here — open a session with → first");
        return;
      }
      if (pending) {
        say("answer or decline the question before handing off");
        return;
      }
      if (working) {
        say("the agent is still working — wait or press ^X to stop it first");
        return;
      }
      const targetEngine = current.engine === "claude-code" ? "codex"
        : current.engine === "codex" ? "claude-code" : null;
      const targetName = targetEngine === "codex" ? "Codex" : targetEngine ? "Claude" : null;
      if (!targetEngine) {
        say(`no handoff target for engine ${current.engine ?? "unknown"}`);
        return;
      }
      if (handoffArmedId !== current.id) {
        setHandoffArmedId(current.id);
        warn(`continue this work in ${targetName}? press ^T again to confirm`);
        return;
      }
      setHandoffArmedId(null);
      setBusy(true);
      say(`handing off to ${targetName}…`);
      client
        .handoff(current.id, targetEngine)
        .then(async (r) => {
          setSessions(await client.sessions());
          setSelectedId(r.id);
          setView("session");
          setScroll(0);
          say(`continued in ${targetName} — the source session is still available`);
        })
        .catch((e) => warn(`could not hand off: ${e.message}`))
        .finally(() => setBusy(false));
      return;
    }
    if (key.ctrl && ch === "x") { // STOP the turn in flight (docs/architecture.md)
      // SAY WHY IN EVERY DEAD CASE. A key that silently does nothing reads as a broken
      // key — the lesson the arrows already taught this TUI once.
      if (!inSession || !current) {
        say("nothing to stop here — open a session with → first");
        return;
      }
      say("stopping…");
      client
        .interrupt(current.id)
        .then((r) =>
          // ^X stops the TURN, not the session, so the notice points at what to do next:
          // "stop" is nearly always followed by a correction.
          say(r?.ok ? "stopped — type a correction and press ⏎" : `nothing to stop (${r?.reason ?? "not running"})`)
        )
        .catch((e) => warn(`could not stop: ${e.message}`));
      return;
    }
    if (key.ctrl && ch === "e") { // toggle exposure
      say("switching exposure…");
      onExpose(mode).then(({ mode: m, url: u, error }) => {
        setMode(m); if (u) setUrl(u);
        error ? warn(error) : say(null);
        if (!error) setShowQr(true); // the URL is unchanged, but reassure the user
      });
      return;
    }

    // Scrolling the transcript. The alternate screen means the terminal's own
    // scrollback doesn't apply inside the app (same as vim), so back-scroll has to be
    // ours — otherwise long output is simply unreachable.
    if (inSession) {
      const page = Math.max(1, bodyRows - 1);
      const maxScroll = Math.max(0, lines.length - bodyRows);
      if (key.pageUp) {
        if (!maxScroll) { say("nothing above — this is the whole conversation"); return; }
        setScroll((s) => Math.min(maxScroll, s + page));
        return;
      }
      if (key.pageDown) {
        if (!scroll) { say("already at the latest output"); return; }
        setScroll((s) => Math.max(0, s - page));
        return;
      }
      if (key.home) { setScroll(maxScroll); say(maxScroll ? null : "nothing above"); return; }
      if (key.end) { setScroll(0); say(null); return; }
    }

    // ↑↓ move through whichever list you're looking at. The text input ignores up/down
    // (tui/text-input.mjs), so they never collide with typing — which made the old
    // tab-to-focus-the-list dance both unnecessary and undiscoverable.
    if (key.upArrow) { inImport ? stepImport(-1) : step(-1); return; }
    if (key.downArrow) { inImport ? stepImport(+1) : step(+1); return; }

    // → enters the selected session, ← comes back out.
    //
    // ONLY WHEN THE INPUT IS EMPTY: ←/→ move the text cursor, and hijacking them would
    // make a half-typed prompt uneditable. A non-empty buffer means you're writing, so the
    // arrows stay with the text.
    if ((key.rightArrow || key.leftArrow) && input.length === 0) {
      if (key.leftArrow && inImport) {
        // ← cancels an armed adoption first, and only leaves the view on a second press.
        // Otherwise one keystroke both disarms and navigates, and the disarm is invisible.
        if (armedRef) { setArmedRef(null); say("cancelled"); return; }
        setView("list");
        say(null);
        return;
      }
      if (key.rightArrow) {
        if (!current) { say("nothing to open — type a prompt to start a session"); return; }
        composingNew.current = false;
        setView("session");
        setScroll(0);
        say(null);
      } else {
        setView("list");
        say(null);
      }
      return;
    }

    // Alt+<n> jumps straight INTO a session — the numbers on the rows are what make
    // this guessable. Plain digits can't be used: they're legitimate input, since "1"
    // is how you answer a decision card.
    if (key.meta && /^[1-9]$/.test(ch)) {
      const target = sessions[Number(ch) - 1];
      if (target) {
        composingNew.current = false;
        setSelectedId(target.id);
        setView("session");
        setScroll(0);
        say(null);
      } else say(`no session ${ch}`);
      return;
    }
  });

  return h(
    Box,
    // OWN THE WHOLE SCREEN. Fixed height (not just flexGrow) is what pins the input to
    // the bottom edge: the body between the chrome absorbs the slack.
    { flexDirection: "column", height: totalRows, width: cols },

    inSession && current
      ? h(SessionTitle, {
          session: current,
          conn,
          waiting,
          status: current.status,
        })
      : h(Header, { mode, url, push, sessionCount: sessions.length, engine, waiting }),

    qrFits
      ? h(QrPanel, { qr })
      : wantQr
        ? h(
            Box,
            { flexDirection: "column", flexShrink: 0 },
            h(Text, { color: "yellow", wrap: "truncate" },
              `  ⚠ the pairing QR needs ${qr.length + 3} rows × ${qrWidth + 4} cols — this terminal is ${totalRows}×${cols}. Open this on the phone:`),
            h(Text, { color: "cyan", wrap: "truncate" }, `  ${url}`)
          )
        : null,

    // ---- the body: whichever thing you came to look at, given every spare row ----
    inSession && current
      ? h(Transcript, { lines, rows: bodyRows, offset: scroll })
      : inImport
        ? h(
            Box,
            { flexDirection: "column", flexGrow: 1, borderStyle: "round", borderColor: armedRef ? "yellow" : "blue" },
            // The label carries the counts AND the honest caveat. `convNote` is where a
            // runaway-guard truncation or a listing failure says so out loud, rather than
            // leaving a short list looking complete.
            h(
              Text,
              { dimColor: true, wrap: "truncate" },
              convState === "loading"
                ? " import · reading conversations…"
                : convState === "error"
                  ? ` import · could not list: ${convNote ?? "unknown error"}`
                  : ` import · ${convRows.length}${convRows.length !== conversations.length ? `/${conversations.length}` : ""}` +
                    ` conversation${convRows.length === 1 ? "" : "s"}` +
                    (input.trim() ? `  filter "${oneLine(input.trim(), 20)}"` : "  type to filter") +
                    "  ⏎ adopt" +
                    (convNote ? `  ⚠ ${convNote}` : "")
            ),
            h(ImportList, {
              rows: convWindow.rows,
              selectedRef,
              height: bodyRows,
              hiddenAbove: convWindow.above,
              hiddenBelow: convWindow.below,
              armedRef,
              cols,
            })
          )
        : h(
          Box,
          { flexDirection: "column", flexGrow: 1, borderStyle: "round", borderColor: waiting ? "yellow" : "gray" },
          h(
            Text,
            { dimColor: true },
            ` sessions${sessions.length > 1 ? "  ↑↓ move" : ""}` + (current ? "  → open" : "")
          ),
          h(SessionList, {
            rows: listWindow.rows,
            selectedId,
            height: bodyRows,
            hiddenAbove: listWindow.above,
            hiddenBelow: listWindow.below,
          })
        ),

    // The card lives in the SESSION view only, because that's the view whose ⏎ answers
    // it. Normally the effect above has already pulled you in; the one case that lands
    // here is `^N`, where you've said you're writing a new prompt — and a card saying
    // "type a number" above an input that would start a fresh session is a trap. The
    // question isn't lost: the row keeps its ● and the header still counts it.
    card ? h(DecisionCard, { lines: card }) : null,

    // ---- pinned to the bottom ----
    h(
      Box,
      { borderStyle: "round", borderColor: answering ? "yellow" : "cyan", paddingX: 1, flexShrink: 0 },
      h(Text, { color: answering ? "yellow" : "green" }, busy ? "… " : "› "),
      h(TextInput, {
        value: input,
        onChange: setInput,
        onSubmit: submit,
        // The row it actually has: the terminal minus the box's border (2) and padding (2),
        // minus the "› " prompt. It has to be told, because ONE wrapped row makes the app
        // taller than the screen and Ink repaints the whole thing — the typing "blink".
        width: Math.max(4, cols - 6),
        focus: true, // the input is ALWAYS live; ↑↓ switch sessions without stealing it
        placeholder: answering
          ? "answer the question above"
          : inImport
            ? "filter conversations   (⏎ adopts the highlighted one)"
            : inSession
              ? "reply to this session   (← back to the list)"
              : "what should we build?   (a new session starts here)",
      })
    ),
    notice
      ? notice.tone === "error"
        ? h(Text, { color: "red", wrap: "truncate" }, "⚠ " + notice.text)
        : h(Text, { dimColor: true, wrap: "truncate" }, "· " + notice.text)
      : null,
    // The keys are spelled out because none of them are discoverable otherwise — the
    // arrows reading as "broken" was really them being unadvertised and silent. Which
    // is also why the footer DROPS keys from the right rather than being truncated:
    // a half-written "^C deta…" advertises nothing and looks like a rendering bug.
    h(
      Text,
      { dimColor: true, wrap: "truncate" },
      // `working` = there is a turn in flight to stop. A parked decision is NOT working:
      // the agent is waiting on you, and ^X would have nothing to interrupt.
      footer(
        keysFor({
          answering,
          inSession,
          inImport,
          armed: !!armedRef,
          expanded,
          working,
        }),
        cols
      )
    )
  );
}
