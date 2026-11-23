// LAYOUT test for the TUI — a real pty, a FAKE daemon, and ZERO tokens.
//
// WHY THIS EXISTS SEPARATELY FROM tui-test.mjs: that test drives a real Claude run to
// prove the decision loop works, so it costs money and about two minutes. Layout is
// the thing most likely to break (a resize, one extra chrome row, a new element) and
// the thing you'd therefore want to check on every change. So this one stubs the
// daemon over HTTP+WS — the TUI is a pure client (PROBLEM 9), which is exactly what
// makes that substitution possible — and asserts the SHAPE of the screen:
//
//   * the input sits on the BOTTOM row of the terminal, in both views and at any size
//   * the sessions list gets the leftover space on the list view
//   * the session view's top row is just the session name — no header box
//   * the transcript is formatted (⏺ / ⎿), not one-line-per-block
//   * a resize re-budgets the rows instead of stranding the input mid-screen
//
// ASSERTIONS RUN AGAINST AN EMULATED SCREEN (tui/screen.mjs), NOT THE TRANSCRIPT. Ink
// repaints *differentially* — cursor-up, erase-line, rewrite — so the raw pty
// transcript is a stream of edits, and grepping it answers "were these bytes ever
// written", which is not the question. A row that was later erased still matches; a row
// rewritten in place matches twice; and there's no dependable frame boundary, so
// "which row is the input on?" can't be answered at all. Replaying the bytes into a
// grid answers it exactly: row -1 IS the bottom of the screen.
//
//   node apps/cli/src/layout-test.mjs

import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import { Screen } from "./tui/screen.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIN = join(HERE, "main.mjs");
const PTY = join(HERE, "pty-runner.py");
const PORT = 4396;
const STATE_DIR = mkdtempSync(join(tmpdir(), "loop-layout-"));
const SAFE_CWD = mkdtempSync(join(tmpdir(), "loop-layout-cwd-"));
// Stands in for Tailscale's state directory. The app watches it and re-probes exposure when
// it changes; the real one can't be moved by a test, this can.
const TS_WATCH_DIR = mkdtempSync(join(tmpdir(), "loop-layout-tswatch-"));

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? `\n      ${extra}` : ""}`); }
};

/** Only for the "did this ever appear" style of wait; assertions use the screen. */
const strip = (s) =>
  s.replace(/\x1b\][^\x07\x1b]*(\x07|\x1b\\)/g, "").replace(/\x1b[\[\(][0-9;?]*[a-zA-Z]/g, "");

// ---- the fake daemon -----------------------------------------------------
//
// Two sessions with hand-written transcripts, so the formatting assertions have known
// content to match instead of whatever a live model happened to say. `probeDaemon`
// only checks `service: "loop-daemon"`, so `loop` adopts this and never spawns the
// real one.

const TRANSCRIPT_TURNS = [
  { role: "user", blocks: [{ kind: "text", text: "add a health endpoint and run the tests" }], ts: new Date(0).toISOString() },
  { role: "assistant", blocks: [
    { kind: "thinking", text: "Look at the server file first to see how routes are registered." },
    { kind: "text", text: "I'll add it. The **plan**:\n\n- read `server.mjs`\n- add the route\n- run the tests" },
    { kind: "tool_use", id: "t1", name: "Read", input: { file_path: "daemon/server.mjs" } },
  ], ts: new Date(0).toISOString() },
  { role: "user", blocks: [{
    kind: "tool_result", tool_use_id: "t1",
    text: Array.from({ length: 40 }, (_, i) => `line ${i}: const value_${i} = ${i};`).join("\n"),
  }], ts: new Date(0).toISOString() },
  { role: "assistant", blocks: [
    { kind: "tool_use", id: "t2", name: "Bash", input: { command: "npm test --workspace @loop-eng/cli" } },
  ], ts: new Date(0).toISOString() },
  { role: "user", blocks: [{ kind: "tool_result", tool_use_id: "t2", text: "41 passed, 0 failed" }], ts: new Date(0).toISOString() },
  { role: "assistant", blocks: [{
    kind: "text",
    text: "Done — `/health` returns 200 and all 41 tests pass. This sentence is deliberately long so that wrapping happens and we can see whether the continuation lines align underneath the bullet the way they should.",
  }], ts: new Date(0).toISOString() },
];

const SESSIONS = [
  { id: "aaaa1111", cwd: SAFE_CWD, engine: "claude-code", projectLabel: "alpha", projectName: "alpha",
    status: "running", busy: false, pending: false, lastRole: "assistant", lastTs: new Date().toISOString(),
    preview: "Done — /health returns 200 and all 41 tests pass.", turnCount: 6,
    // Claude's own name (PROBLEM 21). beta has none, so the list must still read without one.
    title: "Add health endpoint" },
  { id: "bbbb2222", cwd: SAFE_CWD, engine: "claude-code", projectLabel: "beta", projectName: "beta",
    status: "idle", busy: false, pending: false, lastRole: "assistant", lastTs: new Date().toISOString(),
    preview: "waiting for instructions", turnCount: 1 },
];

// Conversations from ANOTHER client, for the import picker (PROBLEM 20). Two engines, and
// long absolute cwds on purpose: the picker's job is to show WHICH DIRECTORY an adoption
// will run in, and the row has to keep that readable without wrapping (one wrapped row makes
// the app taller than the terminal — PROBLEM 14f).
const CONVERSATIONS = [
  { engine: "claude-code", ref: "conv-claude-1", title: "Fix the failing auth test",
    cwd: "/Users/someone/Developer/Personal/Loop-Eng", gitBranch: "dev",
    lastTs: new Date(Date.now() - 60_000).toISOString(), preview: "the auth test fails on CI", adoptedAs: null },
  { engine: "claude-code", ref: "conv-claude-2", title: "Rename the pairing module",
    cwd: "/Users/someone/Developer/Work/some-other-repo", gitBranch: "main",
    lastTs: new Date(Date.now() - 3_600_000).toISOString(), preview: "rename pair.mjs", adoptedAs: null },
  { engine: "codex", ref: "conv-codex-1", title: "Port the installer to POSIX sh",
    cwd: "/Users/someone/Developer/Personal/Loop-Eng", gitBranch: null,
    lastTs: new Date(Date.now() - 7_200_000).toISOString(), preview: "installer", adoptedAs: null },
];
const convRequests = [];  // every /conversations call, so the cursor walk can be asserted
const adopts = [];        // every adopt POST, so "⏎ armed but did NOT adopt" is provable
const handoffs = [];      // every confirmed ^T, so the first press is provably only an arm

const QUESTION = {
  question: "Which fruit should I use for the smoke test?",
  header: "Fruit",
  options: [
    { label: "Mango", description: "the sweet one, ships in every test fixture" },
    { label: "Guava", description: "tart" },
    { label: "Papaya", description: "large" },
  ],
  multiSelect: false,
};

const live = new Set();          // open stream sockets, so the test can push events
let pendingOn = null;            // session id with a parked question
let interrupted = 0;             // how many times ^X reached the daemon
let declined = 0;                // how many times esc reached the daemon's decline route
// The LIVE exposure mode, as the header's badge should report it. Served over HTTP so the
// test can change it mid-run and check that the badge follows — the real thing asks
// `tailscale serve status`, which a test can't move. See "the exposure badge" below.
let exposureMode = "serve";

const json = (res, body, code = 200) => {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const http = createServer((req, res) => {
  const { pathname } = new URL(req.url, "http://x");
  if (pathname === "/health")
    return json(res, { service: "loop-daemon", version: "test", push: { enabled: true, subscriptions: 1 } });
  if (pathname === "/engines")
    return json(res, {
      engines: [
        // `canListConversations` is what the import picker filters on (PROBLEM 20). Two
        // engines here so the picker's mixed list is exercised, and one that CANNOT list, so
        // the capability filter is doing something rather than being incidentally true.
        { id: "claude-code", label: "Claude Code", available: true, canListConversations: true },
        { id: "codex", label: "Codex", available: true, canListConversations: true },
        { id: "bare", label: "Bare", available: true, canListConversations: false },
      ],
    });
  // Foreign conversations (PROBLEM 20). Paged, because the TUI walks every page — a single
  // unpaged response would leave the cursor loop untested.
  if (pathname === "/conversations") {
    const u = new URL(req.url, "http://x");
    const engine = u.searchParams.get("engine");
    if (engine === "bare") return json(res, { conversations: [], nextCursor: null });
    const rows = CONVERSATIONS.filter((c) => c.engine === engine);
    const cursor = u.searchParams.get("cursor");
    const page = cursor === "page2" ? rows.slice(1) : rows.slice(0, 1);
    convRequests.push({ engine, cursor });
    return json(res, {
      engine,
      conversations: page,
      nextCursor: cursor || rows.length <= 1 ? null : "page2",
    });
  }
  // Not a real daemon route — the harness's way to move the exposure state that the TUI
// re-probes. LOOP_EXPOSURE_PROBE_URL below points `loop` here instead of at Tailscale.
  if (pathname === "/test-exposure")
    return json(res, { mode: exposureMode });
  if (pathname === "/sessions" && req.method === "GET")
    return json(res, { sessions: SESSIONS.map((s) => ({ ...s, pending: s.id === pendingOn })) });
  if (pathname === "/sessions" && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    return req.on("end", () => {
      let body = {};
      try { body = JSON.parse(raw || "{}"); } catch { /* treated as a plain start */ }
      // ADOPT (PROBLEM 20): becomes a real session whose transcript came from elsewhere.
      if (body.adopt) {
        adopts.push(body.adopt);
        const conv = CONVERSATIONS.find((c) => c.ref === body.adopt.ref);
        const id = `imp${adopts.length}0000`;
        if (conv) conv.adoptedAs = id; // so the next list marks it ✓ imported
        SESSIONS.push({
          ...SESSIONS[0], id,
          projectName: "imported", projectLabel: conv?.cwd ?? "imported",
          preview: conv?.title ?? "imported conversation", turnCount: 9,
          adoptedFrom: { engine: body.adopt.engine, ref: body.adopt.ref, truncated: false, total: 9 },
        });
        return json(res, { id, meta: SESSIONS[SESSIONS.length - 1], adopted: body.adopt });
      }
      const id = `cccc${SESSIONS.length}333`;
      SESSIONS.push({ ...SESSIONS[1], id, projectName: "gamma", projectLabel: "gamma", preview: "just started" });
      return json(res, { id });
    });
  }
  if (/^\/sessions\/[^/]+\/reply$/.test(pathname)) {
    pendingOn = null;
    for (const ws of live) ws.send(JSON.stringify({ type: "pending", question: null }));
    return json(res, { ok: true });
  }
  if (/^\/sessions\/[^/]+\/handoff$/.test(pathname) && req.method === "POST") {
    let raw = "";
    req.on("data", (c) => { raw += c; });
    return req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      const sourceId = pathname.split("/")[2];
      const source = SESSIONS.find((s) => s.id === sourceId) ?? SESSIONS[0];
      const id = `hand${handoffs.length + 1}`;
      const target = {
        ...source,
        id,
        engine: body.engine,
        title: `${source.title ?? source.projectName} → ${body.engine === "codex" ? "Codex" : "Claude"}`,
        handoffFrom: { sessionId: source.id, engine: source.engine, turnCount: source.turnCount, createdAt: new Date().toISOString() },
      };
      handoffs.push({ sourceId, engine: body.engine });
      SESSIONS.push(target);
      return json(res, { id, meta: target, handoff: { includedTurns: source.turnCount, omittedTurns: 0 } });
    });
  }
  // The kill switch (PROBLEM 17). Counted so the test can prove the key reached the
  // daemon, not merely that the TUI printed something reassuring.
  if (/^\/sessions\/[^/]+\/interrupt$/.test(pathname) && req.method === "POST") {
    interrupted++;
    return json(res, { ok: true });
  }
  // Decline (PROBLEM 23). Counted for the same reason as interrupt, and it clears the
  // question exactly the way the real daemon does — with a null pending frame.
  if (/^\/sessions\/[^/]+\/decline$/.test(pathname) && req.method === "POST") {
    declined++;
    pendingOn = null;
    for (const ws of live) ws.send(JSON.stringify({ type: "pending", question: null }));
    return json(res, { ok: true, mode: "declined" });
  }
  if (/^\/sessions\/[^/]+\/history$/.test(pathname))
    return json(res, { turns: TRANSCRIPT_TURNS });
  return json(res, { error: "not found" }, 404);
});

const wss = new WebSocketServer({ server: http, path: undefined });
wss.on("connection", (ws, req) => {
  const id = decodeURIComponent(new URL(req.url, "http://x").pathname.split("/").pop());
  live.add(ws);
  ws.on("close", () => live.delete(ws));
  // Only the first session has a conversation; the second is fresh.
  ws.send(JSON.stringify({ type: "history", turns: id === "bbbb2222" ? [] : TRANSCRIPT_TURNS }));
  ws.send(JSON.stringify({ type: "pending", question: id === pendingOn ? QUESTION : null }));
});

await new Promise((r) => http.listen(PORT, "127.0.0.1", r));
console.log(`\nfake daemon on :${PORT}\nstate dir: ${STATE_DIR}\n`);

// ---- drive the TUI in a real pty -----------------------------------------

const COLS = 100, ROWS = 40;
const TRANSCRIPT = join(STATE_DIR, "layout.transcript");
// A token file must exist or `loop` prints a warning path we don't care about here.
writeFileSync(join(STATE_DIR, "token"), "x".repeat(43) + "\n");

// PRELUDE_LINES of shell output BEFORE `loop` starts, so the cursor is partway down the
// screen when the app takes over — which is the normal state of a real terminal (a
// prompt, plus whatever the last command printed). A pty that starts at row 0 hides the
// alternate-screen origin bug entirely; see "the alternate screen" assertions below.
const PRELUDE_LINES = 20;

const child = spawn(
  "python3",
  [PTY, TRANSCRIPT, String(COLS), String(ROWS),
   "sh", "-c",
   `for i in $(seq ${PRELUDE_LINES}); do echo "shell output line $i"; done; exec "$@"`, "sh",
   process.execPath, MAIN, `--port=${PORT}`, `--cwd=${SAFE_CWD}`, "--no-expose"],
  {
    cwd: SAFE_CWD,
    env: {
      ...process.env,
      LOOP_ENG_DIR: STATE_DIR,
      TERM: "xterm-256color",
      // Point the exposure re-probe at the stub, so the test can move it.
      LOOP_EXPOSURE_PROBE_URL: `http://127.0.0.1:${PORT}/test-exposure`,
      LOOP_EXPOSURE_WATCH_DIR: TS_WATCH_DIR,
      // POLLING OFF, effectively. Without this the badge would update within 5s no matter
      // what, and every assertion below would pass whether the watcher works or not.
      LOOP_EXPOSURE_POLL_MS: "600000",
      LOOP_EXPOSURE_BACKSTOP_MS: "600000",
    },
    stdio: ["pipe", "inherit", "inherit"],
  }
);
let exited = null;
child.on("exit", (code, sig) => { exited = { code, sig }; });

