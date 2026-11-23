// Test for the test harness (tui/screen.mjs).
//
// WHY BOTHER: layout-test.mjs asserts things like "the input is on the bottom row" by
// asking this emulator what's on screen. If the emulator is wrong, those assertions are
// worthless in the worst way — they'd fail on correct code and pass on broken code, and
// I'd go debugging the app. So the thing doing the measuring gets checked first.
//
// The sequences below are exactly the ones Ink emits (verified by counting escapes in a
// real pty transcript): SGR colour, ESC[K erase-line, ESC[nA cursor-up, ESC[G column-0,
// ESC[2J/3J erase-display, ESC[H home, and the ?1049h / ?2026h private toggles.
//
//   node apps/cli/src/tui/screen-test.mjs

import { renderScreen, Screen } from "./screen.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`); }
};
const rows = (data, c = 20, r = 4) => renderScreen(data, c, r).lines();

console.log("\nbasics\n");

ok("plain text lands on row 0", rows("hello")[0] === "hello");
ok("CRLF starts the next row", rows("a\r\nb").slice(0, 2).join("|") === "a|b");
// LF moves DOWN ONLY — the column is preserved. Real ptys have ONLCR set, so the
// driver inserts the \r; a transcript therefore contains \r\n. Getting this backwards
// would silently left-align every row and make column assertions meaningless.
ok("bare LF moves down without returning to column 0", rows("ab\ncd")[1] === "  cd");
ok("CR returns to column 0 and overwrites", rows("hello\rbye")[0] === "byelo");
ok("a tab advances to the next stop", rows("a\tb")[0] === "a       b");
ok("backspace steps back a column", rows("abc\b\bX")[0] === "aXc");

console.log("\nerasing\n");

ok("ESC[2K clears the whole row", rows("hello\r\x1b[2K")[0] === "");
ok("ESC[K clears from the cursor to the end", rows("hello\r\x1b[2C\x1b[K")[0] === "he");
ok("ESC[2J wipes the screen", renderScreen("a\r\nb\r\n\x1b[2J").text().trim() === "");
ok("ESC[0J wipes from the cursor down",
  rows("a\r\nb\r\nc\r\n\x1b[2A\x1b[G\x1b[0J").join("|") === "a|||", rows("a\r\nb\r\nc\r\n\x1b[2A\x1b[G\x1b[0J").join("|"));

console.log("\ndifferential updates — how Ink actually repaints\n");

// THE CASE THAT MOTIVATED ALL OF THIS. Ink rewrites a row in place rather than redrawing
// the frame, so the transcript contains BOTH the old and the new text. A regex over the
// transcript sees the stale row; the grid does not.
{
  const line = rows("a\r\nb\r\nc\r\n\x1b[2A\x1b[G\x1b[2KX");
  ok("a rewritten row shows only the NEW text", line.slice(0, 3).join("|") === "a|X|c", line.join("|"));
  ok("the stale text is really gone from the grid",
    !renderScreen("a\r\nb\r\nc\r\n\x1b[2A\x1b[G\x1b[2KX").text().includes("b"));
}
ok("ESC[H homes the cursor", rows("a\r\nb\r\n\x1b[HX")[0] === "X");
ok("colour codes leave no residue in the grid", rows("\x1b[1m\x1b[36mhi\x1b[0m")[0] === "hi");
ok("private-mode toggles (alt screen, sync update) are no-ops",
  rows("\x1b[?1049h\x1b[?2026hhi\x1b[?2026l\x1b[?25l")[0] === "hi");
ok("an OSC title sequence is swallowed whole",
  rows("\x1b]0;my title\x07hi")[0] === "hi", JSON.stringify(rows("\x1b]0;my title\x07hi")[0]));
ok("an unknown CSI does not corrupt the row", rows("a\x1b[38;5;204mb")[0] === "ab");

console.log("\nthe screen edges\n");

{
  const s = renderScreen("1\r\n2\r\n3\r\n4\r\n5", 10, 3);
  ok("output past the last row scrolls", s.lines().join("|") === "3|4|5", s.lines().join("|"));
}
ok("bottom(2) reads the last two rows", renderScreen("a\r\nb\r\nc", 10, 3).bottom(2) === "b\nc");
ok("find() returns the row index", renderScreen("a\r\nneedle\r\nc", 10, 3).find(/needle/) === 1);
ok("find() returns -1 when absent", renderScreen("a", 10, 3).find(/needle/) === -1);
ok("the grid is exactly `rows` tall", renderScreen("hi", 10, 7).lines().length === 7);
ok("text longer than the width wraps to the next row",
  renderScreen("abcdef", 3, 3).lines().slice(0, 2).join("|") === "abc|def");

console.log("\nwide characters\n");

// A wide glyph takes two cells; if it didn't, every column after it would drift left
// and "is this on the bottom row / at this column" assertions would quietly skew. The
// second cell reads back as a space — it's the glyph's continuation column, which is
// what keeps the column arithmetic honest (the TUI's own glyphs — ⏺ ⎿ ✻ • ▸ — are all
// narrow, so this never shows up in a layout assertion).
ok("a wide char occupies two cells", renderScreen("日x", 10, 2).lines()[0] === "日 x");
ok("wide chars still respect the width",
  renderScreen("日本語", 4, 2).lines().slice(0, 2).join("|") === "日 本|語",
  renderScreen("日本語", 4, 2).lines().join("|"));

console.log("\nresize\n");

{
  const s = new Screen(10, 3);
  s.write("hello");
  s.resize(20, 5);
  ok("resize clears and re-shapes the grid", s.lines().length === 5 && s.text().trim() === "");
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
