// Pairing — print a QR the phone scans to install the PWA already authenticated.
//
// The whole point: auth must cost the user ZERO extra steps (docs/architecture.md
// Typing a long `*.ts.net` hostname on a phone keyboard is worse UX than no auth at
// all, so the token rides inside the QR:
//
//     https://<host>/?token=<t>
//
// The daemon then trades `?token=` for an HttpOnly cookie on first load, so the
// token disappears from the URL bar before the user ever installs to the Home Screen
// (see server.mjs). That matters: iOS captures start_url at install time, and a
// token baked into the installed app's URL would be permanent.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Ask Tailscale for this machine's stable HTTPS name.
 *
 * Stable, NOT random: it's derived from machine name + tailnet name, and `serve` and
 * `funnel` both publish the SAME name. That's what lets the PWA survive switching
 * between them — same origin means the install, service worker and push
 * subscription all keep working.
 */
export async function tailscaleHost() {
  try {
    const { stdout } = await run("tailscale", ["status", "--json"], { timeout: 5000 });
    const status = JSON.parse(stdout);
    const dns = status?.Self?.DNSName;
    if (dns) return dns.replace(/\.$/, ""); // trailing dot is a valid FQDN, bad in a URL
    return status?.CertDomains?.[0] ?? null;
  } catch {
    return null; // Tailscale absent or down — fall back to a LAN/localhost URL
  }
}

/** Which sharing mode is live: "funnel" (public), "serve" (tailnet), or null. */
export async function tailscaleMode() {
  try {
    const { stdout } = await run("tailscale", ["serve", "status"], { timeout: 5000 });
    if (/Funnel on/i.test(stdout)) return "funnel";
    if (/proxy\s+http/i.test(stdout)) return "serve";
    return null;
  } catch {
    return null;
  }
}

/**
 * The URL to pair with. Prefers the Tailscale HTTPS name because push REQUIRES a
 * secure context — an http:// LAN address can never register a service worker, so a
 * QR pointing at one would produce an app that loads but can never notify.
 */
export async function pairingUrl({ port, token, host = null }) {
  const ts = host ?? (await tailscaleHost());
  const base = ts ? `https://${ts}` : `http://localhost:${port}`;
  return token ? `${base}/?token=${encodeURIComponent(token)}` : `${base}/`;
}

/**
 * Print the pairing QR to the terminal.
 *
 * `qrcode`'s terminal renderer uses half-block characters, which stay scannable in a
 * normal-width terminal — an ASCII "██" QR at this payload size wraps and becomes
 * unscannable.
 */
export async function printPairingQr({ port, token, host = null } = {}) {
  const url = await pairingUrl({ port, token, host });
  const mode = await tailscaleMode();

  let qr = null;
  try {
    const QRCode = (await import("qrcode")).default;
    qr = await QRCode.toString(url, { type: "terminal", small: true, errorCorrectionLevel: "L" });
  } catch {
    /* qrcode missing — still print the URL, which is the load-bearing part */
  }

  const lines = [];
  lines.push("");
  lines.push("  ── pair your phone ──────────────────────────────");
  if (qr) lines.push(qr);
  lines.push(`  ${url}`);
  lines.push("");
  if (mode === "funnel")
    lines.push("  exposure: FUNNEL — PUBLIC internet. Token required. `tailscale funnel reset` when done.");
  else if (mode === "serve")
    lines.push("  exposure: SERVE — your tailnet only. Phone needs the Tailscale app, connected.");
  else
    lines.push("  exposure: LOCAL only — run `tailscale serve --bg " + port + "` to reach your phone.");
  if (!token) lines.push("  auth: DISABLED (LOOP_NO_AUTH=1)");
  lines.push("  ─────────────────────────────────────────────────");
  lines.push("");
  console.log(lines.join("\n"));
  return url;
}
