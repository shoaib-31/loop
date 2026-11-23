// Verifies the daemon serves the PWA correctly. This is load-bearing for push:
// get the service worker scope or cache headers wrong and notifications break in
// ways that look like daemon bugs (docs/architecture.md).
//
// Runs against a temp dir shaped like a real `vite build` output, so it needs no
// web build and stays fast.
//
// Run: node services/orchestrator/daemon/static-test.mjs

import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Point the static server at our fixture BEFORE importing it (read at module load).
const root = mkdtempSync(join(tmpdir(), "loop-web-"));
process.env.LOOP_WEB_DIR = root;

// Mirror the real Vite layout: ONE index.html for every route (the router resolves
// the path at runtime) plus content-hashed files under assets/.
mkdirSync(join(root, "assets"), { recursive: true });
writeFileSync(join(root, "index.html"), "<html>INDEX</html>");
writeFileSync(join(root, "sw.js"), "// service worker");
writeFileSync(join(root, "manifest.webmanifest"), "{}");
writeFileSync(join(root, "assets/index-abc123.js"), "// bundle");
writeFileSync(join(root, "assets/index-abc123.css"), "/* styles */");

const { serveStatic, webStatus } = await import("./static.mjs");

// Minimal host: static only, so any 404 means "static declined" — exactly how the
// real server treats it (API routes run first and win).
const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (await serveStatic(req, res, url.pathname)) return;
  res.writeHead(404, { "content-type": "application/json" }).end('{"error":"not found"}');
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${server.address().port}`;

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

const get = async (path, init) => {
  const res = await fetch(`${base}${path}`, init);
  return { res, body: await res.text() };
};

console.log("\nDISCOVERY");
const status = await webStatus();
check("reports serving from the fixture dir", status.serving === true, status.dir);

console.log("\nAPP SHELL + ROUTES");
{
  const { res, body } = await get("/");
  check("/ serves index.html", res.status === 200 && body.includes("INDEX"));
  check("/ is html", (res.headers.get("content-type") ?? "").startsWith("text/html"));
}
{
  const { res, body } = await get("/settings");
  check("/settings serves the app shell (client-routed)",
    res.status === 200 && body.includes("INDEX"));
}

console.log("\nSERVICE WORKER (push depends on these exactly)");
{
  const { res } = await get("/sw.js");
  check("sw.js is served", res.status === 200);
  // A cached sw.js is effectively permanent — the browser keeps the old worker.
  check("sw.js is no-store", res.headers.get("cache-control") === "no-store",
    String(res.headers.get("cache-control")));
  // Without root scope the worker cannot control /session/:id, so taps break.
  check("sw.js allows root scope", res.headers.get("service-worker-allowed") === "/");
  check("sw.js is javascript",
    (res.headers.get("content-type") ?? "").includes("javascript"));
}
{
  const { res } = await get("/manifest.webmanifest");
  // Wrong MIME here and iOS may refuse to treat the site as installable.
  check("manifest has manifest+json type",
    (res.headers.get("content-type") ?? "").includes("application/manifest+json"),
    String(res.headers.get("content-type")));
}

console.log("\nDEEP LINKS (the notification tap target)");
{
  const { res, body } = await get("/session/abc123");
  check("/session/<id> serves the app shell", body.includes("INDEX"));
  // Must be 200: a 404 on the notification target reads as a broken link, and the
  // real route is resolved client-side from the URL.
  check("/session/<id> returns 200, not 404", res.status === 200, `got ${res.status}`);
}
{
  const { res, body } = await get("/session/deeply/nested/unknown");
  check("unknown deep path still returns the app, not an error",
    res.status === 200 && body.includes("INDEX"));
}
{
  // A missing hashed asset must NOT be rewritten to HTML: a stale service worker
  // requesting an old chunk would get a MIME error that looks like a corrupt
  // build. A truthful 404 is what makes that debuggable.
  const { res } = await get("/assets/index-GONE999.js");
  check("missing hashed asset 404s instead of returning HTML", res.status === 404,
    `got ${res.status}`);
}

console.log("\nCACHING");
{
  const { res } = await get("/assets/index-abc123.js");
  check("hashed bundle is immutable",
    (res.headers.get("cache-control") ?? "").includes("immutable"),
    String(res.headers.get("cache-control")));
  check("hashed bundle is javascript",
    (res.headers.get("content-type") ?? "").includes("javascript"));
}
{
  const { res } = await get("/assets/index-abc123.css");
  check("hashed css is immutable + css type",
    (res.headers.get("cache-control") ?? "").includes("immutable") &&
      (res.headers.get("content-type") ?? "").includes("text/css"));
}
{
  const { res } = await get("/");
  check("index.html is no-cache", res.headers.get("cache-control") === "no-cache",
    String(res.headers.get("cache-control")));
}

console.log("\nSECURITY (the daemon is exposed via a PUBLIC Funnel)");
for (const attack of [
  "/%2e%2e%2f%2e%2e%2fetc/passwd",
  "/..%2f..%2f..%2fetc/passwd",
  "/%00",
]) {
  const { res, body } = await get(attack);
  // Either refuse it or serve the app shell — never file contents from outside root.
  const leaked = body.includes("root:") || body.includes("/bin/");
  check(`no traversal leak: ${attack}`, !leaked, `status ${res.status}`);
}

console.log("\nMETHODS");
{
  const { res } = await get("/", { method: "HEAD" });
  check("HEAD / returns 200 with no body", res.status === 200);
}
{
  const { res } = await get("/", { method: "POST" });
  // POST must fall through so it can't shadow an API route of the same path.
  check("POST / is declined by static (falls through)", res.status === 404);
}

server.close();
console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) {
  console.log("\n❌ FAIL");
  process.exit(1);
}
console.log("\n✅ ALL CHECKS PASSED");
