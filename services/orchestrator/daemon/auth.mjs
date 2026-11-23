// Daemon auth — a single shared bearer token, persisted next to the VAPID keypair.
//
// WHY a token at all when `tailscale serve` already authenticates every request to
// a tailnet device (docs/architecture.md):
//   1. Funnel stays a supported mode (`loop share`) and is ANONYMOUS by design.
//      The token is the only thing standing between the public internet and a
//      daemon that auto-allows every tool.
//   2. `serve` authenticates a DEVICE, not a person. Anyone holding an unlocked
//      laptop that's on the tailnet is a valid tailnet device.
//   3. The QR is the pairing UX either way, so carrying a token in it is free.
//
// Three ways to present it, because the transports genuinely differ:
//   - `Authorization: Bearer <t>` / `x-loop-token: <t>`  — normal API calls
//   - `?token=<t>`                                        — the QR link, and WS
//   - `loop_token` cookie                                 — everything after pairing
//
// The cookie exists because **a browser cannot set headers on a WebSocket**. Rather
// than putting the token in every ws:// URL (where it lands in logs and history),
// the first authenticated GET trades `?token=` for an HttpOnly cookie and redirects
// to the clean URL. After that the token is invisible to JS and travels
// automatically on both fetch and the WS handshake.

import { randomBytes, timingSafeEqual } from "node:crypto";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

const STATE_DIR = process.env.LOOP_ENG_DIR ?? join(homedir(), ".loop-eng");
const TOKEN_FILE = join(STATE_DIR, "token");

export const COOKIE_NAME = "loop_token";
const COOKIE_MAX_AGE = 60 * 60 * 24 * 365; // a year; pairing should be a one-time act

let token = null;

/**
 * Load the token, generating one on first run.
 *
 * `LOOP_TOKEN` overrides the file (useful for tests and for a throwaway token).
 * `LOOP_NO_AUTH=1` disables auth entirely — an ESCAPE HATCH, never the default:
 * with Funnel on, that exposes an agent that auto-allows every tool.
 */
export async function initAuth() {
  if (process.env.LOOP_NO_AUTH === "1") {
    token = null;
    return { enabled: false, token: null };
  }
  if (process.env.LOOP_TOKEN) {
    token = process.env.LOOP_TOKEN;
    return { enabled: true, token, source: "env" };
  }
  try {
    const t = (await readFile(TOKEN_FILE, "utf8")).trim();
    if (t) {
      token = t;
      return { enabled: true, token, source: "file" };
    }
  } catch {
    /* first run */
  }
  // 32 bytes of base64url ≈ 256 bits. Unguessable, and short enough to survive a
  // QR at a scannable density.
  token = randomBytes(32).toString("base64url");
  await mkdir(STATE_DIR, { recursive: true });
  await writeFile(TOKEN_FILE, token + "\n", { mode: 0o600 });
  return { enabled: true, token, source: "generated" };
}

export function authEnabled() {
  return token !== null;
}

export function currentToken() {
  return token;
}

/** Length-safe constant-time compare. */
function sameToken(candidate) {
  if (typeof candidate !== "string" || !token) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(token);
  if (a.length !== b.length) return false; // timingSafeEqual throws on length mismatch
  return timingSafeEqual(a, b);
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i < 0) continue;
    out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

/** Pull a presented token out of a request, in order of preference. */
export function presentedToken(req, url) {
  const auth = req.headers.authorization;
  if (auth?.startsWith("Bearer ")) return auth.slice(7).trim();
  const header = req.headers["x-loop-token"];
  if (typeof header === "string" && header) return header;
  const q = url?.searchParams?.get("token");
  if (q) return q;
  const cookie = parseCookies(req.headers.cookie)[COOKIE_NAME];
  if (cookie) return cookie;
  return null;
}

/**
 * Is this request from a process on THIS machine (so already past any boundary a
 * token could add)?
 *
 * THE TRAP THIS ENCODES: `tailscale serve`/`funnel` proxy to 127.0.0.1, so a
 * request from the public internet ALSO arrives with a loopback remote address.
 * Trusting loopback alone would exempt every remote request and silently disable
 * auth completely. The proxy sets `x-forwarded-*` and (for Funnel)
 * `tailscale-funnel-request`, so the presence of ANY forwarding marker disqualifies
 * a request from being treated as local.
 */
export function isLocalRequest(req) {
  const forwarded =
    req.headers["x-forwarded-for"] ||
    req.headers["x-forwarded-proto"] ||
    req.headers["x-forwarded-host"] ||
    req.headers["tailscale-funnel-request"] ||
    req.headers["tailscale-user-login"];
  if (forwarded) return false;
  const ip = req.socket?.remoteAddress ?? "";
  return ip === "127.0.0.1" || ip === "::1" || ip === "::ffff:127.0.0.1";
}

/**
 * Authorize a request. Returns { ok, via, reason }.
 *
 * Loopback is allowed without a token so the TUI, the test suites and
 * tools/browser-check.mjs keep working untouched — they all talk to localhost, and
 * anything running on this machine can read the token file anyway.
 */
export function authorize(req, url) {
  if (!authEnabled()) return { ok: true, via: "disabled" };
  if (isLocalRequest(req)) return { ok: true, via: "loopback" };
  const presented = presentedToken(req, url);
  if (!presented) return { ok: false, reason: "no token" };
  if (!sameToken(presented)) return { ok: false, reason: "bad token" };
  return { ok: true, via: "token" };
}

/** True when the request reached us over TLS (directly or via the Tailscale proxy). */
function isHttps(req) {
  const proto = req.headers["x-forwarded-proto"];
  if (typeof proto === "string") return proto.split(",")[0].trim() === "https";
  return !!req.socket?.encrypted;
}

export function cookieHeader(req) {
  const bits = [
    `${COOKIE_NAME}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    // Lax, not Strict: a notification tap is a top-level cross-site navigation, and
    // Strict would withhold the cookie on exactly that request — the USP's last hop.
    "SameSite=Lax",
    `Max-Age=${COOKIE_MAX_AGE}`,
  ];
  // Only mark Secure on real HTTPS: a Secure cookie is dropped outright over
  // http://<tailscale-ip>:4318, which would break the LAN/tailnet-IP viewer path.
  if (isHttps(req)) bits.push("Secure");
  return bits.join("; ");
}

export function clearCookieHeader() {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