const cleanup = () => { try { child.kill("SIGKILL"); } catch {} try { http.close(); } catch {} };
process.on("exit", cleanup);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
  process.on(sig, () => { cleanup(); process.exit(1); });

let out = "";
const refresh = () => {
  out = existsSync(TRANSCRIPT) ? readFileSync(TRANSCRIPT, "utf8") : "";
  return out;
};
const waitFor = (test, timeoutMs = 20000) =>
  new Promise((resolve) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (test(strip(refresh()))) { clearInterval(iv); resolve(true); }
      else if (exited) { clearInterval(iv); resolve(false); }
      else if (Date.now() - started > timeoutMs) { clearInterval(iv); resolve(false); }
    }, 200);
  });

// THE SCREEN. Replaying the transcript into a grid gives precisely what the terminal is
// showing: the emulator applies every edit in order, exactly as the real one does.
//
// `replayFrom` matters after a RESIZE. Bytes written while the pty was 120 columns wide
// would wrap wrongly in an 80-column grid and shift every row, so the replay has to
// start at the resize. Ink repaints the whole screen on SIGWINCH (ESC[2J), so picking up
// from the first clear at-or-after that point yields a clean, complete frame.
let size = { cols: COLS, rows: ROWS };
let replayFrom = 0;
const screen = () => {
  const raw = refresh();
  let from = replayFrom;
  const clear = raw.indexOf("\x1b[2J", from);
  if (clear >= 0) from = clear;
  return new Screen(size.cols, size.rows).write(raw.slice(from));
};
/** Screen rows as strings. `rows()[rows().length-1]` is the literal bottom line. */
const rows = () => screen().lines();
const text = () => rows().join("\n");
/** The last n rows — where the input and footer must live. */
const bottom = (n = 4) => rows().slice(-n).join("\n");
/** Rows with content, so "the list fills the space" can be measured. */
const rowOf = (re) => rows().findIndex((l) => re.test(l));

/**
 * IDENTIFY THE FOOTER BY ITS LEFT EDGE, not by `^C detach`.
 *
 * The footer drops keys from the RIGHT when they don't fit (keysFor lists them most
 * important first), so pinning these assertions to the LAST key means every new
 * shortcut breaks them — and breaks them while reporting "the input was pushed off the
 * screen", which sends you hunting a layout bug that isn't there. `^O` cost exactly
 * that. Every footer opens with `⏎ <verb>` and nothing else on screen does.
 */
const FOOTER_RE = /^⏎ \S/;
const footerRow = () => rowOf(FOOTER_RE);

/**
 * Is the `›` prompt exactly where the budget says it should be, counting UP from the footer?
 *
 * The notice line is OPTIONAL and sits between the input box and the footer, so the prompt's
 * absolute row is 24-3 without one and 24-4 with one. Hard-coding either number makes an
 * assertion that fails whenever the app happens to be saying something — which reads as a
 * layout bug when it is really just a hint on screen. Measuring from the footer is what makes
 * this test about the LAYOUT rather than about the notice.
 */
