// Loop daemon — the north-star engine host. Owns Claude sessions via the SDK
// and exposes ONE protocol (start · stream · decide · reply) that BOTH clients
// (terminal TUI + phone app) speak. The web API client and shared types live in
// apps/web/src/lib/api.ts and apps/web/src/lib/types.ts:
//
//   GET  /health
//   GET  /sessions                       -> { sessions: [meta] }
//   POST /sessions            {prompt,cwd}-> { id }            (start a run)
//   GET  /sessions/:id/history           -> { id, turns }
//   GET  /sessions/:id/pending           -> { id, question }   (HTTP fallback)
//   POST /sessions/:id/reply  {text}      -> { ok, ... }        (answer / continue)
//   POST /sessions/:id/interrupt         -> { ok, status }      (stop the turn, keep the session)
//   POST /sessions/:id/decline           -> { ok, status }      (refuse the question, stop the turn)
//   POST /sessions/:id/handoff {engine}  -> { id, meta }        (continue on another engine)
//   POST /sessions/:id/hibernate         -> { ok, status }      (free the process, keep the chat)
//   DELETE /sessions/:id                 -> { ok, closed }      (end it for good)
//   GET  /engines                        -> { engines: [{id,label,available}] }
//   WS   /stream/:id                      -> history, turn, pending, busy, done, error
//
// SECURITY: binds 0.0.0.0 so Tailscale can proxy to it. Every non-loopback request
// must carry the shared token (auth.mjs; docs/architecture.md) — the daemon
// auto-allows every tool, so an unauthenticated one is remote code execution.
// Loopback is exempt so the TUI, tests and browser-check keep working.

import { createServer } from "node:http";
import { existsSync } from "node:fs";
import { WebSocketServer } from "ws";
import { Session } from "./session.mjs";
import { prepareHandoff } from "./handoff.mjs";
import {
  probeEngines,
  getEngine,
  engineIds,
  DEFAULT_ENGINE,
  // The optional read verbs (PROBLEM 20). Imported as the module-level wrappers, not off
  // the engine class, because those are the ones that degrade cleanly when an engine
  // doesn't implement them.
  listConversations,
  readConversation,
} from "./engines/engine.mjs";
import {
  initAuth,
  authorize,
  authEnabled,
  currentToken,
  cookieHeader,
  clearCookieHeader,
} from "./auth.mjs";
import { printPairingQr } from "./pair.mjs";
import {
  initNotifier,
  attachNotifier,
  addSubscription,
  removeSubscription,
  publicKey,
  subscriptionCount,
} from "./notify.mjs";
import { serveStatic, webStatus } from "./static.mjs";
import { initStore, attachStore, loadSnapshots, removeSnapshot, snapshotDir } from "./store.mjs";

const PORT = process.env.PORT ? Number(process.env.PORT) : 4318;
const HOST = process.env.HOST ?? "0.0.0.0";

const sessions = new Map(); // id -> Session

function json(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "access-control-allow-origin": "*",
    "content-length": Buffer.byteLength(payload),
  });
  res.end(payload);
}

