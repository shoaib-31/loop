// Turns -> styled terminal LINES. The transcript renderer's brain.
//
// WHY THIS IS A SEPARATE, PURE MODULE:
//   1. It's the "cleanly formatted, like Claude does" part, and formatting bugs are
//      exactly what a build can't catch — but a plain unit test can, for free, in
//      milliseconds. `blocks-test.mjs` needs no pty, no daemon and no tokens.
//   2. Line-exact output is what makes scrolling possible. If Ink re-wrapped our text
//      we would not know how many rows a turn occupies, so "show the last N lines"
//      and every scroll offset would be guesswork. So WE wrap, and every line is
//      rendered with wrap="truncate" so Ink can never re-flow it.
//
// The visual language mirrors Claude Code's own transcript, because that's the thing
// the user is comparing against:
//
//   ⏺ what the agent said, wrapped, with continuation lines indented
//   ⏺ Bash(npm test)              tool call: name + the one argument that matters
//     ⎿  3 packages audited        its result — ONE row, then "… +N lines  click / ^O"
//   ✻ Thinking… dim and italic
//   > what the human said
//
// Tool output is COLLAPSED by default and `expanded` (the TUI's `^O`) opens it. The
// prose is what the reader came for; a Read that returns 2000 lines is not.
//
// A LINE is { spans: [{ text, color?, dim?, bold?, italic? }] } — a list of styled
// runs. The component maps each span to an <ink Text>; this file never imports Ink.
//
// Mirrors apps/web/src/lib/tool-cards.ts (the phone's equivalent). Kept as a twin
// rather than shared because that file is TypeScript and the CLI has no build step.

// ---- width ---------------------------------------------------------------

// East Asian Wide / Fullwidth ranges — the characters that occupy two terminal
// cells. Without this, one line of CJK output wraps at the wrong column and every
// row below it is off by one, which looks like a corrupted screen rather than a
// width bug. Combining marks occupy zero. Everything else counts as one.
const WIDE = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf],
  [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff],
  [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6],
  [0x1f300, 0x1f64f], [0x1f900, 0x1f9ff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
  // Emoji from the SYMBOL blocks, which are two cells despite living below U+1F300.
  // These are not exotic: ✅ ❌ ⚠ are what an agent puts in a table, and counting them as
  // one cell each is what makes every column after them land a character to the left.
  [0x231a, 0x231b], [0x23e9, 0x23f3], [0x25fd, 0x25fe], [0x2614, 0x2615],
  [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce],
  [0x26d4, 0x26d4], [0x26ea, 0x26ea], [0x26f2, 0x26f3], [0x26f5, 0x26f5],
  [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755],
  [0x2757, 0x2757], [0x2795, 0x2797], [0x27b0, 0x27b0], [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55],
];
const inRanges = (cp, ranges) => ranges.some(([a, b]) => cp >= a && cp <= b);
const isCombining = (cp) =>
  (cp >= 0x0300 && cp <= 0x036f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f;

/** Terminal cells a string occupies. ANSI-free input only — we build the styling. */
export function cellWidth(s) {
  const chars = [...String(s ?? "")];
  let n = 0;
  for (let i = 0; i < chars.length; i++) {
    const cp = chars[i].codePointAt(0);
    if (isCombining(cp)) continue;
    // U+FE0F (the emoji variation selector) is what turns a text-presentation symbol into an
    // emoji, and terminals draw those two cells wide: `⚠` is one cell, `⚠️` is two. The
    // selector itself measures zero, so without this peek the pair measures one and every
    // column after it lands a character to the left.
    const emojified = chars[i + 1]?.codePointAt(0) === 0xfe0f;
    n += inRanges(cp, WIDE) || emojified ? 2 : 1;
  }
  return n;
}

/** Cells a span list occupies. */
const spansWidth = (spans) => spans.reduce((n, s) => n + cellWidth(s.text), 0);

/** Hard-cut to `cols` cells, appending "…" when it doesn't fit. */
export function truncate(s, cols) {
  if (cols <= 0) return "";
  if (cellWidth(s) <= cols) return s;
  let out = "", n = 0;
  for (const ch of String(s)) {
    const w = cellWidth(ch);
    if (n + w > cols - 1) break;
    out += ch;
    n += w;
  }
  return out + "…";
}

// ---- inline markdown -----------------------------------------------------

// Order matters: `~~` and the link form are matched before the single-char emphasis rules,
// or `~~x~~` would be seen as stray text and `[t](u)` would keep its punctuation.
const INLINE =
  /(\*\*[^*]+\*\*|~~[^~]+~~|\[[^\]\n]+\]\([^)\s]+\)|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
