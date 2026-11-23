// Basic terminal TUI client for the Loop-Eng daemon. It is JUST A CLIENT of the
// same protocol the phone app speaks (start · stream · decide · reply) — it does
// NOT own the session (the daemon does). That's the north-star invariant: start
// here, walk away, continue on the phone, close this — the session lives on.
//
// Deliberately plain (readline + console). Streaming deltas, box-drawing, arrow-
// key menus, markdown are later complexity bumps. This proves the loop.
//
// Usage:
//   node daemon/server.mjs                      # in one terminal
//   node daemon/tui.mjs "your first prompt"     # in another
//   node daemon/tui.mjs --resume <id>           # attach to an existing session
//
// Env: DAEMON=http://host:4318 to point elsewhere.

import { WebSocket } from "ws";
import * as readline from "node:readline";

const DAEMON = process.env.DAEMON ?? "http://127.0.0.1:4318";
const WS_BASE = DAEMON.replace(/^http/, "ws");

// ---- tiny ANSI helpers (no deps) ----
const c = {
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
  bold: (s) => `\x1b[1m${s}\x1b[0m`,
  cyan: (s) => `\x1b[36m${s}\x1b[0m`,
  green: (s) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s) => `\x1b[33m${s}\x1b[0m`,
  magenta: (s) => `\x1b[35m${s}\x1b[0m`,
  red: (s) => `\x1b[31m${s}\x1b[0m`,
};

const post = async (path, body) => {
  const res = await fetch(`${DAEMON}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
};

let currentPending = null; // the live structured question (if any)

function printTurn(turn) {
  const who =
    turn.role === "assistant" ? c.cyan("claude") :
    turn.blocks.every((b) => b.kind === "tool_result") ? c.dim("tool") : c.green("you");
  for (const b of turn.blocks) {
    switch (b.kind) {
      case "text":
        console.log(`\n${who} ${c.dim("›")} ${b.text}`);
        break;
      case "thinking":
        console.log(c.dim(`\n  · thinking: ${b.text.slice(0, 120)}${b.text.length > 120 ? "…" : ""}`));
        break;
      case "tool_use":
        if (b.name === "AskUserQuestion") break; // shown via pending
        console.log(c.magenta(`\n  ⚙ ${b.name}`) + " " + c.dim(oneLine(b.input)));
        break;
      case "tool_result":
        // suppress question answers; show other results briefly
        console.log(c.dim(`  ↳ ${oneLine(b.text)}`));
        break;
    }
  }
}

function printPending(q) {
  currentPending = q;
  console.log(c.yellow(`\n● Waiting for you`) + (q.header ? c.dim(` [${q.header}]`) : ""));
  console.log(c.bold(`  ${q.question}`));
  q.options.forEach((o, i) => {
    console.log(`   ${c.green(String(i + 1))}. ${o.label}` + (o.description ? c.dim(` — ${o.description}`) : ""));
  });
  console.log(c.dim(`  (type a number to choose, or just type text)`));
}

function oneLine(v) {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > 100 ? flat.slice(0, 100) + "…" : flat;
}

async function main() {
  const args = process.argv.slice(2);
  let id;

  if (args[0] === "--resume") {
    id = args[1];
    if (!id) { console.error("usage: tui.mjs --resume <id>"); process.exit(1); }
  } else {
    const prompt = args.join(" ").trim();
    if (!prompt) { console.error('usage: tui.mjs "your prompt"   |   tui.mjs --resume <id>'); process.exit(1); }
    const { id: newId } = await post("/sessions", { prompt, cwd: process.cwd() });
    id = newId;
  }

  console.log(c.dim(`— loop-tui — session ${id} @ ${DAEMON} —`));
  console.log(c.dim(`  (Ctrl+C to detach; the session keeps running in the daemon)`));

  const ws = new WebSocket(`${WS_BASE}/stream/${id}`);
  ws.on("open", () => console.log(c.dim("• connected")));
  ws.on("close", () => console.log(c.dim("• disconnected (session still alive in daemon)")));
  ws.on("message", (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }
    if (msg.type === "history") {
      msg.turns.forEach(printTurn);
    } else if (msg.type === "turn") {
      printTurn(msg.turn);
    } else if (msg.type === "pending") {
      if (msg.question) printPending(msg.question);
      else currentPending = null;
    } else if (msg.type === "done") {
      console.log(c.dim("\n• session finished"));
    } else if (msg.type === "error") {
      console.log(c.red(`\n⚠ ${msg.error}`));
    }
    rl.prompt(true);
  });

  // input loop: a number answers a pending structured question; anything else is
  // a text reply / next message. Both go through the SAME /reply endpoint.
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c.green("» ") });
  rl.prompt();
  rl.on("line", async (line) => {
    const text = line.trim();
    if (!text) { rl.prompt(); return; }
    try {
      await post(`/sessions/${id}/reply`, { text });
    } catch (e) {
      console.log(c.red(`⚠ reply failed: ${e.message}`));
    }
    rl.prompt();
  });
  rl.on("SIGINT", () => {
    console.log(c.dim("\n• detaching (session stays alive). bye."));
    ws.close();
    process.exit(0);
  });
}

main().catch((e) => { console.error(c.red(`[ERROR] ${e.message}`)); process.exit(1); });
