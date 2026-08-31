// Getting new code into a running app, telling the reader about it, and the
// escape hatch for when the answer is "the cache is why".
//
// Adapted from the sibling project's sw-update.js (F1 Apex), with onedash's own
// storage in the reset: it keeps every record in IndexedDB, which that app has
// nothing equivalent to, and holds a session cookie the page can't clear itself.
//
// The manifest says `display: standalone`, so an installed app has no browser
// chrome — on iOS there is no reload button at all, and the only way to pick up
// new code is to kill the app from the switcher. The shell therefore has to
// notice its own updates and offer the refresh itself.
//
// The sequence: a new sw.js installs and waits (it does not call skipWaiting), a
// sticky alert goes up, and the reader's tap posts SKIP_WAITING. The new worker
// activates, `controllerchange` fires, and the page reloads once. Nothing
// reloads on its own — a page that vanishes mid-sentence is worse than one
// running last week's build, and a reload loop in an app with no address bar can
// only be escaped by deleting it.

import { alert } from "./alerts.js";

/** The browser refetches sw.js on its own schedule, which can be a day. */
const UPDATE_CHECK_MS = 15 * 60 * 1000;
/** How long to wait for the new worker to take over before reloading anyway. */
const TAKEOVER_GRACE_MS = 4000;
/** How long an on-demand check waits for a new worker to finish installing. */
const INSTALL_GRACE_MS = 8000;

let lastUpdateCheck = 0;
let updateOffered = false;
let accepted = false;
let reloading = false;

function reloadOnce(): void {
  if (reloading) return;
  reloading = true;
  location.reload();
}

/**
 * Which build this device is actually running, or null.
 *
 * Read from the shell cache's name rather than a constant, because sw.js's
 * CACHE_NAME *is* the deploy mechanism for the public half and is therefore the
 * one version that cannot be stale. It is also the version this device is
 * running rather than the newest one deployed, which is the distinction that
 * matters the moment something is behaving oddly.
 */
export async function shellVersion(): Promise<string | null> {
  try {
    if (!("caches" in window)) return null;
    const keys = await caches.keys();
    return keys.find((key) => key.startsWith("onedash-shell-"))?.slice("onedash-shell-".length) ?? null;
  } catch {
    return null;
  }
}

export function watchForUpdates(): void {
  if (!("serviceWorker" in navigator)) return;

  void navigator.serviceWorker
    .getRegistration()
    .then((registration) => registration ?? navigator.serviceWorker.register("/sw.js"))
    .then(watch)
    .catch(() => {});

  // Reload only where this tab's own reader accepted. Whether a document is
  // controlled at script time races with clients.claim(), so "was there a
  // controller before?" is not a sound test for first-install-versus-update —
  // but "did someone tap Refresh here?" always is.
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (accepted) reloadOnce();
  });
}

function watch(registration: ServiceWorkerRegistration | undefined): void {
  if (!registration) return;
  lastUpdateCheck = Date.now();

  // Updated while the app was closed: the new worker is already waiting.
  if (registration.waiting && navigator.serviceWorker.controller) {
    offerUpdate(registration.waiting);
  }

  registration.addEventListener("updatefound", () => {
    const incoming = registration.installing;
    if (!incoming) return;
    incoming.addEventListener("statechange", () => {
      if (incoming.state === "installed" && navigator.serviceWorker.controller) {
        offerUpdate(incoming);
      }
    });
  });

  // A phone that spends a week in a pocket is exactly the case that misses a
  // fix, so re-check whenever the app comes back to the foreground.
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    if (Date.now() - lastUpdateCheck < UPDATE_CHECK_MS) return;
    lastUpdateCheck = Date.now();
    registration.update().catch(() => {});
  });
}

/**
 * A waiting update, told through the same channel as everything else rather than
 * as its own popup in the corner — two different-looking notices arriving
 * together makes the reader work out which one is the app itself talking.
 *
 * Sticky: it shows as a toast for as long as any alert does, then waits in the
 * bell until Refresh is pressed. It cannot be dismissed, because a stray tap
 * treating dismissal as a final answer leaves a device on old code with nothing
 * left to remind it.
 */
function offerUpdate(worker: ServiceWorker): void {
  // Once per page life; the alert persists in the bell, so re-raising it on
  // every check would only shuffle its position in the list.
  if (updateOffered) return;
  updateOffered = true;

  alert({
    source: "app-update",
    title: "A new version is ready",
    detail: "Refresh to pick up the latest build.",
    sticky: true,
    action: { label: "Refresh", onClick: () => applyUpdate(worker) },
  });
}

/** Hand over to a waiting worker and reload onto it. */
export function applyUpdate(worker: ServiceWorker): void {
  accepted = true;
  worker.postMessage({ type: "SKIP_WAITING" });
  // If the handover is slow or the message is lost, reload anyway rather than
  // leave the button stuck — the reader already asked for this, and a worker
  // still waiting afterwards simply offers again.
  setTimeout(reloadOnce, TAKEOVER_GRACE_MS);
}

export type UpdateCheck =
  | { state: "unsupported" }
  | { state: "current" }
  | { state: "ready"; worker: ServiceWorker };

/**
 * Ask now rather than on the browser's schedule — "am I actually on the newest
 * build?" is otherwise unanswerable from inside an app with no address bar.
 */
export async function checkForUpdate(): Promise<UpdateCheck> {
  if (!("serviceWorker" in navigator)) return { state: "unsupported" };
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) return { state: "unsupported" };

  lastUpdateCheck = Date.now();
  await registration.update().catch(() => {});

  if (registration.waiting) return { state: "ready", worker: registration.waiting };

  // A worker the check just found is still downloading and parsing; give it a
  // moment rather than reporting "up to date" about the build we just fetched.
  const installing = registration.installing;
  if (installing) {
    const settled = await new Promise<boolean>((resolve) => {
      const done = (): void => {
        if (installing.state === "installed" || installing.state === "activated") resolve(true);
        else if (installing.state === "redundant") resolve(false);
      };
      installing.addEventListener("statechange", done);
      setTimeout(() => resolve(false), INSTALL_GRACE_MS);
      done();
    });
    if (settled && registration.waiting) return { state: "ready", worker: registration.waiting };
  }

  return { state: "current" };
}

/**
 * Everything this app has put on this device, gone, then a reload onto a cold
 * start: every encrypted record in IndexedDB, the preferences and nav order and
 * alert history with them, the cached shell, the service worker itself, and the
 * session — so the next thing seen is the lock screen.
 *
 * The session has to be ended by the server: its cookie is HttpOnly, which is
 * the point of it, and a reset that left the device still signed in would be
 * exactly the wrong kind of half-done. Awaited but never allowed to block — a
 * last resort that stalls on a network call is not a last resort.
 */
export async function resetApp(): Promise<void> {
  await fetch("/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});

  // Where every tile's records live (../storage/db.ts). The one deletion that
  // actually matters here; the rest is cache.
  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase("onedash");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      // Another tab holding the database open blocks the delete indefinitely.
      request.onblocked = () => resolve();
      setTimeout(resolve, 3000);
    } catch {
      resolve();
    }
  });

  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // Private mode, or storage disabled. Nothing to clear.
  }

  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
  }

  if ("caches" in window) {
    await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
  }

  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister()));
  }

  // Not reloadOnce(): that guard stops a handover reloading twice, and this is a
  // deliberate restart that was asked for.
  location.replace("/");
}