const LINK = /^\[([^\]\n]+)\]\(([^)\s]+)\)$/;

/**
 * `**bold**`, `` `code` ``, `*italic*`, `~~struck~~`, `[text](url)` -> styled spans.
 *
 * Deliberately small: agents emit prose with light markup, and a full markdown engine in a
 * terminal buys nothing but edge cases. Unmatched syntax is left as literal text rather than
 * swallowed — losing a character is worse than showing a stray asterisk.
 *
 * A LINK RENDERS AS ITS TEXT, underlined, and the URL is dropped. Not an OSC 8 hyperlink,
 * tempting as that is: the escape would live inside a span's text, where `cellWidth` would
 * count its bytes as columns and the whole line-exact layout falls apart. Losing the URL is
 * the lesser evil, and the phone shows the real thing.
 */
export function inlineSpans(text, base = {}) {
  const out = [];
  for (const part of String(text ?? "").split(INLINE)) {
    if (!part) continue;
    const link = LINK.exec(part);
    if (part.startsWith("**") && part.endsWith("**") && part.length > 4)
      out.push({ ...base, text: part.slice(2, -2), bold: true });
    else if (part.startsWith("~~") && part.endsWith("~~") && part.length > 4)
      out.push({ ...base, text: part.slice(2, -2), strikethrough: true });
    else if (link)
      out.push({ ...base, text: link[1], underline: true, color: base.color ?? "cyan" });
    else if (part.startsWith("`") && part.endsWith("`") && part.length > 2)
      out.push({ ...base, text: part.slice(1, -1), color: "cyan" });
    else if (/^[*_].*[*_]$/.test(part) && part.length > 2)
      out.push({ ...base, text: part.slice(1, -1), italic: true });
    else out.push({ ...base, text: part });
  }
  return out;
}

// ---- wrapping ------------------------------------------------------------

/**
 * Wrap styled spans to `cols`, carrying each word's style with it.
 *
 * `hang` indents continuation lines, so a bullet's text stays visually under the
 * bullet instead of sliding back to column 0.
 */
export function wrapSpans(spans, cols, { hang = 0 } = {}) {
  if (cols <= 1) return [{ spans }];
  const lines = [];
  let cur = [], used = 0, indent = 0;
  // Did WE start this line by wrapping? Leading spaces are dropped on a wrapped line (they'd
  // be a ragged left edge) but KEPT at the very start of the input, where they are the
  // author's indentation. Dropping them there flattened every nested list to one level and
  // un-indented every line of every code block — visible only by reading the output.
  let wrapped = false;

  const flush = () => {
    lines.push({ spans: cur.length ? cur : [{ text: "" }] });
    // Continuation lines OPEN with the indent — reserving the columns isn't enough,
    // the spaces have to actually be emitted or the text slides back to column 0.
    cur = hang > 0 ? [{ text: " ".repeat(hang) }] : [];
    indent = hang;
    used = hang;
    wrapped = true;
  };

  for (const span of spans) {
    // Keep the separators: splitting on /(\s+)/ means a run of spaces inside a
    // line survives, which matters for anything pre-formatted.
    for (const word of String(span.text ?? "").split(/(\s+)/)) {
      if (!word) continue;
      const isSpace = /^\s+$/.test(word);
      let w = cellWidth(word);

      if (isSpace) {
        if (used === indent && wrapped) continue; // no ragged left edge on a wrapped line
        if (used + w > cols) { flush(); continue; }
        cur.push({ ...span, text: word });
        used += w;
        continue;
      }

      if (used + w > cols && used > indent) flush();

      // A single word longer than the line (a URL, a base64 blob) must be cut
      // across lines, or it would push every following line over the edge.
      let rest = word;
      while (cellWidth(rest) > cols - used) {
        const room = cols - used;
        if (room <= 0) { flush(); continue; }
        let head = "", n = 0;
        for (const ch of rest) {
          const cw = cellWidth(ch);
          if (n + cw > room) break;
          head += ch;
          n += cw;
        }
        if (!head) { flush(); continue; }
        cur.push({ ...span, text: head });
        rest = rest.slice(head.length);
        flush();
      }
      if (rest) {
        cur.push({ ...span, text: rest });
        used += cellWidth(rest);
      }
    }
  }
  // Only a line with real content: after the last flush, `cur` may hold nothing but
  // the hanging indent, and that would render as a stray blank row.
  if (cur.some((s) => String(s.text).trim())) lines.push({ spans: cur });
  return lines.length ? lines : [{ spans: [{ text: "" }] }];
}

// ---- tool summaries ------------------------------------------------------

