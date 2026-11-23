// Serves the exported PWA from the daemon itself.
//
// WHY the daemon hosts the app rather than a separate web server: web push forces
// same-origin (docs/architecture.md).
//   1. The service worker must be at ROOT scope to control /session/:id, and a
//      worker can only be served from the origin it controls.
//   2. `/subscribe` + `/vapid-public-key` must be reachable from that origin.
//   3. Tailscale Funnel exposes exactly ONE origin, so app and API
//      cannot be split across two.
// Together those mean one origin serving both, which means the daemon.
//
// Build the app first:  npm run build:pwa   (vite build -> apps/web/dist)
// Static files are opt-in: if dist/ is missing, the daemon still runs its API and
// simply reports the app as unavailable. That keeps the TUI path working with no
// web build present.

import { createReadStream } from "node:fs";
import { stat, readFile } from "node:fs/promises";
import { join, extname, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
// daemon/ -> orchestrator/ -> services/ -> repo root -> apps/web/dist
const DEFAULT_ROOT = resolve(HERE, "../../../apps/web/dist");
const ROOT = process.env.LOOP_WEB_DIR ? resolve(process.env.LOOP_WEB_DIR) : DEFAULT_ROOT;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
};

let available = null; // lazily probed once

export async function webRoot() {
  if (available === null) {
    try {
      available = (await stat(join(ROOT, "index.html"))).isFile();
    } catch {
      available = false;
    }
  }
  return available ? ROOT : null;
}

function cacheControl(pathname, ext) {
  // The service worker MUST NOT be cached. A stale sw.js is effectively permanent
  // (the browser keeps serving the old worker), which would freeze the push code
  // path at whatever shipped first — the worst possible thing to get stuck.
  if (pathname === "/sw.js") return "no-store";
  // Same for the manifest and HTML: cheap, and they define install behaviour.
  if (ext === ".html" || ext === ".webmanifest") return "no-cache";
  // Vite emits content-hashed filenames under /assets/, so those are immutable.
  if (pathname.startsWith("/assets/")) return "public, max-age=31536000, immutable";
  return "public, max-age=3600";
}

/**
 * Try to serve `pathname` as a static file.
 * Returns true if the response was handled, false to let the API router continue.
 *
 * Static serving runs LAST in the request chain, so an API route can never be
 * shadowed by a file of the same name.
 */
export async function serveStatic(req, res, pathname) {
  const root = await webRoot();
  if (!root) return false;
  if (req.method !== "GET" && req.method !== "HEAD") return false;

  const filePath = safeJoin(root, pathname);
  // Path traversal: refuse anything that escaped the root.
  if (!filePath) {
    res.writeHead(403).end("forbidden");
    return true;
  }

  let target = filePath;
  let info = await stat(target).catch(() => null);
  if (info?.isDirectory()) {
    target = join(target, "index.html");
    info = await stat(target).catch(() => null);
  }

  // Unknown path: fall back to the deep-link handler below.
  if (!info?.isFile()) return serveFallback(req, res, root, pathname);

  return sendFile(req, res, target, pathname, info);
}

/**
 * Deep-link fallback — the SPA rewrite. Vite builds ONE index.html and the router
 * reads the path at runtime, so /session/abc123 (what a tapped notification opens)
 * matches no file on disk and must be answered with the app shell.
 *
 * Serving it with 200 rather than 404 is deliberate: that URL genuinely IS the app,
 * and a 404 on the notification deep-link target would look like a broken link.
 *
 * A path with a file extension is NOT rewritten. If a hashed asset is missing (a
 * stale service worker asking for a chunk from an older build), returning HTML
 * under a .js/.css request produces a MIME error that reads like a corrupt build;
 * a plain 404 is both truthful and debuggable.
 */
async function serveFallback(req, res, root, pathname) {
  if (extname(pathname)) return false; // asset-looking request → let it 404

  const shell = safeJoin(root, "/index.html");
  if (!shell) return false;
  const info = await stat(shell).catch(() => null);
  if (!info?.isFile()) return false;
  return sendFile(req, res, shell, "/index.html", info);
}

function sendFile(req, res, filePath, pathname, info) {
  const ext = extname(filePath).toLowerCase();
  const headers = {
    "content-type": MIME[ext] ?? "application/octet-stream",
    "content-length": info.size,
    "cache-control": cacheControl(pathname, ext),
  };
  // The service worker is only allowed to control "/" if served from root — which
  // it is — but state this explicitly so a future move to a subpath fails loudly
  // rather than silently breaking push.
  if (pathname === "/sw.js") headers["service-worker-allowed"] = "/";

  res.writeHead(200, headers);
  if (req.method === "HEAD") {
    res.end();
    return true;
  }
  createReadStream(filePath).pipe(res);
  return true;
}

// Resolve a URL path inside root, refusing traversal. Returns null if it escapes.
function safeJoin(root, pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (decoded.includes("\0")) return null;
  const p = resolve(join(root, normalize(decoded)));
  if (p !== root && !p.startsWith(root + sep)) return null;
  return p;
}

/** One-line startup diagnostic: is the PWA actually being served? */
export async function webStatus() {
  const root = await webRoot();
  if (!root) return { serving: false, dir: ROOT };
  let version = null;
  try {
    const html = await readFile(join(root, "index.html"), "utf8");
    version = /<title>([^<]*)<\/title>/.exec(html)?.[1] ?? null;
  } catch { /* not important */ }
  return { serving: true, dir: root, title: version };
}
