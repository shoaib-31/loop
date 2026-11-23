// Drives the daemon over its REAL HTTP+WS protocol — exactly what the phone app
// and TUI do — and asserts both decision paths work end-to-end:
//   1. start a run (POST /sessions)
//   2. connect WS /stream/:id, collect turn/pending frames
//   3. PATH A: a `pending` frame arrives (structured Q) -> reply with option "1"
//   4. PATH B: model asks a text question -> reply with text
//   5. run reaches `done`
//
// Run: node daemon/e2e-test.mjs   (starts its own server on a test port)

import { WebSocket } from "ws";
import { server, sessions } from "./server.mjs";
import { Session } from "./session.mjs";

const PORT = 4319;
const BASE = `http://127.0.0.1:${PORT}`;
const WS_BASE = `ws://127.0.0.1:${PORT}`;

const log = (...a) => console.log(...a);
const post = async (path, body) =>
  (await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })).json();

async function main() {
  await new Promise((r) => server.listen(PORT, "127.0.0.1", r));
  log(`test server on ${BASE}\n`);

  // 1) start a run that will first ask a STRUCTURED question, then a TEXT one.
  const { id } = await post("/sessions", {
    prompt:
      "First, use the AskUserQuestion tool to ask me which language to use " +
      "(give 3-4 options). After I answer, ask me ONE short follow-up in PLAIN " +
      "TEXT ending with a question mark (do NOT use a tool for the follow-up). " +
      "After I answer that, reply with a one-sentence summary ending in a period.",
    cwd: process.cwd(),
  });
  log(`started session ${id}\n`);

  // 2) connect the watch channel
  const ws = new WebSocket(`${WS_BASE}/stream/${id}`);
  const seen = { pendingCount: 0, textQuestionCount: 0, done: false, finalSummary: false };
  let repliedStructured = false;
  let repliedText = false;

  const endsWithQ = (t) => /\?\s*$/.test((t || "").trim());

  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.type === "history") {
      log(`[ws] history: ${msg.turns.length} turns`);
    } else if (msg.type === "turn") {
      const text = msg.turn.blocks.filter((b) => b.kind === "text").map((b) => b.text).join("");
      const kinds = msg.turn.blocks.map((b) => b.kind).join(",");
      if (text) log(`[ws] turn (${msg.turn.role}/${kinds}): ${text.slice(0, 100)}`);
      else log(`[ws] turn (${msg.turn.role}/${kinds})`);

      // PATH B: an assistant text turn ending in "?" and no structured pending
      if (msg.turn.role === "assistant" && endsWithQ(text) && !repliedText && repliedStructured) {
        seen.textQuestionCount++;
        log(`   🔔 [PATH B] text question detected -> replying with text`);
        repliedText = true;
        await post(`/sessions/${id}/reply`, { text: "Use your best judgment; summarize in one sentence ending with a period." });
      }

      // Terminal state for a PERSISTENT session: after we've answered the text
      // question, an assistant turn that does NOT end in "?" = idle/done-for-now
      // (still alive — the north-star invariant). This is the real success signal,
      // not the SDK `done` event (which only fires when we CLOSE the input).
      if (msg.turn.role === "assistant" && repliedText && !endsWithQ(text) && text) {
        seen.finalSummary = true;
        log(`   🏁 idle: assistant finished a turn without a question (session still alive)`);
      }
    } else if (msg.type === "pending") {
      if (msg.question) {
        seen.pendingCount++;
        log(`[ws] 🅰 PENDING (structured): "${msg.question.question}" opts=[${msg.question.options.map((o) => o.label).join(" | ")}]`);
        if (!repliedStructured) {
          repliedStructured = true;
          log(`   📱 [PATH A] tapping option 1`);
          await post(`/sessions/${id}/reply`, { text: "1" });
        }
      } else {
        log(`[ws] pending cleared`);
      }
    } else if (msg.type === "done") {
      seen.done = true;
      log(`[ws] ✅ done`);
    } else if (msg.type === "error") {
      log(`[ws] ⚠ error: ${msg.error}`);
    }
  });

  // wait for the persistent-session idle signal (final summary turn) or timeout
  const start = Date.now();
  while (!seen.finalSummary && Date.now() - start < 120000) {
    await new Promise((r) => setTimeout(r, 250));
  }

  // Now prove the EXPLICIT-close path: closing input makes the SDK emit `done`.
  const s = sessions.get(id);
  s.close();
  const closeStart = Date.now();
  while (!seen.done && Date.now() - closeStart < 15000) {
    await new Promise((r) => setTimeout(r, 250));
  }
  ws.close();

  log(`\n===================== VERDICT =====================`);
  log(`PATH A structured pending frame seen : ${seen.pendingCount > 0 ? "YES" : "NO"} (${seen.pendingCount})`);
  log(`PATH A answered via option number    : ${repliedStructured ? "YES" : "NO"}`);
  log(`PATH B text question detected        : ${seen.textQuestionCount > 0 ? "YES" : "NO"}`);
  log(`PATH B answered via text             : ${repliedText ? "YES" : "NO"}`);
  log(`Reached idle (persistent, alive)     : ${seen.finalSummary ? "YES" : "NO"}`);
  log(`Emitted done after explicit close    : ${seen.done ? "YES" : "NO"}`);
  log(`Final turn count in session          : ${s?.turns.length}`);
  const pass =
    seen.pendingCount > 0 && repliedStructured &&
    seen.textQuestionCount > 0 && repliedText &&
    seen.finalSummary && seen.done;
  log(`\n${pass ? "✅ PASS — both paths work over the real protocol" : "❌ FAIL — see above"}`);
  log(`===================================================`);

  server.close();
  process.exit(pass ? 0 : 1);
}

main().catch((e) => { console.error("[ERROR]", e); process.exit(1); });
