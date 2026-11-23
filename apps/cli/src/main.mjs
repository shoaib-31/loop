#!/usr/bin/env node
// `loop` — the front door. See docs/architecture.md.
//
// BARE `loop` DOES FOUR THINGS IN ONE COMMAND:
//   1. start (or attach to) the daemon
//   2. bring up `tailscale serve` — the DEFAULT exposure, tailnet-only
//   3. print the pairing QR
//   4. drop into the TUI
//
// Exposure is part of startup, NOT a subcommand: a QR pointing at a URL that
// doesn't resolve is worse than no QR, because it looks like it should work.
//
// Subcommands: serve (headless), share (escalate to Funnel, NON-STICKY),
// ls, doctor, stop, update.

import { render } from "ink";
import React from "react";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { homedir } from "node:os";
import {
  ensureDaemon, probeDaemon, stopDaemon, DEFAULT_PORT, paths, DAEMON_SUBCOMMAND, daemonEntry,
} from "./daemon-ctl.mjs";
import {
  ensureServe, enableFunnel, disableFunnel, currentMode, hostname,
  pairingUrl, qrLines, tailscaleAvailable, MODE_LABEL, stateDir, watchStateDir,
} from "./expose.mjs";
import { DaemonClient } from "./client.mjs";
import { Dashboard } from "./tui/dashboard.mjs";
import { ENABLE as MOUSE_ENABLE, DISABLE as MOUSE_DISABLE } from "./tui/mouse.mjs";
import { PASTE_ON, PASTE_OFF } from "./tui/text-input.mjs";
import { parseArgs } from "./args.mjs";

/** Where `loop update` fetches the installer from. Overridable for testing a fork. */
const REPO = process.env.LOOP_REPO ?? "shoaib-31/loop";

const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
};

/** The token, so the QR can carry it. Read from disk — the daemon owns generating it. */
async function readToken() {
  if (process.env.LOOP_NO_AUTH === "1") return null;
  if (process.env.LOOP_TOKEN) return process.env.LOOP_TOKEN;
  try {
    const dir = process.env.LOOP_ENG_DIR ?? join(homedir(), ".loop-eng");
    const t = (await readFile(join(dir, "token"), "utf8")).trim();
    return t || null;
  } catch {
    return null;
  }
}

const HELP = `
${c.bold("loop")} — run coding agents anywhere, decide from your phone

  ${c.bold("loop")}                       start/attach the daemon, expose it, print the QR, open the TUI
  ${c.bold("loop")} "<prompt>"            same, and immediately start a session with that prompt
  ${c.bold("loop serve")}                 daemon + exposure only, no TUI (headless)
  ${c.bold("loop share")}                 escalate to a PUBLIC Funnel URL (ends when you Ctrl+C)
  ${c.bold("loop ls")}                    list sessions
  ${c.bold("loop doctor")}                check prerequisites (engines, tailscale, port, push)
  ${c.bold("loop stop")}                  stop the daemon ${c.dim("(kills every hosted session)")}
  ${c.bold("loop update")}                update the binary

Flags
  --port <n>        daemon port (default ${DEFAULT_PORT})
  --engine <id>     agent engine: claude-code (default)
  --cwd <path>      working directory for new sessions (default: here)
  --no-expose       skip Tailscale; local only
  --funnel          expose PUBLICLY at startup instead of tailnet-only
`;

// ---- startup shared by bare `loop` and `loop serve` ----------------------

async function bringUp({ port, cwd, funnel = false, expose = true }) {
  const existing = await probeDaemon(port);
  const { started, health } = await ensureDaemon({ port, cwd });

  let mode = "local";
  if (expose) mode = funnel ? (await enableFunnel(port)).mode : await ensureServe(port);
  else mode = await currentMode();

  const token = await readToken();
  const url = await pairingUrl({ port, token, mode });
  return { started, adopted: !!existing, health, mode, url, token };
}