function readBody(req, { limit = 1_000_000 } = {}) {
  return new Promise((resolve, reject) => {
    let data = "", size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > limit) { reject(new Error("body too large")); req.destroy(); return; }
      data += c;
    });
    req.on("end", () => resolve(data));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const { pathname } = url;

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      // Reflect the origin rather than "*": a wildcard is INVALID alongside
      // credentials, so "*" would block the cookie on the dev-server path.
      "access-control-allow-origin": req.headers.origin ?? "*",
      "access-control-allow-credentials": "true",
      "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
      "access-control-allow-headers": "content-type,authorization,x-loop-token",
    });
    return res.end();
  }

  try {
    // ---- auth gate (docs/architecture.md) ----
    // Runs BEFORE every route including static, so no asset, API call or deep link
    // is reachable without the token.
    const auth = authorize(req, url);
    if (!auth.ok) {
      // 401 + a WWW-Authenticate hint. Deliberately terse: an unauthenticated
      // caller learns only that a token is needed, not whether this daemon has
      // sessions or a web build.
      res.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="loop"',
      });
      return res.end(JSON.stringify({ error: "unauthorized" }));
    }

    // Pairing handoff: a QR link arrives as /?token=<t>. Swap it for an HttpOnly
    // cookie and redirect to the clean URL. Three reasons this is a redirect and
    // not just a Set-Cookie on the page:
    //   1. iOS captures start_url when you Add to Home Screen — a token left in
    //      the URL would be baked into the installed app permanently.
    //   2. It keeps the token out of history, screenshots and the Referer header.
    //   3. The WS handshake can't send headers, but DOES send cookies.
    if (
      authEnabled() &&
      req.method === "GET" &&
      url.searchParams.has("token") &&
      auth.via === "token"
    ) {
      const clean = new URL(url);
      clean.searchParams.delete("token");
      res.writeHead(302, {
        location: clean.pathname + (clean.search || "") || "/",
        "set-cookie": cookieHeader(req),
        "cache-control": "no-store",
      });
      return res.end();
    }

    // Explicit un-pair, for a lost phone: drops this browser's cookie. The token
    // itself is unchanged — rotating it is `rm ~/.loop-eng/token` + restart.
    if (pathname === "/unpair" && req.method === "POST") {
      res.writeHead(200, {
        "content-type": "application/json",
        "set-cookie": clearCookieHeader(),
      });
      return res.end(JSON.stringify({ ok: true }));
    }

    if (pathname === "/health")
      return json(res, 200, {
        ok: true,
        service: "loop-daemon",
        push: { enabled: !!publicKey(), subscriptions: subscriptionCount() },
        // `live` is the number of agent PROCESSES this daemon is holding, which is the
        // number that used to only ever go up. Worth being able to read without
        // resorting to `pgrep`.
        sessions: {
          total: sessions.size,
          live: [...sessions.values()].filter((s) => s.status === "running" || s.status === "starting").length,
          hibernated: [...sessions.values()].filter((s) => s.status === "hibernated").length,
          pending: [...sessions.values()].filter((s) => s.pending).length,
        },
        // Never the token itself — only whether auth is on and how THIS caller got
        // in, which is what makes "why am I authorised?" debuggable.
        auth: { enabled: authEnabled(), via: auth.via },
      });

    // ---- web push (docs/architecture.md) ----
    // The client needs our VAPID public key to create a subscription.
    if (pathname === "/vapid-public-key" && req.method === "GET") {
      const key = publicKey();
      if (!key) return json(res, 503, { error: "notifier not initialised" });
      return json(res, 200, { key });
    }

    if (pathname === "/subscribe" && req.method === "POST") {
      let sub;
      try { sub = JSON.parse((await readBody(req)) || "{}"); }
      catch { return json(res, 400, { error: "invalid JSON body" }); }
      try {
        const count = await addSubscription(sub);
        return json(res, 200, { ok: true, count });
      } catch (e) {
        return json(res, 400, { error: String(e?.message ?? e) });
      }
    }

    // Explicit unsubscribe (the PWA calls this when notifications are turned off).
    // Dead subscriptions are also pruned automatically on a 404/410 from push.
    if (pathname === "/unsubscribe" && req.method === "POST") {
      let body;
      try { body = JSON.parse((await readBody(req)) || "{}"); }
      catch { return json(res, 400, { error: "invalid JSON body" }); }
      if (!body?.endpoint) return json(res, 400, { error: "endpoint is required" });
      return json(res, 200, { ok: true, removed: await removeSubscription(body.endpoint) });
    }

    if (pathname === "/sessions" && req.method === "GET") {
      // Ordered by URGENCY, not insertion: anything waiting on a human first, then
      // most-recently-active. Every client shows this list, so the ordering belongs
      // here rather than being re-derived (and drifting) in the PWA and the TUI.
      // Titles are refreshed first: each is one cheap vendor-store read (PROBLEM 21).
      await Promise.all([...sessions.values()].map((s) => s.refreshTitle()));
      const list = [...sessions.values()].map((s) => s.meta()).sort((a, b) => {
        if (!!a.pending !== !!b.pending) return a.pending ? -1 : 1;
        return new Date(b.lastTs ?? 0) - new Date(a.lastTs ?? 0);
      });
      return json(res, 200, { sessions: list });
    }

    // Which agent engines this machine can actually run (docs/architecture.md).
    // Backs `loop doctor` and the engine picker: a missing CLI becomes a clear
    // message instead of a spawn failure halfway into a run.
    if (pathname === "/engines" && req.method === "GET") {
      return json(res, 200, { default: DEFAULT_ENGINE, engines: await probeEngines() });
    }

    // ---- foreign conversations (docs/architecture.md) -------------------
    // Conversations that exist in an ENGINE's own store rather than ours — work started in
    // the terminal, in an IDE, or by any other client. Read-only; adopting one is a POST to
    // /sessions below.

    // GET /conversations?engine=&dir=&cursor=&limit=
    if (pathname === "/conversations" && req.method === "GET") {
      const engine = url.searchParams.get("engine") ?? DEFAULT_ENGINE;
      if (!engineIds().includes(engine))
        return json(res, 400, { error: `unknown engine "${engine}"`, engines: engineIds() });
      const rawLimit = Number.parseInt(url.searchParams.get("limit") ?? "", 10);
      // Clamp rather than trust: an unbounded limit turns one request into reading every
      // transcript on the machine, and `limit=0` would page forever.
      const limit = Number.isInteger(rawLimit) ? Math.min(Math.max(rawLimit, 1), 200) : 50;
      const r = await listConversations(engine, {
        dir: url.searchParams.get("dir") || null,
        cursor: url.searchParams.get("cursor") || null,
        limit,
      });
      // Which refs are ALREADY adopted, so a client can say "open" instead of offering to
      // import a second writer onto the same transcript.
      const adopted = new Map();
      for (const s of sessions.values()) if (s.sdkSessionId) adopted.set(s.sdkSessionId, s.id);
      return json(res, 200, {
        engine,
        conversations: r.conversations.map((c) => ({ ...c, adoptedAs: adopted.get(c.ref) ?? null })),
        nextCursor: r.nextCursor ?? null,
        reason: r.reason ?? null,
      });
    }

    // GET /conversations/:engine/:ref — preview one, as normalized turns.
    const convMatch = pathname.match(/^\/conversations\/([^/]+)\/([^/]+)$/);
    if (convMatch && req.method === "GET") {
      const engine = decodeURIComponent(convMatch[1]);
      if (!engineIds().includes(engine))
        return json(res, 400, { error: `unknown engine "${engine}"`, engines: engineIds() });
      const ref = decodeURIComponent(convMatch[2]);
      const r = await readConversation(engine, ref, { limit: 400 });
      // 501 = this engine can't read conversations at all; 404 = it can, and there is no
      // such conversation. A 200 with an empty array would read as "this conversation is
      // empty", which is a different and misleading claim.
      if (r.reason && !r.turns.length) return json(res, 501, { error: r.reason });
      if (!r.turns.length) return json(res, 404, { error: `conversation "${ref}" not found or empty`, engine, ref });
      return json(res, 200, { engine, ...r });
    }

    // start a new run
    if (pathname === "/sessions" && req.method === "POST") {
      let payload;
      try { payload = JSON.parse((await readBody(req)) || "{}"); }
      catch { return json(res, 400, { error: "invalid JSON body" }); }

      // ---- ADOPT an existing foreign conversation (PROBLEM 20) --------------
      // Checked BEFORE the prompt guard below, because adopting needs no prompt: the
      // conversation already has one, and what happens next is whatever the human types.
      //
      // The whole thing is Session.fromSnapshot(). An adopted conversation is a transcript
      // plus an engine resume handle plus no process — which is EXACTLY the state a restored
      // snapshot is in (PROBLEM 16), so this reuses the wake path that is already measured
      // rather than inventing a second way to continue a conversation. Nothing calls
      // start(): the session sits hibernated until the first reply wakes it.
      if (payload?.adopt && typeof payload.adopt === "object") {
        const { engine = DEFAULT_ENGINE, ref } = payload.adopt;
        if (!engineIds().includes(engine))
          return json(res, 400, { error: `unknown engine "${engine}"`, engines: engineIds() });
        if (typeof ref !== "string" || !ref.trim())
          return json(res, 400, { error: "adopt.ref is required" });

        // DEDUPE BY REF. Two sessions resuming one transcript means two writers on the same
        // file, and "resume in place" is the whole point of the feature — so a second adopt
        // returns the FIRST session instead of racing it.
        for (const s of sessions.values())
          if (s.sdkSessionId === ref) return json(res, 200, { id: s.id, meta: s.meta(), alreadyAdopted: true });

        const conv = await readConversation(engine, ref, { limit: 400 });
        if (conv.reason && !conv.turns.length) return json(res, 501, { error: conv.reason });
        if (!conv.turns.length)
          return json(res, 404, { error: `conversation "${ref}" has no readable turns` });

        // cwd: the conversation's own directory is where continuing it will RUN, and the
        // daemon auto-allows every tool — so an explicit override is allowed but the
        // default is never silently this daemon's cwd, which would point the agent at the
        // wrong repo while showing the right transcript.
        const cwd = payload?.cwd || conv.cwd || process.cwd();
        // A CONVERSATION CAN OUTLIVE ITS DIRECTORY — a deleted temp dir, a moved or renamed
        // repo. Refuse now with something actionable rather than letting the spawn fail
        // minutes later, on the first reply, as an opaque session error. Falling back to
        // the daemon's cwd would be worse than either: the transcript would look right
        // while the agent worked in the wrong tree.
        if (!existsSync(cwd))
          return json(res, 409, {
            error: `the conversation's working directory no longer exists: ${cwd}`,
            hint: "adopt it with a `cwd` that does exist",
            cwd,
          });

        const s = Session.fromSnapshot(
          {
            cwd,
            engine,
            model: payload?.model ?? null,
            // The foreign ref IS the resume handle. fromSnapshot restores as `hibernated`
            // when this is present, and as `done` (readable, not continuable) when it isn't.
            sdkSessionId: ref,
            turns: conv.turns,
          },
          {
            engineOptions: payload?.engineOptions && typeof payload.engineOptions === "object"
              ? payload.engineOptions
              : {},
          }
        );
        s.adoptedFrom = { engine, ref, truncated: !!conv.truncated, total: conv.total ?? conv.turns.length };
        sessions.set(s.id, s);
        attachNotifier(s);
        attachStore(s);
        return json(res, 200, { id: s.id, meta: s.meta(), adopted: { engine, ref }, truncated: !!conv.truncated });
      }

      const prompt = payload?.prompt;
      if (typeof prompt !== "string" || !prompt.trim())
        return json(res, 400, { error: "prompt is required" });
      // Reject an unknown engine up front: starting a Claude run because "codex"
      // was misspelled would be a silent, expensive surprise.
      if (payload?.engine && !engineIds().includes(payload.engine))
        return json(res, 400, { error: `unknown engine "${payload.engine}"`, engines: engineIds() });
      const s = new Session({
        cwd: payload?.cwd,
        engine: payload?.engine,
        model: payload?.model ?? null,
        // Opaque per-engine extras (e.g. `{"mode":"plan"}` for Codex, which is what
        // unlocks its structured question tool). Passed through without interpretation so
        // the daemon never grows a per-vendor option list.
        engineOptions: payload?.engineOptions && typeof payload.engineOptions === "object"
          ? payload.engineOptions
          : {},
      });
      sessions.set(s.id, s);
      // Buzz the phone whenever this session needs a human. Attached BEFORE
      // start() so a decision in the very first turn isn't missed. Notifications
      // ride the same listener stream as WS clients, so Session stays unaware of
      // push entirely.
      attachNotifier(s);
      // Persistence rides that same listener stream, for the same reason.
      attachStore(s);
      s.start(prompt);
      return json(res, 200, { id: s.id, meta: s.meta() });
    }

    const histMatch = pathname.match(/^\/sessions\/([^/]+)\/history$/);
    if (histMatch && req.method === "GET") {
      const s = sessions.get(decodeURIComponent(histMatch[1]));
      if (!s) return json(res, 404, { error: "session not found" });
      return json(res, 200, { id: s.id, turns: s.turns });
    }

    const pendMatch = pathname.match(/^\/sessions\/([^/]+)\/pending$/);
    if (pendMatch && req.method === "GET") {
      const s = sessions.get(decodeURIComponent(pendMatch[1]));
      if (!s) return json(res, 404, { error: "session not found" });
      return json(res, 200, { id: s.id, question: s.pending });
    }

    // CONTINUE THIS WORK ON ANOTHER ENGINE. This is a handoff, not a native-session
    // conversion: the target gets our provider-neutral transcript + current Git state and
    // starts a fresh conversation in the same cwd. The source remains intact and linked.
    const handoffMatch = pathname.match(/^\/sessions\/([^/]+)\/handoff$/);
    if (handoffMatch && req.method === "POST") {
      const source = sessions.get(decodeURIComponent(handoffMatch[1]));
      if (!source) return json(res, 404, { error: "session not found" });

      let payload;
      try { payload = JSON.parse((await readBody(req)) || "{}"); }
      catch { return json(res, 400, { error: "invalid JSON body" }); }
      const targetEngine = payload?.engine;
      if (typeof targetEngine !== "string" || !targetEngine.trim())
        return json(res, 400, { error: "engine is required" });
      if (!engineIds().includes(targetEngine))
        return json(res, 400, { error: `unknown engine "${targetEngine}"`, engines: engineIds() });

      // Fail before creating a session when the CLI is not usable. A dead target carrying a
      // perfectly good handoff brief looks like lost context; the honest answer is immediate.
      const TargetEngine = await getEngine(targetEngine);
      const targetProbe = await TargetEngine.probe();
      if (!targetProbe?.available)
        return json(res, 409, {
          error: targetProbe?.reason ?? `engine "${targetEngine}" is not available`,
          engine: targetEngine,
        });

      let prepared;
      try {
        prepared = await prepareHandoff({
          source,
          targetEngine,
          model: payload?.model ?? null,
          engineOptions: payload?.engineOptions,
          instruction: payload?.instruction,
        });
      } catch (error) {
        return json(res, error?.status ?? 500, { error: String(error?.message ?? error) });
      }

      const target = prepared.session;
      sessions.set(target.id, target);
      // Attach BEFORE start, for the same reason as ordinary creation: a fast first event
      // must be persisted and must be able to buzz the phone.
      attachNotifier(target);
      attachStore(target);
      target.start(prepared.prompt);

      // The source is idle by validation. Release its process now: a handoff should not
      // leave two provider processes attached to the same worktree. The conversation and
      // transcript remain available, and a later reply can still wake it.
      if (source.status === "running") source.hibernate();

      return json(res, 200, {
        id: target.id,
        meta: target.meta(),
        handoff: {
          from: { id: source.id, engine: source.engineId },
          to: { id: target.id, engine: target.engineId },
          includedTurns: prepared.includedTurns,
          omittedTurns: prepared.omittedTurns,
        },
      });
    }

    const replyMatch = pathname.match(/^\/sessions\/([^/]+)\/reply$/);
    if (replyMatch && req.method === "POST") {
      const s = sessions.get(decodeURIComponent(replyMatch[1]));
      if (!s) return json(res, 404, { error: "session not found" });
      let payload;
      try { payload = JSON.parse((await readBody(req)) || "{}"); }
      catch { return json(res, 400, { error: "invalid JSON body" }); }
      const text = payload?.text;
      if (typeof text !== "string" || text.trim() === "")
        return json(res, 400, { error: "text is required" });
      return json(res, 200, s.reply(text));
    }

    // DECLINE THE PARKED QUESTION (docs/architecture.md): refuse it without answering
    // and stop the turn, so the human's next message is what the agent acts on. Its own
    // route rather than a reserved reply string, so no typed answer can ever trigger it.
    const decMatch = pathname.match(/^\/sessions\/([^/]+)\/decline$/);
    if (decMatch && req.method === "POST") {
      const s = sessions.get(decodeURIComponent(decMatch[1]));
      if (!s) return json(res, 404, { error: "session not found" });
      const r = s.decline();
      // 409, like interrupt: "nothing is waiting" is a statement about state — the
      // question was most likely answered from the other client a moment ago.
      return json(res, r.ok ? 200 : 409, { id: s.id, ...r, status: s.status });
    }

    // END A SESSION FOR GOOD — the agent process dies and the transcript is dropped.
    // Until this existed the only way to reclaim a run's process was to stop the whole
    // daemon, which ends every OTHER session too (docs/architecture.md).
    const delMatch = pathname.match(/^\/sessions\/([^/]+)$/);
    if (delMatch && req.method === "DELETE") {
      const id = decodeURIComponent(delMatch[1]);
      const s = sessions.get(id);
      if (!s) return json(res, 404, { error: "session not found" });
      // discard(), not close(): it also blocks any further snapshot write, including
      // the one the imminent `done` event would otherwise trigger after the unlink.
      s.discard();
      sessions.delete(id);
      // Delete means delete: leaving the snapshot behind would resurrect the session
      // on the next daemon boot, which is the opposite of what DELETE was asked to do.
      await removeSnapshot(id);
      return json(res, 200, { ok: true, id, closed: true });
    }

    // THE KILL SWITCH (docs/architecture.md). Stops the turn in flight and leaves the
    // session usable, so "stop, that's wrong" can be followed by a correction. Before
    // this, stopping a run meant stopping the daemon — and every other session with it.
    const intMatch = pathname.match(/^\/sessions\/([^/]+)\/interrupt$/);
    if (intMatch && req.method === "POST") {
      const s = sessions.get(decodeURIComponent(intMatch[1]));
      if (!s) return json(res, 404, { error: "session not found" });
      const r = await s.interrupt();
      // 409 for "nothing to interrupt": a statement about state, not a bad request.
      return json(res, r.ok ? 200 : 409, { id: s.id, ...r, status: s.status });
    }

    // Release the process NOW, keeping the conversation. Same thing the idle timer
    // does; exposed because "wait 30 minutes" is not a testable path, and because
    // "I'm done for now, free the RAM" is a real thing to want.
    const hibMatch = pathname.match(/^\/sessions\/([^/]+)\/hibernate$/);
    if (hibMatch && req.method === "POST") {
      const s = sessions.get(decodeURIComponent(hibMatch[1]));
      if (!s) return json(res, 404, { error: "session not found" });
      const r = s.hibernate();
      // 409, not 400: refusing to hibernate a session parked on a decision is a
      // statement about current state, not about a malformed request.
      return json(res, r.ok ? 200 : 409, { id: s.id, ...r, status: s.status });
    }

    // Static PWA LAST, so an API route can never be shadowed by a built file.
    // Handles the app shell, the service worker, and notification deep links.
    if (await serveStatic(req, res, pathname)) return;

    return json(res, 404, { error: "not found", pathname });
  } catch (err) {
    return json(res, 500, { error: String(err?.message ?? err) });
  }
});

