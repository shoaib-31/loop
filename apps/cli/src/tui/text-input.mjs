// The prompt's text input — ours, because `ink-text-input`'s central assumption is wrong
// for this app.
//
// ITS RULE IS "INSERT ANY KEY I DON'T RECOGNISE" (build/index.js:80: the final `else`
// splices `input` into the value). It recognises ↑↓, tab, ^C, ⏎, ←→ and backspace, and
// treats everything else as typing. That produced three separate bugs here:
//
//   1. `^R` typed an "r" into the prompt and `^E` an "e" (PROBLEM 14).
//   2. Mouse reports arrived as text, so enabling the wheel typed `[<64;10;5M`.
//   3. The workaround for both — let it insert, then write the old value back — left its
//      PRIVATE `cursorOffset` advanced past the end. An unchanged value means React skips
//      the re-render, so its own clamping effect never ran, and the next two characters
//      came out REVERSED: typing "hi" gave "ih", silently, into a prompt bound for the
//      agent. Remounting to reset that cursor re-registered its input listener AFTER
//      ours, which inverted the ordering the whole restore trick depended on.
//
// So the fix is to stop fighting it. OUR RULE IS THE INVERSE: insert only what is
// recognisably typed text, and ignore everything else. Then nothing needs undoing, the
// cursor is ours, and no handler ordering matters — which is why this file exists rather
// than a fourth workaround.
//
// The reducer is PURE and Ink-free so it unit-tests without a pty (same reasoning as
// tui/blocks.mjs), and the component around it is a dozen lines.

import React from "react";
import { Box, Text, useInput } from "ink";
import { parseMouse } from "./mouse.mjs";
import { cellWidth } from "./blocks.mjs";

const h = React.createElement;

