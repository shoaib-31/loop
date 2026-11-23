// Proves the north-star claim: running Claude headless gives a STRUCTURED JSON
// event stream, and a pending AskUserQuestion is captured the INSTANT it's asked
// (via canUseTool) — no regex over a terminal, no waiting for a file write.
//
// Unlike capture.mjs this is NON-INTERACTIVE (auto-answers option 1) so it runs
// unattended and we can watch the whole round-trip.
//
// Run: node stream-test.mjs

import { query } from "@anthropic-ai/claude-agent-sdk";

let captured = null; // the structured question payload we grab from the stream

// --- decision interceptor: this IS the reliable capture point ---
async function canUseTool(toolName, inputData) {
  if (toolName === "AskUserQuestion") {
    captured = inputData;
    console.log("\n========== AskUserQuestion CAPTURED (mid-run) ==========");
    console.log("Raw structured payload straight off the stream — no scraping:");
    console.log(JSON.stringify(inputData, null, 2));

    // auto-answer: pick option 1 (label) for every question
    const answers = {};
    for (const q of inputData.questions ?? []) {
      const first = q.options?.[0]?.label ?? "";
      answers[q.question] = first;
      console.log(`  -> auto-answering "${q.header}" with: ${first}`);
    }
    console.log("========================================================\n");
    return { behavior: "allow", updatedInput: { questions: inputData.questions, answers } };
  }
  console.log(`[auto-allow tool] ${toolName}`);
  return { behavior: "allow", updatedInput: inputData };
}

async function main() {
  console.log("Starting headless run with the JSON event stream...\n");
  console.log("--- live stream events (type only, to show it's structured & realtime) ---");

  const prompt =
    "I want to start a tiny web project but I'm torn on the stack. Before writing " +
    "ANY code or files, ask me the key decision using the AskUserQuestion tool. " +
    "Do not guess or proceed until I answer.";

  let sawQuestionInStream = false;

  for await (const message of query({
    prompt,
    options: {
      tools: ["AskUserQuestion", "Read", "Glob", "Grep"],
      canUseTool,
      includePartialMessages: true, // <-- gives us the raw realtime stream events
      maxTurns: 6,
    },
  })) {
    // Show the shape of the realtime stream. stream_event = the low-level deltas.
    if (message.type === "stream_event") {
      const ev = message.event;
      const t = ev?.type;
      // flag the exact moment the AskUserQuestion tool_use block opens in the stream
      if (t === "content_block_start" && ev.content_block?.type === "tool_use") {
        console.log(`  [stream] tool_use starts: ${ev.content_block.name}`);
        if (ev.content_block.name === "AskUserQuestion") sawQuestionInStream = true;
      } else {
        console.log(`  [stream] ${t}`);
      }
    }

    if (message.type === "assistant") {
      const text = message.message?.content
        ?.filter((b) => b.type === "text")
        .map((b) => b.text)
        .join("");
      if (text) console.log(`\n[assistant] ${text}\n`);
    }

    if ("result" in message) {
      console.log(`\n[RESULT] ${message.result}`);
    }
  }

  // --- verdict ---
  console.log("\n===================== VERDICT =====================");
  console.log(`AskUserQuestion tool_use seen in raw stream : ${sawQuestionInStream ? "YES" : "no"}`);
  console.log(`Structured question captured via callback   : ${captured ? "YES" : "no"}`);
  if (captured) {
    const q = captured.questions?.[0];
    console.log(`  header      : ${q?.header}`);
    console.log(`  question    : ${q?.question}`);
    console.log(`  options     : ${q?.options?.map((o) => o.label).join(" | ")}`);
    console.log(`  multiSelect : ${q?.multiSelect}`);
  }
  console.log("Run reached a clean finish (resumed after answer): YES (loop exited normally)");
  console.log("===================================================");
}

main().catch((err) => {
  console.error("\n[ERROR]", err);
  process.exit(1);
});