// ---- WS /stream/:id : replay history, then live turn/pending/done frames ----
const wss = new WebSocketServer({ noServer: true });
const wsSend = (ws, obj) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj)); };

wss.on("connection", (ws, req) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const m = url.pathname.match(/^\/stream\/([^/]+)$/);
  const s = m ? sessions.get(decodeURIComponent(m[1])) : null;
  if (!s) { wsSend(ws, { type: "error", error: "session not found" }); return ws.close(); }

  // Seed a new viewer with full history and the current pending decision.
  wsSend(ws, { type: "history", total: s.turns.length, turns: s.turns });
  if (s.pending) wsSend(ws, { type: "pending", question: s.pending });
  // Seed the in-flight text too, or a client that connects mid-turn sees nothing until
  // the turn completes — which is the exact stall streaming was added to remove.
  if (s.partial) wsSend(ws, { type: "delta", kind: s.partial.kind, text: "", partial: s.partial });
  // And whether a turn is in flight. Without this a client that connects mid-turn — a
  // notification tap, a reload — cannot know it, and shows a silent screen with no Stop.
  wsSend(ws, { type: "busy", busy: s.busy, since: s.busySince, activityAt: s.activityAt });

  const unsub = s.addListener((evt) => wsSend(ws, evt));
  const ping = setInterval(() => { if (ws.readyState === ws.OPEN) ws.ping(); }, 30000);
  const cleanup = () => { clearInterval(ping); unsub(); };
  ws.on("close", cleanup);
  ws.on("error", cleanup);
});

