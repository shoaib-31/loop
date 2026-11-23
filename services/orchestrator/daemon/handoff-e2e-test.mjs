// REAL cross-provider proof for PROBLEM 24. Starts a Claude session over HTTP, hands it to
// Codex through the public daemon route, and proves a secret that existed only in Claude's
// transcript reached the new Codex conversation.
//
// Spends a tiny amount of Claude + Codex usage; intentionally excluded from `npm test`.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Never let a direct invocation write snapshots into the operator's real ~/.loop-eng.
process.env.LOOP_ENG_DIR ||= mkdtempSync(join(tmpdir(), "loop-handoff-e2e-state-"));
const { server, sessions } = await import("./server.mjs");

const PORT = 4324;
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = mkdtempSync(join(tmpdir(), "loop-handoff-e2e-"));
const SECRET = `CROSSENGINE-${Date.now().toString(36).toUpperCase()}`;

let pass = 0, fail = 0;
function ok(name, value, detail = "") {
  if (value) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(path, init = {}) {
  const res = await fetch(BASE + path, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const post = (path, body) => request(path, { method: "POST", body: JSON.stringify(body) });

async function waitFor(fn, ms, label) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const value = await fn();
    if (value) return value;
    await sleep(300);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const textOf = (turns) => (turns ?? [])
  .flatMap((turn) => turn.blocks ?? [])
  .filter((block) => block.kind === "text")
  .map((block) => block.text)
  .join("\n");

try {
  await new Promise((resolve) => server.listen(PORT, "127.0.0.1", resolve));
  console.log(`\nreal handoff test on ${BASE}`);

  const started = await post("/sessions", {
    engine: "claude-code",
    cwd: CWD,
    prompt: `Remember this verification secret: ${SECRET}. Reply with exactly SOURCE_READY and do not use tools.`,
  });
  ok("Claude source session starts", started.status === 200 && !!started.body.id, JSON.stringify(started.body));
  const sourceId = started.body.id;

  await waitFor(async () => {
    const live = sessions.get(sourceId);
    if (live?.status === "error")
      throw new Error(`Claude source errored: ${live.lastError ?? textOf(live.turns)}`);
    const liveText = textOf(live?.turns);
    if (/API Error:|Not logged in/i.test(liveText))
      throw new Error(`Claude source could not run: ${liveText}`);
    const history = await request(`/sessions/${sourceId}/history`);
    const list = await request("/sessions");
    const meta = list.body.sessions?.find((s) => s.id === sourceId);
    return /SOURCE_READY/.test(textOf(history.body.turns)) && meta?.busy === false;
  }, 120_000, "Claude to finish its source turn");
  ok("source transcript contains the secret", /CROSSENGINE-/.test(textOf(sessions.get(sourceId)?.turns)));

  const handed = await post(`/sessions/${sourceId}/handoff`, {
    engine: "codex",
    instruction: `If the handoff notes contain the verification secret, reply with exactly TARGET_HAS_${SECRET} and nothing else.`,
  });
  ok("handoff route creates a Codex target", handed.status === 200 && handed.body.handoff?.to?.engine === "codex", JSON.stringify(handed.body));
  const targetId = handed.body.id;
  ok("target is linked to the source", handed.body.meta?.handoffFrom?.sessionId === sourceId);
  ok("target keeps the same working directory", handed.body.meta?.cwd === CWD);

  const targetHistory = await waitFor(async () => {
    const live = sessions.get(targetId);
    if (live?.status === "error")
      throw new Error(`Codex target errored: ${live.lastError ?? textOf(live.turns)}`);
    const liveText = textOf(live?.turns);
    if (/not logged in|authentication|unauthorized/i.test(liveText))
      throw new Error(`Codex target could not run: ${liveText}`);
    const history = await request(`/sessions/${targetId}/history`);
    return textOf(history.body.turns).includes(`TARGET_HAS_${SECRET}`) ? history.body.turns : null;
  }, 120_000, "Codex to use Claude's handoff context");
  ok("Codex received context that existed only in Claude", textOf(targetHistory).includes(`TARGET_HAS_${SECRET}`));

  await waitFor(() => sessions.get(sourceId)?.status === "hibernated", 15_000, "source process to hibernate");
  ok("source conversation remains available", sessions.has(sourceId));
  ok("source process is released after handoff", sessions.get(sourceId)?.status === "hibernated");
} catch (error) {
  fail++;
  console.error(`  ✗ ${error?.stack ?? error}`);
  for (const [id, session] of sessions) {
    console.error(`    session ${id}: engine=${session.engineId} status=${session.status} busy=${session.busy} error=${session.lastError ?? "none"} turns=${session.turns.length} partial=${session.partial?.text?.slice(0, 120) ?? "none"}`);
  }
} finally {
  for (const session of sessions.values()) {
    try { session.close(); } catch { /* already gone */ }
  }
  await new Promise((resolve) => server.close(resolve));
}

console.log(`\n${fail ? "FAIL" : "PASS"} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