function printBanner({ started, adopted, mode, url, health, port }) {
  console.log("");
  console.log(
    `  ${c.cyan(c.bold("loop"))}  ${c.dim(
      adopted ? `attached to the daemon on :${port}` : `daemon started on :${port}`
    )}`
  );
  const label = MODE_LABEL[mode] ?? "LOCAL";
  const color = mode === "funnel" ? c.yellow : mode === "serve" ? c.green : c.dim;
  console.log(`  exposure: ${color(label)}  ${c.dim(url)}`);
  if (mode === "funnel")
    console.log(c.yellow("  ⚠ PUBLIC internet. The token is the only guard. Ends when this process exits."));
  if (mode === "local")
    console.log(c.dim("  (no Tailscale exposure — your phone can't reach this yet)"));
  const subs = health?.push?.subscriptions;
  if (subs === 0) console.log(c.dim("  no phone paired yet — scan the QR below"));
  else if (subs > 0) console.log(c.dim(`  push: ${subs} device(s) subscribed`));
  console.log("");
}

// ---- commands ------------------------------------------------------------

async function cmdDefault(args) {
  const port = Number(args.flags.port ?? DEFAULT_PORT);
  const cwd = args.flags.cwd ? String(args.flags.cwd) : process.cwd();
  const engine = String(args.flags.engine ?? "claude-code");
  const prompt = args._.join(" ").trim();

  const up = await bringUp({
    port,
    cwd,
    funnel: !!args.flags.funnel,
    expose: !args.flags["no-expose"],
  });

  const client = new DaemonClient({ port, token: up.token });

  // Fail early and clearly if the chosen engine can't run — better than a spawn
  // error three seconds into what looked like a working session.
  try {
    const { engines } = await client.engines();
    const e = engines.find((x) => x.id === engine);
    if (!e) {
      console.error(c.red(`unknown engine "${engine}". available: ${engines.map((x) => x.id).join(", ")}`));
      process.exit(1);
    }
    if (!e.available) {
      console.error(c.red(`engine "${engine}" is not available: ${e.reason}`));
      process.exit(1);
    }
  } catch { /* older daemon without /engines — carry on */ }

  const qr = await qrLines(up.url);
  let launchedRun = false;
  if (prompt) {
    launchedRun = await client.createSession({ prompt, cwd, engine }).then(() => true).catch((e) => {
      console.error(c.red(`could not start session: ${e.message}`));
      return false;
    });
  }

  // The header's exposure badge is a SAFETY signal (is this box on the public internet?),
  // and exposure changes behind our back — another `loop` exiting runs `tailscale serve
  // reset`, `tailscale down` drops everything, a `loop share` elsewhere flips it to
  // PUBLIC. So the TUI re-asks instead of trusting the startup snapshot forever.
  //
  // LOOP_EXPOSURE_PROBE_URL is a TEST SEAM: the live answer comes from `tailscale serve
  // status`, which a test can't move, so layout-test.mjs points this at its stub daemon
  // and flips the mode there. Unset in normal use, which is the only path that matters.
  const probeUrl = process.env.LOOP_EXPOSURE_PROBE_URL;
  const onProbeMode = async () => {
    const m = probeUrl
      ? (await (await fetch(probeUrl, { signal: AbortSignal.timeout(2000) })).json()).mode
      : await currentMode();
    return { mode: m, url: await pairingUrl({ port, token: up.token, mode: m }) };
  };

  // …AND PUSH, so it doesn't have to re-ask on a timer. Tailscale has no event for a
  // serve/funnel change (measured — see expose.mjs), but it does touch its state directory
  // when one happens, so a watch there turns "ask every 5 seconds" into "ask when something
  // moved". The poll stays as a slow backstop; this is the fast path, not the only path.
  //
  // LOOP_EXPOSURE_WATCH_DIR is the test seam, for the same reason the probe has one: a test
  // can't move the real Tailscale, but it can touch a temp directory.
  const watchDir = process.env.LOOP_EXPOSURE_WATCH_DIR ?? (await stateDir());
  const onWatchExposure = (cb) => watchStateDir(watchDir, cb);

  const onExpose = async (mode) => {
    // ^E toggles between tailnet and public. Same URL either way (PROBLEM 11), so
    // the install and push subscription survive the switch.
    if (mode === "funnel") {
      const r = await disableFunnel(port);
      return { mode: r.mode, url: await pairingUrl({ port, token: up.token, mode: r.mode }) };
    }
    const r = await enableFunnel(port);
    return {
      mode: r.mode,
      url: await pairingUrl({ port, token: up.token, mode: r.mode }),
      error: r.ok ? null : r.error,
    };
  };

  // ENTER THE ALTERNATE SCREEN OURSELVES — CLEARED, WITH THE CURSOR HOMED.
  //
  // Ink writes `ESC[?1049h` and nothing more (ink.js `setAlternateScreen`): it does not
  // clear the page or home the cursor. A real terminal swaps the CONTENTS on that switch
  // but KEEPS the cursor row, and by the time `loop` runs the shell has normally scrolled
  // to the bottom (a prompt, plus whatever the last command printed). So Ink begins
  // drawing at row N of a 24-row screen, the frame's last rows run past the bottom edge,
  // and the terminal scrolls to make room — pushing the app's own header off the top.
  // tmux keeps alt-screen scroll history, so those pushed rows are exactly what you can
  // scroll back to. MEASURED: cursor at row 20 => 20 rows pushed off.
  //
  // The row budget was never wrong; the app was simply drawing from the wrong origin.
  // 2J clears the page, 3J drops the scrollback that clear orphans (the part that stops
  // the back-scroll), and H homes the cursor so the frame's row 0 is the screen's row 0.
  // Ink's own later full repaints already emit this same sequence — this just makes the
  // FIRST frame agree with them.
  //
  // Ink is idempotent about `?1049h`, and it still owns the exit path (it writes
  // `?1049l` on unmount), so entering early costs nothing and leaves teardown alone.
  if (process.stdout.isTTY) process.stdout.write("\x1b[?1049h\x1b[2J\x1b[3J\x1b[H");

  // TWO THINGS THE TERMINAL ONLY DOES IF ASKED.
  //
  // 1. REPORT THE MOUSE, so the wheel scrolls the transcript and a click opens a tool step.
  //    Taking the terminal's scrollback away (the line above) left the wheel doing nothing
  //    at all, and the wheel is what a hand reaches for. The parsing side — and why
  //    enabling without parsing types escape sequences into the prompt — is tui/mouse.mjs.
  //
  // 2. BRACKET PASTES, so ⌘V works. Without it a pasted newline is indistinguishable from
  //    ⏎ (so pasting two lines SENDS the first), and Ghostty's paste protection refuses the
  //    paste outright — which is why ⌘V appeared to do nothing at all. See tui/text-input.mjs.
  //
  // Teardown is OURS because Ink doesn't know we did either: `?1049l` restoring the screen
  // turns off neither. Without it the shell inherits a terminal that reports the wheel and
  // wraps every paste in `ESC[200~`, so both a normal-exit write and the signal handlers.
  if (process.stdout.isTTY) {
    process.stdout.write(MOUSE_ENABLE + PASTE_ON);
    const restore = () => { try { process.stdout.write(MOUSE_DISABLE + PASTE_OFF); } catch {} };
    process.on("exit", restore);
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"])
      process.on(sig, () => { restore(); process.exit(0); });
  }

  const { waitUntilExit } = render(
    React.createElement(Dashboard, {
      client,
      initialUrl: up.url,
      initialMode: up.mode,
      qr,
      cwd,
      engine,
      onExpose,
      onProbeMode,
      onWatchExposure,
      // `loop "<prompt>"` = "run this now", so land inside that run rather than on a
      // fleet list whose only row is the thing you just asked for.
      initialView: launchedRun ? "session" : "list",
    }),
    // FULLSCREEN. The dashboard is a workspace, not a log: the sessions list should
    // own every spare row and the input should sit at the bottom edge, which only
    // works if we own the whole screen. The alternate screen buffer also means
    // detaching (^C) restores the shell exactly as it was, with no wall of frames
    // left in the scrollback.
    //
    // Ink disables this itself on a non-TTY, so piping `loop` still behaves.
    // The cost is that scrollback doesn't apply inside the app (same as vim/htop) —
    // which is why the transcript scrolls itself with PgUp/PgDn.
    //
    // `incrementalRendering` IS THE FIX FOR THE TYPING FLICKER, and it defaults to FALSE.
    // Ink ships two frame writers (node_modules/ink/build/log-update.js):
    //   createStandard    — `eraseLines(previousLineCount) + wholeFrame`, i.e. blank all 40
    //                       rows and redraw all 40, on EVERY render. That's what a keystroke
    //                       cost, and the blank moment in between is the blink.
    //   createIncremental — walks the lines and skips the ones whose contents are unchanged.
    //                       Its own comment: "This prevents flickering during renders."
    // Typing changes exactly one row (the input), so this turns a whole-screen repaint per
    // keystroke into a one-row write. Nothing about our tree was wrong; we were on the wrong
    // writer, and the default hid it.
    { alternateScreen: true, incrementalRendering: true }
  );
  await waitUntilExit();
  console.log(c.dim("\ndetached — sessions keep running in the daemon. `loop` to come back.\n"));
}

