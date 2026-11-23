// Proves the flow that actually matters for the daemon: a PERSISTENT session
// where the model can end a turn with a plain-text question (the natural TUI
// feel the user likes), we DETECT it dumbly (trailing "?"), fire a stand-in
// "phone buzz", reply with PLAIN TEXT, and the SAME session continues in context.
//
// No AskUserQuestion forcing. Text questions stay text. Detection = look for "?".
//
// Run: node session-test.mjs

import { query } from "@anthropic-ai/claude-agent-sdk";

// --- a tiny async message queue so we can feed replies into a live session ---
// query() accepts an AsyncIterable<SDKUserMessage>; this lets us push the next
// user message only AFTER we've seen the previous turn end. That "hold the input
// open and inject when ready" is exactly what the daemon does.
function makeInputChannel() {
  const queue = [];
  let resolveNext = null;
  let closed = false;

  function push(text) {
    const msg = {
      type: "user",
      message: { role: "user", content: text },
      parent_tool_use_id: null,
    };
    if (resolveNext) { resolveNext({ value: msg, done: false }); resolveNext = null; }
    else queue.push(msg);
  }
  function close() {
    closed = true;
    if (resolveNext) { resolveNext({ value: undefined, done: true }); resolveNext = null; }
  }
  const iterable = {
    [Symbol.asyncIterator]() {
      return {
        next() {
          if (queue.length) return Promise.resolve({ value: queue.shift(), done: false });
          if (closed) return Promise.resolve({ value: undefined, done: true });
          return new Promise((res) => { resolveNext = res; });
        },
      };
    },
  };
  return { iterable, push, close };
}

// dumb detector, exactly as the user proposed: does the turn end with a "?"
function endsWithQuestion(text) {
  return /\?\s*$/.test((text || "").trim());
}

async function main() {
  const { iterable, push, close } = makeInputChannel();

  // The script's side of the "conversation" — what the phone would send back.
  // We reply in PLAIN TEXT to whatever the model asks. Last reply ends it.
  const scriptedReplies = [
    "It's a personal note-taking web app. Use your sensible defaults for everything else, then tell me in ONE sentence what stack you picked. End that sentence with a period, not a question.",
  ];
  let replyIdx = 0;

  // kick off the conversation
  push(
    "I want to build a tiny web app but I'm not sure about the details. " +
    "Ask me ONE short clarifying question in plain text (just end your message " +
    "with a question — do NOT use any tool), then wait for my answer."
  );

  console.log("=== persistent session started (streaming input) ===\n");

  let turn = 0;
  for await (const message of query({
    prompt: iterable,
    options: {
      tools: ["Read", "Glob", "Grep"], // no AskUserQuestion — force the text path
      maxTurns: 8,
    },
  })) {
    if (message.type === "assistant") {
      const text = message.message?.content
        ?.filter((b) => b.type === "text").map((b) => b.text).join("");
      if (text) console.log(`[assistant turn ${turn + 1}]\n${text}\n`);
    }

    // 'result' = a turn just ended in streaming mode. THIS is our boundary.
    if (message.type === "result") {
      turn += 1;
      const finalText = message.result || "";
      const isQuestion = endsWithQuestion(finalText);

      console.log(`--- turn ${turn} ended | ends-with-"?": ${isQuestion} | num_turns=${message.num_turns} ---`);

      if (isQuestion) {
        // >>> this is the exact point the daemon fires the phone notification <<<
        console.log(`   \u{1F514}  [PHONE BUZZ] Claude is asking — would notify you now.`);

        if (replyIdx < scriptedReplies.length) {
          const reply = scriptedReplies[replyIdx++];
          console.log(`   \u{1F4F1} [you reply, plain text]: ${reply}\n`);
          push(reply); // inject reply -> SAME session continues
        } else {
          console.log("   (no more scripted replies) closing session.\n");
          close();
        }
      } else {
        // turn ended WITHOUT a question => Claude considers itself done.
        console.log("   ✅ turn ended without a question — treating as DONE, closing.\n");
        close();
      }
    }
  }

  console.log("=== session loop exited cleanly ===");
  console.log(`Total turns in the SAME session: ${turn}`);
}

main().catch((err) => { console.error("\n[ERROR]", err); process.exit(1); });