const firstLine = (s) => (String(s ?? "").split("\n").find((l) => l.trim()) ?? "").trim();
const str = (v) => {
  if (typeof v === "string") return v;
  if (v == null) return "";
  try { return JSON.stringify(v); } catch { return String(v); }
};

/**
 * A tool call as ONE line: the name, plus the single argument a human actually
 * scans for. `Bash(npm test)` answers "what is it doing" at a glance in a way that
 * pretty-printed JSON input never does.
 *
 * `full: true` keeps the argument's later lines instead of stopping at the first —
 * that's the expanded view (`^O`), where the point is to read the whole command.
 *
 * Twin of `toolUseCard()` in apps/web/src/lib/tool-cards.ts.
 */
export function toolSummary(name, input, { full = false } = {}) {
  const n = name ?? "tool";
  const i = input ?? {};
  // Trailing/leading BLANK LINES are dropped either way — a command that opens with a
  // newline would otherwise render its own name on a row of its own.
  const pick = (v) => (full ? str(v).replace(/^\s*\n+/, "").replace(/\s+$/, "") : firstLine(str(v)));
  switch (n) {
    case "Bash": return { title: "Bash", arg: pick(i.command ?? i.description) };
    case "Read": return { title: "Read", arg: pick(i.file_path) };
    case "Write": return { title: "Write", arg: pick(i.file_path) };
    case "Edit": return { title: "Edit", arg: pick(i.file_path) };
    case "Glob": return { title: "Glob", arg: pick(i.pattern) };
    case "Grep": return { title: "Grep", arg: pick(i.pattern) };
    case "Task":
    case "Agent": return { title: "Agent", arg: pick(i.description ?? i.prompt) };
    case "WebFetch": return { title: "WebFetch", arg: pick(i.url) };
    case "WebSearch": return { title: "WebSearch", arg: pick(i.query) };
    case "TodoWrite":
    case "TaskCreate":
    case "TaskUpdate": return { title: n, arg: pick(i.description ?? "") };
    case "AskUserQuestion": {
      const qs = Array.isArray(i.questions) ? i.questions : [];
      return { title: "Question", arg: pick(qs.map((q) => q?.question).filter(Boolean).join(" · ")) };
    }
    default:
      // MCP tools arrive as mcp__server__tool; the server name is the useful half.
      if (n.startsWith("mcp__")) {
        const p = n.split("__");
        return { title: p[2] ?? n, arg: p[1] ?? "" };
      }
      return { title: n, arg: pick(str(input)) };
  }
}

// ---- glyphs --------------------------------------------------------------

export const GLYPH = {
  bullet: "⏺",   // an agent action (matches Claude Code)
  result: "⎿",   // its result — hanging beneath when expanded, inline when collapsed
  think: "✻",
  you: ">",
};

const TOOL_COLOR = {
  Bash: "yellow", Read: "cyan", Glob: "cyan", Grep: "cyan",
  Write: "green", Edit: "green",
  Agent: "magenta", WebFetch: "blue", WebSearch: "blue",
  Question: "yellow",
};

// ---- blocks -> lines -----------------------------------------------------

// THE COLLAPSE POLICY: A WHOLE TOOL STEP IS ONE ROW.
//
// Not one row for the call and one for the result — ONE, both halves on the same line:
//
//   ⏺ Bash(npm test)              ⎿ 41 passed, 0 failed
//   ⏺ Read(daemon/server.mjs)     ⎿ line 0: const value_0 = 0;  +39
//
// The transcript exists to show the CONVERSATION, and an agent that reads six files and
// runs four commands otherwise fills the screen with output nobody asked to read. Three
// rows a step (call / first line / "+N more") was still enough to push the prose off the
// top — so the whole step is a single scannable line, and opening it is a click or `^O`.
//
// The marker stays `⎿` — the same glyph the expanded form uses for output, so collapsing
// changes the LAYOUT and not the vocabulary. It is deliberately NOT the disclosure chevron
// `▸`, because that is already the fleet list's selection cursor; one glyph meaning two
// things across two views is how a screen starts lying to you. `+N` carries "there's more".
const STEP_MARKER = GLYPH.result;

// ---- markdown that isn't just a styled word ------------------------------

const TABLE_ROW = /^\s*\|(.*)\|\s*$/;
// The separator row is what MAKES a table a table (`|---|:--:|`): a run of pipes with only
// dashes, colons and spaces between them, and at least one dash.
const TABLE_SEP = /^\s*\|[\s:|-]*-[\s:|-]*\|\s*$/;
const QUOTE = /^\s*>\s?(.*)$/;
const RULE = /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/;
const CHECKBOX = /^\[([ xX])\]\s+(.*)$/;

