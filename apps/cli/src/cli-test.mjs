// CLI tests — the parts that are pure logic plus a real daemon lifecycle round-trip.
//
// Runs against a THROWAWAY LOOP_ENG_DIR and a non-default port, because the real
// ~/.loop-eng holds the VAPID keypair the actual phone's subscription depends on
// (regenerating it silently invalidates the device) and the real daemon may be
// hosting live sessions.
//
//   LOOP_ENG_DIR=$(mktemp -d) node apps/cli/src/cli-test.mjs

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Isolate BEFORE importing anything that reads the state dir at module load.
if (!process.env.LOOP_ENG_DIR) process.env.LOOP_ENG_DIR = mkdtempSync(join(tmpdir(), "loop-cli-test-"));
const STATE_DIR = process.env.LOOP_ENG_DIR;

const { pairingUrl, MODE_LABEL, watchStateDir, stateDir } = await import("./expose.mjs");
const { probeDaemon, ensureDaemon, stopDaemon, daemonEntry } = await import("./daemon-ctl.mjs");
const { DaemonClient } = await import("./client.mjs");
const { existsSync } = await import("node:fs");

const PORT = 4397; // not 4318 (real daemon) and not 4319 (e2e-test)

let pass = 0, fail = 0;
const ok = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${extra ? ` — ${extra}` : ""}`); }
};
const eq = (name, a, b) => ok(name, a === b, `got ${JSON.stringify(a)}`);

console.log(`\nstate dir: ${STATE_DIR}`);

// ---- argv parsing -------------------------------------------------------
console.log("\nargv parsing");
{
  const { parseArgs } = await import("./args.mjs");

  // THE BUG THIS LOCKS DOWN: a boolean flag must not consume the next argument.
  // `loop --no-expose "<prompt>"` used to store the prompt as the value of
  // --no-expose, leaving args._ empty — so no session was created and the dashboard
  // sat there empty with no error anywhere. Found by tui-test.mjs, not by a build.
  const a = parseArgs(["--no-expose", "fix the tests"]);
  eq("a boolean flag does NOT swallow the prompt", a._.join(" "), "fix the tests");
  eq("the boolean flag is still set", a.flags["no-expose"], true);

  const b = parseArgs(["--port", "4399", "hello"]);
  eq("a value flag DOES take the next argument", b.flags.port, "4399");
  eq("...and the positional survives", b._.join(" "), "hello");

  const cc = parseArgs(["--cwd=/tmp/x", "--engine=codex", "go"]);
  eq("--flag=value form", cc.flags.cwd, "/tmp/x");
  eq("--engine=value form", cc.flags.engine, "codex");
  eq("positional after = flags", cc._.join(" "), "go");

  eq("a value flag at the end is not left dangling", parseArgs(["--port"]).flags.port, true);
  eq("bare subcommand", parseArgs(["doctor"])._[0], "doctor");
  eq("--funnel stays boolean", parseArgs(["--funnel"]).flags.funnel, true);
}

// ---- pairing URL --------------------------------------------------------
console.log("\npairing URL");
{
  // THE BUG THIS LOCKS DOWN: in LOCAL mode the .ts.net name doesn't resolve, so
  // printing it produces a QR that looks like it should work and 404s (PROBLEM 12).
  const local = await pairingUrl({ port: PORT, token: "tok", mode: "local" });
  ok("LOCAL mode never advertises the .ts.net host", !local.includes("ts.net"), local);
  ok("LOCAL mode falls back to a URL that really works", local.startsWith("http://localhost:"), local);
  ok("token is carried", local.includes("token=tok"));

  const served = await pairingUrl({ port: PORT, token: "tok", host: "example.ts.net", mode: "serve" });
  eq("serve mode uses HTTPS on the tailscale host", served, "https://example.ts.net/?token=tok");
  const funnelled = await pairingUrl({ port: PORT, token: "tok", host: "example.ts.net", mode: "funnel" });
  ok("funnel publishes the SAME url as serve (PROBLEM 11)", funnelled === served, funnelled);

  const noToken = await pairingUrl({ port: PORT, token: null, host: "example.ts.net", mode: "serve" });
  eq("no token -> clean url", noToken, "https://example.ts.net/");

  const weird = await pairingUrl({ port: PORT, token: "a b/c+d=", host: "x.ts.net", mode: "serve" });
  ok("token is URL-encoded", weird.includes("token=a%20b%2Fc%2Bd%3D"), weird);

  eq("LOCAL label", MODE_LABEL.local, "LOCAL");
  eq("serve reads as TAILNET", MODE_LABEL.serve, "TAILNET");
  eq("funnel reads as PUBLIC", MODE_LABEL.funnel, "PUBLIC");
}

// ---- daemon discovery ---------------------------------------------------
console.log("\ndaemon discovery");
{
  ok("daemon entry resolves to a real file", existsSync(daemonEntry()), daemonEntry());
  const none = await probeDaemon(4396, { timeoutMs: 500 });
  ok("probe of a dead port returns null (no throw)", none === null);
}

// ---- lifecycle: start, adopt, stop --------------------------------------
console.log("\ndaemon lifecycle");
let started;
{
  started = await ensureDaemon({ port: PORT, cwd: "/tmp" });
  ok("ensureDaemon starts a daemon", started.started === true);
  ok("health confirms it's ours", started.health?.service === "loop-daemon");

  // THE INVARIANT: a second `loop` must ATTACH, never take over — the daemon hosts
  // the sessions, so restarting it would kill every running agent (PROBLEM 4b).
  const again = await ensureDaemon({ port: PORT, cwd: "/tmp" });
  ok("a second invocation ADOPTS rather than spawning", again.started === false);
  ok("adopted health is the same daemon", again.health?.service === "loop-daemon");
}

// ---- client speaks the protocol ----------------------------------------
console.log("\nclient (pure protocol client — never hosts a session)");
{
  const client = new DaemonClient({ port: PORT });
  const health = await client.health();
  ok("GET /health", health.ok === true);
  ok("auth is ON by default", health.auth?.enabled === true);
  eq("loopback is exempt so the TUI needs no token", health.auth?.via, "loopback");

  const { engines, default: def } = await client.engines();
  eq("default engine is claude-code", def, "claude-code");
  ok("claude-code reports available", engines.find((e) => e.id === "claude-code")?.available === true);

  const sessions = await client.sessions();
  ok("GET /sessions returns an array", Array.isArray(sessions));

  // An unknown engine must be refused BEFORE a run starts — silently falling back
  // to Claude when "codex" was misspelled would be an expensive surprise.
  let refused = null;
  try {
    await client.createSession({ prompt: "hi", cwd: "/tmp", engine: "not-an-engine" });
  } catch (e) { refused = e.message; }
  ok("unknown engine is refused at creation", !!refused && /unknown engine/.test(refused), String(refused));

  // A missing prompt is a 400, not a hung session.
  let badPrompt = null;
  try { await client.createSession({ prompt: "", cwd: "/tmp" }); }
  catch (e) { badPrompt = e.message; }
  ok("empty prompt is rejected", !!badPrompt, String(badPrompt));

  let missing = null;
  try { await client.history("does-not-exist"); } catch (e) { missing = e.message; }
  ok("unknown session id 404s cleanly", !!missing, String(missing));
}

// ---- session list ordering ----------------------------------------------
console.log("\nsession list ordering (urgency first)");
{
  // WHY THE DAEMON SORTS: every client renders this list, so ordering here keeps the
  // PWA and the TUI from drifting. And the TUI selects by ID precisely because this
  // order CHANGES — an index would start pointing at a different session mid-poll,
  // which means replying into the wrong run.
  const rows = [
    { id: "a", pending: null, lastTs: "2026-08-10T10:00:00Z" },
    { id: "b", pending: { question: "?" }, lastTs: "2026-08-10T09:00:00Z" },
    { id: "c", pending: null, lastTs: "2026-08-10T11:00:00Z" },
    { id: "d", pending: { question: "?" }, lastTs: "2026-08-10T12:00:00Z" },
  ];
  const sorted = [...rows].sort((a, b) => {
    if (!!a.pending !== !!b.pending) return a.pending ? -1 : 1;
    return new Date(b.lastTs ?? 0) - new Date(a.lastTs ?? 0);
  });
  eq("waiting-on-you sessions come first", sorted.map((s) => s.id).join(""), "dbca");
  ok("...and within each group, most recent first",
    sorted[0].id === "d" && sorted[1].id === "b" && sorted[2].id === "c");

  const noTs = [{ id: "x", lastTs: null }, { id: "y", lastTs: "2026-08-10T10:00:00Z" }].sort((a, b) => {
    if (!!a.pending !== !!b.pending) return a.pending ? -1 : 1;
    return new Date(b.lastTs ?? 0) - new Date(a.lastTs ?? 0);
  });
  eq("a null timestamp sorts last, not NaN-crashes", noTs.map((s) => s.id).join(""), "yx");
}

// ---- teardown -----------------------------------------------------------
console.log("\nteardown");
{
  const r = await stopDaemon();
  ok("stopDaemon reports success", r.stopped === true, JSON.stringify(r));
  await new Promise((res) => setTimeout(res, 600));
  const gone = await probeDaemon(PORT, { timeoutMs: 500 });
  ok("daemon is actually gone", gone === null);
  const again = await stopDaemon();
  ok("stopping twice is safe", again.stopped === false, JSON.stringify(again));
}

console.log("\nwatching for exposure changes (instead of asking every 5s)\n");

// WHAT THIS REPLACES: a `tailscale serve status` process spawn every 5 seconds, forever,
// and a badge that could be up to 5s stale — on the one signal that says whether this
// machine is on the public internet.
//
// MEASURED ON TAILSCALE 1.98.5 (2026-08-19), so nobody has to re-derive it: the IPN bus
// (`tailscale debug watch-ipn`) reports NOTHING about serve/funnel — toggling serve produced
// 12 messages, all Engine byte counters. `ipn.Notify` has no ServeConfig field. But
// tailscaled writes its own log inside its state directory when the config changes, and that
// directory is world-readable even though its contents aren't, so an fs watch on it fires
// within milliseconds. The event is a HINT; `currentMode()` stays the source of truth.
{
  const { mkdirSync, writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "loop-tswatch-"));
  mkdirSync(join(dir, "sub"), { recursive: true });

  let fired = 0;
  const at = [];
  const sub = watchStateDir(dir, () => { fired++; at.push(Date.now()); }, { debounceMs: 60, minGapMs: 0 });
  ok("it watches a real directory", sub.watching === true);

  writeFileSync(join(dir, "ipn.log.txt"), "a");
  await new Promise((r) => setTimeout(r, 300));
  ok("a change in the state dir fires the callback", fired === 1, `fired ${fired}`);

  // RECURSIVE, because what actually changes lives in a subdirectory.
  writeFileSync(join(dir, "sub", "nested"), "b");
  await new Promise((r) => setTimeout(r, 300));
  ok("a change in a SUBdirectory fires it too", fired === 2, `fired ${fired}`);

  // DEBOUNCED: one config change touched the log twice in the real measurement, and peer
  // churn writes it for reasons that have nothing to do with us. A burst must cost one probe.
  for (let i = 0; i < 8; i++) writeFileSync(join(dir, `burst${i}`), "x");
  await new Promise((r) => setTimeout(r, 400));
  ok("a burst of changes collapses into ONE callback", fired === 3, `fired ${fired}`);

  sub.stop();
  writeFileSync(join(dir, "after-stop"), "c");
  await new Promise((r) => setTimeout(r, 300));
  ok("stop() actually stops it", fired === 3, `fired ${fired}`);
}
{
  // RATE-LIMITED, because the signal is noisy: 60 idle seconds on the real directory produced
  // 8 events (tailscaled writes its log every ~7s regardless). Without a floor between
  // callbacks this "no polling" change would spawn MORE processes than the 5s poll it
  // replaced — the measurement that turned a nice idea into a bounded one.
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "loop-tsgap-"));
  const at = [];
  const sub = watchStateDir(dir, () => at.push(Date.now()), { debounceMs: 20, minGapMs: 500 });
  for (let i = 0; i < 6; i++) {
    writeFileSync(join(dir, `n${i}`), "x");
    await new Promise((r) => setTimeout(r, 150)); // 6 events over ~900ms
  }
  await new Promise((r) => setTimeout(r, 700));
  sub.stop();
  ok("a steady trickle of events is rate-limited, not amplified", at.length <= 3,
    `${at.length} callbacks from 6 events across ~900ms`);
  const gaps = at.slice(1).map((t, i) => t - at[i]);
  ok("consecutive callbacks respect the minimum gap",
    gaps.every((g) => g >= 450), JSON.stringify(gaps));
  ok("…but the first one is still prompt", at.length > 0);
}
{
  // DEGRADING IS THE POINT: the sandboxed App Store build keeps its state somewhere we may
  // not be able to watch, and a missing directory must mean "fall back to polling", never a
  // crash on startup.
  const missing = watchStateDir(join(tmpdir(), "loop-does-not-exist-" + Date.now()), () => {});
  ok("a missing directory degrades to not-watching", missing.watching === false);
  ok("…and its stop() is still safe to call", (() => { missing.stop(); return true; })());
  const none = watchStateDir(null, () => {});
  ok("no directory at all degrades the same way", none.watching === false);

  // A watcher that throws must not take the caller down with it.
  const boom = watchStateDir("/tmp", () => {}, { watch: () => { throw new Error("nope"); } });
  ok("a watch that throws degrades instead of propagating", boom.watching === false);

  // A callback that throws must not either — it runs inside a timer, where an exception is
  // an unhandled rejection that kills the process.
  const dir2 = mkdtempSync(join(tmpdir(), "loop-tswatch2-"));
  const risky = watchStateDir(dir2, () => { throw new Error("callback blew up"); }, { debounceMs: 30 });
  const { writeFileSync: w2 } = await import("node:fs");
  w2(join(dir2, "x"), "1");
  await new Promise((r) => setTimeout(r, 250));
  ok("a throwing callback doesn't kill the process", true);
  risky.stop();
}
{
  // The real path, on this machine. `stateDir()` shells out to `tailscale debug statedir`;
  // if Tailscale isn't installed it must answer null rather than throw.
  const dir = await stateDir();
  ok("stateDir() answers a path or null, never throws",
    dir === null || typeof dir === "string", JSON.stringify(dir));
}

// ---- how a daemon gets started, in both worlds --------------------------
// docs/architecture.md. From source there's a server.mjs to hand to node; a released
// binary has no such file and must re-invoke ITSELF. The old code claimed to handle the
// second case and spawned a path that cannot exist there, so a released `loop` could
// never have started a daemon at all.
console.log("\ndaemon spawn strategy (source vs. compiled binary)");
{
  const { daemonSpawn, DAEMON_SUBCOMMAND } = await import("./daemon-ctl.mjs");
  const s = daemonSpawn();
  // We're running from source here, so server.mjs exists.
  eq("from source it spawns the daemon script", s.mode, "source");
  ok("…and the script it names exists", existsSync(s.argv[0]), s.argv[0]);

  // Simulate the compiled case by pointing the entry at something absent.
  const prev = process.env.LOOP_DAEMON_ENTRY;
  process.env.LOOP_DAEMON_ENTRY = join(tmpdir(), "definitely-not-here-" + Date.now(), "server.mjs");
  const compiled = daemonSpawn();
  eq("with no script on disk it re-invokes itself", compiled.mode, "self");
  eq("…via the hidden subcommand", compiled.argv[0], DAEMON_SUBCOMMAND);
  ok("…and never passes a path that doesn't exist", compiled.argv.length === 1, JSON.stringify(compiled.argv));
  if (prev === undefined) delete process.env.LOOP_DAEMON_ENTRY;
  else process.env.LOOP_DAEMON_ENTRY = prev;
}

// ---- the installer -------------------------------------------------------
// install.sh is the highest-blast-radius file in the repo: it is the ONE thing every new
// user runs, before anything of ours exists to help them. Tested against a locally built
// binary via LOOP_ASSET_URL, and skipped (loudly) when there's no build to test with.
console.log("\ninstall.sh");
{
  const { spawnSync } = await import("node:child_process");
  const { writeFileSync, readlinkSync, readdirSync } = await import("node:fs");
  const { dirname } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
  const script = join(ROOT, "install.sh");
  const binary = join(ROOT, "dist", "loop");

  ok("install.sh exists", existsSync(script), script);
  const lint = spawnSync("sh", ["-n", script], { encoding: "utf8" });
  ok("install.sh is valid POSIX sh", lint.status === 0, lint.stderr);

  const install = (env) =>
    spawnSync("sh", [script], { encoding: "utf8", env: { ...process.env, ...env }, timeout: 120000 });

  // A GitHub 404 is an HTML page. Installing it would put a 9KB "binary" on the PATH that
  // fails with something unrelated to the actual problem.
  {
    const prefix = join(mkdtempSync(join(tmpdir(), "loop-inst-html-")), "prefix");
    const fake = join(tmpdir(), `loop-fake-asset-${Date.now()}`);
    writeFileSync(fake, "<!DOCTYPE html><html>Not Found</html>");
    const r = install({ LOOP_PREFIX: prefix, LOOP_ASSET_URL: `file://${fake}`, LOOP_VERSION: "v0" });
    ok("an HTML error page is refused, not installed", r.status !== 0, `status=${r.status}`);
    ok("…and it says what it actually got", /not a binary/.test(r.stderr + r.stdout), r.stderr);
    ok("…and nothing was linked onto the PATH", !existsSync(join(prefix, "bin", "loop")));
  }

  if (!existsSync(binary)) {
    console.log("  · skipped the real-install checks: no dist/loop (build it with `bun apps/cli/build.mjs`)");
  } else {
    const prefix = join(mkdtempSync(join(tmpdir(), "loop-inst-")), "prefix");
    const asset = `file://${binary}`;
    const first = install({ LOOP_PREFIX: prefix, LOOP_ASSET_URL: asset, LOOP_VERSION: "v0.1.0" });
    ok("a real install succeeds", first.status === 0, first.stderr);
    ok("it lands in a VERSIONED directory", existsSync(join(prefix, "share/loop/versions/v0.1.0/loop")));
    ok("and links it onto the PATH", existsSync(join(prefix, "bin/loop")));
    ok("the installed binary runs",
      spawnSync(join(prefix, "bin/loop"), ["--help"], { timeout: 60000 }).status === 0);

    // THE POINT OF THE VERSIONED LAYOUT: a second version installs ALONGSIDE, so an
    // update is one symlink move and a rollback is the same move backwards.
    const second = install({ LOOP_PREFIX: prefix, LOOP_ASSET_URL: asset, LOOP_VERSION: "v0.2.0" });
    ok("a second version installs alongside the first", second.status === 0, second.stderr);
    const versions = readdirSync(join(prefix, "share/loop/versions")).sort();
    eq("both versions are kept", versions.join(","), "v0.1.0,v0.2.0");
    ok("the symlink now points at the new one",
      /v0\.2\.0/.test(readlinkSync(join(prefix, "bin/loop"))), readlinkSync(join(prefix, "bin/loop")));
    ok("so rolling back needs no download, just the older path",
      existsSync(join(prefix, "share/loop/versions/v0.1.0/loop")));

    // It must SAY when the bin dir isn't on PATH — an installed binary you can't type is
    // indistinguishable from a failed install.
    ok("it warns when the bin dir is not on PATH", /NOT on your PATH/.test(first.stdout), first.stdout.slice(-200));
  }
}

console.log(`\n${fail === 0 ? "PASS" : "FAIL"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail === 0 ? 0 : 1);