async function cmdServe(args) {
  const port = Number(args.flags.port ?? DEFAULT_PORT);
  const cwd = args.flags.cwd ? String(args.flags.cwd) : process.cwd();
  const up = await bringUp({
    port, cwd,
    funnel: !!args.flags.funnel,
    expose: !args.flags["no-expose"],
  });
  printBanner({ ...up, port });
  const qr = await qrLines(up.url);
  if (qr) console.log(qr.join("\n") + "\n");
  console.log(c.dim(`  logs: ${paths.LOG_FILE}`));
  console.log(c.dim("  headless — the daemon keeps running after this exits.\n"));
}

async function cmdShare(args) {
  const port = Number(args.flags.port ?? DEFAULT_PORT);
  const health = await probeDaemon(port);
  if (!health) {
    console.error(c.red(`no daemon on :${port}. Start one with \`loop\` or \`loop serve\`.`));
    process.exit(1);
  }
  const r = await enableFunnel(port);
  if (!r.ok) {
    console.error(c.red(`could not enable Funnel: ${r.error}`));
    process.exit(1);
  }
  const token = await readToken();
  const url = await pairingUrl({ port, token });
  console.log("");
  console.log(`  exposure: ${c.yellow("PUBLIC")}  ${url}`);
  const qr = await qrLines(url);
  if (qr) console.log("\n" + qr.join("\n"));
  console.log(c.yellow("\n  ⚠ This is the public internet. The token is the only guard."));
  // NON-STICKY (PROBLEM 12): staying up after the terminal closes is how a machine
  // ends up exposed for days. Hold the process so teardown is guaranteed.
  console.log(c.dim("  Ctrl+C to stop sharing (drops back to tailnet-only).\n"));
  await new Promise(() => {});
}