const promptRowOk = () => {
  const f = footerRow();
  if (f < 0) return false;
  const noticeShown = /^[·⚠] /.test(rows()[f - 1] ?? "");
  return rowOf(/›/) === f - (noticeShown ? 3 : 2);
};

/**
 * Like waitFor, but tests what is ON SCREEN rather than the raw transcript.
 *
 * Use this for any predicate that NEGATES — `waitFor` sees the cumulative byte stream, so
 * `!/TAILNET/` is unsatisfiable the moment those bytes are written once, even after the
 * row has been erased and rewritten. Ink repaints differentially (see tui/screen.mjs), so
 * "no longer showing X" is a question only the grid can answer.
 */
const waitForScreen = (test, timeoutMs = 20000) =>
  new Promise((resolve) => {
    const started = Date.now();
    const iv = setInterval(() => {
      if (test(text())) { clearInterval(iv); resolve(true); }
      else if (exited) { clearInterval(iv); resolve(false); }
      else if (Date.now() - started > timeoutMs) { clearInterval(iv); resolve(false); }
    }, 200);
  });

const key = async (seq, waitMs = 700) => {
  child.stdin.write(seq);
  await new Promise((r) => setTimeout(r, waitMs));
  refresh();
};
/**
 * One left click on a screen row, THE WAY A TERMINAL SENDS IT: the press *and* the
 * release, as two separate reports.
 *
 * Sending only the press would be a test that can't fail for the most likely bug — acting
 * on both reports toggles the block twice and leaves it exactly as it was, i.e. a click
 * that looks completely dead. (`row` is 0-based here, like the grid; the wire format is
 * 1-based, and that conversion is the other bug this guards.)
 */
const click = async (row, col = 5) => {
  child.stdin.write(`\x1b[<0;${col};${row + 1}M`);
  await new Promise((r) => setTimeout(r, 60));
  child.stdin.write(`\x1b[<0;${col};${row + 1}m`);
  await new Promise((r) => setTimeout(r, 700));
  refresh();
};
const type = async (text) => {
  for (const ch of text) { child.stdin.write(ch); await new Promise((r) => setTimeout(r, 10)); }
  await new Promise((r) => setTimeout(r, 250));
};

