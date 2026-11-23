// Unit test for the transcript formatter (tui/blocks.mjs).
//
// The pty harness (tui-test.mjs) spends real tokens and takes a minute, so it can't be
// the thing that guards line-level formatting. This can: pure functions, no pty, no
// daemon, no network, milliseconds.
//
// What it's actually protecting: the transcript is TAILED and SCROLLED by line index,
// so "how many lines does this turn occupy" must be exact. A wrap bug that pushes one
// line over the terminal width doesn't crash — it silently shifts every row below it,
// which reads as a corrupted screen.
//
//   node apps/cli/src/tui/blocks-test.mjs

import {
  cellWidth, truncate, inlineSpans, wrapSpans, toolSummary, blockLines,
  transcriptLines, transcriptWindow, GLYPH,
} from "./blocks.mjs";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`); }
};

/** A rendered line as plain text — what the eye actually sees on that row. */
const flat = (line) => line.spans.map((s) => s.text).join("");
const flatten = (lines) => lines.map(flat);
/** Every line must fit the viewport. This is THE invariant. */
const fits = (lines, cols) => lines.every((l) => cellWidth(flat(l)) <= cols);

console.log("\nwidth\n");

ok("ascii counts one cell per char", cellWidth("hello") === 5);
ok("CJK counts two cells", cellWidth("日本語") === 6);
ok("combining marks count zero", cellWidth("é") === 1);
ok("truncate leaves short strings alone", truncate("abc", 10) === "abc");
ok("truncate marks the cut with an ellipsis", truncate("abcdefgh", 5) === "abcd…");
ok("truncate respects wide chars", cellWidth(truncate("日本語日本語", 5)) <= 5);

console.log("\ninline markdown\n");

{
  const spans = inlineSpans("plain **bold** and `code` here");
  ok("bold is styled and the ** is dropped", spans.some((s) => s.text === "bold" && s.bold));
  ok("code is coloured and the backticks are dropped",
    spans.some((s) => s.text === "code" && s.color === "cyan"));
  ok("no marker characters survive", !spans.map((s) => s.text).join("").includes("*"));
  ok("nothing is lost", spans.map((s) => s.text).join("") === "plain bold and code here");
}
ok("an unmatched asterisk stays literal",
  inlineSpans("2 * 3 = 6").map((s) => s.text).join("") === "2 * 3 = 6");

console.log("\nwrapping\n");

{
  const lines = wrapSpans([{ text: "the quick brown fox jumps over the lazy dog" }], 12);
  ok("wraps at the width", fits(lines, 12), JSON.stringify(flatten(lines)));
  ok("wrapping loses no words",
    flatten(lines).join(" ").split(/\s+/).filter(Boolean).join(" ") ===
      "the quick brown fox jumps over the lazy dog");
  ok("no wrapped line starts with a space", flatten(lines).every((l) => !l.startsWith(" ")));
}
{
  // The case that would otherwise overflow forever: one token longer than the line.
  const long = "x".repeat(50);
  const lines = wrapSpans([{ text: long }], 10);
  ok("a word longer than the line is broken, not overflowed", fits(lines, 10));
  ok("breaking a long word keeps every character",
    flatten(lines).join("").replace(/\s+/g, "") === long);
}
{
  const lines = wrapSpans([{ text: "aaa bbb ccc ddd eee" }], 8, { hang: 3 });
  ok("continuation lines are indented by hang",
    lines.slice(1).every((l) => flat(l).startsWith("   ")), JSON.stringify(flatten(lines)));
  ok("hanging indent still fits the width", fits(lines, 8));
}
ok("style survives the wrap",
  wrapSpans([{ text: "aaaa bbbb", bold: true }], 5).every((l) => l.spans.every((s) => s.bold)));

console.log("\ntool summaries\n");

ok("Bash shows the command", (() => {
  const s = toolSummary("Bash", { command: "npm test", description: "run tests" });
  return s.title === "Bash" && s.arg === "npm test";
})());
ok("Read shows the path", toolSummary("Read", { file_path: "/tmp/a.txt" }).arg === "/tmp/a.txt");
ok("Grep shows the pattern", toolSummary("Grep", { pattern: "TODO" }).arg === "TODO");
ok("Task reads as Agent", toolSummary("Task", { description: "find bugs" }).title === "Agent");
ok("an mcp tool shows the tool name",
  toolSummary("mcp__figma__get_file", {}).title === "get_file");
ok("an unknown tool still names itself", toolSummary("Frobnicate", { a: 1 }).title === "Frobnicate");
ok("a multi-line command collapses to its first line",
  toolSummary("Bash", { command: "\ncd /tmp\nls -la\n" }).arg === "cd /tmp");

console.log("\nblocks\n");

{
  const lines = blockLines({ kind: "text", text: "hello there" }, { cols: 40 });
  ok("agent text gets the ⏺ bullet", flat(lines[0]).startsWith(GLYPH.bullet + " "));
}
{
  const lines = blockLines({ kind: "text", text: "do the thing" }, { cols: 40, role: "user" });
  ok("your own text gets > instead", flat(lines[0]).startsWith("> "));
}
{
  const text = "line one is quite long and will wrap around\nline two";
  const lines = blockLines({ kind: "text", text }, { cols: 20 });
  ok("multi-line text is NOT truncated to one line", lines.length >= 3);
  ok("every text line fits the width", fits(lines, 20), JSON.stringify(flatten(lines)));
  ok("only the first line carries the bullet",
    lines.filter((l) => flat(l).startsWith(GLYPH.bullet)).length === 1);
  ok("continuation lines align under the bullet",
    flat(lines[1]).startsWith("  "), JSON.stringify(flatten(lines)));
}
{
  const lines = blockLines({ kind: "text", text: "## Heading\n- alpha\n- beta" }, { cols: 40 });
  const all = flatten(lines).join("\n");
  ok("heading hashes are dropped", !all.includes("#") && all.includes("Heading"));
  ok("dashes render as bullets", all.includes("•") && !/^\s*⏺ -/m.test(all));
}
{
  const lines = blockLines({ kind: "thinking", text: "pondering the options" }, { cols: 40 });
  ok("thinking is marked with ✻", flat(lines[0]).startsWith(GLYPH.think));
  ok("thinking is dim and italic", lines[0].spans.some((s) => s.italic && s.dimColor));
}
{
  const lines = blockLines({ kind: "tool_use", name: "Bash", input: { command: "npm test" } }, { cols: 40 });
  ok("a tool call is exactly one line", lines.length === 1);
  ok("it reads Bash(npm test)", flat(lines[0]).includes("Bash(npm test)"), flat(lines[0]));
}
{
  const wide = { kind: "tool_use", name: "Bash", input: { command: "x".repeat(200) } };
  ok("a huge tool arg is truncated to the width", fits(blockLines(wide, { cols: 40 }), 40));
}
{
  const lines = blockLines({ kind: "tool_result", text: "ok\ndone" }, { cols: 40 });
  ok("a result hangs under its call with ⎿", flat(lines[0]).includes(GLYPH.result));
  ok("result lines are indented", lines.every((l) => flat(l).startsWith("  ")));
}
{
  const big = { kind: "tool_result", text: Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\n") };
  const lines = blockLines(big, { cols: 40 });
  ok("a huge result is ONE row", lines.length === 1, `${lines.length} lines`);
  ok("that row says how much it is holding back",
    flatten(lines).some((l) => /\+\d+/.test(l)), JSON.stringify(flatten(lines)));
}
{
  const lines = blockLines({ kind: "tool_result", text: "boom", is_error: true }, { cols: 40 });
  ok("an error result is red", lines[0].spans.some((s) => s.color === "red"));
}

console.log("\ncollapsed by default, ^O expands\n");

// THE POINT OF THE COLLAPSE: tool output is the bulk of what an agent produces and
// almost none of what you want to read. These assert the ratio, not just the mechanism —
// a policy of "6 rows each" also "caps" the output and still buries the prose.
{
  const rows = Array.from({ length: 40 }, (_, i) => `row ${i}`).join("\n");
  const collapsed = blockLines({ kind: "tool_result", text: rows }, { cols: 40 });
  ok("a 40-line result collapses to ONE row, full stop", collapsed.length === 1,
    JSON.stringify(flatten(collapsed)));
  ok("the line it keeps is the FIRST one", flat(collapsed[0]).includes("row 0"));
  ok("and it counts what it held back", /\+39/.test(flat(collapsed[0])), flat(collapsed[0]));

  const expanded = blockLines({ kind: "tool_result", text: rows }, { cols: 40, expanded: true });
  ok("expanded shows every line", expanded.length === 40, `${expanded.length} lines`);
  ok("expanded has nothing left to hide", !flatten(expanded).some((l) => /\+\d+$/.test(l)));
  ok("expanded still fits the width", fits(expanded, 40));
  ok("expanded lines stay indented under the ⎿", expanded.every((l) => flat(l).startsWith("  ")));
}
{
  // AN ERROR COLLAPSES TOO — one row, like everything else — but it must still SAY what
  // broke. The first line is where the message is, and the row is red, so a failure is
  // scannable without opening anything.
  const err = ["error TS2345: not assignable", ...Array.from({ length: 19 }, (_, i) => `  at frame ${i}`)].join("\n");
  const lines = blockLines({ kind: "tool_result", text: err, is_error: true }, { cols: 60 });
  ok("an error is one row when collapsed", lines.length === 1, `${lines.length} lines`);
  ok("it still shows the message, not just a count",
    /error TS2345/.test(flat(lines[0])), flat(lines[0]));
  ok("the error row is red", lines[0].spans.some((s) => s.color === "red"));
  ok("and it says there's more behind it", /\+19/.test(flat(lines[0])), flat(lines[0]));
}
{
  const one = blockLines({ kind: "tool_result", text: "only line" }, { cols: 40 });
  ok("a one-line result gets no count", one.length === 1 && !/\+\d/.test(flat(one[0])),
    JSON.stringify(flatten(one)));
  const two = blockLines({ kind: "tool_result", text: "a\nb" }, { cols: 40 });
  ok("hiding one line still says +1", /\+1\b/.test(flat(two[0])), flat(two[0]));
  const none = blockLines({ kind: "tool_result", text: "" }, { cols: 40 });
  ok("an empty result says so rather than rendering blank",
    /\(no output\)/.test(flat(none[0])), JSON.stringify(flatten(none)));
}
{
  // The whole reason to expand a tool CALL: a command too long for the width is the one
  // you want to read in full, and collapsed it's the one that gets cut.
  const long = { kind: "tool_use", name: "Bash", input: { command: "git log --oneline --graph --decorate --all --date=iso" } };
  const collapsed = blockLines(long, { cols: 40 });
  ok("a long command is one truncated row when collapsed",
    collapsed.length === 1 && /…/.test(flat(collapsed[0])), flat(collapsed[0]));
  const expanded = blockLines(long, { cols: 40, expanded: true });
  ok("expanded wraps the command instead of cutting it", expanded.length > 1);
  ok("expanded loses none of it",
    flatten(expanded).join("").replace(/\s+/g, " ").includes("--date=iso"),
    JSON.stringify(flatten(expanded)));
  ok("the expanded call still fits the width", fits(expanded, 40));
}
{
  // A multi-line command (a heredoc, a `for` loop) keeps its own line breaks.
  const multi = { kind: "tool_use", name: "Bash", input: { command: "cd /tmp\nls -la\necho done" } };
  ok("collapsed shows only the first line of a multi-line command",
    flat(blockLines(multi, { cols: 60 })[0]).includes("Bash(cd /tmp)"),
    flat(blockLines(multi, { cols: 60 })[0]));
  const all = flatten(blockLines(multi, { cols: 60, expanded: true })).join("\n");
  ok("expanded shows the later lines too", all.includes("ls -la") && all.includes("echo done"), all);
}
{
  // The transcript-level switch has to reach the blocks — a toggle that changes only
  // one of them is the bug this asserts against.
  const turns = [
    { role: "assistant", blocks: [
      { kind: "text", text: "Running it." },
      { kind: "tool_use", id: "t1", name: "Bash", input: { command: "npm test" } },
    ] },
    { role: "user", blocks: [{ kind: "tool_result", tool_use_id: "t1",
      text: Array.from({ length: 30 }, (_, i) => `out ${i}`).join("\n") }] },
  ];
  const collapsed = transcriptLines(turns, { cols: 50 });
  const expanded = transcriptLines(turns, { cols: 50, expanded: true });
  ok("collapsing keeps the whole transcript short", collapsed.length < 8, `${collapsed.length} lines`);
  ok("expanding it grows by the hidden output", expanded.length > collapsed.length + 20,
    `${collapsed.length} -> ${expanded.length}`);
  ok("the PROSE is present either way",
    flatten(collapsed).some((l) => l.includes("Running it.")) &&
      flatten(expanded).some((l) => l.includes("Running it.")));
  ok("out 29 is only reachable expanded",
    !flatten(collapsed).some((l) => l.includes("out 29")) &&
      flatten(expanded).some((l) => l.includes("out 29")));
  ok("both fit the width", fits(collapsed, 50) && fits(expanded, 50));
}
{
  // An ANSWER to a question is not tool output and must never collapse — it's the record
  // of the decision, which is the product.
  const turns = [
    { role: "assistant", blocks: [{
      kind: "tool_use", id: "q1", name: "AskUserQuestion",
      input: { questions: [{ question: "Which fruit?", options: [{ label: "Mango" }] }] },
    }] },
    { role: "user", blocks: [{ kind: "tool_result", tool_use_id: "q1", text: "Mango" }] },
  ];
  for (const expanded of [false, true])
    ok(`the answer survives ${expanded ? "expanded" : "collapsed"}`,
      flatten(transcriptLines(turns, { cols: 50, expanded })).some((l) => l.includes("answered: Mango")));
}
ok("an unknown block renders nothing", blockLines({ kind: "weird" }, { cols: 40 }).length === 0);

console.log("\nthe whole transcript\n");

{
  const turns = [
    { role: "user", blocks: [{ kind: "text", text: "build me a thing" }] },
    { role: "assistant", blocks: [
      { kind: "thinking", text: "hmm" },
      { kind: "text", text: "Starting now." },
      { kind: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/x" } },
    ] },
    { role: "user", blocks: [{ kind: "tool_result", tool_use_id: "t1", text: "contents" }] },
  ];
  const lines = transcriptLines(turns, { cols: 50 });
  const all = flatten(lines);
  ok("every part of the conversation is present",
    all.some((l) => l.includes("build me a thing")) &&
    all.some((l) => l.includes("Starting now.")) &&
    all.some((l) => l.includes("Read(/tmp/x)")) &&
    all.some((l) => l.includes("contents")), JSON.stringify(all));
  ok("turns are separated by a blank line", all.some((l) => l === ""));
  ok("it does not end on a blank line", all[all.length - 1] !== "");
  ok("the whole transcript fits the width", fits(lines, 50));
  ok("order is preserved",
    all.findIndex((l) => l.includes("build me a thing")) <
      all.findIndex((l) => l.includes("Read(/tmp/x)")));
}
{
  // A question's tool_result is the ANSWER, not tool output — it must read that way.
  const turns = [
    { role: "assistant", blocks: [{
      kind: "tool_use", id: "q1", name: "AskUserQuestion",
      input: { questions: [{ question: "Which fruit?", options: [{ label: "Mango" }] }] },
    }] },
    { role: "user", blocks: [{ kind: "tool_result", tool_use_id: "q1", text: "Mango" }] },
  ];
  const all = flatten(transcriptLines(turns, { cols: 50 }));
  ok("a question shows its text", all.some((l) => l.includes("Which fruit?")), JSON.stringify(all));
  ok("its answer is labelled as an answer",
    all.some((l) => l.includes("answered: Mango")), JSON.stringify(all));
}
ok("no turns render as no lines", transcriptLines([], { cols: 40 }).length === 0);
ok("a turn of nothing renders as no lines",
  transcriptLines([{ role: "assistant", blocks: [] }], { cols: 40 }).length === 0);
{
  // A narrow terminal is where off-by-one wrap bugs actually show up.
  const turns = [{ role: "assistant", blocks: [
    { kind: "text", text: "a fairly long sentence that must wrap many times over" },
    { kind: "tool_use", name: "Bash", input: { command: "echo hello world" } },
    { kind: "tool_result", text: "hello world" },
  ] }];
  for (const cols of [20, 24, 40, 80, 120])
    ok(`fits at ${cols} columns`, fits(transcriptLines(turns, { cols }), cols));
}

console.log("\nclick targets: which row belongs to which step\n");

// A CLICK CAN ONLY WORK IF THE LINES SAY WHAT THEY BELONG TO. The dashboard turns a screen
// row into a line index and then reads `.block` off it — so this tagging is the entire
// mechanism behind click-to-expand, and it's invisible on screen.
const CLICKY = [
  { role: "assistant", blocks: [
    { kind: "text", text: "Reading it." },
    { kind: "tool_use", id: "t1", name: "Read", input: { file_path: "/tmp/x" } },
  ] },
  { role: "user", blocks: [{ kind: "tool_result", tool_use_id: "t1",
    text: Array.from({ length: 30 }, (_, i) => `a ${i}`).join("\n") }] },
  { role: "assistant", blocks: [{ kind: "tool_use", id: "t2", name: "Bash", input: { command: "ls" } }] },
  { role: "user", blocks: [{ kind: "tool_result", tool_use_id: "t2",
    text: Array.from({ length: 30 }, (_, i) => `b ${i}`).join("\n") }] },
];
{
  const lines = transcriptLines(CLICKY, { cols: 60 });
  const at = (re) => lines.find((l) => re.test(flat(l)));

  // ONE ROW FOR THE WHOLE STEP: the call and its result share a line, so there is nothing
  // to aim at except that line — and it has to carry the key.
  ok("a step is a single row", !!at(/Read\(/) && flat(at(/Read\(/)).includes("a 0"),
    flatten(lines).join("\n"));
  ok("that row knows its block", at(/Read\(/)?.block === "t1");
  // `⎿` stays the glyph for output — it just sits on the CALL's row instead of below it.
  ok("the ⎿ is on the call's row, not a row of its own",
    lines.findIndex((l) => flat(l).includes(GLYPH.result)) === lines.findIndex((l) => /Read\(/.test(flat(l))),
    flatten(lines).join("\n"));
  ok("nothing hangs beneath while collapsed",
    !flatten(lines).some((l) => l.startsWith("  " + GLYPH.result)), flatten(lines).join("\n"));
  ok("a different step has a different key", at(/Bash\(ls\)/)?.block === "t2");
  ok("prose is NOT a click target", at(/Reading it\./)?.block === undefined);
  ok("the count rides on that same row", /\+29/.test(flat(at(/Read\(/))), flat(at(/Read\(/)));
  // Steps pack together: a blank line between two of them is wasted height, and a run of
  // `⏺` rows separates itself.
  ok("consecutive steps are not blank-lined apart",
    lines.findIndex((l) => /Bash\(ls\)/.test(flat(l))) ===
      lines.findIndex((l) => /Read\(/.test(flat(l))) + 1,
    flatten(lines).join("\n"));
}
{
  // Expanding SPLITS the step back into its two halves, which is where `⎿` comes back.
  const open = transcriptLines(CLICKY, { cols: 60, toggled: new Set(["t1"]) });
  const rowOfRe = (re) => open.findIndex((l) => re.test(flat(l)));
  ok("expanding a step splits it into call + output rows",
    rowOfRe(/⎿ +a 0/) === rowOfRe(/Read\(/) + 1,
    `call ${rowOfRe(/Read\(/)}, first output ${rowOfRe(/⎿ +a 0/)}`);
  ok("the call row no longer carries the summary",
    !/a 0/.test(flat(open[rowOfRe(/Read\(/)])), flat(open[rowOfRe(/Read\(/)]));
  ok("every output row of an expanded step is still clickable",
    open.filter((l) => /⎿ +a 0|a 29/.test(flat(l))).every((l) => l.block === "t1"));
}
{
  // A call whose result hasn't arrived is a step still RUNNING: one row, no summary, and
  // no marker promising something behind it.
  const running = transcriptLines(
    [{ role: "assistant", blocks: [{ kind: "tool_use", id: "z1", name: "Bash", input: { command: "sleep 5" } }] }],
    { cols: 50 }
  );
  ok("a step with no result yet is one bare row",
    running.length === 1 && flat(running[0]).includes("Bash(sleep 5)"), JSON.stringify(flatten(running)));
  ok("…and it makes no promise of hidden output",
    !flat(running[0]).includes(GLYPH.result), flat(running[0]));
}
{
  // Toggling ONE step must leave the others alone — that's the difference between a click
  // and ^O, and getting it wrong makes the two gestures indistinguishable.
  const one = transcriptLines(CLICKY, { cols: 50, toggled: new Set(["t1"]) });
  const all = flatten(one).join("\n");
  ok("clicking one step opens it", /a 29/.test(all));
  ok("…and only it", !/b 29/.test(all), all.split("\n").filter((l) => /b \d/.test(l)).join(" | "));

  // XOR, the case that's easy to get backwards: everything expanded, then close ONE.
  const inverted = transcriptLines(CLICKY, { cols: 50, expanded: true, toggled: new Set(["t1"]) });
  const inv = flatten(inverted).join("\n");
  ok("with everything expanded, clicking a step COLLAPSES it", !/a 29/.test(inv));
  ok("…and leaves the rest expanded", /b 29/.test(inv));
}
{
  // An answered question has nothing hidden, so it must not look clickable.
  const turns = [
    { role: "assistant", blocks: [{
      kind: "tool_use", id: "q1", name: "AskUserQuestion",
      input: { questions: [{ question: "Which fruit?", options: [{ label: "Mango" }] }] },
    }] },
    { role: "user", blocks: [{ kind: "tool_result", tool_use_id: "q1", text: "Mango" }] },
  ];
  const answer = transcriptLines(turns, { cols: 50 }).find((l) => /answered: Mango/.test(flat(l)));
  ok("an answered question is not a click target", answer && answer.block === undefined);
}
{
  // Blocks with no id still need SOME stable key, or they can't be toggled at all.
  const turns = [
    { role: "assistant", blocks: [{ kind: "tool_use", name: "Bash", input: { command: "date" } }] },
    { role: "user", blocks: [{ kind: "tool_result", text: "Fri" }] },
  ];
  const lines = transcriptLines(turns, { cols: 50 });
  ok("an id-less tool call still gets a key", !!lines.find((l) => /Bash\(date\)/.test(flat(l)))?.block);
}

console.log("\nthe visible window (shared by the renderer and the click handler)\n");

// This is the arithmetic a click depends on: screen row -> line index. It lives in ONE
// exported function because two copies that drift don't crash, they open the wrong block.
{
  const live = transcriptWindow({ total: 100, rows: 10, offset: 0 });
  ok("at live output the window is the last `rows` lines",
    live.start === 90 && live.end === 100, JSON.stringify(live));
  ok("nothing is below when you're live", live.below === 0);

  const up = transcriptWindow({ total: 100, rows: 10, offset: 20 });
  ok("scrolled up, the window moves back", up.end === 80, JSON.stringify(up));
  // The "↓ n more" marker costs a row and is taken OUT of the text budget, or the column
  // grows by one and the input is pushed off the bottom of the screen.
  ok("the ↓ marker costs one text row", up.textRows === 9 && up.start === 71, JSON.stringify(up));
  ok("it reports how much is below", up.below === 20);

  const short = transcriptWindow({ total: 3, rows: 10, offset: 0 });
  ok("a transcript shorter than the viewport starts at 0",
    short.start === 0 && short.end === 3, JSON.stringify(short));
  const over = transcriptWindow({ total: 5, rows: 10, offset: 999 });
  ok("an absurd offset can't produce a negative window",
    over.start === 0 && over.end === 0, JSON.stringify(over));
  ok("an empty transcript is a zero-width window",
    transcriptWindow({ total: 0, rows: 10, offset: 0 }).end === 0);
}

console.log("\nthe markdown an agent actually emits\n");

// THE SOURCE OF THIS LIST: a headless session where the agent was asked for "all kind of
// things you reply during a response" and answered with a catalogue — three tables, quotes,
// links, strikethrough, task lists, rules, diff fences. Every one of those rendered as raw
// syntax in the TUI. This is that catalogue, turned into assertions.
{
  const md = [
    "| Element | Renders? | Notes |",
    "|---------|:--------:|-------|",
    "| Tables | ✅ | Aligned columns work |",
    "| HTML | ❌ | Shown as raw text |",
  ].join("\n");
  const lines = blockLines({ kind: "text", text: md }, { cols: 60 });
  const all = flatten(lines);
  ok("a table loses its pipes", !all.some((l) => l.includes("|")), all.join("\n"));
  ok("…and its dashes-and-colons separator row",
    !all.some((l) => /---|:-/.test(l)), all.join("\n"));
  ok("the header gets a rule under it", /^\s*─+$/.test(all[1]), JSON.stringify(all[1]));
  ok("the header is bold", lines[0].spans.some((s) => s.bold));
  ok("every cell is still there",
    all.join(" ").includes("Tables") && all.join(" ").includes("Aligned columns work") &&
    all.join(" ").includes("Shown as raw text"), all.join("\n"));
  // ALIGNED IS THE POINT of rendering a table at all: the second column has to start at the
  // same screen offset on every row, which is only true if the widths were computed.
  const col2 = all.filter((l) => /✅|❌/.test(l)).map((l) => l.indexOf(l.match(/[✅❌]/)[0]));
  ok("the columns line up", new Set(col2).size === 1, JSON.stringify(col2));
  // 4 source rows -> 4 screen rows: the separator row BECOMES the rule rather than adding one.
  ok("one source row is one screen row", lines.length === 4,
    `${lines.length} rows for header + rule + 2 body`);
  ok("the table fits the width", fits(lines, 60), all.join("\n"));
}
{
  // A NARROW terminal is where a table either degrades or destroys the layout. Cells are
  // truncated, never wrapped, so the row count stays exact for scrolling.
  const md = [
    "| Category | Example | Status |",
    "|---|---|---|",
    "| A very long category name indeed | `some.long.example(value)` | ✅ styled |",
  ].join("\n");
  for (const cols of [24, 40, 80]) {
    const lines = blockLines({ kind: "text", text: md }, { cols });
    ok(`a wide table fits ${cols} columns`, fits(lines, cols),
      flatten(lines).join("\n"));
    ok(`…and stays 3 rows at ${cols}`, lines.length === 3, `${lines.length} rows`);
  }
}
{
  const lines = blockLines({ kind: "text", text: "> Quoted text.\n> Second line." }, { cols: 40 });
  const all = flatten(lines);
  // THE `>` MUST GO. It's the glyph for "the human said this" everywhere else in the
  // transcript, so a quote that keeps it reads as your own message echoed back.
  ok("a blockquote drops the > and draws a bar",
    all.every((l) => !/>/.test(l)) && all.every((l) => l.includes("│")), all.join("\n"));
  ok("the quoted text survives", all.join(" ").includes("Quoted text."), all.join("\n"));
  ok("a quote is dim", lines[0].spans.some((s) => s.dimColor));
}
{
  const lines = blockLines({ kind: "text", text: "before\n\n---\n\nafter" }, { cols: 30 });
  const all = flatten(lines);
  ok("a horizontal rule is drawn, not left as dashes",
    all.some((l) => /─{4,}/.test(l)) && !all.some((l) => l.includes("---")), all.join("\n"));
  ok("the rule fits the width", fits(lines, 30));
}
{
  const lines = blockLines({ kind: "text", text: "- [ ] not done\n- [x] done" }, { cols: 40 });
  const all = flatten(lines).join("\n");
  ok("an unchecked task is a ○", /○ not done/.test(all), all);
  ok("a checked task is a ✓", /✓ done/.test(all), all);
  ok("the brackets are gone", !/\[[ x]\]/.test(all), all);
  ok("a done task reads as done (green)",
    lines[1].spans.some((s) => s.color === "green"), JSON.stringify(lines[1].spans));
}
{
  const spans = inlineSpans("some ~~struck~~ text");
  ok("~~text~~ is struck through, without the tildes",
    spans.some((s) => s.strikethrough && s.text === "struck") &&
    !spans.map((s) => s.text).join("").includes("~"), JSON.stringify(spans));
}
{
  const spans = inlineSpans("read the [docs](https://example.com/a?b=c) first");
  ok("a link renders as its text, underlined",
    spans.some((s) => s.underline && s.text === "docs"), JSON.stringify(spans));
  ok("the URL is not printed", !spans.map((s) => s.text).join("").includes("example.com"),
    JSON.stringify(spans));
  ok("the surrounding words survive",
    spans.map((s) => s.text).join("") === "read the docs first",
    JSON.stringify(spans.map((s) => s.text).join("")));
}
{
  const md = "```diff\n- removed\n+ added\n@@ -1,2 +1,2 @@\n context\n```";
  const lines = blockLines({ kind: "text", text: md }, { cols: 40 });
  // Look at the span holding the TEXT, not the first coloured span on the row: row 0 opens
  // with the cyan ⏺ glyph, so `find(s => s.color)` answers "cyan" for every question.
  const colorOf = (re) =>
    lines.find((l) => re.test(flat(l)))?.spans.find((s) => re.test(s.text))?.color;
  ok("a diff fence colours removals red", colorOf(/removed/) === "red");
  ok("…additions green", colorOf(/added/) === "green");
  ok("…and hunk headers cyan", colorOf(/@@/) === "cyan");
  ok("the fence markers are still dropped",
    !flatten(lines).some((l) => l.includes("```")), flatten(lines).join("\n"));
}
{
  // ✅ and ❌ are TWO cells wide. Counting them as one is what silently shifts every column
  // after them — the reason the emoji ranges were added to WIDE.
  ok("✅ counts as two cells", cellWidth("✅") === 2);
  ok("❌ counts as two cells", cellWidth("❌") === 2);
  ok("a plain check mark stays one", cellWidth("✓") === 1);
}
{
  // Plain code fences must NOT be coloured like a diff: a `-` at the start of a shell line is
  // a flag, not a removal.
  const md = "```sh\n- not a removal\n+ not an addition\n```";
  const lines = blockLines({ kind: "text", text: md }, { cols: 40 });
  ok("a non-diff fence stays dim",
    lines.every((l) => l.spans.some((s) => s.dimColor) && !l.spans.some((s) => s.color === "red")),
    JSON.stringify(flatten(lines)));
}

