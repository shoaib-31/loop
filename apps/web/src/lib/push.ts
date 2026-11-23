// Web Push subscription — the phone half of the notification-decision loop.
// The daemon half is services/orchestrator/daemon/notify.mjs; why web push at all
// is documented in docs/architecture.md.
//
// The hard-won iOS constraints this file encodes:
//  - PushManager does not EXIST until the site is installed to the Home Screen.
//    So "unsupported" is usually "not installed yet" — a fixable user step, not a
//    dead end. `pushCapabilities()` distinguishes the two so the UI can say which.
//  - requestPermission() must be called from a real user gesture.
//  - A secure context is mandatory: https or localhost. http://100.x LAN will not
//    work, ever (that's why Tailscale Funnel exists in this design).

import { authHeaders } from './token';

export type PushCapabilities = {
  /** https or localhost. Service workers refuse to run without this. */
  secureContext: boolean;
  /** Launched from the home-screen icon (not a Safari tab). */
  standalone: boolean;
  serviceWorker: boolean;
  pushManager: boolean;
  permission: NotificationPermission | 'unavailable';
  /** True when a subscription can actually be created right now. */
  ready: boolean;
  /** Set when !ready — a plain-language explanation of the blocker. */
  blocker: string | null;
};

/** True on iOS/iPadOS Safari, incl. iPadOS pretending to be a Mac. */
function isAppleMobile(): boolean {
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

export function pushCapabilities(): PushCapabilities {
  const secureContext = window.isSecureContext === true;
  const standalone =
    window.matchMedia?.('(display-mode: standalone)').matches === true ||
    (navigator as { standalone?: boolean }).standalone === true;
  const serviceWorker = 'serviceWorker' in navigator;
  const pushManager = 'PushManager' in window;
  const permission =
    typeof Notification !== 'undefined' ? Notification.permission : 'unavailable';

  // Order matters: report the blocker the user can actually act on FIRST.
  let blocker: string | null = null;
  if (!secureContext) {
    blocker =
      'This page must be served over HTTPS. A plain http:// or LAN address can never receive push.';
  } else if (!serviceWorker) {
    blocker = 'This browser has no service worker support.';
  } else if (!pushManager) {
    // The single most common state, and it LOOKS like a hard failure while being
    // a two-tap fix. Say so explicitly rather than reporting "unsupported".
    blocker = isAppleMobile()
      ? !standalone
        ? 'Tap Share → Add to Home Screen, then open Loop from the icon. iOS only allows notifications for installed apps.'
        : 'Push is unavailable. iOS 16.4 or newer is required.'
      : 'This browser does not support push notifications.';
  } else if (permission === 'denied') {
    blocker =
      'Notifications were blocked. Re-enable them in the system settings for Loop, then try again.';
  }

  return {
    secureContext,
    standalone,
    serviceWorker,
    pushManager,
    permission,
    ready: blocker === null,
    blocker,
  };
}

/**
 * Register the service worker at ROOT scope.
 * Root scope is required: a worker can only control pages beneath its own path,
 * and notification taps must be able to land on any /session/:id route.
 */
export async function registerServiceWorker(): Promise<ServiceWorkerRegistration | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    return await navigator.serviceWorker.register('/sw.js', { scope: '/' });
  } catch (e) {
    console.warn('[push] service worker registration failed', e);
    return null;
  }
}

// base64url (how VAPID keys travel over JSON) -> Uint8Array (what subscribe() demands).
function urlB64ToUint8Array(base64String: string): Uint8Array {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map((c) => c.charCodeAt(0)));
}

function trimBase(base: string): string {
  return base.replace(/\/+$/, '');
}

/** The push subscription this browser already holds, if any. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!('serviceWorker' in navigator)) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration('/');
    return (await reg?.pushManager?.getSubscription?.()) ?? null;
  } catch {
    return null;
  }
}

/**
 * Full subscribe flow. MUST be called from a user gesture (iOS enforces this on
 * requestPermission).
 *
 * Re-registers an EXISTING subscription with the daemon rather than skipping it:
 * the daemon keeps subscriptions in a file that can be deleted, and its VAPID
 * keypair can be regenerated, so the browser and daemon can disagree about who is
 * subscribed. Re-POSTing is idempotent (keyed by endpoint) and self-heals that.
 */
export async function subscribeToPush(base: string): Promise<PushSubscription> {
  const caps = pushCapabilities();
  if (!caps.ready) throw new Error(caps.blocker ?? 'Push is unavailable.');

  const registration =
    (await navigator.serviceWorker.getRegistration('/')) ?? (await registerServiceWorker());
  if (!registration) throw new Error('Could not register the service worker.');

  // Wait for an ACTIVE worker: subscribing against an installing worker can fail.
  await navigator.serviceWorker.ready;

  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(
      permission === 'denied'
        ? 'Notifications were blocked. Re-enable them in system settings for Loop.'
        : 'Notification permission was dismissed.'
    );
  }

  const existing = await registration.pushManager.getSubscription();
  if (existing) {
    await postSubscription(base, existing);
    return existing;
  }

  const res = await fetch(`${trimBase(base)}/vapid-public-key`, {
    credentials: 'include',
    headers: authHeaders(),
  });
  if (res.status === 401) throw new Error('Not paired with the daemon. Re-scan the pairing QR.');
  if (!res.ok) throw new Error(`Daemon has no push key (HTTP ${res.status}).`);
  const { key } = (await res.json()) as { key?: string };
  if (!key) throw new Error('Daemon returned an empty push key.');

  const sub = await registration.pushManager.subscribe({
    // Required. Chrome rejects false outright, and iOS ignores silent push —
    // consistent with the SW always showing a notification.
    userVisibleOnly: true,
    applicationServerKey: urlB64ToUint8Array(key) as BufferSource,
  });

  await postSubscription(base, sub);
  return sub;
}

async function postSubscription(base: string, sub: PushSubscription): Promise<void> {
  const res = await fetch(`${trimBase(base)}/subscribe`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json', ...authHeaders() },
    body: JSON.stringify(sub),
  });
  if (res.status === 401)
    throw new Error('Not paired with the daemon. Re-scan the pairing QR, then try again.');
  if (!res.ok) throw new Error(`Daemon rejected the subscription (HTTP ${res.status}).`);
}

/**
 * Turn notifications off: drop it locally AND tell the daemon.
 * Local unsubscribe happens first and is what the user actually asked for, so a
 * failed daemon call must not surface as an error — the daemon prunes dead
 * endpoints on the next 404/410 from the push service anyway.
 */
export async function unsubscribeFromPush(base: string): Promise<boolean> {
  const sub = await currentSubscription();
  if (!sub) return false;
  const { endpoint } = sub;
  const ok = await sub.unsubscribe().catch(() => false);
  try {
    await fetch(`${trimBase(base)}/unsubscribe`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...authHeaders() },
      body: JSON.stringify({ endpoint }),
    });
  } catch {
    /* best effort; daemon self-heals via 404/410 pruning */
  }
  return ok;
}
