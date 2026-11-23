// A tiny terminal emulator: pty bytes -> the grid of characters actually on screen.
//
// WHY THIS EXISTS. The TUI tests used to regex the raw pty transcript, and that answers
// the wrong question. Ink does NOT redraw whole frames — it emits *differential* updates
// (cursor-up, erase-line, rewrite), so the transcript is a stream of edits, not a
// sequence of screens. Grepping it tells you "these bytes were written at some point",
// which is how a test can pass while the real screen shows something else entirely:
//   * a row that was later erased still matches
//   * a row rewritten in place matches twice
//   * and there is no reliable way to find where one "frame" ends, so
//     "is the input on the bottom row?" is unanswerable
//
// Replaying the bytes into a grid answers it exactly: row -1 is the bottom of the
// screen, full stop. That's the assertion the layout needs.
//
// Ink's escape vocabulary turns out to be tiny, which is what makes this ~100 lines
// instead of a dependency: SGR colours (m), erase-line (K), cursor-up (A),
// cursor-to-column-0 (G), erase-display (J), home (H), and the alternate-screen /
// synchronised-update toggles (?h/?l). Anything else is ignored, deliberately: an
// unrecognised sequence must not corrupt the grid, or a test failure stops being
// evidence about the app.

const ESC = "\x1b";

export class Screen {
  constructor(cols = 100, rows = 40) {
    this.resize(cols, rows);
  }

  resize(cols, rows) {
    this.cols = cols;
    this.rows = rows;
    this.grid = Array.from({ length: rows }, () => Array(cols).fill(" "));
    this.x = 0;
    this.y = 0;
  }

  /** Rows as strings, trailing spaces trimmed — what a human would say is on screen. */
  lines() {
    return this.grid.map((r) => r.join("").replace(/\s+$/, ""));
  }

  text() {
    return this.lines().join("\n");
  }

  /** The last `n` non-blank-padded rows, for "is the input at the bottom" assertions. */
  bottom(n = 5) {
    return this.lines().slice(-n).join("\n");
  }

  /** Row index of the first line matching `re`, or -1. */
  find(re) {
    return this.lines().findIndex((l) => re.test(l));
  }

  _scroll() {
    this.grid.shift();
    this.grid.push(Array(this.cols).fill(" "));
    this.y = this.rows - 1;
  }

  _put(ch) {
    if (this.x >= this.cols) { this.x = 0; this.y++; }
    while (this.y >= this.rows) this._scroll();
    this.grid[this.y][this.x] = ch;
    this.x++;
  }

  _eraseLine(mode) {
    if (this.y < 0 || this.y >= this.rows) return;
    const row = this.grid[this.y];
    // 0/absent = cursor to end, 1 = start to cursor, 2 = whole line.
    const from = mode === 1 ? 0 : mode === 2 ? 0 : this.x;
    const to = mode === 1 ? this.x + 1 : this.cols;
    for (let i = from; i < Math.min(to, this.cols); i++) row[i] = " ";
  }

  _eraseDisplay(mode) {
    // 0 = cursor to end of screen, 1 = start to cursor, 2/3 = everything.
    if (mode === 2 || mode === 3) {
      this.grid = Array.from({ length: this.rows }, () => Array(this.cols).fill(" "));
      return;
    }
    if (mode === 1) {
      for (let y = 0; y < this.y; y++) this.grid[y].fill(" ");
      this._eraseLine(1);
      return;
    }
    this._eraseLine(0);
    for (let y = this.y + 1; y < this.rows; y++) this.grid[y].fill(" ");
  }

  /** Feed pty output. Call repeatedly; state carries over. */
  write(data) {
    const s = String(data);
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];

      if (ch === ESC) {
        // OSC (title etc): ESC ] ... BEL | ESC \  — consumed and dropped.
        if (s[i + 1] === "]") {
          const end = s.slice(i).search(/\x07|\x1b\\/);
          i = end < 0 ? s.length : i + end + (s[i + end] === "\x07" ? 0 : 1);
          continue;
        }
        // CSI: ESC [ params letter
        const m = /^\x1b\[([0-9;?]*)([a-zA-Z])/.exec(s.slice(i));
        if (!m) { i += 1; continue; } // ESC ( charset, ESC =, etc.
        const [all, rawParams, cmd] = m;
        i += all.length - 1;
        const params = rawParams.replace(/^\?/, "").split(";").map((p) => (p === "" ? null : Number(p)));
        const p0 = params[0];
        const priv = rawParams.startsWith("?");

        if (priv) continue; // ?1049h alt screen, ?2026h sync update, ?25l cursor — no grid effect
        switch (cmd) {
          case "A": this.y = Math.max(0, this.y - (p0 ?? 1)); break;
          case "B": this.y = Math.min(this.rows - 1, this.y + (p0 ?? 1)); break;
          case "C": this.x = Math.min(this.cols - 1, this.x + (p0 ?? 1)); break;
          case "D": this.x = Math.max(0, this.x - (p0 ?? 1)); break;
          case "E": this.y = Math.min(this.rows - 1, this.y + (p0 ?? 1)); this.x = 0; break;
          case "F": this.y = Math.max(0, this.y - (p0 ?? 1)); this.x = 0; break;
          case "G": this.x = Math.max(0, (p0 ?? 1) - 1); break;
          case "H":
          case "f":
            this.y = Math.min(this.rows - 1, Math.max(0, (params[0] ?? 1) - 1));
            this.x = Math.min(this.cols - 1, Math.max(0, (params[1] ?? 1) - 1));
            break;
          case "J": this._eraseDisplay(p0 ?? 0); break;
          case "K": this._eraseLine(p0 ?? 0); break;
          default: break; // m (colour), s/u (save/restore), r (scroll region): no grid effect
        }
        continue;
      }

      if (ch === "\n") { this.y++; while (this.y >= this.rows) this._scroll(); continue; }
      if (ch === "\r") { this.x = 0; continue; }
      if (ch === "\t") { this.x = Math.min(this.cols - 1, (Math.floor(this.x / 8) + 1) * 8); continue; }
      if (ch === "\b") { this.x = Math.max(0, this.x - 1); continue; }
      if (ch === "\x07") continue; // bell
      if (ch < " ") continue;      // any other control char

      this._put(ch);
      // Wide characters occupy a second cell; without this, a CJK row's columns drift.
      const cp = ch.codePointAt(0);
      if (cp >= 0x1100 && (cp <= 0x115f || (cp >= 0x2e80 && cp <= 0xa4cf) ||
          (cp >= 0xac00 && cp <= 0xd7a3) || (cp >= 0xf900 && cp <= 0xfaff) ||
          (cp >= 0xff00 && cp <= 0xff60) || (cp >= 0x1f300 && cp <= 0x1f64f)))
        this._put(" ");
    }
    return this;
  }
}

/** Replay a whole transcript into a fresh screen. */
export function renderScreen(data, cols = 100, rows = 40) {
  return new Screen(cols, rows).write(data);
}