{
  // AUTHORED INDENTATION IS CONTENT. `wrapSpans` used to drop leading spaces on every line,
  // not just wrapped ones — which flattened every nested list to one level and un-indented
  // every line of every code block. Both were visible only by reading the rendered output.
  const md = "1. Ordered\n2. Another\n   - Nested bullet\n     - Deeper still";
  const all = flatten(blockLines({ kind: "text", text: md }, { cols: 60 }));
  ok("a nested bullet keeps its indent", /^ {5}• Nested bullet/.test(all[2]), JSON.stringify(all));
  ok("a deeper one keeps more of it", /^ {7}• Deeper still/.test(all[3]), JSON.stringify(all));

  const code = "```python\ndef f():\n    return 1\n```";
  const lines = flatten(blockLines({ kind: "text", text: code }, { cols: 60 }));
  ok("a code block keeps its indentation", /^ {6}return 1/.test(lines[1]), JSON.stringify(lines));

  // …but a WRAPPED line must still not start with a ragged space.
  const long = wrapSpans([{ text: "aaaa bbbb cccc dddd" }], 10);
  ok("a wrapped line still has no leading space",
    flatten(long).slice(1).every((l) => !l.startsWith(" ")), JSON.stringify(flatten(long)));
}

{
  // ALIGNMENT WITH MARKDOWN INSIDE THE CELLS. Padding by the RAW cell width while rendering the
  // processed text pads `**b**` as 5 columns and draws 3, so every column after it slides left
  // — a table that looks aligned in the source and ragged on screen.
  const md = [
    "| What | Mark | End |",
    "|---|---|---|",
    "| plain | x | ✅ |",
    "| bold | **b** | ✅ |",
    "| code | `c` | ✅ |",
    "| struck | ~~s~~ | ✅ |",
  ].join("\n");
  const all = flatten(blockLines({ kind: "text", text: md }, { cols: 60 }));
  const ticks = all.filter((l) => l.includes("✅")).map((l) => l.indexOf("✅"));
  ok("cells containing markdown still line up", new Set(ticks).size === 1, JSON.stringify(ticks));
  ok("the markers themselves are gone",
    !all.some((l) => /\*\*|~~|`/.test(l)), all.join("\n"));
}
{
  // Right- and centre-alignment come from the separator's colons.
  const md = ["| L | C | R |", "|:--|:-:|--:|", "| a | b | c |"].join("\n");
  const rows = flatten(blockLines({ kind: "text", text: md }, { cols: 40 }));
  ok("an alignment row is consumed, not printed", !rows.some((l) => l.includes(":")), rows.join("\n"));
  ok("the table still renders", rows.some((l) => /a/.test(l)) && rows.length === 3, rows.join("\n"));
}

console.log("\nthe working line (PROBLEM 23)");
{
  const { formatElapsed, workingLabel, workingLine, QUIET_AFTER_MS } = await import("./blocks.mjs");
  ok("seconds under a minute", formatElapsed(13_400) === "13s");
  ok("minutes pad their seconds", formatElapsed(125_000) === "2m 05s");
  ok("hours drop the seconds", formatElapsed(3_780_000) === "1h 3m");
  ok("a negative clock (skew) never shows as negative", formatElapsed(-5000) === "0s");

  const bash = [{ role: "assistant", blocks: [{ kind: "text", text: "on it" }, { kind: "tool_use", name: "Bash", input: { command: "npm test" } }] }];
  ok("an unanswered tool call is named", workingLabel(null, bash) === "Running Bash", workingLabel(null, bash));
  ok("streaming thinking wins over the tool", workingLabel({ kind: "thinking" }, bash) === "Thinking");
  ok("streaming text reads as writing", workingLabel({ kind: "text" }, bash) === "Writing");
  const answered = [...bash, { role: "user", blocks: [{ kind: "tool_result", text: "41 passed" }] }];
  ok("once its result is in, the call isn't 'running' any more", workingLabel(null, answered) === "Working");
  const ask = [{ role: "assistant", blocks: [{ kind: "tool_use", name: "AskUserQuestion", input: {} }] }];
  ok("a question is never 'running'", workingLabel(null, ask) === "Working");

  const flat = (l) => l.spans.map((x) => x.text).join("");
  ok("the line reads like Claude Code's", flat(workingLine({ label: "Running Bash", elapsedMs: 13_000 })) === "✻ Running Bash… 13s");
  ok("no silence warning before the threshold",
    !/no output/.test(flat(workingLine({ label: "Working", elapsedMs: 60_000, quietMs: QUIET_AFTER_MS - 1 }))));
  ok("…and one after it",
    /no output for 1m 10s/.test(flat(workingLine({ label: "Working", elapsedMs: 200_000, quietMs: 70_000 }))));
  const narrow = workingLine({ label: "Running WebFetch", elapsedMs: 200_000, quietMs: 70_000, cols: 24 });
  ok("never wider than its row (a wrapped status line is an unbudgeted row)", cellWidth(flat(narrow)) <= 24, flat(narrow));
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