async function cmdLs(args) {
  const port = Number(args.flags.port ?? DEFAULT_PORT);
  const health = await probeDaemon(port);
  if (!health) { console.log(c.dim(`no daemon on :${port}`)); return; }
  const client = new DaemonClient({ port, token: await readToken() });
  const sessions = await client.sessions();
  if (!sessions.length) { console.log(c.dim("no sessions")); return; }
  console.log("");
  for (const s of sessions) {
    const dot = s.pending ? c.yellow("●") : s.status === "error" ? c.red("○") : c.dim("○");
    const state = s.pending ? c.yellow("needs a decision") : s.status;
    console.log(`  ${dot} ${c.bold(s.id.slice(0, 8))}  ${(s.projectName ?? "").padEnd(16)} ${state}`);
    if (s.preview) console.log(`    ${c.dim(s.preview.slice(0, 76))}`);
  }
  console.log("");
}

async function cmdDoctor(args) {
  const port = Number(args.flags.port ?? DEFAULT_PORT);
  const rows = [];
  const ok = (n, v, d = "") => rows.push([true, n, v, d]);
  const bad = (n, v, d = "") => rows.push([false, n, v, d]);

  // WHICH claude, not just which version. The SDK spawns its OWN bundled native CLI,
  // not the one on your PATH, and those are different builds (measured: 2.1.226 vs
  // 2.1.235). Reporting a version without saying which binary produced it is how you
  // end up debugging a version you were never running.
  const engineDetail = (e, def) =>
    [e.id === def ? "(default)" : "", e.source === "sdk-bundled" ? "SDK-bundled CLI" : e.source === "path" ? "from PATH" : "", e.warning ?? ""]
      .filter(Boolean)
      .join(" · ");

  // engines — the pluggability check (PROBLEM 13)
  const health = await probeDaemon(port);
  if (health) {
    const client = new DaemonClient({ port, token: await readToken() });
    try {
      const { engines, default: def } = await client.engines();
      for (const e of engines)
        e.available
          ? ok(`engine ${e.id}`, e.version ?? "available", engineDetail(e, def))
          : bad(`engine ${e.id}`, "unavailable", e.reason ?? "");
    } catch { bad("engines", "daemon has no /engines endpoint"); }
  } else {
    // Probe the engine directly when there's no daemon to ask.
    const { probeEngines } = await import(
      new URL("../../../services/orchestrator/daemon/engines/engine.mjs", import.meta.url)
    ).catch(() => ({ probeEngines: null }));
    if (probeEngines) {
      for (const e of await probeEngines())
        e.available
          ? ok(`engine ${e.id}`, e.version ?? "available", engineDetail(e, null))
          : bad(`engine ${e.id}`, e.reason ?? "unavailable");
    }
  }

  health ? ok("daemon", `running on :${port}`) : bad("daemon", `not running on :${port}`, "start with `loop`");
  if (health?.auth) {
    health.auth.enabled
      ? ok("auth", "enabled", "token in ~/.loop-eng/token")
      : bad("auth", "DISABLED", "LOOP_NO_AUTH=1 — never expose this over Funnel");
  }
  if (health?.push) {
    health.push.enabled
      ? ok("push", `${health.push.subscriptions} subscription(s)`, health.push.subscriptions === 0 ? "scan the QR to pair" : "")
      : bad("push", "not initialised");
  }

  const tsAvail = await tailscaleAvailable();
  if (tsAvail.available) {
    ok("tailscale", tsAvail.version.split(" ")[0]);
    const hn = await hostname();
    hn ? ok("tailscale host", hn) : bad("tailscale host", "no DNSName", "is tailscale logged in?");
    const mode = await currentMode();
    mode === "local"
      ? bad("exposure", "LOCAL", "your phone can't reach the daemon; `loop` sets up serve")
      : ok("exposure", MODE_LABEL[mode]);
  } else {
    bad("tailscale", tsAvail.reason, "push needs HTTPS — a LAN address can never notify");
  }

  const token = await readToken();
  token ? ok("token", "present") : bad("token", "missing", "the daemon generates one on first run");

  console.log("");
  for (const [good, name, value, detail] of rows) {
    console.log(
      `  ${good ? c.green("✓") : c.red("✗")} ${name.padEnd(18)} ${String(value).padEnd(28)} ${c.dim(detail)}`
    );
  }
  const fails = rows.filter(([g]) => !g).length;
  console.log("");
  console.log(fails === 0 ? c.green("  all checks passed\n") : c.yellow(`  ${fails} issue(s) above\n`));
  process.exit(fails === 0 ? 0 : 1);
}

