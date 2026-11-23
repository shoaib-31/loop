// v0 capture test — the ONE load-bearing question:
// Can we intercept the agent's decision event (AskUserQuestion) via the
// canUseTool callback, surface it, feed an answer back, and watch the run continue?
//
// No phone / Telegram / push here on purpose. If the terminal round-trip works,
// notification delivery is trivial plumbing afterward.
//
// Run: node capture.mjs

import { query } from "@anthropic-ai/claude-agent-sdk";
import * as readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

// --- the "notification + reply" stand-in: for now it's just the terminal ---
async function surfaceDecisionToHuman(questions) {
  console.log("\n\n================= DECISION NEEDED =================");
  console.log("(this is the event we would push to the phone)\n");

  const answers = {};
  const rl = readline.createInterface({ input, output });

  for (const q of questions) {
    console.log(`[${q.header ?? "?"}] ${q.question}`);
    q.options.forEach((opt, i) => {
      console.log(`   ${i + 1}. ${opt.label} — ${opt.description ?? ""}`);
    });
    const raw = (await rl.question("   your choice (number, or free text): ")).trim();

    // number -> option label; otherwise treat as free text
    const idx = Number.parseInt(raw, 10) - 1;
    const chosen =
      Number.isInteger(idx) && idx >= 0 && idx < q.options.length
        ? q.options[idx].label
        : raw;
    answers[q.question] = chosen;
  }
  rl.close();
  console.log("==================================================\n");
  return answers;
}

// --- decision interceptor ---
// canUseTool fires for BOTH tool-permission asks AND clarifying questions.
// We only care about AskUserQuestion here; everything else we auto-allow so
// the run proceeds freely (mimics bypass-permissions behaviour).
async function canUseTool(toolName, inputData /*, context */) {
  if (toolName === "AskUserQuestion") {
    console.log("\n>>> CAPTURED an AskUserQuestion event <<<");
    const answers = await surfaceDecisionToHuman(inputData.questions ?? []);
    return {
      behavior: "allow",
      updatedInput: { questions: inputData.questions, answers },
    };
  }

  // auto-allow all other tools (log so we can see the stream of activity)
  console.log(`[auto-allow] ${toolName}`);
  return { behavior: "allow", updatedInput: inputData };
}

async function main() {
  console.log("Starting headless run. Watching for a decision event...\n");

  // Prompt engineered to force a genuine clarifying question early, with no
  // file writes needed — keeps the test self-contained.
  const prompt =
    "I want to start a new tiny web project but I'm genuinely torn on the stack. " +
    "Before writing ANY code or files, ask me the key decision(s) you need using " +
    "the AskUserQuestion tool. Do not guess or proceed until I answer.";

  for await (const message of query({
    prompt,
    options: {
      // include AskUserQuestion explicitly so it's always available
      tools: ["AskUserQuestion", "Read", "Glob", "Grep"],
      canUseTool,
      maxTurns: 6, // safety cap — do not let it run away
    },
  })) {
    // surface the result / any final text so we can confirm it resumed
    if (message.type === "assistant") {
      const text = message.message?.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text) console.log(`\n[assistant] ${text}`);
    }
    if ("result" in message) {
      console.log(`\n[RESULT] ${message.result}`);
    }
  }

  console.log("\nRun finished. If you saw the DECISION block and it continued after your answer, the mechanism works.");
}

main().catch((err) => {
  console.error("\n[ERROR]", err);
  process.exit(1);
});
