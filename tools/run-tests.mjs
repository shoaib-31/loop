// The test entry point. `npm test` runs everything that costs NOTHING to run;
// `npm run test:agent` runs the ones that drive a real Claude run and spend tokens.
//
// WHY THE SPLIT IS THE WHOLE POINT: the fast suites are the ones you can afford to run
// on every change, so they're the ones that actually catch regressions. If a single
// `npm test` also burned two minutes and real tokens, nobody would run it, and the
// cheap coverage would go stale. The agent suites still exist because they're the only
// proof the decision loop — the product — works end to end.
//
// Each suite prints its own "N passed, M failed"; this just sequences them, isolates
// state, and reports which ones failed.
//
//   node tools/run-tests.mjs           # free
//   node tools/run-tests.mjs --agent   # + the real-agent runs (SPENDS TOKENS)
//   node tools/run-tests.mjs --only=blocks,screen,layout

import { spawnSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

// `cost: "tokens"` = drives a real agent. `pty: true` = needs python3 + a real pty.
const SUITES = [
  // pure logic — milliseconds
  { name: "blocks", file: "apps/cli/src/tui/blocks-test.mjs", what: "transcript formatter (⏺/⎿ lines, wrapping)" },
  { name: "screen", file: "apps/cli/src/tui/screen-test.mjs", what: "the pty→grid emulator the layout test measures with" },
  { name: "mouse", file: "apps/cli/src/tui/mouse-test.mjs", what: "wheel → scroll, click → open, and never into the prompt" },
  { name: "input", file: "apps/cli/src/tui/text-input-test.mjs", what: "the prompt: what gets typed, and what must NEVER be" },
  // daemon + CLI — seconds, no tokens
  { name: "notify", file: "services/orchestrator/daemon/notify-test.mjs", what: "web push logic against a TLS stub" },
  { name: "auth", file: "services/orchestrator/daemon/auth-test.mjs", what: "token gate + pairing cookie" },
  { name: "engine", file: "services/orchestrator/daemon/engine-test.mjs", what: "engine seam via a FakeEngine" },
  { name: "handoff", file: "services/orchestrator/daemon/handoff-test.mjs", what: "cross-engine context, safety gates, and target metadata" },
  { name: "store", file: "services/orchestrator/daemon/store-test.mjs", what: "session snapshots: restore as sleeping, wake on reply" },
  { name: "import", file: "services/orchestrator/daemon/import-test.mjs", what: "adopting conversations from another client, against fixtures" },
  { name: "static", file: "services/orchestrator/daemon/static-test.mjs", what: "PWA serving (no web build needed)" },
  { name: "cli", file: "apps/cli/src/cli-test.mjs", what: "CLI logic + daemon lifecycle" },
  // real pty, FAKE daemon — no tokens, and the only thing that checks layout
  { name: "layout", file: "apps/cli/src/layout-test.mjs", pty: true, what: "TUI layout on a real emulated screen" },
  // real agent — money and minutes
  { name: "tui", file: "apps/cli/src/tui-test.mjs", pty: true, cost: "tokens", what: "the decision loop in a real pty with a real agent" },
  { name: "e2e", file: "services/orchestrator/daemon/e2e-test.mjs", cost: "tokens", what: "full daemon protocol against a real agent" },
  { name: "lifecycle", file: "services/orchestrator/daemon/lifecycle-test.mjs", cost: "tokens", what: "hibernate/wake/close by COUNTING the daemon's agent processes" },
  { name: "stream", file: "services/orchestrator/daemon/stream-test.mjs", cost: "tokens", what: "deltas beat the completed turn, and interrupt really stops a run" },
  { name: "codex", file: "services/orchestrator/daemon/codex-test.mjs", cost: "tokens", what: "the SECOND engine: the decision loop on Codex, not Claude" },
  { name: "handoff-e2e", file: "services/orchestrator/daemon/handoff-e2e-test.mjs", cost: "tokens", what: "Claude transcript → Codex context through the real HTTP route" },
  { name: "decline", file: "services/orchestrator/daemon/decline-test.mjs", cost: "tokens", what: "declining a question STOPS the turn, on both engines; busy seeds a late client" },
];

const argv = process.argv.slice(2);
const withAgent = argv.includes("--agent") || argv.includes("--all");
const only = argv.find((a) => a.startsWith("--only="))?.slice("--only=".length).split(",");

const chosen = SUITES.filter((s) =>
  only ? only.includes(s.name) : withAgent || s.cost !== "tokens"
);
if (!chosen.length) {
  console.error(`no suites matched. names: ${SUITES.map((s) => s.name).join(", ")}`);
  process.exit(2);
}

const results = [];
for (const s of chosen) {
  console.log(`\n\x1b[1m── ${s.name}\x1b[0m  ${s.what}${s.cost === "tokens" ? "  \x1b[33m(spends tokens)\x1b[0m" : ""}`);
  const started = Date.now();
  const r = spawnSync(process.execPath, [join(ROOT, s.file)], {
    cwd: ROOT,
    stdio: "inherit",
    // A THROWAWAY STATE DIR PER SUITE. The real ~/.loop-eng holds the VAPID keypair the
    // phone's push subscription is bound to — regenerating it silently kills the device's
    // notifications, which is the one thing that must never break (AGENTS.md).
    env: { ...process.env, LOOP_ENG_DIR: mkdtempSync(join(tmpdir(), `loop-${s.name}-`)) },
    timeout: s.cost === "tokens" ? 600000 : 180000,
  });
  results.push({ ...s, ok: r.status === 0, status: r.status, signal: r.signal, ms: Date.now() - started });
}

console.log("\n\x1b[1msummary\x1b[0m\n");
for (const r of results)
  console.log(`  ${r.ok ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m ${r.name.padEnd(8)} ${String(Math.round(r.ms / 1000) + "s").padStart(5)}` +
    (r.ok ? "" : `   exit=${r.status}${r.signal ? ` signal=${r.signal}` : ""}`));

const failed = results.filter((r) => !r.ok);
const skipped = SUITES.filter((s) => !chosen.includes(s));
if (skipped.length) console.log(`\n  not run: ${skipped.map((s) => s.name).join(", ")}` +
  (withAgent || only ? "" : "   (--agent adds the real-agent suites)"));
console.log(`\n${failed.length ? `\x1b[31mFAIL\x1b[0m — ${failed.map((r) => r.name).join(", ")}` : "\x1b[32mALL PASS\x1b[0m"}\n`);
process.exit(failed.length ? 1 : 0);
