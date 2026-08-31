// Post-auth bundle entry point. `public/shell/auth.js` dynamically imports
// this module as `/app/main.js` on a successful passkey ceremony and calls
// `start()` — see docs/DESIGN.md §13.1. This file wires the DEK, storage and
// sync layers together and hands off to the shell (shell.ts) once they're
// ready; it owns no UI of its own.

import { createEncryptedStorage } from "../storage/db.js";
import { createSyncQueue } from "../sync/queue.js";
import { mountShell } from "./shell.js";

export interface StartOptions {
  /** Already unwrapped by the caller (public/shell/auth.js) before this bundle was even
   * fetched — deriving the master key and unwrapping/generating the DEK has to happen
   * pre-auth regardless (registration must send a wrapped DEK in the same request that
   * proves the passkey, section 2.3), so it lives in the pre-auth bundle rather than here.
   * This module never touches the master key or the wrapping step, only the result. */
  dek: CryptoKey;
}

export async function start({ dek }: StartOptions): Promise<void> {
  // Before anything paints: the shell must never be visible unstyled, and the
  // lock screen's own stylesheet must not survive into it (see below).
  await loadShellStylesheet();

  // Follow the page's own scheme rather than hardcoding wss: — over plain http (a local
  // `wrangler dev` run) a wss: URL fails the TLS handshake and the sync socket never opens.
  const wsScheme = location.protocol === "https:" ? "wss" : "ws";
  const syncQueue = createSyncQueue(`${wsScheme}://${location.host}/sync`);
  // Threaded through so every put() also reaches every other device (universal sync,
  // section 1) — see storage/db.ts.
  const storage = createEncryptedStorage(dek, syncQueue);

  await mountShell(document.body, { storage, syncQueue });
  dropLockScreenStyles();
}

/** The pre-auth lock screen styles itself from an inline <style> in
 * public/index.html. mountShell replaces the body, but that block lives in the
 * head and outlives it — and it is not scoped, so its `.mark` (a 64px centred
 * squircle) and its `body` (a centred, non-scrolling flex box) go on applying
 * to the app underneath the real stylesheet. The rail's brand mark wearing
 * `margin: 0 auto` is what gave this away. The block has done its job by the
 * time the shell is up, so it goes. */
function dropLockScreenStyles(): void {
  document.getElementById("lock-css")?.remove();
}

/** The pre-auth shell (public/shell/index.html) links no post-auth CSS —
 * shell.css only matters once this bundle has loaded, so it's pulled in
 * here rather than paid for by every anonymous visitor. Served from the
 * same session-gated route as this module (serveGatedBundle,
 * src/worker/index.ts), built alongside it by scripts/build-app.mjs. */
function loadShellStylesheet(): Promise<void> {
  if (document.getElementById("shell-css")) return Promise.resolve();
  return new Promise((resolve) => {
    const link = document.createElement("link");
    link.id = "shell-css";
    link.rel = "stylesheet";
    link.href = "/app/shell.css";
    // Resolve either way: a stylesheet that fails to load is a broken-looking
    // app, but hanging here would be a blank one.
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => resolve(), { once: true });
    document.head.appendChild(link);
  });
}