// BRACKETED PASTE. Ask the terminal to wrap pasted text in markers so a paste is
// distinguishable from typing. Two things break without it:
//
//   1. A pasted newline is indistinguishable from ⏎, so pasting two lines SENDS the first
//      one to the agent. Bracketed, the whole paste is literal text and can't submit.
//   2. Ghostty (and iTerm) refuse or warn on a multi-line paste into an app that hasn't
//      enabled it — "clipboard paste protection". That is one of the two reasons ⌘V looked
//      dead: the bytes never arrived at all.
//
// Same deal as the mouse: whatever we turn on, we turn off (main.mjs), or the shell
// inherits a terminal emitting `ESC[200~` around every paste.
export const PASTE_ON = "\x1b[?2004h";
export const PASTE_OFF = "\x1b[?2004l";

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// An escape sequence Ink didn't resolve to a named key, arriving with its ESC already
// stripped (use-input.js does that unconditionally). `[A`, `[1;5D`, `[200~` and friends:
// they must not be typed into the prompt. A lone `[` IS ordinary typing and stays typing —
// keystrokes arrive as separate events, so a multi-character `[…` chunk is never a person.
const CSI_REMNANT = /^\[[\d;?<>=]*[A-Za-z~]$/;

/** Is this Ink `input` string something a person actually typed? */
export function isTypedText(input) {
  const s = String(input ?? "");
  if (!s) return false;
  if (parseMouse(s)) return false;          // a mouse report, not typing
  if (s.length > 1 && CSI_REMNANT.test(s)) return false;
  // Any control character means an escape sequence we don't understand. Never insert it:
  // a raw ESC in the prompt corrupts the rendering of every row after it.
  for (const ch of s) if (ch < " " || ch === "\x7f") return false;
  return true;
}

/**
 * A PASTE, turned into insertable text — or `null` if this isn't one.
 *
 * WHY THIS ISN'T JUST `isTypedText`: that rejects the whole chunk if ANY character is a
 * control character, which is right for a stray escape sequence and wrong for a paste. Copy
 * a line from a browser and the clipboard almost always ends in `\n`; that single byte made
 * the entire paste vanish. This was the other half of "⌘V does nothing".
 *
 * Ink hands the whole paste over as one `input` string (parseKeypress leaves it unnamed, so
 * use-input passes `keypress.sequence` through), which is what makes this possible at all.
 *
 * The rules, in order:
 *   - Strip the bracketed-paste markers if they're there. Everything between them is
 *     LITERAL: a `\r` in a paste is text, not the return key.
 *   - Without markers, a chunk is a paste if it's longer than one character and holds a
 *     newline or a tab. Nobody types those inside a chunk — ⏎ arrives as its own named key
 *     with a one-byte sequence, so it is handled before this and still submits.
 *   - An ESC anywhere in an UNMARKED chunk means an escape sequence, not a paste. Rejected,
 *     because inserting `[A` for an arrow key is exactly the bug this file exists to kill.
 *   - Newlines and tabs collapse to single spaces: the prompt is one line. The text is all
 *     still there, which is what matters for something being sent to an agent.
 */
export function pastedText(input) {
  const s = String(input ?? "");
  if (!s) return null;

  // Ink strips ONE leading ESC from anything it couldn't name, so a bracketed paste arrives
  // as `[200~…` rather than `\x1b[200~…`. Accept both.
  const marked = s.includes(PASTE_START) || s.includes(PASTE_END) ||
    s.startsWith("[200~") || s.includes("[201~");
  let body = s;
  if (marked) {
    body = body
      .split(PASTE_START).join("").split(PASTE_END).join("")
      .replace(/^\[200~/, "").split("[201~").join("");
  } else {
    if (s.length < 2) return null;
    if (!/[\n\r\t]/.test(s)) return null;   // a plain multi-char chunk: ordinary typing
    if (s.includes("\x1b")) return null;    // an escape sequence, not a paste
  }

  const flat = body
    .replace(/\r\n?/g, "\n")
    .replace(/[\n\t]+/g, " ")
    // Anything else non-printable is dropped rather than inserted: a raw control byte in
    // the prompt corrupts every row rendered after it.
    .replace(/[\x00-\x1f\x7f]/g, "");
  return flat.length ? flat : null;
}

/**
 * The slice of the value that FITS on the row, keeping the cursor visible.
 *
 * THIS IS WHY THE SCREEN USED TO BLINK. With no window, a value longer than the box wrapped
 * onto a second row, so the app rendered `totalRows + 1` rows — and Ink falls back to
 * `clearTerminal` + full repaint for any frame taller than the viewport (ink.js:
 * `shouldClearTerminalForFrame`, the `isOverflowing` branch). Every keystroke past the edge
 * of the box wiped and redrew the whole screen. It also clears the frame AFTER the
 * overflowing one, so a single long line flickers twice.
 *
 * Measured in CELLS, not characters, because two-cell CJK text would otherwise overflow the
 * row while "fitting" by length — the same wrap-to-a-second-row bug wearing a different hat.
 *
 * A quarter of the width is held for text to the RIGHT of the cursor, so editing mid-string
 * shows what you're editing into; when you're typing at the end there is nothing to the
 * right and the whole width shows the tail.
 */
export function inputWindow(value, cursor, width) {
  const chars = [...String(value ?? "")];
  const w = Math.max(4, Math.floor(width) || 4);
  const at = Math.max(0, Math.min(cursor, chars.length));

  const under = chars[at] ?? " ";
  let room = w - cellWidth(under);

  // Reserve some lookahead, then take everything else from the left.
  const lookahead = Math.min(room, Math.floor(w / 4));
  let budgetRight = lookahead;
  const right = [];
  let j = at + 1;
  while (j < chars.length && cellWidth(chars[j]) <= budgetRight) {
    right.push(chars[j]);
    budgetRight -= cellWidth(chars[j]);
    j++;
  }
  room -= lookahead - budgetRight;

  const left = [];
  let i = at - 1;
  while (i >= 0 && cellWidth(chars[i]) <= room) {
    left.unshift(chars[i]);
    room -= cellWidth(chars[i]);
    i--;
  }

  // Spend anything the left side didn't need on more lookahead.
  while (j < chars.length && cellWidth(chars[j]) <= room) {
    right.push(chars[j]);
    room -= cellWidth(chars[j]);
    j++;
  }

  return {
    before: left.join(""),
    under: chars[at] ?? "",
    after: right.join(""),
    scrolled: i >= 0,            // text exists to the left of the window
    more: j < chars.length,      // …and to the right
  };
}

/**
 * The whole input, as a pure function: (state, keypress) -> state.
 *
 * `state` is `{ value, cursor }`. Returns the SAME object when the keypress isn't ours,
 * which is what lets the caller tell "handled" from "ignored" without a second convention.
 * `submit: true` marks the keypress as ⏎.
 */
export function applyKey(state, ch, key = {}) {
  const { value, cursor } = state;
  const at = Math.max(0, Math.min(cursor, value.length));

  if (key.return) return { value, cursor: at, submit: true };

  // A PASTE IS TEXT, and it's checked before the modifier and navigation guards on purpose:
  // ⌘V arrives as content, not as a key, and a bracketed paste can legitimately contain
  // bytes that look like anything at all.
  const pasted = pastedText(ch);
  if (pasted) return { value: value.slice(0, at) + pasted + value.slice(at), cursor: at + pasted.length };

  // Modified keys belong to the app's shortcuts (^R, ^E, ^N, ^C, Alt+n), never to the
  // text. This single line is what bug 1 and bug 2 above both needed.
  if (key.ctrl || key.meta) return state;

  // Navigation the app owns: it uses ↑↓ for sessions and PgUp/PgDn/Home/End for scrolling.
  if (key.upArrow || key.downArrow || key.pageUp || key.pageDown ||
      key.home || key.end || key.tab || key.escape) return state;

  if (key.leftArrow) return at > 0 ? { value, cursor: at - 1 } : state;
  if (key.rightArrow) return at < value.length ? { value, cursor: at + 1 } : state;

  if (key.backspace || key.delete) {
    // ⌫ on a Mac reports as `delete`, and Ink doesn't distinguish it from forward-delete,
    // so both erase backwards — the behaviour that matches the key people are pressing.
    if (at === 0) return state;
    return { value: value.slice(0, at - 1) + value.slice(at), cursor: at - 1 };
  }

  if (!isTypedText(ch)) return state;
  return { value: value.slice(0, at) + ch + value.slice(at), cursor: at + ch.length };
}

/**
 * A controlled single-line input. `value`/`onChange` as usual; the cursor is internal
 * because nothing outside needs it.
 *
 * The cursor is drawn as an inverted cell rather than by moving the real terminal cursor —
 * Ink repaints differentially and doesn't track where we left it, so a positioned cursor
 * would land in the wrong row. This is the same choice ink-text-input made.
 */
export function TextInput({ value, onChange, onSubmit, placeholder = "", focus = true, width = 80 }) {
  const [cursor, setCursor] = React.useState(value.length);

  // Keep the cursor inside the value when it changes from OUTSIDE (a reply being sent
  // clears it, for instance). The bug this avoids is exactly the one that motivated the
  // file: a cursor left past the end of the text.
  const clamped = Math.min(cursor, value.length);
  React.useEffect(() => {
    if (cursor > value.length) setCursor(value.length);
  }, [value, cursor]);

  useInput((ch, key) => {
    const next = applyKey({ value, cursor: clamped }, ch, key);
    if (next.submit) { onSubmit?.(value); return; }
    if (next.value === value && next.cursor === clamped) return;
    setCursor(next.cursor);
    if (next.value !== value) onChange?.(next.value);
  }, { isActive: focus });

  // EVERY BRANCH IS ONE ROW, AND `wrap: "truncate"` IS LOAD-BEARING. One extra rendered row
  // makes the whole app taller than the terminal, and Ink answers that by clearing the
  // screen and repainting it — the "why does the TUI blink while I type" bug. A long
  // placeholder in a narrow terminal wraps just as readily as a long value.
  if (!value) {
    // The placeholder carries the cursor on its first cell, so an empty prompt still shows
    // where typing will go.
    const hint = placeholder.slice(0, Math.max(0, width));
    return h(
      Box,
      null,
      focus
        ? h(Text, { inverse: true, wrap: "truncate" }, hint ? hint[0] : " ")
        : hint
          ? h(Text, { dimColor: true, wrap: "truncate" }, hint[0])
          : null,
      hint ? h(Text, { dimColor: true, wrap: "truncate" }, hint.slice(1)) : null
    );
  }

  const { before, under, after } = inputWindow(value, clamped, width);
  return h(
    Box,
    null,
    h(Text, { wrap: "truncate" }, before),
    focus
      ? h(Text, { inverse: true, wrap: "truncate" }, under || " ")
      : under ? h(Text, { wrap: "truncate" }, under) : null,
    h(Text, { wrap: "truncate" }, after)
  );
}

export default TextInput;