/** `| a | b |` -> ["a", "b"]. */
const tableCells = (raw) => TABLE_ROW.exec(raw)[1].split("|").map((c) => c.trim());

/**
 * A markdown table -> aligned rows. Header bold, one dim rule under it, no outer box.
 *
 * WHY THIS EXISTS AT ALL: the agent's answers are full of tables (the headless session that
 * prompted this is three of them), and unhandled they render as literal `|---|:--:|` rows —
 * the single ugliest thing in the transcript.
 *
 * WIDTHS ARE THE WHOLE JOB. Natural column widths rarely fit a terminal, so the widest column
 * gives up a cell at a time until the row fits, and cells are truncated (never wrapped) so a
 * table stays exactly one row per row — which is what keeps the line count exact for scrolling.
 */
function tableLines(rows, body) {
  const grid = rows.map(tableCells);
  const cols = Math.max(...grid.map((r) => r.length));
  const align = (rows.aligns ?? []).slice();

  // RENDER EVERY CELL FIRST, then measure THAT. Measuring the raw markdown and rendering the
  // processed text pads `**b**` as five columns and draws three, so every column after it
  // slides left by two — the table looks aligned in the source and ragged on screen.
  const cells = grid.map((row, r) =>
    Array.from({ length: cols }, (_, i) =>
      inlineSpans(row[i] ?? "", r === 0 ? { bold: true } : {})
    )
  );
  const width = Array.from({ length: cols }, (_, i) =>
    Math.max(1, ...cells.map((row) => spansWidth(row[i])))
  );

  const GAP = 2;
  const fits = () => width.reduce((n, w) => n + w, 0) + GAP * (cols - 1) <= body;
  // Shrink the widest column repeatedly: the long "Notes" column pays for the narrow ones,
  // which is what a person would do by hand.
  let guard = 4096;
  while (!fits() && guard-- > 0) {
    const widest = width.indexOf(Math.max(...width));
    if (width[widest] <= 3) break;
    width[widest]--;
  }

  return cells.map((row) => {
    const spans = [];
    for (let i = 0; i < cols; i++) {
      const w = width[i];
      const cut = trimSpans(row[i], w);
      const pad = Math.max(0, w - spansWidth(cut));
      const a = align[i] ?? "left";
      const left = a === "right" ? pad : a === "center" ? Math.floor(pad / 2) : 0;
      if (left) spans.push({ text: " ".repeat(left) });
      spans.push(...cut);
      // No trailing pad on the last column: those spaces are invisible either way, and the
      // header rule below is drawn from the row's width.
      const right = i < cols - 1 ? pad - left : 0;
      if (right) spans.push({ text: " ".repeat(right) });
      if (i < cols - 1) spans.push({ text: " ".repeat(GAP) });
    }
    return spans;
  });
}

/** Alignment per column, read from the separator row's colons. */
function tableAligns(sep) {
  return tableCells(sep).map((c) => {
    const l = c.startsWith(":");
    const r = c.endsWith(":");
    return l && r ? "center" : r ? "right" : "left";
  });
}

