// Persistent app config — just the daemon base URL (a non-secret settings string).
//
// Much simpler than the React Native version this replaces: localStorage is
// SYNCHRONOUS, so there's no async hydration and no `loading` state to gate
// screens on. The value is known on the first render.
//
// Still a module-level store behind useSyncExternalStore rather than per-screen
// state, so saving in Settings updates every mounted consumer at once.

import { useCallback, useSyncExternalStore } from 'react';

const BASE_URL_KEY = 'loopeng.agentBaseUrl';

// When the PWA is served BY the daemon (the shipping setup — one Tailscale Funnel
// port serves both app and API), the daemon's address is by definition where we
// were loaded from. Defaulting to it means the phone needs NO configuration:
// install from the QR and it's already connected.
//
// Same-origin isn't just convenience, it's required for push — the service worker
// must be root-scope on this origin and /subscribe must be reachable from it
// (docs/architecture.md).
//
// Skipped on the Vite dev server (:8082), which serves the app but has no API.
function originBaseUrl(): string | null {
  if (typeof window === 'undefined' || !window.location?.origin) return null;
  const { origin, port } = window.location;
  if (port === '8082') return null; // dev server — daemon lives elsewhere
  return origin.replace(/\/+$/, '');
}

function read(): string | null {
  try {
    // A stored value always wins: it's an explicit user choice (e.g. pointing the
    // dev-server app at a Mac on the tailnet) and must not be silently overridden.
    return localStorage.getItem(BASE_URL_KEY) ?? originBaseUrl();
  } catch {
    // Safari in private mode can throw on localStorage access.
    return originBaseUrl();
  }
}

let snapshot: string | null = read();
const listeners = new Set<() => void>();

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

// Must stay referentially stable — returning a fresh object each call would spin
// useSyncExternalStore forever.
const getSnapshot = () => snapshot;

export function saveBaseUrl(url: string): void {
  const cleaned = url.trim().replace(/\/+$/, '');
  try {
    localStorage.setItem(BASE_URL_KEY, cleaned);
  } catch {
    /* private mode — keep it in memory for this session at least */
  }
  snapshot = cleaned;
  for (const l of listeners) l();
}

export function useBaseUrl() {
  const baseUrl = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  const setBaseUrl = useCallback((url: string) => saveBaseUrl(url), []);
  return { baseUrl, setBaseUrl };
}

export function getBaseUrl(): string | null {
  return snapshot;
}
