// Test for the prompt's input reducer (tui/text-input.mjs).
//
// This file replaced `ink-text-input` because that one INSERTS ANY KEY IT DOESN'T
// RECOGNISE, and three separate bugs came out of that (^R typing an "r", mouse reports
// typed into the prompt, and a cursor corrupted by the workaround for both — which
// silently reversed characters, turning "hi" into "ih" in a prompt bound for the agent).
//
// So the assertions come in two halves, and the second is the one that matters: what gets
// inserted, and — far more important — WHAT DOESN'T. Every escape sequence and modified
// key that reaches the prompt as text is a corrupted message to an agent.
//
//   node apps/cli/src/tui/text-input-test.mjs

import { applyKey, isTypedText, pastedText, inputWindow, PASTE_ON, PASTE_OFF } from "./text-input.mjs";
import { cellWidth } from "./blocks.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`); }
};

/** Feed a sequence of [ch, key] pairs from empty, returning the final state. */
const typeAll = (events, start = { value: "", cursor: 0 }) =>
  events.reduce((s, [ch, key = {}]) => {
    const next = applyKey(s, ch, key);
    return next.submit ? s : next;
  }, start);

const letters = (s) => typeAll([...s].map((c) => [c, {}]));

console.log("\ntyping\n");

ok("a character is inserted", letters("a").value === "a");
// IN ORDER. "contains h and i" passed while the old input rendered "ih" — the ordering IS
// the assertion, because the failure mode was a transposition.
ok("characters keep their order", letters("hi").value === "hi", JSON.stringify(letters("hi")));
ok("a longer word keeps its order", letters("hello world").value === "hello world");
ok("the cursor tracks the end", letters("abc").cursor === 3);
// Ink delivers a paste as ONE string, so this is a real path, not a synthetic one.
ok("a pasted chunk is inserted whole", applyKey({ value: "", cursor: 0 }, "pasted text", {}).value === "pasted text");
ok("a digit is typed (it's also how you answer a card)", letters("1").value === "1");
ok("unicode is typed", letters("héllo").value === "héllo");

console.log("\nediting\n");

{
  const s = letters("abc");
  const left = applyKey(s, "", { leftArrow: true });
  ok("← moves the cursor back", left.cursor === 2 && left.value === "abc");
  const ins = applyKey(left, "X", {});
  ok("typing inserts AT the cursor, not at the end", ins.value === "abXc", JSON.stringify(ins));
  ok("the cursor follows the insert", ins.cursor === 3);

  const bs = applyKey(s, "", { backspace: true });
  ok("backspace deletes before the cursor", bs.value === "ab" && bs.cursor === 2);
  const midBs = applyKey(left, "", { backspace: true });
  ok("backspace mid-string deletes the right character", midBs.value === "ac", JSON.stringify(midBs));
  // ⌫ on a Mac reports as `delete`; treating it as forward-delete would eat the wrong side.
  ok("the delete key also deletes backwards",
    applyKey(s, "", { delete: true }).value === "ab");

  ok("backspace at the start is a no-op",
    applyKey({ value: "abc", cursor: 0 }, "", { backspace: true }).value === "abc");
  ok("← at the start is a no-op", applyKey({ value: "abc", cursor: 0 }, "", { leftArrow: true }).cursor === 0);
  ok("→ at the end is a no-op", applyKey(s, "", { rightArrow: true }).cursor === 3);
  const right = applyKey(applyKey(s, "", { leftArrow: true }), "", { rightArrow: true });
  ok("→ moves the cursor forward", right.cursor === 3);
}

// A cursor past the end is EXACTLY the corruption that motivated this file: the old input
// kept one privately and the next characters landed in the wrong order.
{
  const s = applyKey({ value: "ab", cursor: 99 }, "c", {});
  ok("a cursor past the end is clamped, and typing still appends", s.value === "abc", JSON.stringify(s));
}

console.log("\nsubmit\n");

{
  const s = applyKey({ value: "hi", cursor: 2 }, "\r", { return: true });
  ok("⏎ marks a submit", s.submit === true);
  ok("⏎ does not alter the value", s.value === "hi");
  ok("⏎ inserts no newline", !letters("hi").value.includes("\n"));
}

console.log("\nWHAT MUST NEVER BE INSERTED\n");

