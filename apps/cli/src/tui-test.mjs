// TUI decision-loop test — the USP, in the terminal, against a REAL agent.
//
// WHY THIS EXISTS: "it builds" is not "it works" (AGENTS.md). The dashboard could
// compile, render, and still never show the decision card — which is the one thing
// the product is for. So this drives the actual CLI in a real pty: it starts a
// session that asks a structured question, asserts the card appears with its options,
// types "1", and asserts the agent resumed with that choice.
//
// The web equivalent is tools/browser-check.mjs --click. This is its terminal twin.
// It SPENDS TOKENS on a real Claude run, so it is not part of the fast test loop.
//
//   node apps/cli/src/tui-test.mjs

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Screen } from "./tui/screen.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "main.mjs");
const PTY = join(HERE, "pty-runner.py");
const PORT = 4394;
const STATE_DIR = mkdtempSync(join(tmpdir(), "loop-tui-test-"));
const SAFE_CWD = mkdtempSync(join(tmpdir(), "loop-tui-cwd-"));

// A prompt engineered to make the agent use AskUserQuestion immediately, so the test
// is about OUR rendering rather than about coaxing the model.
const PROMPT =
  "Use the AskUserQuestion tool right now to ask me which fruit to use, " +
  "with exactly these options: Mango, Guava, Papaya. Ask nothing else first. " +
  "After I answer, reply with exactly: You picked <fruit>.";

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`); }
};

// Strip ANSI for the "did this EVER appear" class of wait — a line the agent emitted
// and then scrolled past still counts as proof it happened. Anything about what is on
// screen RIGHT NOW goes through view() instead (see below).
const strip = (s) =>
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b[\[\(][0-9;?]*[a-zA-Z]/g, "");

console.log(`\nstate dir: ${STATE_DIR}\nsafe cwd:  ${SAFE_CWD}\n`);

// A pty is REQUIRED: Ink refuses to render interactively to a plain pipe, and the
// interactive path is exactly what's under test.
//
// The obvious tool, `script`, is a dead end and cost three debugging rounds: it calls
// tcgetattr on ITS OWN stdout and dies with "Operation not supported on socket" when
// given a pipe — and `stdio: "ignore"` (/dev/null) isn't a tty either, so it fails
// identically with a 0-byte transcript. pty-runner.py allocates a real pty instead.
const TRANSCRIPT = join(STATE_DIR, "tui.transcript");
// The pty size is a CONSTANT the assertions share: the emulated grid must be exactly
// the size the app was told it had, or every row index is off.
const COLS = 100, ROWS = 45;
const child = spawn(
  "python3",
  [PTY, TRANSCRIPT, String(COLS), String(ROWS),
   process.execPath, MAIN, `--port=${PORT}`, `--cwd=${SAFE_CWD}`, "--no-expose", PROMPT],
  {
    cwd: SAFE_CWD,
    env: { ...process.env, LOOP_ENG_DIR: STATE_DIR, TERM: "xterm-256color" },
    stdio: ["pipe", "inherit", "inherit"],
  }
);

let exited = null;
child.on("exit", (code, sig) => { exited = { code, sig }; });

// A `finally` block does NOT run when this process is killed by a signal (an outer
// `timeout 400`, or an impatient ^C), and the daemon we started is DETACHED — so it
// survives and keeps its test port. Reap it synchronously on the way out too.
const reapDetachedDaemon = () => {
  try {
    const pid = Number(readFileSync(join(STATE_DIR, "daemon.pid"), "utf8").trim());
    if (pid > 0) process.kill(pid, "SIGTERM");
  } catch { /* never started, or already gone */ }
  try { child.kill("SIGKILL"); } catch { /* already gone */ }
};
process.on("exit", reapDetachedDaemon);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(sig, () => { reapDetachedDaemon(); process.exit(1); });

let out = "";
const refresh = () => {
  out = existsSync(TRANSCRIPT) ? readFileSync(TRANSCRIPT, "utf8") : "";
  return out;
};

/** Wait until `test` sees what it needs in the live transcript. */
const waitFor = (test, timeoutMs = 120000) =>
  new Promise((resolve) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (test(strip(refresh()))) { clearInterval(iv); resolve(true); }
      else if (exited) { clearInterval(iv); resolve(false); }   // don't wait out the timeout on a dead child
      else if (Date.now() - started > timeoutMs) { clearInterval(iv); resolve(false); }
    }, 250);
  });

const tail = (n = 30) => strip(out).split("\n").slice(-n).join("\n");

// THE CURRENT SCREEN. Replaying the transcript into a grid (tui/screen.mjs) gives what
// the terminal is actually showing, which is what every view assertion below is about.
// The old approach — find the last header line and treat the rest as "the frame" — was
// built on the belief that Ink redraws whole frames. It does NOT: it emits differential
// updates (cursor-up, erase-line, rewrite), so there is no frame boundary to find, a
// row that was later erased still matches, and a row rewritten in place matches twice.
// The grid has none of those problems: row -1 IS the bottom of the screen.
const view = () => new Screen(COLS, ROWS).write(refresh());
const screenRows = () => view().lines();
const screenText = () => screenRows().join("\n");
const screenBottom = (n = 4) => screenRows().slice(-n).join("\n");

// IDENTIFY THE FOOTER BY ITS LEFT EDGE. It drops keys from the RIGHT when they don't
// fit, so `^C detach` — deliberately last — is the first thing to disappear when a key
// is added (`^O` did exactly that at 100 columns). Matching on it turns "we added a
// shortcut" into "the input was pushed off the screen", which is a wild goose chase.
// Every footer opens with `⏎ <verb>`; nothing else on screen does.
const FOOTER_RE = /^⏎ \S/;

/** waitFor, but the predicate sees the SCREEN instead of the byte stream. */
const waitScreen = (test, timeoutMs = 20000) =>
  new Promise((resolve) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (test(screenText())) { clearInterval(iv); resolve(true); }
      else if (exited) { clearInterval(iv); resolve(false); }
      else if (Date.now() - started > timeoutMs) { clearInterval(iv); resolve(false); }
    }, 250);
  });

// "Everything after right now", for assertions that must not be satisfied by an OLD
// frame. It has to be an offset into the STRIPPED text, because that's what waitFor
// hands its predicate — a raw out.length is much larger (Ink emits far more escape
// bytes than glyphs), so slicing with it silently yields "" and the wait always fails.
const mark = () => strip(refresh()).length;
const since = (s, at) => s.slice(at);

let answered = false;
try {
  // 1. the shell renders at all
  ok("dashboard renders", await waitFor((s) => /\bloop\b/.test(s) && /session/i.test(s), 40000),
    exited ? `child exited early: ${JSON.stringify(exited)}` : tail());
  // These live in the LIST view's header, and a prompt on the command line takes you
  // straight into the run — so they're asserted against the stream ("was this ever
  // drawn"), which is the honest question for chrome that has since been replaced by
  // the one-row session title.
  ok("exposure indicator is shown", /LOCAL|TAILNET|PUBLIC/.test(strip(out)), tail(15));
  ok("engine is named in the header", /claude-code/.test(strip(out)), tail(15));
  // FULLSCREEN: the footer is the last thing drawn, so it belongs on the terminal's
  // last row. Cheap here, and it means a real-agent run also catches a layout regression.
  ok("the footer is on the terminal's bottom row",
    await waitScreen((s) => FOOTER_RE.test(s.split("\n")[ROWS - 1]), 20000),
    `bottom 3 rows:\n${screenBottom(3)}`);

  // 2. the session the prompt created shows up in the list
  ok("the new session appears in the list",
    await waitFor((s) => /working|needs a decision|idle|thinking/.test(s), 60000), tail());

  // 3. THE USP: the decision card
  const sawCard = await waitFor((s) => /WAITING FOR YOU/.test(s), 150000);
  ok("decision card appears (WAITING FOR YOU)", sawCard, tail(35));
  const clean = strip(out);
  ok("the question text is rendered", /fruit/i.test(clean));
  ok("options are rendered as numbered choices", /1\.\s*Mango/.test(clean),
    clean.match(/.{0,60}Mango.{0,40}/)?.[0]);
  ok("all three options are shown", /Mango/.test(clean) && /Guava/.test(clean) && /Papaya/.test(clean));

  // 4. answer it the way a human would — type "1", then press enter
  if (sawCard) {
    const at = mark();
    // SEPARATE WRITES, WITH A GAP. Ink parses each stdin chunk as ONE key event, so
    // writing "1\r" in one go is neither the digit nor Return — the reply silently
    // never submits. A human's keystrokes always arrive as distinct reads.
    child.stdin.write("1");
    await new Promise((r) => setTimeout(r, 400));
    child.stdin.write("\r");
    answered = true;
    const resumed = await waitFor((s) => /You picked Mango/i.test(since(s, at)), 150000);
    ok("typing 1 answers the question and the agent RESUMES", resumed, resumed ? "" : tail(35));
    // "Is it gone NOW" — the screen, not the stream: the bytes that drew the card are
    // still in the transcript forever, so only the grid can answer this.
    ok("the decision card clears after answering",
      await waitScreen((s) => !/WAITING FOR YOU/.test(s), 20000), screenText());
    // The input must not have been left stranded where the card used to be.
    ok("the input is still on the bottom rows after the card clears",
      /reply to this session|what should we build\?|›/.test(screenBottom(4)), screenBottom(4));
  }

  // 5. A SECOND session, then switching between them. This is the case that was
  // broken: with one session everything looks fine, and the bug only appears once
  // there are two — selection was by array index into a list the 2s poll REORDERS,
  // so the selection silently slid onto a different run.
  const beforeSecond = mark();
  child.stdin.write("\x0e"); // ^N — compose a new session
  await new Promise((r) => setTimeout(r, 800));
  for (const chr of "Reply with exactly: SECOND-DONE. Nothing else.") {
    child.stdin.write(chr);
    await new Promise((r) => setTimeout(r, 8)); // one key per chunk (see above)
  }
  await new Promise((r) => setTimeout(r, 300));
  child.stdin.write("\r");

  const secondRan = await waitFor((s) => /SECOND-DONE/.test(since(s, beforeSecond)), 150000);
  ok("^N starts a SECOND session and it runs", secondRan, secondRan ? "" : tail(30));

  if (secondRan) {
    // 6. ← LEAVES the session for the fleet list, → GOES BACK IN. Two views, because
    // "we should only see list and their status here and should be able to switch".
    // Submitting a prompt lands you inside the run, so ← is what surfaces the list.
    child.stdin.write("\x1b[D"); // ←
    const backOnList = await waitScreen((s) => /→ open/.test(s), 15000);
    ok("← leaves the session and shows the list", backOnList, backOnList ? "" : screenText());

    const listScreen = screenText();
    // Match the rendered ROW, not the line start — Ink wraps the list box in `│` borders.
    const listRows = listScreen.split("\n").filter((l) => /[12] [●◐○] /.test(l));
    ok("both sessions are listed at once",
      listRows.some((l) => /\s1 [●◐○] /.test(l)) && listRows.some((l) => /\s2 [●◐○] /.test(l)),
      listScreen);
    ok("rows carry an id prefix, so two runs in one cwd are distinguishable",
      listRows.length === 2 && listRows.every((l) => /[●◐○] \S+\s+[0-9a-f]{4}\s/.test(l)),
      listRows.join("\n"));
    // The list is a LIST: no transcript competing with it for the screen. This is the
    // literal complaint — a transcript was eating the lower half of the fleet view.
    // `⎿` is a transcript-only glyph (a tool result), so its absence is the check.
    ok("the transcript is NOT on the list screen", !/⎿/.test(listScreen), listScreen);
    // The keys were never the problem — being unadvertised and silent was.
    ok("the list advertises ⏎ start / → open",
      /⏎ start/.test(listScreen) && /→ open/.test(listScreen),
      listScreen.split("\n").slice(-2).join("\n"));
    // The list OWNS the spare rows: the fleet is the workspace, not a two-row island.
    const listLabelRow = screenRows().findIndex((l) => /sessions/.test(l));
    const inputRow = screenRows().findIndex((l) => /what should we build\?/.test(l));
    ok("the sessions area fills the space down to the input",
      listLabelRow > 0 && inputRow > listLabelRow && inputRow - listLabelRow > ROWS / 2,
      `label row ${listLabelRow}, input row ${inputRow} of ${ROWS}`);

    // ↑↓ must move the selection with NO tab or mode change. Which row the other
    // session sits on depends on the daemon's urgency+recency sort, so try both
    // directions: the claim under test is "an arrow moves the selection", not "down".
    const selectedRow = (s) => s.match(/▸ (\d) [●◐○]/)?.[1] ?? null;
    const wasOn = selectedRow(screenText());
    child.stdin.write("\x1b[B"); // ↓
    let moved = await waitScreen((s) => selectedRow(s) && selectedRow(s) !== wasOn, 8000);
    if (!moved) {
      child.stdin.write("\x1b[A"); // ↑
      moved = await waitScreen((s) => selectedRow(s) && selectedRow(s) !== wasOn, 8000);
    }
    ok("↑↓ move the selection (no tab needed)", moved, `was on row ${wasOn}\n${screenText()}`);

    // 7. → opens whatever is selected, and the conversation comes with it.
    child.stdin.write("\x1b[C"); // →
    const opened = await waitScreen((s) => /← back/.test(s) && !/→ open/.test(s), 25000);
    ok("→ opens the selected session", opened, opened ? "" : screenText());
    // "just show its name on top": the fleet list is GONE in here — no numbered rows,
    // no header box, one title row instead.
    ok("the session view drops the fleet list for a one-row title",
      screenRows().filter((l) => /[0-9] [●◐○] /.test(l)).length === 0 &&
        // `.*?` = the engine's own title, when it has written one yet (PROBLEM 21) — e.g.
        // "loop-tui-cwd-x  Second-done  a066  idle". The CLI writes it asynchronously, so
        // whether it's there by now is a race, not a layout fact.
        /^\s{2}\S+(\s.*?)?\s[0-9a-f]{4}\s+(working|idle|sleeping|error|needs a decision)/.test(screenRows()[0] ?? ""),
      `row 0: ${JSON.stringify(screenRows()[0])}`);
    // The whole point of going in: formatted output, not one line per block. `⏺`
    // (assistant block) is the marker the formatter puts there and nothing else does.
    ok("the conversation is formatted (⏺ blocks)",
      await waitScreen((s) => /⏺/.test(s), 15000), screenText());

    // ←/→ must NOT navigate while there's text to edit: the prompt needs them for the
    // cursor, and a half-typed prompt you can't edit is worse than no shortcut.
    for (const chr of "hello") {
      child.stdin.write(chr);
      await new Promise((r) => setTimeout(r, 8));
    }
    await new Promise((r) => setTimeout(r, 300));
    child.stdin.write("\x1b[D"); // ← with a non-empty buffer: cursor move, NOT navigate
    await new Promise((r) => setTimeout(r, 800));
    const editScreen = screenText();
    ok("←/→ stay with the cursor while typing (no view change)",
      /← back/.test(editScreen) && !/→ open/.test(editScreen), editScreen);
    ok("the typed text is in the input, on the bottom rows", /hello/.test(screenBottom(4)),
      screenBottom(4));
    // A ctrl key must NOT leak its letter into the prompt. `ink-text-input` used to insert
    // the character of anything it didn't recognise, so ^R typed a stray "r" that the next ⏎
    // would have sent to the agent; `tui/text-input.mjs` drops modified keys outright
    // (PROBLEM 14d). Still asserted here because this is the real terminal, not a stub.
    child.stdin.write("\x12"); // ^R — toggles the QR panel
    await new Promise((r) => setTimeout(r, 600));
    // ← moved the cursor one left, so a leaked "r" would land as "hellro", not "hellor".
    ok("^R does not type an 'r' into the prompt",
      /hello/.test(screenBottom(6)) && !/hellro|hellor/.test(screenBottom(6)), screenBottom(6));
    child.stdin.write("\x12"); // ^R again — put the QR away
    await new Promise((r) => setTimeout(r, 600));
    ok("the input is still on the bottom row after the QR closes",
      FOOTER_RE.test(screenRows()[ROWS - 1]), screenBottom(4));
    // Don't leave that text in the buffer: ^C is next, and the input would otherwise
    // still hold a stray "hello".
    for (let i = 0; i < 6; i++) {
      child.stdin.write("\x7f"); // backspace
      await new Promise((r) => setTimeout(r, 20));
    }
  }
} finally {
  // Ctrl+C = detach. The session must survive it — that's the north-star invariant:
  // the daemon hosts the run, not the user's connection.
  try { child.stdin.write("\x03"); } catch { /* already gone */ }
  await new Promise((r) => setTimeout(r, 2000));

  const stillThere = await fetch(`http://127.0.0.1:${PORT}/sessions`)
    .then((r) => r.json())
    .then((b) => (b.sessions ?? []).length)
    .catch((e) => `err:${e.message}`);
  ok("detaching leaves the sessions alive in the daemon", stillThere >= 1, `sessions=${stillThere}`);

  child.kill("SIGKILL");
  // Stop the daemon we started, so a run never leaves one behind holding a session
  // (and the port) for the next run to trip over.
  process.env.LOOP_ENG_DIR = STATE_DIR;
  const { stopDaemon } = await import("./daemon-ctl.mjs");
  await stopDaemon().catch(() => {});
}

console.log(`\ntranscript: ${TRANSCRIPT}`);
console.log(`${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed${answered ? "" : " (never reached the answer step)"}\n`);
process.exit(fail === 0 ? 0 : 1);
