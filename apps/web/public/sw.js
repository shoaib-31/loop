// Loop service worker — the receiving half of the USP (buzz → tap → answer).
// Receives web-push events and deep-links notification taps into a session.
//
// Deliberately does NO fetch/offline caching. Its only job is push + click routing.
// A caching SW here would be a liability: this app is a live view of a running
// agent, so a stale cached shell is worse than a slow load, and cache bugs would
// be indistinguishable from daemon bugs while we're still proving the loop.
//
// MUST be served from ROOT scope with `cache-control: no-store` — a SW registered
// at /sw.js can only control pages under its own path, and we need all of "/".

self.addEventListener("install", () => {
  // Take over immediately rather than waiting for the old worker to die.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("push", (event) => {
  // A malformed/absent payload must STILL produce a visible notification: on iOS a
  // push that displays nothing can get the site's push permission revoked outright.
  let data = { title: "Loop", body: "A decision is waiting.", url: "/" };
  try {
    if (event.data) data = { ...data, ...event.data.json() };
  } catch {
    if (event.data) data.body = event.data.text();
  }

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      // Carry the deep-link target through to the click handler.
      data: { url: data.url },
      // tag + renotify: a second decision in the SAME session replaces the older
      // banner instead of stacking, but still buzzes. Per-session tags come from
      // the daemon (`loop-<sessionId>`).
      tag: data.tag || "loop-decision",
      renotify: true,
      // No `actions`: iOS does not support notification buttons (measured), and
      // AskUserQuestion option descriptions are far too long for a banner anyway.
      // The design is buzz → tap → answer in-app.
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const target = event.notification.data?.url || "/";

  // Land the tap INSIDE the app on the right session. Focus an existing window if
  // there is one (iOS standalone usually keeps one alive), else open fresh.
  event.waitUntil(
    (async () => {
      const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
      for (const client of all) {
        if ("focus" in client) {
          // navigate() can reject (cross-origin, or a client we don't control).
          // Focus is the part that must not be lost, so swallow navigate errors.
          if ("navigate" in client) await client.navigate(target).catch(() => {});
          return client.focus();
        }
      }
      return self.clients.openWindow(target);
    })()
  );
});