function textLines(text, cols, { role }) {
  const lines = [];
  const you = role === "user";
  const glyph = you ? GLYPH.you : GLYPH.bullet;
  const body = cols - 2;
  let fenced = false;
  let fenceLang = "";

  // THE GLYPH MARKS THE BLOCK, NOT THE LINE. It goes on the first rendered row and
  // nowhere else; every later row is indented two columns to sit under it. Deciding
  // this per *source* line would stamp a bullet on each wrapped fragment, which reads
  // as one message per line instead of one message.
  const push = (spans) => {
    const firstRow = lines.length === 0;
    lines.push({
      spans: [
        firstRow
          ? { text: `${glyph} `, color: you ? "green" : "cyan", bold: !you }
          : { text: "  " },
        ...spans,
      ],
    });
  };

  const src = String(text ?? "").split("\n");
  for (let i = 0; i < src.length; i++) {
    const raw = src[i];
    // Fenced code: no inline markdown inside, because `*` and `_` in code mean
    // themselves. The fence markers are dropped; the content is dimmed instead.
    const fence = /^\s*```(\w*)/.exec(raw);
    if (fence) {
      fenced = !fenced;
      fenceLang = fenced ? fence[1].toLowerCase() : "";
      continue;
    }

    if (fenced) {
      // A ```diff fence reads as a diff: green added, red removed, cyan hunk headers. This
      // is what the Edit tool's output looks like, so it's worth the four lines.
      const tone = fenceLang === "diff"
        ? /^\+/.test(raw) ? { color: "green" }
          : /^-/.test(raw) ? { color: "red" }
          : /^@@/.test(raw) ? { color: "cyan" }
          : { dimColor: true }
        : { dimColor: true };
      for (const l of wrapSpans([{ text: raw, ...tone }], body)) push(l.spans);
      continue;
    }

    // A blank source line stays blank — it's the paragraph break the agent wrote.
    if (!raw.trim()) { if (lines.length) lines.push({ spans: [{ text: "" }] }); continue; }

    // A TABLE: this row, a separator under it, and every row after. Consumed as a unit,
    // because the widths can only be chosen once all the rows are known.
    if (TABLE_ROW.test(raw) && i + 1 < src.length && TABLE_SEP.test(src[i + 1])) {
      const rows = [raw];
      let j = i + 2;
      for (; j < src.length && TABLE_ROW.test(src[j]) && !TABLE_SEP.test(src[j]); j++) rows.push(src[j]);
      const grid = rows;
      grid.aligns = tableAligns(src[i + 1]);
      const rendered = tableLines(grid, body);
      rendered.forEach((spans, r) => {
        push(spans);
        // One dim rule under the header, instead of a full box: it separates without
        // spending three rows and a column of pipes on decoration.
        if (r === 0) push([{ text: "─".repeat(Math.min(body, Math.max(4, spansWidth(spans)))), dimColor: true }]);
      });
      i = j - 1;
      continue;
    }

    // A HORIZONTAL RULE, drawn rather than left as three literal dashes.
    if (RULE.test(raw)) { push([{ text: "─".repeat(Math.max(4, body)), dimColor: true }]); continue; }

    // A BLOCKQUOTE gets a left bar. It must NOT keep its `>`: that glyph means "the human
    // said this" everywhere else in the transcript, so a quoted line would read as your own
    // message coming back at you.
    const quote = QUOTE.exec(raw);
    if (quote) {
      const spans = [{ text: "│ ", dimColor: true }, ...inlineSpans(quote[1], { dimColor: true })];
      for (const l of wrapSpans(spans, body, { hang: 2 })) push(l.spans);
      continue;
    }

    // Headings read as bold; the #s themselves are noise in a terminal.
    const heading = raw.match(/^(#{1,6})\s+(.*)$/);
    // Bullets and numbered items get a hanging indent so the text lines up.
    const bullet = raw.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);

    let spans, hang = 0;
    if (heading) spans = [{ text: heading[2], bold: true }];
    else if (bullet) {
      // A TASK LIST is a bullet whose text starts with `[ ]` or `[x]`. Drawing the state
      // instead of the brackets is the difference between a checklist and punctuation.
      const box = CHECKBOX.exec(bullet[3]);
      const marker = box
        ? (box[1] === " " ? "○" : "✓")
        : /^[-*+]$/.test(bullet[2]) ? "•" : bullet[2];
      hang = bullet[1].length + marker.length + 1;
      spans = [
        { text: bullet[1] + marker + " ", color: box && box[1] !== " " ? "green" : "gray" },
        ...inlineSpans(box ? box[2] : bullet[3]),
      ];
    } else spans = inlineSpans(raw);

    for (const l of wrapSpans(spans, body, { hang })) push(l.spans);
  }
  return lines;
}

function thinkingLines(text, cols) {
  const spans = [{ text: `${GLYPH.think} `, dimColor: true }, ...inlineSpans(text, { dimColor: true, italic: true })];
  return wrapSpans(spans, cols);
}

function toolUseLines(block, cols, { expanded = false } = {}) {
  const { title, arg } = toolSummary(block.name, block.input, { full: expanded });
  const color = TOOL_COLOR[title] ?? "magenta";
  const head = [
    { text: `${GLYPH.bullet} `, color },
    { text: title, bold: true },
  ];
  // `step: true` for the collapsed one-row forms, so a run of them packs together. A call
  // with no result yet — a step still running — is the same shape of row, and having it
  // suddenly gain blank lines around it while it waits would read as a glitch.
  if (!arg) return [{ step: !expanded, spans: trimSpans(head, cols) }];

  // Collapsed: tool calls are scan targets, not prose — one line each keeps the
  // transcript readable when an agent fires off twenty of them.
  if (!expanded)
    return [{ step: true, spans: trimSpans([...head, { text: "(" + arg + ")", dimColor: true }], cols) }];

  // Expanded: the WHOLE argument, wrapped instead of cut. A command long enough to be
  // truncated is exactly the one you pressed `^O` to read, so cutting it here would
  // make the key useless for the case that motivates it.
  const src = arg.split("\n");
  const out = [];
  src.forEach((raw, i) => {
    const open = i === 0 ? "(" : "";
    const close = i === src.length - 1 ? ")" : "";
    const spans = i === 0
      ? [...head, { text: open + raw + close, dimColor: true }]
      : [{ text: "    " }, { text: raw + close, dimColor: true }];
    for (const l of wrapSpans(spans, cols, { hang: 4 })) out.push({ spans: l.spans });
  });
  return out;
}