try {
  console.log("list view\n");

  ok("the dashboard renders", await waitFor((s) => /\^C detach/.test(s), 25000),
    exited ? `child exited early: ${JSON.stringify(exited)}` : strip(out).slice(-800));

  await waitFor((s) => /alpha/.test(s) && /beta/.test(s), 10000);
  await new Promise((r) => setTimeout(r, 600));
  refresh();

  {
    const r = rows();
    // FULLSCREEN, measured the only way that means anything: the footer is the LAST
    // thing the app draws, so it must be on the terminal's last row. If the layout
    // under-fills, the footer sits higher and this fails. This is the whole "take all
    // the space in shell" request in one assertion.
    ok("the footer is on the very bottom row of the terminal",
      FOOTER_RE.test(r[ROWS - 1]), `bottom 4 rows:\n${bottom(4)}`);

    // INPUT AT THE BOTTOM — directly above the footer, not floating mid-screen.
    ok("the input box is pinned to the bottom",
      /what should we build\?/.test(bottom(4)), `bottom 4 rows:\n${bottom(4)}`);

    // THE LIST OWNS THE SPARE ROWS. With two sessions in a 40-row terminal the box must
    // be tall — the complaint was a 2-row island floating in a mostly empty screen.
    const listTop = rowOf(/sessions/);
    const inputTop = rowOf(/what should we build\?/);
    ok("the sessions area fills the space between header and input",
      listTop > 0 && inputTop > listTop && inputTop - listTop > 20,
      `list label row ${listTop}, input row ${inputTop} of ${ROWS}\n${text()}`);

    ok("both sessions are listed", /alpha/.test(text()) && /beta/.test(text()), text());
    const alphaRow = r.find((l) => /alpha/.test(l)) ?? "";
    ok("a titled row shows Claude's title AND the preview after it",
      /Add health endpoint\s+Done/.test(alphaRow), JSON.stringify(alphaRow));
    ok("the list advertises its keys",
      /⏎ start/.test(text()) && /→ open/.test(text()), bottom(2));
    // The list view is a LIST: no transcript competing for the screen.
    ok("no transcript on the list view", !/⎿/.test(text()), text());
    // Nothing may be drawn below the footer — that's off-screen content.
    ok("nothing is drawn past the footer", footerRow() === ROWS - 1,
      `footer on row ${footerRow()} of ${ROWS}`);
  }

  console.log("\nthe alternate screen\n");

  // THE REGRESSION THIS GUARDS — "it covers the screen but I can still scroll up and see
  // my old terminal output".
  //
  // Switching to the alternate screen swaps the CONTENTS but keeps the CURSOR ROW, and
  // Ink writes `ESC[?1049h` and nothing else: no clear, no home. So with the cursor 20
  // rows down (PRELUDE_LINES above, i.e. any ordinary shell), Ink began drawing at row 20,
  // the frame's last rows ran past the bottom edge, and the terminal SCROLLED to make
  // room — pushing the app's own header into scroll history, which tmux keeps for the
  // alternate screen. Measured before the fix: cursor at row 20 => exactly 20 rows lost.
  //
  // Every other assertion in this file is blind to it, because they replay from Ink's
  // repaint and so start at a clean row 0 by construction. This one models the switch the
  // way a terminal does and counts the scrolls.
  {
    class AltScreen extends Screen {
      constructor(...a) { super(...a); this.scrolls = 0; this.counting = false; }
      _scroll() { if (this.counting) this.scrolls++; super._scroll(); }
      enterAlt() {
        this.startedAtRow = this.y;
        this.grid = Array.from({ length: this.rows }, () => Array(this.cols).fill(" "));
        this.counting = true;
        this.scrolls = 0;
      }
    }
    const raw = refresh();
    const at = raw.indexOf("\x1b[?1049h");
    ok("the app enters the alternate screen", at >= 0);
    if (at >= 0) {
      const s = new AltScreen(COLS, ROWS);
      s.write(raw.slice(0, at)); // the shell's prelude, on the primary screen
      s.enterAlt();
      s.write(raw.slice(at));    // everything the app drew
      ok("the cursor really was partway down the screen (the test is testing something)",
        s.startedAtRow > 0, `cursor started at row ${s.startedAtRow}`);
      ok("the app scrolls NOTHING off the top of the alternate screen",
        s.scrolls === 0,
        `${s.scrolls} rows pushed into scroll history (cursor started at row ${s.startedAtRow})`);

      // And the mechanism, asserted directly: the cursor must be HOMED before any frame
      // content is written. Checking the end state alone isn't enough — Ink's later full
      // repaints emit their own clear+home, so the screen looks correct again a second
      // later even when the first frame scrolled the header away. Only the bytes between
      // "entered the alternate screen" and "started drawing" distinguish the two, which is
      // why the deleted version of this check ("is the header on screen?") passed against
      // the bug.
      const afterAlt = raw.slice(at + "\x1b[?1049h".length);
      const firstBoxChar = afterAlt.search(/[╭│╰]/);
      const beforeFirstFrame = firstBoxChar < 0 ? afterAlt : afterAlt.slice(0, firstBoxChar);
      ok("the cursor is homed before the first frame is drawn",
        /\x1b\[H|\x1b\[1;1H/.test(beforeFirstFrame),
        `bytes before the first frame: ${JSON.stringify(beforeFirstFrame.slice(0, 120))}`);
      ok("the alternate screen is cleared before the first frame is drawn",
        /\x1b\[2J/.test(beforeFirstFrame),
        `bytes before the first frame: ${JSON.stringify(beforeFirstFrame.slice(0, 120))}`);
    }

    // THE TERMINAL IS ASKED TO REPORT THE MOUSE. This has to be a BYTE assertion: the
    // wheel tests below inject the report bytes into the pty themselves, so they pass
    // whether or not the app ever enabled mouse reporting — against a real terminal that
    // means a wheel that does nothing, which is the bug being fixed. Only the outgoing
    // request distinguishes the two.
    ok("the app asks the terminal to report the mouse (SGR)",
      /\x1b\[\?1006h/.test(raw) && /\x1b\[\?1000h/.test(raw),
      "no mouse-enable sequence was written — the wheel and clicks would be dead in a real terminal");
  }

  console.log("\nthe exposure badge\n");

  // THE REGRESSION THIS GUARDS: the badge was a snapshot taken once at startup, and only
  // `^E` ever replaced it — so it kept asserting TAILNET long after that stopped being
  // true, and restarting the CLI was the only thing that appeared to fix it (it just took
  // a fresh snapshot). Exposure is not ours alone to control: `tailscale serve reset`
  // in another shell drops it, so does `tailscale down`, a `loop share` elsewhere
  // flips it to PUBLIC. The badge is how you know whether this box is on the public
  // internet, so a stale one is the one kind of wrong that actually matters here.
  //
  // `loop` was started with --no-expose, so the badge begins at LOCAL; the stub says
  // "serve". A badge that follows it has re-probed rather than trusted the snapshot.
  //
  // No assertion that it STARTS at LOCAL: the first probe fires on mount, so the badge is
  // legitimately already correct by the time this runs. Racing it would make the test
  // flaky in the direction that hides bugs.
  //
  // AND IT IS EVENT-DRIVEN NOW (PROBLEM 14g): polling is set to 10 minutes for this run, so
  // the ONLY thing that can move the badge is the state-directory watch. `touchTailscale()`
  // is what a `tailscale serve` change does to that directory in real life.
  const touchTailscale = async (n = 0) => {
    writeFileSync(join(TS_WATCH_DIR, `ipn.log.${n}.txt`), String(Date.now()));
    await new Promise((r) => setTimeout(r, 400));
  };
  {
    const reachedTailnet = await waitForScreen((s) => /TAILNET/.test(s), 12000);
    ok("the badge re-probes and follows the LIVE exposure state",
      reachedTailnet, `still: ${rows().slice(0, 5).join("\n")}`);

    // THE BADGE IS PUSHED, NOT POLLED. With the poll at 10 minutes, moving the stub's answer
    // must NOT reach the screen until something touches Tailscale's state directory. If this
    // fails, the interval is doing the work and the watcher is decoration.
    exposureMode = "funnel";
    await new Promise((r) => setTimeout(r, 1500));
    ok("nothing changes while Tailscale is quiet (so it isn't the timer doing this)",
      !/PUBLIC/.test(text()), rows().slice(0, 5).join("\n"));
    ok("…and then ONE state-dir event brings it up to date",
      await (async () => { await touchTailscale(1); return waitForScreen((s) => /PUBLIC/.test(s), 8000); })(),
      rows().slice(0, 5).join("\n"));
    exposureMode = "serve";
    await touchTailscale(2);
    await waitForScreen((s) => /TAILNET/.test(s), 8000);

    // …and it must keep following. Both remaining checks are written as transitions AWAY
    // from the badge's current text, because the stale badge sits at LOCAL: an assertion
    // like "LOCAL eventually appears" would pass on the very bug this exists to catch.
    // Hence `reachedTailnet &&` — without it, a badge frozen at LOCAL satisfies "shows
    // LOCAL" and this passes while nothing is being re-probed at all.
    //
    // They read the SCREEN, not the transcript: `!/TAILNET/` over a cumulative byte stream
    // can never come true once those bytes are written, and that mistake made this fail
    // against WORKING code — the failure mode tui/screen.mjs was written to end.
    exposureMode = "local";
    await touchTailscale(3);
    ok("losing exposure shows up (the safety-critical direction)",
      reachedTailnet && await waitForScreen((s) => /LOCAL/.test(s) && !/TAILNET/.test(s), 12000),
      reachedTailnet ? rows().slice(0, 5).join("\n") : "never reached TAILNET, so nothing was lost");

    exposureMode = "funnel";
    await touchTailscale(4);
    ok("escalation to PUBLIC shows up without a restart",
      await waitForScreen((s) => /PUBLIC/.test(s), 12000), rows().slice(0, 5).join("\n"));

    exposureMode = "serve"; // leave it exposed for the rest of the run
    await touchTailscale(5);
    await waitForScreen((s) => /TAILNET/.test(s), 12000);
  }

  console.log("\nsession view\n");

  await key("\x1b[C"); // → open
  await waitFor((s) => /← back/.test(s), 10000);
  await new Promise((r) => setTimeout(r, 800));
  refresh();

  {
    const r = rows();
    const t = text();
    ok("the footer is still on the terminal's last row",
      FOOTER_RE.test(r[ROWS - 1]), `bottom 4:\n${bottom(4)}`);

    // "when i go inside a session we can just show its name on top" — the FIRST
    // non-blank row is the name, and the header BOX is gone. It's the first non-blank
    // row rather than row 0 because a short conversation is padded from the top so it
    // reads top-down; the title is still the first thing drawn.
    const firstContent = r.find((l) => l.trim()) ?? "";
    ok("the first row is the session name", /alpha/.test(firstContent),
      `first content row: ${JSON.stringify(firstContent)}`);
    ok("the name row carries Claude's title", /Add health endpoint/.test(firstContent),
      JSON.stringify(firstContent));
    ok("the name row carries the session's state",
      /working|idle|needs a decision/.test(firstContent), JSON.stringify(firstContent));
    ok("the header box is gone in-session", !/push:/.test(t) && !/sessions:/.test(t),
      r.slice(0, 6).join("\n"));
    ok("the fleet list box is gone in-session", !/↑↓ move/.test(t), r.slice(0, 8).join("\n"));

    // FORMATTED OUTPUT — the "like claude does" part. These glyphs are the whole point.
    ok("agent turns are marked with ⏺", /⏺/.test(t), t);
    // COLLAPSED, A STEP IS ONE ROW: the call and its output share a line, so there is no
    // `⎿` on screen at all until something is expanded (the `▸` says there's more behind it).
    ok("a whole tool step is ONE row: call and output on the same line",
      /Bash\(npm test[^)]*\).*⎿.*41 passed, 0 failed/.test(t),
      t.match(/.*Bash\(npm test.*/)?.[0] ?? t);
    // `⎿` is still the glyph for output; collapsed, it sits on the call's row instead of
    // hanging beneath it. So "nothing hangs below" is the check, not "no ⎿ anywhere".
    ok("nothing hangs beneath a collapsed step", !/^\s+⎿/m.test(t), t);
    ok("a tool call reads Name(arg)", /Read\(daemon\/server\.mjs\)/.test(t),
      t.match(/.*Read.*/)?.[0] ?? t);
    ok("thinking is marked with ✻", /✻/.test(t), t);
    ok("markdown bullets render as •", /•/.test(t), t);
    ok("the huge tool result is reduced to a count on its call's row",
      /Read\(daemon\/server\.mjs\).*\+39/.test(t), t.match(/.*Read\(daemon.*/)?.[0] ?? t);
    ok("markdown syntax is not shown raw", !/\*\*/.test(t) && !/`server\.mjs`/.test(t), t);
    // The old renderer printed an "agent"/"you" column and truncated every block to one
    // line; the new one wraps. A wrapped continuation line proves it.
    ok("long text wraps instead of being truncated",
      /continuation lines align/.test(t) && /way they should/.test(t), t);
    // Consecutive steps pack together: a blank line between two one-row steps is wasted
    // height, and a run of `⏺` rows already separates itself.
    ok("consecutive steps are on consecutive rows",
      rowOf(/Bash\(npm test/) === rowOf(/Read\(daemon/) + 1,
      `Read row ${rowOf(/Read\(daemon/)}, Bash row ${rowOf(/Bash\(npm test/)}`);

    ok("the input is still pinned to the bottom",
      /reply to this session/.test(bottom(4)), bottom(4));
    ok("the session view advertises ← back and scrolling",
      /← back/.test(t) && /scroll/.test(t), bottom(2));
  }

  console.log("\ncollapsed tool output, and ^O to open it\n");

  // WHAT THIS IS FOR: "i want only worthy text to be displayed primarily". The fake
  // transcript's Read returns 40 lines; collapsed, exactly ONE of them may be on screen,
  // and the agent's PROSE has to be what fills the rest. Asserting the count matters more
  // than asserting the mechanism — a policy of "six rows each" would also look "capped"
  // and would still bury the conversation.
  {
    const t = text();
    ok("a 40-line tool result shows only its first line",
      /line 0: const value_0/.test(t) && !/line 1: const value_1/.test(t),
      (t.match(/.*line \d+: const.*/g) ?? []).join("\n") || t);
    // ONE ROW FOR THE WHOLE STEP. Not the call on one row and a "+39" marker on another —
    // the call, the first line of output and the count, all on the same line.
    ok("the output and its count share the CALL's row",
      /Read\(daemon\/server\.mjs\).*line 0: const value_0.*\+39/.test(t),
      t.match(/.*Read\(daemon.*/)?.[0] ?? t);
    ok("the step occupies exactly one row",
      (t.match(/.*line 0: const value_0.*/g) ?? []).length === 1 &&
        rowOf(/line 0: const value_0/) === rowOf(/Read\(daemon/),
      (t.match(/.*line \d+: const.*/g) ?? []).join("\n"));
    ok("the prose is what fills the screen",
      /way they should/.test(t) && /read `?server\.mjs`?|read server/.test(t), t);
    ok("the footer advertises ^O", /\^O expand/.test(bottom(2)), bottom(2));
  }

  await key("\x0f"); // ^O — expand
  {
    // Expanded, the tail of that output is reachable. `line 39` is the LAST row of the
    // hidden block, so it also proves nothing was silently re-capped at some other number.
    const opened = await waitForScreen((s) => /line 39: const value_39/.test(s), 8000);
    ok("^O opens the hidden output", opened, bottom(10));
    const t = text();
    ok("nothing is left to hide once expanded", !/\+\d+ lines/.test(t),
      t.match(/.*\+\d+ lines.*/)?.[0] ?? "");
    ok("the toggle says what it did", /expanded/.test(t), bottom(3));
    // The label names the ACTION, not the state — "^O collapse" is what it will do next.
    ok("the footer flips to ^O collapse",
      /\^O collapse/.test(bottom(2)) && !/\^O expand/.test(bottom(2)), bottom(2));
    // THE REGRESSION THAT MATTERS: expanding adds ~40 rows to the body. If the body isn't
    // held to its budget, they push the input and the footer off the bottom of the screen.
    ok("expanding does not push the input off the screen",
      FOOTER_RE.test(rows()[ROWS - 1]) && /reply to this session/.test(bottom(5)), bottom(5));
  }

  await key("\x0f"); // ^O — collapse again, so the scroll tests start from a short transcript
  {
    // A NEGATED predicate over the raw transcript can never come true (see waitForScreen).
    const closed = await waitForScreen((s) => !/line 39: const value_39/.test(s), 8000);
    ok("^O collapses it again", closed, bottom(10));
    ok("the one-row step is back", /Read\(daemon\/server\.mjs\).*\+39/.test(text()), bottom(10));
    ok("the footer flips back to ^O expand", /\^O expand/.test(bottom(2)), bottom(2));
  }

  console.log("\nclicking one step open (and shut)\n");

  // "can we not do mouse interactions for that to open n close" — `^O` is all-or-nothing;
  // this is the "just show me THAT command's output" gesture. It's also the one that can
  // silently target the WRONG row, since it goes screen row -> line index -> block.
  {
    const readRow = rowOf(/⏺ Read\(daemon/);
    ok("the tool call is on screen to be clicked", readRow >= 0,
      rows().map((l, i) => `${i}|${l}`).join("\n"));

    // A real terminal's press report, SGR: button 0, column 5, row = readRow + 1 (the
    // terminal counts rows from 1; the grid from 0 — that off-by-one IS the bug class here).
    await click(readRow);
    const opened = await waitForScreen((s) => /line 5: const value_5/.test(s), 8000);
    ok("clicking a ⏺ tool line opens its output", opened, bottom(12));

    // THE ANCHOR. Opening a step inserts ~39 rows BELOW the click, and the viewport is
    // anchored to the bottom — so without compensating scroll, the step you just clicked is
    // shoved off the top of the screen and the click reads as "nothing happened". This is
    // the assertion that fails if that compensation is removed.
    ok("the row you clicked is still on screen", rowOf(/⏺ Read\(daemon/) >= 0,
      `Read row is now ${rowOf(/⏺ Read\(daemon/)}\n${bottom(12)}`);
    ok("its output starts right under it",
      rowOf(/⎿ +line 0: const value_0/) === rowOf(/⏺ Read\(daemon/) + 1,
      `call ${rowOf(/⏺ Read\(daemon/)}, first output row ${rowOf(/⎿ +line 0/)}`);
    ok("that step has nothing left to hide", !/\+39 lines/.test(text()), bottom(12));
    ok("opening one step does not push the input off the screen",
      FOOTER_RE.test(rows()[ROWS - 1]) && /reply to this session/.test(bottom(5)), bottom(5));
    // A click is NOT ^O: the footer still offers to expand everything, because everything
    // is not expanded.
    ok("a click leaves ^O still meaning 'expand'", /\^O expand/.test(bottom(2)), bottom(2));

    // CLICK IT AGAIN TO SHUT IT. This is the assertion that catches acting on the mouse
    // RELEASE as well as the press: that would toggle twice per click and nothing would
    // ever appear to change.
    await click(rowOf(/⏺ Read\(daemon/));
    ok("clicking it again closes it",
      await waitForScreen((s) => !/line 5: const value_5/.test(s), 8000), bottom(12));
    ok("and the step is one row again",
      /Read\(daemon\/server\.mjs\).*⎿.*\+39/.test(text()) && !/^\s+⎿/m.test(text()), bottom(12));
  }
  {
    // Clicking PROSE has nothing to open. Silence would read as a dead gesture (the arrows
    // lesson from PROBLEM 14), so it says what is clickable instead.
    const proseRow = rowOf(/way they should/);
    ok("there is a prose row to click", proseRow >= 0, bottom(12));
    await click(proseRow);
    ok("clicking prose says what IS clickable",
      await waitForScreen((s) => /click a ⏺ tool line/.test(s), 8000), bottom(4));
    ok("…and opens nothing", !/line 5: const value_5/.test(text()), bottom(12));
  }

  console.log("\nstreaming output, and the kill switch (PROBLEM 17)\n");

  // Streaming's whole claim is that text shows up WHILE the agent is still talking. It
  // renders through the transcript rather than in a panel of its own, so the second
  // assertion here is the one that matters structurally: no extra chrome rows, therefore
  // the input cannot be pushed off the bottom (PROBLEM 14f).
  for (const ws of live) {
    ws.send(JSON.stringify({ type: "busy", busy: true, since: new Date().toISOString() }));
    ws.send(JSON.stringify({
      type: "delta",
      kind: "text",
      text: "sen",
      partial: { kind: "text", text: "Streaming half a sen" },
    }));
  }
  ok("in-flight text appears before any turn completes",
    await waitForScreen((s) => /Streaming half a sen/.test(s), 8000), bottom(10));
  ok("streaming does not push the input off the screen",
    FOOTER_RE.test(rows()[ROWS - 1]) && /reply to this session/.test(bottom(4)), bottom(5));
  ok("^X stop is advertised while the agent is working", /\^X stop/.test(text()), bottom(3));

  // THE DAEMON'S VERDICT (PROBLEM 23). `since` is 7s ago, so the count must start there
  // and not at the moment this frame arrived — that's what keeps a reconnect from
  // resetting it, and what makes the TUI and the phone show the same number.
  for (const ws of live)
    ws.send(JSON.stringify({ type: "busy", busy: true, since: new Date(Date.now() - 7000).toISOString() }));
  ok("a working line appears under the output, counting from the daemon's start time",
    await waitForScreen((s) => /✻ Writing… (7|8|9|10)s/.test(s), 8000), bottom(8));
  ok("the working line does not push the input off the screen",
    FOOTER_RE.test(rows()[ROWS - 1]) && /reply to this session/.test(bottom(4)), bottom(5));
  ok("…and it counts", await waitForScreen((s) => /✻ Writing… (9|1\d)s/.test(s), 6000), bottom(8));

  // THE DOUBLING TRAP: the completed turn contains the same words the partial did. If the
  // partial isn't dropped when the turn lands, the sentence is on screen twice.
  for (const ws of live)
    ws.send(JSON.stringify({ type: "turn", turn: {
      role: "assistant",
      blocks: [{ kind: "text", text: "Streaming half a sentence, now done." }],
      ts: new Date(0).toISOString(),
    } }));
  await waitFor((s) => /now done/.test(s), 8000);
  await new Promise((r) => setTimeout(r, 500));
  ok("with the partial gone, the line names the general state",
    /✻ Working… \d+s/.test(text()) && !/Writing…/.test(text()), bottom(8));
  ok("the completed turn REPLACES the partial instead of doubling it",
    (text().match(/Streaming half a sen/g) ?? []).length === 1,
    `matches=${(text().match(/Streaming half a sen/g) ?? []).length}\n${bottom(10)}`);

  // busy:false is AUTHORITATIVE: the session is still "running" (its process is alive), and
  // the old guess would have kept advertising ^X for the next 30 minutes.
  for (const ws of live) ws.send(JSON.stringify({ type: "busy", busy: false, since: null }));
  ok("busy:false removes the working line",
    await waitForScreen((s) => !/✻ \w+…/.test(s), 6000), bottom(8));
  ok("…and stops advertising ^X, though the process is still up",
    !/\^X stop/.test(text()), bottom(3));

  // ^X must reach the daemon AND say what happened — a silent stop is indistinguishable
  // from a dead key.
  const interruptsBefore = interrupted;
  await key("\x18"); // ^X
  ok("^X reaches the daemon", await waitFor(() => interrupted === interruptsBefore + 1, 8000),
    `interrupted=${interrupted}`);
  ok("…and the screen says it stopped, and what to do next",
    await waitForScreen((s) => /stopped/.test(s) && /correction/.test(s), 8000), bottom(4));

  console.log("\nscrolling\n");

  // A conversation SHORTER than the screen has nothing to scroll, and PgUp there must
  // say so rather than sit silent (a silent no-op reads as a dead key — the whole lesson
  // of the arrows being reported "broken").
  await key("\x1b[5~"); // PgUp on a transcript that fits
  ok("PgUp on a short conversation says why nothing happened",
    /nothing above/.test(text()), bottom(4));

  // Now make it genuinely longer than the terminal, so scrolling has work to do.
  for (const ws of live)
    ws.send(JSON.stringify({ type: "turn", turn: {
      role: "assistant",
      blocks: [{ kind: "text", text: Array.from({ length: 60 }, (_, i) => `overflow line ${i}`).join("\n") }],
      ts: new Date(0).toISOString(),
    } }));
  await waitFor((s) => /overflow line 59/.test(s), 10000);
  await new Promise((r) => setTimeout(r, 600));

  ok("new output arrives pinned to the latest line",
    /overflow line 59/.test(text()), bottom(6));

  await key("\x1b[5~"); // PgUp with real content above
  {
    // Scrolled up means you are NOT seeing the latest; the screen must say so or a
    // stale view looks like a stalled agent.
    ok("PgUp scrolls back and says how much is below", /more lines?/.test(text()), bottom(6));
    ok("scrolling back actually moves the content",
      !/overflow line 59/.test(text()), bottom(8));
    // THE REGRESSION THIS GUARDS: the "↓ n more" marker costs a row. If it's added on
    // top of the transcript's budget instead of taken out of it, the whole column grows
    // by one and the input is pushed off the bottom of the screen.
    ok("scrolling does not push the input off the screen",
      FOOTER_RE.test(rows()[ROWS - 1]) && /reply to this session/.test(bottom(4)), bottom(5));
  }
  await key("\x1b[F"); // End -> back to live
  ok("End returns to the latest output",
    !/more lines/.test(text()) && /overflow line 59/.test(text()), bottom(8));

  console.log("\nthe mouse wheel\n");

  // WHY THE WHEEL IS TESTED AT ALL: the alternate screen took the terminal's own
  // scrollback away, so the wheel — the gesture a hand reaches for first — did nothing.
  // Ink has NO mouse support, so these reports arrive as ordinary `input` TEXT and the
  // handler has to both act on them and swallow them.
  //
  // These are the real bytes a terminal sends in SGR mode (ESC[?1006h): button 64 = wheel
  // up, 65 = down. Written as one chunk each because Ink parses one stdin chunk as one
  // key event.
  {
    await key("\x1b[<64;10;5M"); // wheel up
    ok("the wheel scrolls back", /more lines?/.test(text()), bottom(6));
    ok("the wheel moved the content", !/overflow line 59/.test(text()), bottom(8));

    // THE BUG THIS EXISTS FOR. ink-text-input inserts any input it doesn't recognise, so
    // an unswallowed report is typed into the prompt — and the next ⏎ sends `[<64;10;5M`
    // to the agent. Asserting on the prompt's contents is the only way to see it: the
    // scroll above works either way.
    ok("the wheel does not type escape bytes into the prompt",
      !/64;10;5/.test(text()) && !/\[</.test(text()), bottom(5));
    ok("the prompt still shows its placeholder (nothing was inserted)",
      /reply to this session/.test(bottom(4)), bottom(4));

    // A wheel tick is 3 rows, so scrolling down must land back at live without needing
    // End — otherwise "up 3, down 3" leaves you stranded one row off the bottom.
    await key("\x1b[<65;10;5M"); // wheel down
    ok("the wheel scrolls forward again", /overflow line 59/.test(text()), bottom(8));

    ok("the wheel does not push the input off the screen",
      FOOTER_RE.test(rows()[ROWS - 1]) && /reply to this session/.test(bottom(4)), bottom(5));

    // A dead end must SPEAK, same as PgDn: silence reads as a broken wheel.
    await key("\x1b[<65;10;5M"); // wheel down again, already live
    ok("wheeling down at the latest output says so",
      /already at the latest output/.test(text()), bottom(4));

    // A CLICK is recognised-but-unhandled, and that's the case most likely to regress
    // into typing: it takes a different branch from the wheel and does nothing visible,
    // so nothing but the prompt reveals whether its bytes were swallowed.
    await key("\x1b[<0;10;5M");
    await key("\x1b[<0;10;5m"); // press and release
    ok("a click types nothing into the prompt either",
      !/0;10;5/.test(text()) && /reply to this session/.test(bottom(4)), bottom(5));

    // And typing must still WORK — a parser that swallowed too much would break the
    // input box, which is a worse bug than the one being fixed.
    //
    // `› hi` IN ORDER, not just "contains h and i". A swallowed keypress used to leave
    // ink-text-input's private cursor stale, and the next two characters came out
    // REVERSED — "hi" rendered as "ih". An unordered check passes on that.
    await type("hi");
    ok("ordinary typing still reaches the prompt, IN ORDER", /› hi/.test(bottom(4)), bottom(4));
    await key("\x7f"); await key("\x7f"); // backspace it away for the next block
    ok("the prompt is empty again", /reply to this session/.test(bottom(4)), bottom(4));

    await key("\x1b[F"); // End -> back to live for the next block
  }

  // THE WHEEL IS ADVERTISED. An unadvertised key may as well not exist — the arrows
  // reading as "broken" in PROBLEM 14 were bound the whole time.
  ok("the footer advertises the wheel", /wheel/.test(text()), bottom(2));

  console.log("\nan intercepted keypress must not corrupt what you type next\n");

  // THIS BUG PRE-DATES THE WHEEL, so it's tested through ^R — the oldest path that had it —
  // and stays guarded even if the mouse is ever removed.
  //
  // `ink-text-input` inserted the letter of any key it didn't recognise, so every ctrl
  // shortcut had to undo the insert by restoring the value. But it kept its own
  // cursorOffset, and an unchanged value means React skips the re-render that would clamp
  // it: the cursor sat one past the end and the next two characters came out REVERSED.
  // Typing "hi" gave "ih", in a prompt bound for the agent. Verified on the previous
  // commit: ^R then "hi" renders `› ih`. tui/text-input.mjs is the fix.
  //
  // NOT TESTED HERE: ^E. It calls the real `tailscale funnel`, which would expose this
  // machine to the public internet from a test run. The existing suite avoids it for the
  // same reason; `text-input-test.mjs` covers the ctrl-key branch exhaustively and for free.
  {
    await key("\x12"); // ^R shows the QR
    await key("\x12"); // ^R hides it again — two intercepted keypresses, screen unchanged
    await type("hi");
    ok("^R then typing leaves the characters in order", /› hi/.test(bottom(4)), bottom(4));
    await key("\x7f"); await key("\x7f");

    // Typing AFTER the intercepted key is the corrupting case, but an intercepted key must
    // also not eat text already in the buffer.
    await type("keep");
    await key("\x12");
    await key("\x12");
    ok("an intercepted keypress preserves what you had already typed",
      /› keep/.test(bottom(4)), bottom(4));
    await type("er");
    ok("and typing continues at the END of it", /› keeper/.test(bottom(4)), bottom(4));
    for (let i = 0; i < 7; i++) await key("\x7f", 120);
    ok("the prompt is clear for the next block",
      /reply to this session/.test(bottom(4)), bottom(4));
  }

  console.log("\npaste (⌘V)\n");

  // ⌘V DID NOTHING, for two independent reasons: a clipboard almost always ends in `\n`,
  // and one control character used to make the input reject the whole chunk — plus Ghostty
  // refuses a multi-line paste at all unless the app enables bracketed paste. A terminal
  // sends a paste as ONE chunk, which is what these write.
  {
    ok("the app asks for bracketed paste", /\x1b\[\?2004h/.test(refresh()),
      "no ?2004h was written — the terminal won't mark pastes, and Ghostty will refuse them");

    // Bracketed, the way a terminal sends it once ?2004h is on.
    await key("\x1b[200~fix the flaky test\x1b[201~");
    ok("a bracketed paste lands in the prompt", /› fix the flaky test/.test(bottom(4)), bottom(4));
    for (let i = 0; i < 19; i++) await key("\x7f", 40);

    // WITH A TRAILING NEWLINE — the case that used to vanish completely, because one
    // control character disqualified the entire chunk.
    await key("copied from a browser\n");
    ok("a paste ending in a newline is not thrown away",
      /› copied from a browser/.test(bottom(4)), bottom(4));
    // …and it must NOT have submitted: a paste is text, not ⏎.
    ok("a pasted newline does not send the message", !/^\s*$/.test(bottom(4)) &&
      /copied from a browser/.test(bottom(4)), bottom(4));
    for (let i = 0; i < 24; i++) await key("\x7f", 40);

    // Multi-line: every line has to arrive, on the one row the prompt has.
    await key("\x1b[200~line one\nline two\nline three\x1b[201~");
    ok("a multi-line paste keeps all of its text on one row",
      /line one line two line three/.test(bottom(4)), bottom(4));
    ok("pasting three lines does not grow the input box",
      FOOTER_RE.test(rows()[ROWS - 1]) && /›/.test(bottom(4)), bottom(5));
    for (let i = 0; i < 40; i++) await key("\x7f", 30);
    ok("the prompt is clear again", /reply to this session/.test(bottom(4)), bottom(4));
  }

  console.log("\ntyping a long line must not repaint the screen\n");

  // WHY THIS IS A BYTE ASSERTION: Ink falls back to `clearTerminal` (ESC[2J) + a full
  // repaint for any frame TALLER than the viewport, and clears again on the frame after. A
  // wrapping input row is one row too many, so every keystroke past the edge of the box wiped
  // and redrew the whole screen — which is what "the whole TUI kinda blinks" was. Nothing
  // about the final screen shows it; only the bytes do.
  {
    const long = "please refactor the transcript renderer so that every tool step is one row " +
      "and then run the whole suite twice END";
    await type(long);
    refresh();
    // THE TELL IS AN EXTRA ROW, not a clear. The input box is 3 rows (border, text, border)
    // and the footer is the last one, so the `›` row sits at exactly ROWS-3. Let the text
    // wrap and the box becomes 4 rows: `›` moves UP one, the whole app draws ROWS+1 rows into
    // ROWS, the terminal scrolls to make room, and Ink's next differential erase — sized to
    // what it *thinks* it wrote — lands one row off. That misalignment is the blink.
    ok("a long line does not grow the input box", rowOf(/›/) === ROWS - 3,
      `the › row is ${rowOf(/›/)}, expected ${ROWS - 3}\n${bottom(6)}`);
    ok("nothing was pushed off the top by it", FOOTER_RE.test(rows()[ROWS - 1]), bottom(5));
    // WHAT A KEYSTROKE COSTS — the flicker, as bytes.
    //
    // Ink ships two frame writers and DEFAULTS TO THE WRONG ONE for an app like this:
    // `createStandard` blanks every row of the previous frame and rewrites the whole thing on
    // every render, so one keystroke repainted all 40 rows and the blank moment in between is
    // the blink. `createIncremental` skips lines whose contents are unchanged ("This prevents
    // flickering during renders" — its own comment). `incrementalRendering: true` in main.mjs
    // is the switch; typing changes exactly one row, so it should write about one row.
    //
    // MEASURED at 100x40, 10 keystrokes: 4875 bytes / 120 erase sequences on the default,
    // 849 bytes / 3 with it on. The thresholds sit between those, with room either side.
    {
      const t0 = refresh().length;
      await type("abcdefghij");
      const written = refresh().slice(t0);
      const erases = (written.match(/\x1b\[[0-9]*[KJ]/g) ?? []).length;
      ok("ten keystrokes do not repaint the whole screen", written.length < 2000,
        `${written.length} bytes for 10 keystrokes (a full frame is ~4.5KB)`);
      ok("…and do not blank rows to do it", erases < 20,
        `${erases} erase sequences for 10 keystrokes`);
      // Undo just those ten characters; the long line around them is cleared below.
      for (let i = 0; i < 10; i++) await key("\x7f", 20);
    }
    // A window that fits but shows the WRONG end is useless: you type at the end, so the end
    // is what has to be visible.
    ok("the visible part of the input follows the cursor", /END/.test(bottom(4)), bottom(4));
    ok("the transcript is untouched by all that typing", /overflow line 59/.test(text()), bottom(8));
    for (let i = 0; i < long.length + 4; i++) await key("\x7f", 6);
    await new Promise((r) => setTimeout(r, 400));
    refresh();
    ok("and it clears back to the placeholder", /reply to this session/.test(bottom(4)), bottom(4));
  }

  console.log("\nthe decision card (the USP) still fits\n");

  pendingOn = "aaaa1111";
  for (const ws of live) ws.send(JSON.stringify({ type: "pending", question: QUESTION }));
  await waitFor((s) => /WAITING FOR YOU/.test(s), 10000);
  await new Promise((r) => setTimeout(r, 800));
  refresh();
  {
    const t = text();
    ok("the card appears", /WAITING FOR YOU/.test(t), t);
    ok("the question and every option are shown",
      /fruit/i.test(t) && /1\.\s*Mango/.test(t) && /Guava/.test(t) && /Papaya/.test(t), t);
    // THE REGRESSION THIS GUARDS: the card is extra rows. If they aren't taken out of
    // the transcript's budget the column overflows and the input is pushed off-screen —
    // i.e. the question becomes UNANSWERABLE, which is the product's one job.
    ok("the card does not push anything off the screen",
      FOOTER_RE.test(rows()[ROWS - 1]), `bottom 5:\n${bottom(5)}`);
    ok("the input is still reachable below the card",
      /answer the question above/.test(bottom(4)), bottom(6));
    ok("the card sits directly above the input",
      rowOf(/WAITING FOR YOU/) > 0 && rowOf(/answer the question above/) > rowOf(/WAITING FOR YOU/),
      `card row ${rowOf(/WAITING FOR YOU/)}, input row ${rowOf(/answer the question above/)}`);
    ok("the footer says ⏎ answers it", /⏎ answer/.test(t), bottom(2));
    ok("…and that esc declines it", /esc decline/.test(t), bottom(2));
    ok("the card itself says esc declines", /esc to decline/.test(t), t);
  }

  // DECLINE (PROBLEM 23): esc reaches the daemon, the card goes, and the notice points at
  // step two — declining is only ever half of "do this instead".
  {
    const before = declined;
    await key("\x1b");
    ok("esc reaches the daemon's decline route", await waitFor(() => declined === before + 1, 8000),
      `declined=${declined}`);
    ok("…the card is gone", await waitForScreen((s) => !/WAITING FOR YOU/.test(s), 8000), bottom(10));
    ok("…and the screen says what to do next",
      await waitForScreen((s) => /declined/.test(s) && /instead/.test(s), 8000), bottom(4));
    ok("the input is back to replying", /reply to this session/.test(bottom(4)), bottom(4));
    await key("\x1b");
    ok("esc with nothing parked says why, and calls nothing",
      await waitForScreen((s) => /nothing to decline/.test(s), 6000) && declined === before + 1, bottom(4));
  }
  // Re-park it: the QR and resize checks below measure the layout WITH the card.
  pendingOn = "aaaa1111";
  for (const ws of live) ws.send(JSON.stringify({ type: "pending", question: QUESTION }));
  await waitFor((s) => /WAITING FOR YOU/.test(s), 10000);
  // End clears the decline notice: the QR check below is sized to fit EXACTLY, with no
  // notice row, so a lingering one would fail it for a reason that isn't the QR's.
  await key("\x1b[F");
  await new Promise((r) => setTimeout(r, 800));
  refresh();

  console.log("\nthe QR panel\n");

  await key("\x12"); // ^R
  {
    // The QR is the biggest thing that can appear (~24 rows with its border and hint), and
    // this is the tightest size it still FITS in: 24 + an 8-row decision card + 5 rows of
    // chrome + a 3-row body is exactly 40. It must eat into the transcript, never into the
    // input — and the row budget has to come out even, or the app draws more rows than the
    // terminal has and the whole screen strobes. The too-short case is at the end, at 80x24.
    ok("^R shows the QR in-session too", /scan to pair/.test(text()), bottom(10));
    ok("the QR does not push the input off the screen",
      FOOTER_RE.test(rows()[ROWS - 1]) &&
      /answer the question above|reply to this session/.test(bottom(4)), bottom(6));
    ok("the QR eats the transcript, not the chrome", rowOf(/›/) === ROWS - 3,
      `the › row is ${rowOf(/›/)}, expected ${ROWS - 3}`);
  }
  await key("\x12"); // ^R off
  ok("^R hides it again", !/scan to pair/.test(text()), bottom(8));

  console.log("\nresize\n");

  // A layout that only works at the size it started at isn't a layout. The old code
  // read stdout.rows ONCE, so a resized terminal left the input floating mid-screen or
  // pushed it off the bottom. useWindowSize() re-renders; this is what proves it.
  // The runner re-reads "<transcript>.size" on SIGUSR1, resizes the pty and forwards
  // SIGWINCH. Ink learns the new size from the pty, so this is the only honest way to
  // test it — and after a resize the emulator must be told the new grid too, or it would
  // be measuring the old screen.
  const resizeTo = async (cols, r) => {
    // Everything written before the resize was laid out for the OLD width, so replaying
    // it into the new grid would wrap wrongly. Start the replay here; screen() then
    // advances to Ink's repaint-on-SIGWINCH clear.
    replayFrom = refresh().length;
    writeFileSync(TRANSCRIPT + ".size", `${cols} ${r}\n`);
    child.kill("SIGUSR1");
    await new Promise((res) => setTimeout(res, 1500));
    size = { cols, rows: r };
    refresh();
  };

  for (const [cols, r] of [[120, 50], [80, 24]]) {
    await resizeTo(cols, r);
    // A RESIZE MUST RE-BUDGET THE ROWS. The old code read stdout.rows once at mount, so
    // growing the terminal left a dead band and shrinking it pushed the input out of
    // sight. useWindowSize() re-renders; this is the proof.
    ok(`${cols}x${r}: the footer is on the new bottom row`,
      FOOTER_RE.test(rows()[r - 1]),
      `footer on row ${footerRow()} of ${r}\n${rows().map((l, i) => `${i}|${l}`).join("\n")}`);
    ok(`${cols}x${r}: the input is still directly above it`,
      /answer the question above|reply to this session/.test(bottom(4)), bottom(4));
    // Even in a 24-row terminal the question must stay answerable — the product's one job.
    ok(`${cols}x${r}: the decision card survives`, /WAITING FOR YOU/.test(text()), text());
  }

  console.log("\nanswering from the resized screen\n");

  await type("1");
  await key("\r", 1500);
  ok("typing 1 clears the card (the reply reached the daemon)",
    !/WAITING FOR YOU/.test(text()), text());
  // The reclaimed card rows go back to the transcript, and the input stays put. (Don't
  // assert on ⏺ here: the visible tail is the middle of one long block, whose bullet is
  // legitimately scrolled off the top — that's what a bottom-anchored viewport does.)
  ok("the transcript reclaims the card's rows and the input stays put",
    /overflow line 59/.test(text()) && /reply to this session/.test(bottom(4)), bottom(6));

  console.log("\nthe QR in a terminal too short for it\n");

  // STILL AT 80x24. The QR is ~25 rows plus a border and a hint, so it CANNOT fit — and the
  // old budget handed out the rows anyway (`Math.max(3, totalRows - chromeRows)` returns 3
  // rather than admitting the deficit). The app then drew ~39 rows into 24, which makes Ink
  // clear and repaint the whole screen every frame: a permanently blinking TUI with its own
  // header scrolled out of reach. A hint line is the honest answer.
  {
    await key("\x12"); // ^R
    ok("it does not draw a QR that cannot fit", !/scan to pair/.test(text()), bottom(8));
    ok("it says WHY, in both dimensions",
      /pairing QR needs \d+ rows × \d+ cols/.test(text()) &&
      /this terminal is 24×80/.test(text()), rows().slice(0, 4).join("\n"));
    // PAIRING MUST STAY POSSIBLE. The QR is the only place the token is shown, and entering
    // the alternate screen cleared the scrollback, so without this there is no way to pair
    // from a short terminal at all.
    ok("…and offers the pairing URL, token and all",
      /token=/.test(text()) && !/token=\S{1,6}…/.test(text()), rows().slice(0, 4).join("\n"));
    // Same tell as the long input: rows the terminal doesn't have. Forced open here, the QR
    // pushed the footer off the bottom and 15 rows of the app off the top.
    ok("the footer is still on the bottom row", FOOTER_RE.test(rows()[24 - 1]),
      rows().map((l, i) => `${i}|${l}`).join("\n"));
    ok("the input is still above it", /reply to this session/.test(bottom(4)), bottom(4));
    ok("the › row is where it belongs", rowOf(/›/) === 24 - 3,
      `the › row is ${rowOf(/›/)} of 24`);
    await key("\x12"); // ^R off
  }

  console.log("\nthe import picker (docs/architecture.md)\n");

  // STILL AT 80x24 — the tightest screen this test uses, which is where a new view stealing
  // a chrome row shows up. A third view is exactly the kind of change that overflows the
  // budget, and overflow does not clip: it makes the whole screen strobe (PROBLEM 14f).
  {
    await key("\x1b[D");   // ← back to the fleet list first
    await key("\t");       // ⇥ opens the picker  (Tab, NOT ^I — same byte, and Ink says `tab`)
    await waitForScreen((t) => /import ·/.test(t));

    ok("⇥ opens the import picker", /import ·/.test(text()), bottom(6));
    ok("it counts what it found", /import · 3 conversations/.test(text()), rows().slice(0, 6).join("\n"));

    // A MIXED LIST IS THE WHOLE POINT OF THE SEAM: conversations from both engines, in one
    // list, sorted together. If this ever shows only one engine, the picker has quietly
    // become Claude-specific.
    ok("conversations from BOTH engines are listed",
      /claude/.test(text()) && /codex/.test(text()), text());
    ok("the engine that cannot list is not asked",
      !convRequests.some((r) => r.engine === "bare"), JSON.stringify(convRequests));
    // Every page, not just the first — the filter below searches what was loaded, so a
    // half-loaded list would make the filter silently miss things.
    ok("it walks the cursor to the LAST page",
      convRequests.some((r) => r.cursor === "page2"), JSON.stringify(convRequests));

    // THE SAFETY-CRITICAL COLUMN. Adopting adopts the conversation's working directory, and
    // the daemon auto-allows every tool — so the directory must be on the row, not hidden
    // behind a confirm dialog you might not read.
    ok("each row shows the DIRECTORY it would run in", /Loop-Eng/.test(text()), text());
    ok("a long path keeps its tail, which is the identifying part",
      /some-other-repo/.test(text()), text());

    // The overflow guard, at every step.
    ok("the footer is still on the bottom row", FOOTER_RE.test(rows()[24 - 1]),
      rows().map((l, i) => `${i}|${l}`).join("\n"));
    ok("the input is still directly above it", /filter conversations/.test(bottom(4)), bottom(5));
    ok("the footer advertises this view's OWN keys",
      /⏎ adopt/.test(rows()[24 - 1]) && /⇥ close/.test(rows()[24 - 1]), rows()[24 - 1]);

    // Typing FILTERS rather than starting a session — the view decides what text means
    // (PROBLEM 14a), and here it means "narrow this list".
    await type("codex");
    await waitForScreen((t) => /import · 1\/3/.test(t));
    ok("typing filters the list instead of composing a prompt",
      /import · 1\/3/.test(text()), rows().slice(0, 6).join("\n"));
    ok("…and the non-matching rows are gone", !/Fix the failing auth test/.test(text()), text());
    // The placeholder is GONE once text is typed, so the robust tell is the row the `›`
    // prompt sits on — the same one the rest of this file uses.
    ok("the footer and input have not moved while filtering",
      FOOTER_RE.test(rows()[24 - 1]) && promptRowOk(),
      `› is on row ${rowOf(/›/)}, footer on ${footerRow()}`);

    // ⏎ ARMS, IT DOES NOT ADOPT. Everywhere else ⏎ means go; here the first press only asks,
    // because the thing being confirmed is which directory an agent gets pointed at.
    await key("\r");
    ok("the first ⏎ did NOT adopt anything", adopts.length === 0, JSON.stringify(adopts));
    ok("…it asks, showing the directory", /⏎ again to confirm/.test(text()), bottom(4));
    ok("…and names the directory in the confirmation", /Loop-Eng/.test(bottom(3)), bottom(3));
    ok("the footer switches to CONFIRM so the two ⏎s don't read alike",
      /CONFIRM/.test(rows()[24 - 1]), rows()[24 - 1]);
    ok("the screen still fits while armed", FOOTER_RE.test(rows()[24 - 1]), rows()[24 - 1]);

    // ↑↓ cancels: moving off the armed row must disarm, or the confirm could land on a
    // different conversation than the one that was highlighted when you pressed ⏎.
    await key("\x1b[B"); // ↓ — with one match this is a no-op that still disarms
    ok("moving cancels the arm", !/⏎ again to confirm/.test(text()), bottom(4));
    ok("…and still nothing was adopted", adopts.length === 0, JSON.stringify(adopts));

    // Now actually do it: arm, then confirm.
    await key("\r");
    await key("\r");
    await waitForScreen((t) => /imported/.test(t));
    ok("the second ⏎ adopts", adopts.length === 1, JSON.stringify(adopts));
    ok("…the right conversation, on the right engine",
      adopts[0]?.ref === "conv-codex-1" && adopts[0]?.engine === "codex", JSON.stringify(adopts[0]));
    // Adoption drops you into the conversation — you imported it to read and continue it.
    ok("it opens the imported session", /⏎ reply/.test(rows()[24 - 1]), rows()[24 - 1]);
    ok("…and says replies write back into the original",
      /write back into the original/.test(text()), bottom(4));
    ok("the layout survives the adopt", FOOTER_RE.test(rows()[24 - 1]) && promptRowOk(),
      `› is on row ${rowOf(/›/)}, footer on ${footerRow()}`);

    // Re-opening marks it, so you can't create a second writer onto one transcript.
    await key("\x1b[D"); // ← to the list
    await key("\t");     // ⇥ picker again
    await waitForScreen((t) => /✓ imported/.test(t));
    ok("an already-imported conversation is marked", /✓ imported/.test(text()), text());
    await key("\t");     // ⇥ closes
    ok("⇥ closes the picker again", !/import ·/.test(text()), bottom(6));

    // Tab must not eat a half-written prompt — the same rule ←/→ follow.
    await type("half a prompt");
    await key("\t");
    ok("⇥ refuses to open while a prompt is half-typed", !/import ·/.test(text()), bottom(5));
    ok("…and says why, rather than reading as a dead key",
      /clear the prompt first/.test(text()), bottom(3));
    ok("…and the prompt text is untouched", /half a prompt/.test(text()), bottom(4));
  }

  console.log("\ncross-engine handoff\n");
  await key("\x0e"); // ^N clears the half-written prompt and returns to the fleet
  await key("\x1b[C"); // → reopen the selected imported session
  await waitForScreen((t) => /reply to this session/.test(t));
  ok("the session footer advertises handoff", /\^T handoff/.test(text()), bottom(2));
  const beforeHandoffs = handoffs.length;
  await key("\x14"); // ^T — arm only
  await waitForScreen((t) => /again to confirm/.test(t));
  ok("the first ^T asks for confirmation", /again to confirm/.test(text()), bottom(4));
  ok("the first ^T starts nothing", handoffs.length === beforeHandoffs, JSON.stringify(handoffs));
  await key("\x14"); // ^T — confirm
  ok("the second ^T reaches the handoff route",
    await waitFor(() => handoffs.length === beforeHandoffs + 1, 8000), JSON.stringify(handoffs));
  await waitForScreen((t) => /source session is still available/.test(t));
  ok("the TUI opens the target session", /source session is still available/.test(text()), bottom(5));
  const made = SESSIONS.find((s) => s.id === `hand${handoffs.length}`);
  ok("the target uses the other engine", made?.engine !== made?.handoffFrom?.engine, JSON.stringify(made));
} finally {
  try { child.stdin.write("\x03"); } catch {}
  await new Promise((r) => setTimeout(r, 800));
  cleanup();
}

console.log(`transcript: ${TRANSCRIPT}`);
console.log(`${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
