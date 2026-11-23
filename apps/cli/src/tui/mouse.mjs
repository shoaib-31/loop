// Mouse reports -> scroll / click intent. PURE and Ink-free, so it unit-tests without a pty.
//
// WHY THIS EXISTS. `alternateScreen` takes the terminal's own scrollback away (that's the
// deal — same as vim), so PgUp/PgDn became the only way to reach earlier output. But the
// wheel is what a hand reaches for, and reaching for it did NOTHING, which reads exactly
// like "scrolling is broken" — the same lesson as the arrows in PROBLEM 14.
//
// TWO THINGS HAD TO BE TRUE FOR THE WHEEL TO WORK AT ALL:
//
// 1. THE TERMINAL HAS TO BE ASKED. A terminal does not report the mouse unless the app
//    turns it on; unasked, the wheel stays a terminal-level gesture (in tmux, it flips
//    the pane into copy-mode — which is exactly the "I can scroll the terminal" thing we
//    just stopped). `ENABLE`/`DISABLE` below are that request.
//
// 2. SOMETHING HAS TO PARSE THE REPORTS. Ink has NO mouse support — no `key.scrollUp`,
//    nothing (grep `build/` for "mouse": one hit, in measure-element, unrelated). It
//    parses `ESC[<64;20;5M` into `{name: "", sequence: "\x1b[<64;20;5M"}`, and
//    `use-input.js` then sets `input = keypress.sequence` for any unnamed key. So the
//    reports arrive as *typed text* — and `ink-text-input` INSERTS text it doesn't
//    recognise (build/index.js:80, the same trap that made `^R` type an "r"). Turning the
//    mouse on without handling it would type `[<64;20;5M` into your prompt.
//
// So the mouse must be enabled and parsed as one change, or not at all.
//
// CLICKS CAME LATER, FOR FREE (PROBLEM 14e). Once the terminal is reporting, a click is
// just another report — and clicking a `⏺` line to open that step is the gesture people try
// before they find `^O`. The one thing worth knowing: a physical click arrives as TWO
// reports (press `M`, release `m`), so a handler that acts on both toggles twice and looks
// broken. `parseMouse` returns a click for the press only, and `{type:"other"}` for the
// release — non-null, so the caller still swallows the bytes instead of typing them.
//
// TWO DIFFERENT DIALS, EASILY CONFUSED: `1000` picks WHICH EVENTS are reported (press,
// release, wheel), `1006` picks HOW they're ENCODED. Without 1006 you get the default X10
// encoding, which packs each coordinate into one byte as `value + 32` — that breaks past
// column 223 and, worse, isn't self-delimiting, so a stray report can't be told apart from
// typed text. SGR (1006) reports are plain digits with an `M`/`m` terminator, so `MOUSE_RE`
// can be strict and anything it doesn't match is passed through as real typing.

// NORMAL TRACKING (1000), NOT BUTTON-EVENT TRACKING (1002). 1000 reports the press, the
// release and the wheel — everything we act on. 1002 adds a report for every cell the
// pointer crosses while a button is held, which is pure noise here: each one is an input
// event this app has to recognise and swallow, and anything it fails to recognise is typed
// into the prompt. Fewer reports, smaller blast radius. (Both modes make the terminal hand
// us the button, so both cost the native click-drag text selection; shift-drag still
// selects in Ghostty/iTerm/Terminal.app.)
export const ENABLE = "\x1b[?1000h\x1b[?1006h";
/** Give it back. Must run on exit, or the shell inherits a terminal reporting the mouse. */
export const DISABLE = "\x1b[?1000l\x1b[?1002l\x1b[?1006l";

// SGR: ESC [ < button ; col ; row (M press | m release)
//
// THE ESC IS OPTIONAL, and that is not defensiveness — it's the form we actually get.
// Ink's use-input.js ends with "strip escape prefix from broken/incomplete sequences":
// `if (input.startsWith('')) input = input.slice(1)`. Since parseKeypress leaves a
// mouse report unnamed, it falls through to `input = keypress.sequence` and then loses its
// ESC. So the handler is handed `[<64;10;5M`. Requiring the ESC made this parser match
// nothing at all, and the reports were typed straight into the prompt — the exact bug it
// was written to prevent, found only by looking at the rendered prompt.
//
// The cost is that literally typing "[<64;10;5M" scrolls instead of inserting. Ink has
// already destroyed the information needed to tell those apart, and that string is not
// something anyone types by accident.
const MOUSE_RE = /^\x1b?\[<(\d+);(\d+);(\d+)([Mm])$/;

// The wheel is reported as buttons 64 (up) and 65 (down), with modifier bits ORed on top:
// 4 = shift, 8 = meta/alt, 16 = ctrl. Masking them off is what makes shift+wheel and
// ctrl+wheel still scroll instead of being silently dropped as unknown buttons.
const WHEEL_UP = 64;
const WHEEL_DOWN = 65;
const MOD_SHIFT = 4;
const MOD_CTRL = 16;
const MOD_MOTION = 32;   // pointer moved (with a button down, under 1002)
const BUTTON_LEFT = 0;

/** Rows per wheel tick. Three is the convention (readline, less, vim's default). */
export const WHEEL_LINES = 3;

/**
 * Classify one Ink `input` string.
 *
 * Returns `null` for anything that isn't a mouse report — the caller must treat that as
 * ordinary typing and fall through, or the input box stops working.
 *
 * `{ type: "wheel", direction, lines, col, row }` for a wheel tick, where `lines` is how
 * far to move: 3 rows normally (the conventional wheel step — 1 feels broken, a whole
 * page is jarring for a gesture you make repeatedly), and a full page with shift or ctrl
 * held, matching what PgUp/PgDn do.
 *
 * `{ type: "click", col, row }` for the LEFT BUTTON GOING DOWN — 1-based screen
 * coordinates, exactly as the terminal counts them.
 *
 * `{ type: "other" }` for everything else that IS a report — the matching release, the
 * right/middle buttons, pointer motion. Recognised, deliberately unhandled, and still
 * SWALLOWED, because the point is that these bytes never reach the prompt as text.
 */
export function parseMouse(input, { page = 1 } = {}) {
  const m = MOUSE_RE.exec(String(input ?? ""));
  if (!m) return null;

  const button = Number(m[1]);
  const col = Number(m[2]);
  const row = Number(m[3]);
  const press = m[4] === "M";
  const base = button & ~(MOD_SHIFT | 8 | MOD_CTRL);

  if (base === WHEEL_UP || base === WHEEL_DOWN) {
    const bigStep = (button & MOD_SHIFT) !== 0 || (button & MOD_CTRL) !== 0;
    return {
      type: "wheel",
      direction: base === WHEEL_UP ? "up" : "down",
      lines: bigStep ? Math.max(1, page) : WHEEL_LINES,
      col,
      row,
    };
  }

  // A CLICK IS THE PRESS ONLY. The terminal sends the press (`M`) and then the release
  // (`m`) for the same button, so acting on both would toggle whatever was clicked twice
  // and land back where it started — a gesture that looks completely dead. The release is
  // still returned as a report so the caller swallows it instead of typing it.
  if (press && !(button & MOD_MOTION) && base === BUTTON_LEFT)
    return { type: "click", col, row };

  return { type: "other" };
}
