// Service worker: silent push + fetch-and-decrypt pattern (section 6), badging (6.2).
// This file never sees plaintext — pushes carry no content, only a signal to go fetch the
// (still encrypted) update. Decryption happens in the app context, not here, since the
// DEK lives in page memory, not in the service worker's scope.

// Bump on any shell change — that bump is what actually ships a new shell.
const CACHE_NAME = "onedash-shell-v3";
const SHELL_ASSETS = [
  // The lock screen is served at the scope root (public/index.html), which is what
  // manifest.json's start_url points at — not /shell/index.html.
  "/",
  "/shell/auth.js",
  "/shell/manifest.json",
  // Self-hosted Inter. In the precache so the lock screen renders in the
  // app's own type offline, not the system fallback.
  "/fonts/inter-latin.woff2",
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)));
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", (event) => {
  // Only the public shell is safe to cache/serve offline-first; /app/ and /api/ routes are
  // session-gated (section 13.2) and should always hit the network so revocation (9b) and
  // auth state stay authoritative.
  const url = new URL(event.request.url);
  if (!SHELL_ASSETS.includes(url.pathname)) return;

  event.respondWith(caches.match(event.request).then((cached) => cached ?? fetch(event.request)));
});

self.addEventListener("push", (event) => {
  // Generic payload only — "something changed", never content (section 6). The client
  // wakes, fetches the actual encrypted record, and decrypts it locally once the app is in
  // the foreground; this handler just surfaces the OS-level notification and badge nudge.
  event.waitUntil(
    (async () => {
      let count;
      try {
        count = event.data ? event.data.json().unreadCount : undefined;
      } catch {
        count = undefined;
      }

      if (typeof count === "number" && "setAppBadge" in self.navigator) {
        await self.navigator.setAppBadge(count);
      }

      await self.registration.showNotification("onedash", {
        body: "New activity — open the app to view",
        icon: "/icons/icon-192.png",
        tag: "onedash-update",
      });
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil(self.clients.openWindow("/"));
});