async function cmdStop() {
  const r = await stopDaemon();
  if (r.stopped) console.log(c.dim(`stopped daemon (pid ${r.pid}) — every hosted session ended.`));
  else console.log(c.dim(`not stopped: ${r.reason}`));
}

/**
 * Update in place (docs/architecture.md + 18).
 *
 * Deliberately just re-runs the installer rather than reimplementing download, version
 * resolution, platform detection and symlink swapping a second time in a second language.
 * The installer already writes `versions/<tag>/loop` + a symlink, and it is the thing
 * that gets exercised by every new user — a bespoke update path would be the code that
 * only ever runs on machines that already work.
 *
 * Running from source is detected and refused with the honest answer, because `git pull`
 * is what actually updates a source checkout and silently doing nothing would look like
 * a successful update.
 */
async function cmdUpdate() {
  const fromSource = existsSync(daemonEntry());
  if (fromSource) {
    console.log(c.dim("\n  This `loop` is running from a source checkout, not an installed binary."));
    console.log(c.dim("  Update it with:  git pull  (then `bun apps/cli/build.mjs` if you want the binary)\n"));
    return;
  }

  const url = process.env.LOOP_INSTALL_URL ?? `https://raw.githubusercontent.com/${REPO}/main/install.sh`;
  console.log(c.dim(`\n  re-running the installer from ${url}\n`));
  // DOWNLOAD, THEN RUN — not `curl … | sh`. A pipeline's exit status is the LAST
  // command's, so a failed download still reported success and printed "sessions kept
  // running" as though it had updated. `set -e` plus a temp file makes a broken fetch a
  // non-zero exit. (`pipefail` isn't portable to every /bin/sh.)
  //
  // `loop stop` is deliberately NOT called: an update must not kill hosted sessions. The
  // running daemon keeps serving from the old binary until it is restarted.
  const script =
    'set -e; t=$(mktemp); trap \'rm -f "$t"\' EXIT; ' +
    `curl -fsSL ${JSON.stringify(url)} -o "$t"; sh "$t"`;
  const r = spawnSync("/bin/sh", ["-c", script], { stdio: "inherit" });
  if (r.status !== 0) {
    console.error(c.red("\n  update failed. Install by hand:"));
    console.error(c.dim(`    curl -fsSL ${url} | sh\n`));
    process.exit(1);
  }
  console.log(c.dim("  Sessions kept running. `loop stop && loop` to restart the daemon on the new build.\n"));
}