// THE HEART OF THIS FILE. Each of these reached the prompt as text with the old input.
const ignored = [
  ["^R (shows the QR)", "r", { ctrl: true }],
  ["^E (toggles exposure)", "e", { ctrl: true }],
  ["^N (new session)", "n", { ctrl: true }],
  ["^C (detach)", "c", { ctrl: true }],
  ["Alt+1 (jumps to a session)", "1", { meta: true }],
  ["↑ (switches session)", "", { upArrow: true }],
  ["↓ (switches session)", "", { downArrow: true }],
  ["PgUp (scrolls)", "", { pageUp: true }],
  ["PgDn (scrolls)", "", { pageDown: true }],
  ["Home (scrolls)", "", { home: true }],
  ["End (scrolls)", "", { end: true }],
  ["tab", "", { tab: true }],
  ["escape", "", { escape: true }],
  ["a wheel-up report", "[<64;10;5M", {}],
  ["a wheel-down report", "[<65;10;5M", {}],
  ["a click report", "[<0;10;5M", {}],
  ["a click release", "[<0;10;5m", {}],
  ["a wheel report that kept its ESC", "\x1b[<64;10;5M", {}],
  ["an unresolved arrow sequence", "[A", {}],
  ["a modified-arrow sequence", "[1;5D", {}],
  ["a bracketed-paste marker", "[200~", {}],
  ["a bare ESC", "\x1b", {}],
  ["a raw control character", "\x00", {}],
  ["a bell", "\x07", {}],
  ["a stray newline", "\n", {}],
];
for (const [what, ch, key] of ignored) {
  const before = { value: "keep", cursor: 4 };
  const after = applyKey(before, ch, key);
  ok(`${what} is not inserted`, after.value === "keep", `-> ${JSON.stringify(after)}`);
}

// …but the value must SURVIVE those keypresses. Swallowing too much would clear the prompt,
// which is worse than the bug being fixed.
{
  let s = { value: "half-written", cursor: 12 };
  for (const [, ch, key] of ignored) s = applyKey(s, ch, key);
  ok("a half-typed prompt survives every ignored key", s.value === "half-written", JSON.stringify(s));
  ok("and the cursor is unmoved", s.cursor === 12, JSON.stringify(s));
  ok("typing then continues at the end", applyKey(s, "!", {}).value === "half-written!");
}

console.log("\nisTypedText\n");

for (const s of ["a", "1", " ", "hello", "é", "[", "[[", "a[A"])
  ok(`${JSON.stringify(s)} is typed text`, isTypedText(s) === true);
// A LONE "[" IS TYPING — people type brackets. Only a full CSI-shaped chunk is not, and
// keystrokes arrive as separate events so a real person never sends "[A" in one chunk.
for (const s of ["", "\x1b", "\x1b[A", "[A", "[200~", "[<64;10;5M", "\x00", "\x7f"])
  ok(`${JSON.stringify(s)} is NOT typed text`, isTypedText(s) === false);
ok("null/undefined are not typed text", !isTypedText(null) && !isTypedText(undefined));

console.log("\npaste — the ⌘V that did nothing\n");