server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  // Same gate as HTTP — the stream carries the full transcript, so leaving WS open
  // would make the HTTP check cosmetic. A browser can't set headers here, which is
  // exactly why the cookie exists (auth.mjs).
  if (!authorize(req, url).ok) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  if (/^\/stream\/[^/]+$/.test(url.pathname))
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  else socket.destroy();
});

// export the store so an in-process TUI can share sessions without HTTP
export { sessions, server };

/**
 * Boot the daemon. EXPORTED, not just guarded on argv, because a released `loop` is a
 * single compiled binary with no `server.mjs` on disk to spawn — it re-invokes itself as
 * `loop __daemon`, where argv[1] is `__daemon` and an argv-shaped check would silently
 * import this module and never listen (docs/architecture.md). One function, both
 * entry points, no "works from source only" gap.
 */
export async function main() {
  // Auth first: the QR can't be printed without a token, and no request should be
  // served before the gate is armed.
  const authState = await initAuth();
  // Push must be ready before the first session can ask anything.
  const push = await initNotifier().catch((e) => {
    console.error(`[loop-daemon] notifier init failed (push disabled): ${e.message}`);
    return null;
  });
  const web = await webStatus();

  // RESTORE THE FLEET BEFORE THE PORT OPENS (docs/architecture.md). Until this
  // existed, the session registry was an in-memory Map and every restart silently
  // emptied it — including sessions the phone had already been notified about, whose
  // deep links then 404'd. Restored sessions come back HIBERNATED: transcript, no
  // process, and a reply wakes them through the path PROBLEM 15 already measured.
  //
  // Doing it before listen() means no client can ever observe a half-populated fleet.
  await initStore();
  let restored = 0;
  for (const snap of await loadSnapshots()) {
    try {
      const s = Session.fromSnapshot(snap);
      sessions.set(s.id, s);
      attachNotifier(s);
      attachStore(s);
      restored++;
    } catch (e) {
      console.error(`[loop-daemon] could not restore session ${snap?.id}: ${e.message}`);
    }
  }

  server.listen(PORT, HOST, async () => {
    console.log(`[loop-daemon] listening on http://${HOST}:${PORT}`);
    console.log(`[loop-daemon] start a run:  curl -XPOST localhost:${PORT}/sessions -d '{"prompt":"hello"}'`);
    console.log(`[loop-daemon] watch:        ws://${HOST}:${PORT}/stream/<id>`);
    if (push)
      console.log(`[loop-daemon] push ready, ${push.subscriptions} subscription(s)`);
    if (restored)
      console.log(`[loop-daemon] restored ${restored} session(s) from ${snapshotDir()} (sleeping — a reply wakes them)`);
    if (web.serving) console.log(`[loop-daemon] serving PWA from ${web.dir}`);
    else
      console.log(
        `[loop-daemon] no web build at ${web.dir} — API only. Build it with: npm run build:pwa`
      );
    if (authState.enabled) {
      console.log(`[loop-daemon] auth ON (token ${authState.source}); loopback exempt`);
      // The QR is the pairing UX — print it unconditionally so the phone never has
      // to type a .ts.net hostname.
      await printPairingQr({ port: PORT, token: authState.token });
    } else {
      console.log(
        `[loop-daemon] auth DISABLED (LOOP_NO_AUTH=1) — do NOT expose this over Funnel`
      );
      await printPairingQr({ port: PORT, token: null });
    }
  });
}

// Run directly (`node daemon/server.mjs`). The compiled binary calls `main()` itself
// from its `__daemon` subcommand instead, so this guard stays source-only.
if (process.argv[1] && process.argv[1].endsWith("server.mjs")) await main();
