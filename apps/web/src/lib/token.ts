// Client-side token handling for the cross-origin case.
//
// In the SHIPPING setup this file barely matters: the daemon serves the app, pairing
// sets an HttpOnly cookie, and the browser attaches it automatically. HttpOnly means
// JS cannot read it — which is the point, and why there is nothing to store.
//
// It exists for the case the cookie can't cover: the Vite dev server on :8082 talking
// to a daemon on a different origin. A cookie set by the daemon is not sent by
// default from another origin, and Safari's storage partitioning can drop it even
// with credentials: "include". So a token pasted in Settings is kept here and sent as
// a header instead.
//
// Deliberately localStorage and NOT part of the pairing path: on the same-origin
// install we strip ?token= server-side (302 + Set-Cookie) precisely so the token
// never reaches JS or the URL bar of an installed PWA.

const TOKEN_KEY = 'loopeng.token';

export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null; // Safari private mode
  }
}

export function saveToken(token: string): void {
  const cleaned = token.trim();
  try {
    if (cleaned) localStorage.setItem(TOKEN_KEY, cleaned);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* private mode — nothing we can do, the cookie path still works */
  }
}

/** Header form, for fetch. Empty when we have no token (the normal installed case). */
export function authHeaders(): Record<string, string> {
  const t = getToken();
  return t ? { 'x-loop-token': t } : {};
}

/**
 * Query-string form, for WebSocket only.
 *
 * A browser cannot set headers on a WebSocket, so the ONLY ways to authenticate the
 * handshake are a cookie or the URL. Cookie is preferred and needs nothing here;
 * this is the cross-origin fallback.
 */
export function tokenQuery(): string {
  const t = getToken();
  return t ? `token=${encodeURIComponent(t)}` : '';
}

/**
 * If we were opened from a QR link that still has ?token= in it, capture and strip it.
 *
 * Normally the daemon redirects first and JS never sees a token. This is the belt-and-
 * braces path for when it can't — e.g. the QR was opened against the dev server.
 * Stripping via replaceState matters on iOS: Add to Home Screen captures the CURRENT
 * URL, so a lingering token would be baked into the installed app forever.
 */
export function captureTokenFromUrl(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    const t = url.searchParams.get('token');
    if (!t) return;
    saveToken(t);
    url.searchParams.delete('token');
    window.history.replaceState({}, '', url.pathname + (url.search || '') + url.hash);
  } catch {
    /* malformed URL — nothing to capture */
  }
}