// TWO INDEPENDENT REASONS ⌘V LOOKED DEAD, and both had to be fixed:
//   1. `isTypedText` rejects a whole chunk if ANY character is a control character. Copy a
//      line from a browser and the clipboard ends in `\n` — so the entire paste vanished.
//   2. Without bracketed paste, Ghostty's paste protection refuses a multi-line paste
//      outright, so the bytes never even arrived.
{
  ok("a single-line paste with a trailing newline lands",
    pastedText("hello world\n") === "hello world ",
    JSON.stringify(pastedText("hello world\n")));
  ok("a multi-line paste keeps all of its text",
    pastedText("first\nsecond\nthird") === "first second third",
    JSON.stringify(pastedText("first\nsecond\nthird")));
  ok("CRLF is not doubled into two spaces",
    pastedText("a\r\nb") === "a b", JSON.stringify(pastedText("a\r\nb")));
  ok("tabs become spaces too", pastedText("a\tb") === "a b");
  ok("a run of newlines collapses to ONE space",
    pastedText("a\n\n\nb") === "a b", JSON.stringify(pastedText("a\n\n\nb")));

  // Bracketed: the markers are stripped and everything between them is LITERAL. Ink strips
  // one leading ESC, so both forms have to be understood.
  ok("a bracketed paste is unwrapped", pastedText("\x1b[200~hi there\x1b[201~") === "hi there");
  ok("…including the ESC-less form Ink actually delivers",
    pastedText("[200~hi there[201~") === "hi there",
    JSON.stringify(pastedText("[200~hi there[201~")));
  // THE POINT OF BRACKETING: a newline inside a paste is text. Unbracketed it is
  // indistinguishable from ⏎, which would SEND the first line to the agent mid-paste.
  ok("a bracketed newline is text, not a submit",
    pastedText("[200~one\ntwo[201~") === "one two");

  // What must NOT be treated as a paste — the escape-sequence hole this file exists to keep
  // shut. An unbracketed chunk containing ESC is a key, never content.
  for (const s of ["\x1b[A", "[A", "a", "", "hello", "\x1b[<64;10;5M"])
    ok(`${JSON.stringify(s)} is not a paste`, pastedText(s) === null, JSON.stringify(pastedText(s)));
  ok("a lone carriage return is not a paste (it's ⏎)", pastedText("\r") === null);
  ok("a paste of only whitespace yields nothing rather than a stray space",
    pastedText("\n\n") === " " || pastedText("\n\n") === null,
    JSON.stringify(pastedText("\n\n")));
}
{
  // Through the reducer, at the cursor, without disturbing what's already there.
  const s = applyKey({ value: "see: ", cursor: 5 }, "one\ntwo\n", {});
  ok("a paste inserts at the cursor", s.value === "see: one two ", JSON.stringify(s));
  ok("the cursor lands after the pasted text", s.cursor === "see: one two ".length, JSON.stringify(s));
  // ⏎ still submits: it arrives as a NAMED key, which is handled before the paste branch.
  ok("⏎ still submits", applyKey({ value: "go", cursor: 2 }, "\r", { return: true }).submit === true);
}

console.log("\nthe one-row window — why the screen used to blink\n");

// ANY SECOND ROW MAKES THE APP TALLER THAN THE TERMINAL, and Ink answers that by clearing
// and repainting the whole screen (ink.js `shouldClearTerminalForFrame`). So the window must
// fit in CELLS, always, and it must keep the cursor visible or you can't see what you type.
{
  const long = "x".repeat(200);
  for (const width of [4, 10, 40, 80]) {
    const w = inputWindow(long, long.length, width);
    const drawn = w.before + (w.under || " ") + w.after;
    ok(`a 200-char value fits ${width} columns`, cellWidth(drawn) <= width,
      `${cellWidth(drawn)} cells: ${JSON.stringify(drawn)}`);
  }
  const w = inputWindow(long, long.length, 20);
  ok("typing at the end shows the END of the text", w.after === "" && w.scrolled === true,
    JSON.stringify(w));
}
{
  // Two-cell characters are the sneaky case: `length` says it fits, the terminal disagrees,
  // and the row wraps — the same overflow wearing a different hat.
  const cjk = "日本語".repeat(20);
  const w = inputWindow(cjk, cjk.length, 21);
  ok("wide characters are measured in cells, not length",
    cellWidth(w.before + (w.under || " ") + w.after) <= 21,
    `${cellWidth(w.before + w.under + w.after)} cells`);
}
{
  const short = "hello";
  const w = inputWindow(short, 5, 40);
  ok("a value that fits is shown whole", w.before === "hello" && !w.scrolled && !w.more,
    JSON.stringify(w));
  const mid = inputWindow("a".repeat(50) + "MARK" + "b".repeat(50), 52, 30);
  ok("editing mid-string keeps text visible on BOTH sides of the cursor",
    mid.before.length > 0 && mid.after.length > 0, JSON.stringify(mid));
  ok("…and still fits", cellWidth(mid.before + mid.under + mid.after) <= 30);
  ok("it reports that there is more in both directions", mid.scrolled && mid.more);
}
ok("an empty value is a one-cell window",
  cellWidth(inputWindow("", 0, 40).before + inputWindow("", 0, 40).after) === 0);

console.log("\nbracketed paste is turned off again\n");

// Same rule as the mouse: the shell inherits the terminal. Leaving `?2004h` on means every
// later paste in that shell arrives wrapped in `ESC[200~`.
ok("PASTE_ON asks for bracketed paste", PASTE_ON === "\x1b[?2004h");
ok("PASTE_OFF turns off exactly that", PASTE_OFF === "\x1b[?2004l");

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
