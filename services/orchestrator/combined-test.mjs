// Proves BOTH decision paths coexist in ONE persistent session — the exact
// thing the daemon must handle:
//
//   PATH A — structured AskUserQuestion:
//     caught MID-TURN via canUseTool -> full {options[]} payload -> render BUTTONS.
//     (a trailing "?" is useless here; there's no text to match.)
//
//   PATH B — plain-text question (the natural TUI feel):
//     caught at the TURN BOUNDARY via a trailing "?".
//
// Sequence: model asks a structured question first, we "show buttons" + answer,
// same session continues, model then ends a turn with a text question, we detect
// it, "buzz", reply in plain text, done.
//
// Run: node combined-test.mjs

import { query } from "@anthropic-ai/claude-agent-sdk";

// --- async input channel: hold input open, inject the next msg when ready ---
function makeInputChannel() {
  const queue = [];
  let resolveNext = null;
  let closed = false;
  function push(text) {
    const msg = { type: "user", message: { role: "user", content: text }, parent_tool_use_id: null };
    if (resolveNext) { resolveNext({ value: msg, done: false }); resolveNext = null; }
    else queue.push(msg);
  }
  function close() {
    closed = true;
    if (resolveNext) { resolveNext({ value: undefined, done: true }); resolveNext = null; }
  }
  const iterable = { [Symbol.asyncIterator]() { return { next() {
    if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
    if (closed) return Promise.resolve({ value: undefined, done: true });
    return new Promise((res) => { resolveNext = res; });
  } }; } };
  return { iterable, push, close };
}

const endsWithQuestion = (t) => /\?\s*$/.test((t || "").trim());

// per-turn flag: did PATH A fire during the current turn?
let structuredThisTurn = null;

// --- PATH A capture point: structured question, mid-turn ---
async function canUseTool(toolName, inputData) {
  if (toolName === "AskUserQuestion") {
    structuredThisTurn = inputData;
    const q = inputData.questions?.[0];
    console.log("\n  ╔══ PATH A: AskUserQuestion CAPTURED mid-turn (canUseTool) ══");
    console.log(`  ║ header  : ${q?.header}`);
    console.log(`  ║ question: ${q?.question}`);
    console.log(`  ║ >>> would render ${q?.options?.length} BUTTONS on the phone:`);
    q?.options?.forEach((o, i) => console.log(`  ║     [${i + 1}] ${o.label}`));
    const answers = {};
    for (const qq of inputData.questions ?? []) answers[qq.question] = qq.options?.[0]?.label ?? "";
    console.log(`  ║ 📱 you tap: "${q?.options?.[0]?.label}"`);
    console.log("  ╚══════════════════════════════════════════════════════════\n");
    return { behavior: "allow", updatedInput: { questions: inputData.questions, answers } };
  }
  return { behavior: "allow", updatedInput: inputData };
}

async function main() {
  const { iterable, push, close } = makeInputChannel();

  push(
    "I'm starting a new web project. Use the AskUserQuestion tool to ask me ONE " +
    "multiple-choice decision with 3-4 options (e.g. the stack). Ask nothing else this turn."
  );

  console.log("=== ONE persistent session; expect PATH A then PATH B ===");

  let structuredDone = false;
  let textReplied = false;
  let turn = 0;

  for await (const message of query({
    prompt: iterable,
    options: { tools: ["AskUserQuestion", "Read", "Glob", "Grep"], canUseTool, maxTurns: 10 },
  })) {
    if (message.type === "assistant") {
      const text = message.message?.content?.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (text) console.log(`[assistant turn ${turn + 1}] ${text}\n`);
    }

    if (message.type === "result") {
      turn += 1;
      const finalText = message.result || "";
      const hadStructured = !!structuredThisTurn;
      structuredThisTurn = null; // reset for next turn

      console.log(`--- turn ${turn} ended | structured=${hadStructured} | ends-with-"?"=${endsWithQuestion(finalText)} ---`);

      // PATH A just handled this turn -> move the convo toward the text question
      if (hadStructured && !structuredDone) {
        structuredDone = true;
        console.log("   ✅ PATH A done (buttons shown + answered). Now asking for a TEXT question.\n");
        push(
          "Great. Now ask me ONE short follow-up question in PLAIN TEXT — just end " +
          "your message with a question mark, and do NOT use any tool for this one."
        );
        continue;
      }

      // PATH B: dumb trailing-"?" detection at the turn boundary
      if (endsWithQuestion(finalText)) {
        console.log("   🔔 PATH B: [PHONE BUZZ] text question detected via trailing '?'.");
        if (!textReplied) {
          textReplied = true;
          const reply = "Use your best judgment for everything, then give me a ONE-sentence summary that ends with a period.";
          console.log(`   📱 [you reply, plain text]: ${reply}\n`);
          push(reply);
          continue;
        }
      }

      // no question -> Claude considers itself done
      console.log("   🏁 turn ended without a question — DONE. Closing session.\n");
      close();
    }
  }

  console.log("=== session loop exited cleanly ===");
  console.log(`Both paths in ONE session: PATH A (structured/buttons)=${structuredDone}, PATH B (text/buzz)=${textReplied}, total turns=${turn}`);
}

main().catch((err) => { console.error("\n[ERROR]", err); process.exit(1); });
