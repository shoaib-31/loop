// Session snapshots — what makes the fleet survive a daemon restart.
//
// WHY WE STORE OUR OWN SHAPE INSTEAD OF READING THE SDK'S (docs/architecture.md).
// The obvious move is to adopt the store Claude Code already writes
// (`~/.claude/projects/**/<id>.jsonl`, and the SDK even exposes `listSessions()` /
// `getSessionMessages()`), and skip having a storage layer at all. That is wrong here,
// for two reasons that only show up once you look at what we actually display:
//
//   1. OUR TRANSCRIPT IS NOT A VIEW OF THEIRS. `engines/claude-code.mjs` deliberately
//      SUPPRESSES the real `AskUserQuestion` tool_use and its tool_result, and
//      `session.mjs` SYNTHESIZES its own answered-question pair when the human replies —
//      so that a question renders identically whether it is live or historical. The
//      CLI's file has the raw form. Rehydrating from it means re-deriving the
//      suppress-and-synthesize rules against a second, differently-shaped source, and
//      any drift between the two shows up as an answered question that renders wrong.
//   2. IT WOULD ONLY WORK FOR CLAUDE. Reading a vendor's transcript format is exactly
//      the SDK-specific knowledge that PROBLEM 13 confined to one file. Codex keeps its
//      own rollout files in its own shape; a persistence layer that only works for one
//      engine is the seam leaking.
//
// So this file stores the normalized `{role, blocks[], ts}` transcript we already own,
// which is engine-neutral by construction and needs no conversion in either direction.
//
// AND THE KEY SIMPLIFICATION: a restored session comes back **hibernated**. It has a
// transcript and an engine resume handle but no process — which is precisely the state
// PROBLEM 15 already built and measured a wake path for. Persistence is therefore
// "hibernation that survived a reboot", not a second mechanism.
//
// Hangs off `Session.addListener` exactly like notify.mjs does, so `Session` knows
// nothing about storage.

import { readFile, writeFile, mkdir, readdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = process.env.LOOP_ENG_DIR ?? join(homedir(), ".loop-eng");
const SESSIONS_DIR = join(STATE_DIR, "sessions");

/** Writes are coalesced: a busy run emits many turns a second and each save is a full
 *  rewrite of the transcript, so saving per-event would be O(n) per turn. */
const SAVE_DEBOUNCE_MS = Number(process.env.LOOP_SAVE_DEBOUNCE_MS ?? 2000);
/** Keep the list bounded so a long-lived daemon doesn't accumulate forever. */
const MAX_SNAPSHOTS = Number(process.env.LOOP_MAX_SNAPSHOTS ?? 200);
const MAX_AGE_MS = Number(process.env.LOOP_SNAPSHOT_MAX_AGE_MS ?? 30 * 24 * 60 * 60_000);

const SCHEMA = 1;

export async function initStore() {
  await mkdir(SESSIONS_DIR, { recursive: true });
  return { dir: SESSIONS_DIR };
}

const fileFor = (id) => join(SESSIONS_DIR, `${encodeURIComponent(id)}.json`);

/**
 * Persist one session. Best-effort by design: a disk failure must never disturb a
 * running agent, so this logs and moves on rather than throwing into the event stream.
 */
export async function saveSnapshot(session) {
  // THE GUARD THAT MAKES DELETE STICK. Closing a session ends its engine's stream,
  // which emits `done` on a later tick, which lands here via attachStore — AFTER the
  // DELETE handler already unlinked the file. Without this the snapshot is rewritten
  // and the session reappears on the next boot. Checked here rather than in the
  // listener so it covers the debounced path and the immediate flush alike.
  if (session.discarded) return false;
  try {
    await mkdir(SESSIONS_DIR, { recursive: true });
    const snap = { schema: SCHEMA, savedAt: new Date().toISOString(), ...session.toSnapshot() };
    // 0600 to match the rest of ~/.loop-eng: a transcript can contain anything the
    // agent read, which on a dev box is source code and sometimes secrets.
    await writeFile(fileFor(session.id), JSON.stringify(snap), { mode: 0o600 });
    return true;
  } catch (e) {
    console.error(`[store] could not save session ${session.id}: ${e.message}`);
    return false;
  }
}

export async function removeSnapshot(id) {
  try {
    await unlink(fileFor(id));
    return true;
  } catch {
    return false; // already gone
  }
}

/**
 * Every snapshot on disk, newest first, with expired and surplus ones deleted.
 * Unreadable or wrong-schema files are skipped rather than fatal — a corrupt snapshot
 * must not stop the daemon from booting with the rest of the fleet.
 */
export async function loadSnapshots() {
  let names;
  try {
    names = await readdir(SESSIONS_DIR);
  } catch {
    return []; // first run
  }

  const snaps = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      const snap = JSON.parse(await readFile(join(SESSIONS_DIR, name), "utf8"));
      if (snap?.schema !== SCHEMA || !snap?.id) throw new Error("unrecognised snapshot");
      snaps.push(snap);
    } catch (e) {
      console.error(`[store] skipping ${name}: ${e.message}`);
    }
  }

  const stamp = (s) => new Date(s.lastTs ?? s.savedAt ?? 0).getTime() || 0;
  snaps.sort((a, b) => stamp(b) - stamp(a));

  const now = Date.now();
  const keep = [];
  for (const s of snaps) {
    const tooOld = MAX_AGE_MS > 0 && now - stamp(s) > MAX_AGE_MS;
    if (tooOld || keep.length >= MAX_SNAPSHOTS) {
      await removeSnapshot(s.id);
      continue;
    }
    keep.push(s);
  }
  return keep;
}

/**
 * Save this session whenever it changes. Returns an unsubscribe.
 *
 * Terminal events (`done`, `error`, `hibernated`) flush IMMEDIATELY rather than waiting
 * out the debounce: those are exactly the moments the daemon is most likely to be shut
 * down next, and a debounced write is a write that didn't happen.
 */
export function attachStore(session) {
  let timer = null;
  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    saveSnapshot(session);
  };
  const schedule = () => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; saveSnapshot(session); }, SAVE_DEBOUNCE_MS);
    timer.unref?.();
  };

  // Write once up front so a session that dies before its first turn still leaves a
  // record of having existed.
  schedule();

  return session.addListener((evt) => {
    if (evt.type === "done" || evt.type === "error" || evt.type === "hibernated") flush();
    else schedule();
  });
}

export const snapshotDir = () => SESSIONS_DIR;
