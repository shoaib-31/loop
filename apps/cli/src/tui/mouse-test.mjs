// Test for the wheel parser (tui/mouse.mjs).
//
// The stakes are asymmetric, which is why this is its own suite. A missed wheel report
// means the wheel doesn't scroll — annoying. A report mistaken for TYPING means escape
// sequence bytes get inserted into the prompt and the next ⏎ sends them to the agent
// (the ^R-types-an-"r" bug from PROBLEM 14, in a new costume). And a non-mouse input
// mistaken for a report means the letter you typed vanishes. So both directions of the
// "is this a mouse report?" question are asserted, including the near-misses.
//
//   node apps/cli/src/tui/mouse-test.mjs

import { parseMouse, WHEEL_LINES, ENABLE, DISABLE } from "./mouse.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`); }
};

console.log("\nwheel reports\n");

{
  const up = parseMouse("\x1b[<64;20;5M");
  ok("wheel up is recognised", up?.type === "wheel" && up.direction === "up", JSON.stringify(up));
  ok("a tick moves the conventional 3 rows", up?.lines === WHEEL_LINES && WHEEL_LINES === 3, JSON.stringify(up));
  ok("the coordinates come through", up?.col === 20 && up?.row === 5, JSON.stringify(up));

  const down = parseMouse("\x1b[<65;20;5M");
  ok("wheel down is recognised", down?.type === "wheel" && down.direction === "down", JSON.stringify(down));
}

// THE FORM INK ACTUALLY DELIVERS — no ESC. use-input.js strips the escape prefix from any
// sequence parseKeypress didn't resolve to a named key, and a mouse report is exactly
// that. Requiring the ESC made the parser match NOTHING in a real terminal, and the reports
// were typed into the prompt instead; only the pty test caught it, by showing
// `› [<64;10;5M` sitting in the input box. So this is the case that matters most.
{
  const stripped = parseMouse("[<64;20;5M");
  ok("a report with the ESC stripped is still recognised (this is the real one)",
    stripped?.type === "wheel" && stripped.direction === "up", JSON.stringify(stripped));
  ok("the ESC-less form scrolls by the same amount", stripped?.lines === WHEEL_LINES);
  const click = parseMouse("[<0;5;5M");
  ok("an ESC-less click is a click too", click?.type === "click", JSON.stringify(click));
}

// Modifier bits are ORed ONTO the button number, so shift+wheel is 68, not 64. Masking
// them off is what keeps a modified wheel scrolling instead of being dropped as an
// unknown button — silently doing nothing is the failure mode this whole change fixes.
{
  const shift = parseMouse("\x1b[<68;1;1M", { page: 40 });
  ok("shift+wheel still scrolls", shift?.type === "wheel" && shift.direction === "up", JSON.stringify(shift));
  ok("shift+wheel scrolls a whole page", shift?.lines === 40, JSON.stringify(shift));

  const ctrl = parseMouse("\x1b[<80;1;1M", { page: 40 });
  ok("ctrl+wheel scrolls a page too", ctrl?.lines === 40 && ctrl.direction === "up", JSON.stringify(ctrl));

  const alt = parseMouse("\x1b[<72;1;1M");
  ok("alt+wheel is still a wheel", alt?.type === "wheel" && alt.direction === "up", JSON.stringify(alt));
  ok("an unmodified tick ignores `page`",
    parseMouse("\x1b[<64;1;1M", { page: 40 })?.lines === WHEEL_LINES);
  ok("a page of 0 never yields a 0-row scroll",
    parseMouse("\x1b[<68;1;1M", { page: 0 })?.lines >= 1);
}

console.log("\nclicks — the press only, with the coordinates intact\n");

// A CLICK OPENS OR CLOSES ONE TOOL BLOCK, so these coordinates are load-bearing: the row
// is what gets turned back into a line in the transcript. 1-based, exactly as the terminal
// counts, because converting here and again in the caller is how off-by-ones are born.
{
  const c = parseMouse("\x1b[<0;12;7M");
  ok("a left press is a click", c?.type === "click", JSON.stringify(c));
  ok("it carries the row and column as the terminal sent them (1-based)",
    c?.row === 7 && c?.col === 12, JSON.stringify(c));
}

// THE RELEASE MUST NOT BE A SECOND CLICK. The terminal sends `M` then `m` for one physical
// click; toggling on both would open and immediately close the block, which looks EXACTLY
// like a gesture that isn't wired up at all.
ok("the release of that click is NOT a click", parseMouse("\x1b[<0;5;5m")?.type === "other");
ok("…but it is still recognised, so its bytes never reach the prompt",
  parseMouse("\x1b[<0;5;5m") !== null);
ok("motion (button held, pointer moving) is not a click",
  parseMouse("\x1b[<32;5;5M")?.type === "other");
ok("a middle click is recognised but unhandled", parseMouse("\x1b[<1;5;5M")?.type === "other");
ok("a right click is recognised but unhandled", parseMouse("\x1b[<2;5;5M")?.type === "other");
// Modifiers are masked off the button, so a shift-click is still a click rather than an
// unknown button silently dropped.
ok("shift+click is still a click", parseMouse("\x1b[<4;5;5M")?.type === "click");

console.log("\nnot mouse reports — these must PASS THROUGH as typing\n");

// null means "ordinary input". A false positive here eats a real keystroke.
for (const [what, input] of [
  ["a plain letter", "a"],
  ["a digit (how you answer a decision card)", "1"],
  ["empty input", ""],
  ["a whole typed word (Ink delivers a paste as one string)", "hello"],
  ["an arrow key's sequence", "\x1b[A"],
  ["a bare escape", "\x1b"],
  ["a legacy X10 mouse report we did NOT enable", "\x1b[M !!"],
  ["a report with a trailing character", "\x1b[<64;20;5Mx"],
  ["a report with a leading character", "x\x1b[<64;20;5M"],
  ["a truncated report", "\x1b[<64;20;5"],
  ["non-numeric parameters", "\x1b[<a;b;cM"],
]) ok(`${what} is not a mouse report`, parseMouse(input) === null, JSON.stringify(input));

ok("null/undefined don't throw", parseMouse(null) === null && parseMouse(undefined) === null);

console.log("\nthe enable/disable pair\n");

// The shell inherits the terminal, so anything turned ON must be turned OFF by the same
// module — otherwise every scroll after `loop` exits emits garbage into the prompt.
ok("ENABLE asks for SGR encoding (1006)", ENABLE.includes("?1006h"));
ok("ENABLE asks for normal tracking (1000): press, release and wheel", ENABLE.includes("?1000h"));
// 1002 would add a report per cell crossed while dragging — every one of them an event to
// recognise and swallow, and anything unrecognised is typed into the prompt.
ok("ENABLE does NOT ask for motion reports (1002)", !ENABLE.includes("?1002h"));
ok("DISABLE turns off everything ENABLE turned on",
  ENABLE.match(/\?\d+/g).every((m) => DISABLE.includes(m)),
  `${JSON.stringify(ENABLE)} vs ${JSON.stringify(DISABLE)}`);
// 1002 is disabled too, deliberately: an earlier build enabled it, and a terminal left in
// that state after an upgrade would keep reporting motion at whatever runs next.
ok("DISABLE also clears the mode an older build used to set", DISABLE.includes("?1002l"));
ok("DISABLE uses the low (l) form throughout",
  DISABLE.split("\x1b").filter(Boolean).every((s) => s.endsWith("l")), JSON.stringify(DISABLE));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