// ---- dispatch ------------------------------------------------------------

const argv = process.argv.slice(2);

// BE THE DAEMON (docs/architecture.md). A released `loop` is one compiled binary with
// no `server.mjs` on disk, so `daemon-ctl` starts a daemon by re-invoking this executable
// with this argument. Handled before argument parsing and before any other import runs,
// because at this point the process is not a CLI at all.
//
// Undocumented in --help on purpose: nobody should type it. The dynamic import keeps the
// agent SDK — and the seconds of module loading it costs — off every ordinary `loop`
// invocation, while still being a static specifier the bundler can follow into the binary.
if (argv[0] === DAEMON_SUBCOMMAND) {
  const { main: runDaemon } = await import("../../../services/orchestrator/daemon/server.mjs");
  await runDaemon();
} else {

const args = parseArgs(argv);
const sub = args._[0];

const COMMANDS = {
  serve: cmdServe,
  share: cmdShare,
  ls: cmdLs,
  list: cmdLs,
  doctor: cmdDoctor,
  stop: cmdStop,
  update: cmdUpdate,
};

try {
  if (args.flags.help || args.flags.h || sub === "help") {
    console.log(HELP);
  } else if (sub && COMMANDS[sub]) {
    args._.shift();
    await COMMANDS[sub](args);
  } else {
    // Anything else is a prompt for a new session — `loop "fix the tests"`.
    await cmdDefault(args);
  }
} catch (e) {
  console.error(c.red(`\n${e?.message ?? e}\n`));
  process.exit(1);
}

} // end of the non-__daemon path