/**
 * A result as SPANS ONLY — no prefix, no row of its own. This is the collapsed summary,
 * and it's built separately from any row so it can be dropped either onto the end of its
 * call's line (the normal case, one row for the whole step) or behind a `⎿` on its own.
 *
 * The first non-blank line plus `+N` for the rest: the first line is where a command
 * usually puts the answer ("41 passed", "error TS2345: …"), and the count is what says
 * there's more behind the row.
 */
function resultSummarySpans(block) {
  const text = String(block?.text ?? "").replace(/\s+$/, "");
  const all = text ? text.split("\n") : [];
  const err = !!block?.is_error;
  const tone = err ? { color: "red" } : { dimColor: true };

  if (!all.length) return [{ text: err ? "error" : "(no output)", ...tone }];

  const first = (all.find((l) => l.trim()) ?? all[0]).replace(/\t/g, "  ");
  const out = [{ text: first, ...tone }];
  const hidden = all.length - 1;
  if (hidden > 0) out.push({ text: `  +${hidden}`, dimColor: true });
  return out;
}

/**
 * A COLLAPSED STEP: the call and its result on ONE row.
 *
 * `⏺ Bash(npm test)  ▸ 41 passed, 0 failed`
 *
 * The width split is the fiddly part. Appending the summary to an already-full call line
 * would push it straight off the right edge — so the call is trimmed against a reduced
 * budget first, and the summary is capped at a fraction of the width so a chatty result
 * can't swallow the command that produced it. A short summary costs the call nothing.
 */
function stepLine(call, result, cols) {
  const { title, arg } = toolSummary(call.name, call.input);
  const color = TOOL_COLOR[title] ?? "magenta";
  const head = [{ text: `${GLYPH.bullet} `, color }, { text: title, bold: true }];
  if (arg) head.push({ text: "(" + arg + ")", dimColor: true });

  const sum = resultSummarySpans(result);
  const gap = { text: "  " };
  const marker = { text: `${STEP_MARKER} `, dimColor: true };
  const reserve = Math.min(spansWidth(sum) + 4, Math.floor(cols * 0.45));
  const left = trimSpans(head, Math.max(8, cols - reserve));
  // `step: true` marks this as a whole-step row, which is what lets the transcript pack
  // consecutive steps together instead of blank-lining between them.
  return [{ step: true, spans: trimSpans([...left, gap, marker, ...sum], cols) }];
}

function resultLines(block, cols, { expanded = false } = {}) {
  const text = String(block.text ?? "").replace(/\s+$/, "");
  const all = text ? text.split("\n") : [];
  const err = !!block.is_error;
  const tone = err ? { color: "red" } : { dimColor: true };

  // COLLAPSED: one row, behind a `⎿`. Normally this row doesn't happen at all — the
  // summary is merged onto the call's line by transcriptLines. This is the fallback for a
  // result whose call ISN'T the row above (a history that starts mid-step), where a `⎿`
  // hanging off nothing is still clearer than a bare line of output.
  if (!expanded)
    return [{
      spans: trimSpans(
        [{ text: `  ${GLYPH.result}  `, dimColor: true }, ...resultSummarySpans(block)],
        cols
      ),
    }];

  if (!all.length)
    return [{ spans: [{ text: `  ${GLYPH.result}  `, dimColor: true }, { text: err ? "error" : "(no output)", ...tone }] }];

  // EXPANDED: all of it. Scrolling exists (wheel/PgUp/Home), so a 2000-line Read is
  // reachable rather than merely present.
  return all.map((l, i) => ({
    spans: [
      { text: i === 0 ? `  ${GLYPH.result}  ` : "     ", dimColor: true },
      { text: truncate(l.replace(/\t/g, "  "), cols - 5), ...tone },
    ],
  }));
}

/** Truncate a span list to `cols` cells, dropping/cutting from the end. */
function trimSpans(spans, cols) {
  const out = [];
  let used = 0;
  for (const s of spans) {
    const w = cellWidth(s.text);
    if (used + w <= cols) { out.push(s); used += w; continue; }
    const room = cols - used;
    if (room > 1) out.push({ ...s, text: truncate(s.text, room) });
    break;
  }
  return out;
}

