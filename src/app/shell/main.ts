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
  const storage = createEncryptedStorage(dek);
  const syncQueue = createSyncQueue(`wss://${location.host}/sync`);

  await mountShell(document.body, { storage, syncQueue });

  loadShellStylesheet();
}

/** The pre-auth shell (public/shell/index.html) links no post-auth CSS —
 * shell.css only matters once this bundle has loaded, so it's pulled in
 * here rather than paid for by every anonymous visitor. Served from the
 * same session-gated route as this module (serveGatedBundle,
 * src/worker/index.ts), built alongside it by scripts/build-app.mjs. */
function loadShellStylesheet(): void {
  if (document.getElementById("shell-css")) return;
  const link = document.createElement("link");
  link.id = "shell-css";
  link.rel = "stylesheet";
  link.href = "/app/shell.css";
  document.head.appendChild(link);
}
