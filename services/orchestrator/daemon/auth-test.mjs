// Verifies the auth gate. This is the ONLY thing standing between the public
// internet and a daemon that auto-allows every tool (docs/architecture.md), so
// the negative cases matter more than the positive ones.
//
// Uses a throwaway LOOP_ENG_DIR: writing to the real ~/.loop-eng/ could clobber the
// VAPID keypair the actual phone's subscription depends on.
//
// Run: node services/orchestrator/daemon/auth-test.mjs

import { createServer } from "node:http";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer } from "ws";

const stateDir = mkdtempSync(join(tmpdir(), "loop-auth-"));
process.env.LOOP_ENG_DIR = stateDir;
delete process.env.LOOP_TOKEN;
delete process.env.LOOP_NO_AUTH;

const auth = await import("./auth.mjs");
const { initAuth, authorize, authEnabled, currentToken, cookieHeader, isLocalRequest, COOKIE_NAME } =
  auth;

let pass = 0;
let fail = 0;
function check(name, cond, detail = "") {
  if (cond) {
    pass++;
    console.log(`  PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail++;
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

console.log("\nTOKEN BOOTSTRAP");
const state = await initAuth();
check("auth enabled on first run", state.enabled === true && authEnabled());
check("token generated", state.source === "generated" && typeof state.token === "string");
check("token is long enough to resist guessing", state.token.length >= 40, `${state.token.length} chars`);
check("token persisted to LOOP_ENG_DIR", readFileSync(join(stateDir, "token"), "utf8").trim() === state.token);
check(
  "token file is 0600 (not world-readable)",
  (statSync(join(stateDir, "token")).mode & 0o077) === 0,
  (statSync(join(stateDir, "token")).mode & 0o777).toString(8)
);

const TOKEN = currentToken();

// ---- unit-level: the loopback-vs-proxy distinction, the trap worth a test ----
console.log("\nLOOPBACK DETECTION (the proxy trap)");
const fakeReq = (headers = {}, ip = "127.0.0.1") => ({ headers, socket: { remoteAddress: ip } });
check("bare loopback is local", isLocalRequest(fakeReq()) === true);
check("LAN address is not local", isLocalRequest(fakeReq({}, "192.168.1.9")) === false);
// THE important one: tailscale serve/funnel proxy to 127.0.0.1, so a remote request
// arrives from loopback. If forwarding markers didn't disqualify it, auth would be
// silently OFF for the entire internet.
check(
  "loopback + x-forwarded-for is NOT local (proxied remote)",
  isLocalRequest(fakeReq({ "x-forwarded-for": "1.2.3.4" })) === false
);
check(
  "loopback + tailscale-funnel-request is NOT local",
  isLocalRequest(fakeReq({ "tailscale-funnel-request": "true" })) === false
);
check(
  "loopback + x-forwarded-proto is NOT local",
  isLocalRequest(fakeReq({ "x-forwarded-proto": "https" })) === false
);

console.log("\nTOKEN COMPARISON");
const u = new URL("http://x/");
const remote = (headers) => ({ headers: { "x-forwarded-for": "1.2.3.4", ...headers }, socket: { remoteAddress: "127.0.0.1" } });
check("correct bearer accepted", authorize(remote({ authorization: `Bearer ${TOKEN}` }), u).ok === true);
check("correct x-loop-token accepted", authorize(remote({ "x-loop-token": TOKEN }), u).ok === true);
check("correct cookie accepted", authorize(remote({ cookie: `${COOKIE_NAME}=${TOKEN}` }), u).ok === true);
check(
  "query token accepted (the QR + WS path)",
  authorize(remote({}), new URL(`http://x/?token=${TOKEN}`)).ok === true
);
check("missing token rejected", authorize(remote({}), u).ok === false);
check("wrong token rejected", authorize(remote({ "x-loop-token": "nope" }), u).ok === false);
check(
  "token prefix rejected (no partial match)",
  authorize(remote({ "x-loop-token": TOKEN.slice(0, -1) }), u).ok === false
);
check(
  "token with extra char rejected",
  authorize(remote({ "x-loop-token": TOKEN + "x" }), u).ok === false
);
check("empty bearer rejected", authorize(remote({ authorization: "Bearer " }), u).ok === false);

console.log("\nCOOKIE FLAGS");
{
  const httpsCookie = cookieHeader({ headers: { "x-forwarded-proto": "https" }, socket: {} });
  check("HttpOnly (unreadable from JS)", /HttpOnly/.test(httpsCookie));
  // Lax not Strict: a notification tap is a top-level cross-site navigation and
  // Strict would withhold the cookie on exactly that request — the USP's last hop.
  check("SameSite=Lax, not Strict", /SameSite=Lax/.test(httpsCookie));
  check("Secure over https", /Secure/.test(httpsCookie));
  const httpCookie = cookieHeader({ headers: {}, socket: {} });
  check("NOT Secure over plain http (else it's silently dropped)", !/Secure/.test(httpCookie));
}

// ---- integration: a real server with the real gate + WS upgrade ----
console.log("\nHTTP + WS GATE (live server)");
const wss = new WebSocketServer({ noServer: true });
wss.on("connection", (ws) => ws.send(JSON.stringify({ type: "hello" })));

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const a = authorize(req, url);
  if (!a.ok) {
    res.writeHead(401, { "content-type": "application/json" }).end('{"error":"unauthorized"}');
    return;
  }
  if (url.searchParams.has("token") && a.via === "token") {
    const clean = new URL(url);
    clean.searchParams.delete("token");
    res.writeHead(302, {
      location: clean.pathname + (clean.search || "") || "/",
      "set-cookie": cookieHeader(req),
    });
    return res.end();
  }
  res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true, via: a.via }));
});
server.on("upgrade", (req, socket, head) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (!authorize(req, url).ok) {
    socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
    return socket.destroy();
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const port = server.address().port;
const base = `http://127.0.0.1:${port}`;

// Loopback with no token: must pass, or the TUI/tests/browser-check all break.
{
  const res = await fetch(`${base}/health`);
  const body = await res.json();
  check("loopback needs no token", res.status === 200 && body.via === "loopback");
}
// Simulated remote (forwarding header present) — the real gate.
{
  const res = await fetch(`${base}/health`, { headers: { "x-forwarded-for": "1.2.3.4" } });
  check("remote without token -> 401", res.status === 401);
}
{
  const res = await fetch(`${base}/health`, {
    headers: { "x-forwarded-for": "1.2.3.4", "x-loop-token": TOKEN },
  });
  check("remote with token -> 200", res.status === 200);
}

console.log("\nQR PAIRING HANDOFF");
{
  const res = await fetch(`${base}/?token=${TOKEN}`, {
    headers: { "x-forwarded-for": "1.2.3.4" },
    redirect: "manual",
  });
  const setCookie = res.headers.get("set-cookie") ?? "";
  check("?token= redirects (302)", res.status === 302);
  // iOS bakes start_url in at Add-to-Home-Screen time, so the token MUST be gone
  // from the URL before the user can install.
  check("redirect target has no token", (res.headers.get("location") ?? "") === "/");
  check("redirect sets the cookie", setCookie.includes(`${COOKIE_NAME}=`));
  check("cookie is HttpOnly", /HttpOnly/.test(setCookie));
}

console.log("\nWEBSOCKET (cannot send headers — cookie or query only)");
const wsTry = (path, headers = {}) =>
  new Promise(async (resolve) => {
    const { WebSocket } = await import("ws");
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, { headers });
    const done = (v) => { try { ws.close(); } catch { /* already gone */ } resolve(v); };
    ws.on("message", () => done("open"));
    ws.on("error", () => done("rejected"));
    setTimeout(() => done("timeout"), 2000);
  });

check(
  "WS from remote without token is rejected",
  (await wsTry("/stream/x", { "x-forwarded-for": "1.2.3.4" })) === "rejected"
);
check(
  "WS with ?token= is accepted",
  (await wsTry(`/stream/x?token=${TOKEN}`, { "x-forwarded-for": "1.2.3.4" })) === "open"
);
check(
  "WS with cookie is accepted (the installed-app path)",
  (await wsTry("/stream/x", {
    "x-forwarded-for": "1.2.3.4",
    cookie: `${COOKIE_NAME}=${TOKEN}`,
  })) === "open"
);
check(
  "WS with a WRONG token is rejected",
  (await wsTry("/stream/x?token=wrong", { "x-forwarded-for": "1.2.3.4" })) === "rejected"
);

console.log("\nESCAPE HATCH");
{
  // A separate module instance, because token state is module-level.
  process.env.LOOP_NO_AUTH = "1";
  const fresh = await import(`./auth.mjs?nocache=${pass}`);
  const s = await fresh.initAuth();
  check("LOOP_NO_AUTH=1 disables auth", s.enabled === false);
  check(
    "disabled auth lets a remote request through",
    fresh.authorize(remote({}), u).ok === true
  );
  delete process.env.LOOP_NO_AUTH;
}

server.close();
wss.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\n❌ FAIL");
  process.exit(1);
}
console.log("\n✅ ALL CHECKS PASSED");