/**
 * One block -> lines. `askIds` are the AskUserQuestion tool_use ids, so the
 * tool_result that answers one renders as the answer rather than as stray text.
 */
export function blockLines(block, { cols, role = "assistant", askIds, expanded = false } = {}) {
  const width = Math.max(8, cols ?? 80);
  switch (block?.kind) {
    case "text":
      return textLines(block.text, width, { role });
    case "thinking":
      return thinkingLines(block.text, width);
    case "tool_use":
      return toolUseLines(block, width, { expanded });
    case "tool_result": {
      if (askIds?.has(block.tool_use_id))
        return [{
          spans: [
            { text: `  ${GLYPH.result}  `, dimColor: true },
            { text: "answered: ", dimColor: true },
            { text: String(block.text ?? ""), color: "green" },
          ],
        }];
      return resultLines(block, width, { expanded });
    }
    default:
      return [];
  }
}

/**
 * A stable identity for one collapsible step, so a click can toggle it and keep
 * toggling the same thing as the transcript grows.
 *
 * The tool_use id is used for BOTH the call and the result that answers it, so opening
 * either opens the pair — they read as one thing on screen, and toggling half of a `⏺` /
 * `⎿` couple would look like a rendering bug. The `t:`/`r:` fallbacks are for blocks with
 * no id at all; turn indices are stable because turns are only ever appended.
 */
function blockKey(block, turnIndex, blockIndex, askIds) {
  if (block?.kind === "tool_use") return block.id ?? `t${turnIndex}:${blockIndex}`;
  if (block?.kind === "tool_result") {
    // An ANSWERED QUESTION is not tool output — it's the record of a decision, it has
    // nothing hidden, and it must not be clickable.
    if (askIds?.has(block.tool_use_id)) return null;
    return block.tool_use_id ?? `r${turnIndex}:${blockIndex}`;
  }
  return null;
}

/**
 * The whole transcript as lines, in order, with a blank line between turns so
 * the wall of output has some rhythm to it.
 *
 * Two ways a step gets opened, and they compose by XOR:
 *   `expanded`  — the `^O` key: the DEFAULT for every step (open all / close all).
 *   `toggled`   — a Set of block keys clicked to differ from that default. So with
 *                 everything expanded, clicking one step collapses just that one.
 *
 * Every line that belongs to a collapsible step carries `.block = <key>`, which is what
 * lets a click at a screen row find out what it hit. Lines of prose carry nothing.
 */
export function transcriptLines(turns, { cols = 80, expanded = false, toggled = null } = {}) {
  // Which tool_use blocks are questions — needed before rendering, because the
  // tool_result that answers one appears in a LATER turn.
  const askIds = new Set();
  for (const t of turns ?? [])
    for (const b of t.blocks ?? [])
      if (b.kind === "tool_use" && b.name === "AskUserQuestion" && b.id) askIds.add(b.id);

  // PAIR EACH CALL WITH ITS RESULT, so a collapsed step can be ONE row. The SDK delivers
  // the result as its own user-role turn LATER, so this can't be done while walking — by
  // the time the result is reached its call has already been rendered, and merging then
  // would mean surgery on a row that was trimmed to the width without knowing about it.
  const resultOf = new Map();
  for (const t of turns ?? [])
    for (const b of t.blocks ?? [])
      if (b?.kind === "tool_result" && b.tool_use_id && !askIds.has(b.tool_use_id))
        resultOf.set(b.tool_use_id, b);
  // Results already drawn as part of their call's row; their own turn must skip them.
  const merged = new Set();

  const lines = [];
  let ti = -1;
  for (const t of turns ?? []) {
    ti++;
    // The ORIGINAL index travels with each block: `blockKey` falls back to `turn:index` for
    // blocks with no id, and re-indexing after the filter would make that key move when a
    // step is expanded — quietly turning "the step I clicked" into a different one.
    const items = (t.blocks ?? []).map((b, bi) => ({ b, bi })).filter(({ b }) => !merged.has(b));
    // Every block of this turn was already drawn into the row above (the normal case for a
    // collapsed step). Nothing to draw, and — importantly — no blank line to pop.
    if (!items.length) continue;

    // A tool RESULT hangs off the call above it — the ⎿ only makes visual sense
    // directly beneath its ⏺. The SDK delivers results as their own user-role turn,
    // so the turn separator would drive a blank line between the two halves of what
    // the eye reads as one thing.
    const isResultOnly = items.every(({ b }) => b?.kind === "tool_result");
    if (isResultOnly && lines.length && lines[lines.length - 1].spans.every((s) => !s.text))
      lines.pop();

    const before = lines.length;
    for (const { b, bi } of items) {
      const key = blockKey(b, ti, bi, askIds);
      // XOR: `toggled` holds the EXCEPTIONS to the ^O default, which is what makes
      // "expand all, then close this one" work as well as the other way round.
      const open = key && toggled?.has(key) ? !expanded : expanded;

      // THE ONE-ROW STEP: a collapsed call whose result has arrived draws both halves on a
      // single line. Without the result it stays a bare `⏺ Bash(…)` — which is honest,
      // because that's a step still running.
      const pair = !open && b?.kind === "tool_use" && b.id ? resultOf.get(b.id) : null;
      const rendered = pair
        ? stepLine(b, pair, cols)
        : blockLines(b, { cols, role: t.role, askIds, expanded: open });
      if (pair) merged.add(pair);

      // Tag the rows so a click can find its way back to the block. Set on the line
      // objects themselves rather than kept in a parallel index, because the line list is
      // sliced and windowed constantly and any parallel structure would drift out of step.
      if (key) for (const l of rendered) l.block = key;
      lines.push(...rendered);
    }
    if (lines.length > before) lines.push({ spans: [{ text: "" }] });
  }
  // PACK CONSECUTIVE STEPS. The blank between turns gives the wall of output some rhythm,
  // but between two one-row steps it just doubles their height — and a run of `⏺` rows is
  // already visually self-separating. Only blanks with a step row on BOTH sides go; the one
  // between a step and prose stays, because that's where the rhythm is actually doing work.
  const packed = lines.filter((l, i) => {
    if (l.spans.some((s) => s.text)) return true;
    return !(lines[i - 1]?.step && lines[i + 1]?.step);
  });

  // A trailing blank line is just a wasted row at the bottom of the viewport.
  while (packed.length && !packed[packed.length - 1].spans.some((s) => s.text)) packed.pop();
  return packed;
}

/**
 * WHICH LINES ARE ON SCREEN, given the viewport height and how far you've scrolled up.
 *
 * Exported and pure because TWO callers need the same answer and they must never disagree:
 * the component that draws the window, and the click handler that turns a screen row back
 * into a line index. Two copies of this arithmetic that drift apart don't crash — they
 * quietly open the wrong tool call.
 *
 * `offset` counts lines up from the newest (0 = live). The "↓ n more" marker COSTS A ROW
 * and is taken out of the text budget rather than added on top of it, so the whole column
 * stays exactly `rows` tall — otherwise scrolling up pushes the input off the bottom.
 */
export function transcriptWindow({ total, rows, offset = 0 }) {
  const height = Math.max(1, rows);
  const end = Math.max(0, total - Math.max(0, offset));
  const below = total - end;
  const textRows = Math.max(1, height - (below > 0 ? 1 : 0));
  const start = Math.max(0, end - textRows);
  return { start, end, textRows, below };
}

// ---- "it's working, not stuck" (docs/architecture.md) --------------------

/** After this much silence the line says so: "Working · 4m" is true of a build AND a hang. */
export const QUIET_AFTER_MS = 45_000;

/** `13s`, `2m 05s`, `1h 3m` — the same wording the phone uses. */
export function formatElapsed(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m ${String(s % 60).padStart(2, "0")}s` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/**
 * WHAT the agent is doing, when that's knowable. A tool call with no result after it is the
 * long, silent stretch of most runs, so naming it is most of the reassurance.
 */
export function workingLabel(partial, turns) {
  if (partial?.kind === "thinking") return "Thinking";
  if (partial?.kind === "text") return "Writing";
  const last = turns?.[turns.length - 1];
  const call = last?.role === "assistant" ? [...last.blocks].reverse().find((b) => b.kind === "tool_use") : null;
  if (call && call.name !== "AskUserQuestion") return `Running ${toolSummary(call.name, call.input).title}`;
  return "Working";
}

/** The line itself: `✻ Running Bash… 13s`, plus the silence warning once it applies. */
export function workingLine({ label, elapsedMs, quietMs = 0, cols = 80 }) {
  const spans = [
    { text: `${GLYPH.think} `, color: "magenta" },
    { text: `${label}…`, color: "magenta" },
    { text: ` ${formatElapsed(elapsedMs)}`, dimColor: true },
  ];
  if (quietMs >= QUIET_AFTER_MS) spans.push({ text: ` · no output for ${formatElapsed(quietMs)}`, color: "yellow" });
  // One row, always: a wrapped status line is an extra row the layout never budgeted.
  const flat = spans.map((s) => s.text).join("");
  if (cellWidth(flat) > cols) return { spans: [{ text: truncate(flat, cols), color: "magenta" }] };
  return { spans };
}
