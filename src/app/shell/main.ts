// Post-auth bundle entry point. `public/shell/auth.js` dynamically imports
// this module as `/app/main.js` on a successful passkey ceremony and calls
// `start()` — see docs/DESIGN.md §13.1. This file wires the DEK, storage and
// sync layers together and hands off to the shell (shell.ts) once they're
// ready; it owns no UI of its own.

import { generateDek } from "../crypto/keys.js";
import { createEncryptedStorage } from "../storage/db.js";
import { createSyncQueue } from "../sync/queue.js";
import { mountShell } from "./shell.js";

export async function start(): Promise<void> {
  // TODO: the real flow unwraps the account's persisted DEK via
  // unwrapDek(wrapped, iv, masterKey), where wrapped/iv come from the
  // server (issued at registration, section 2.3) and masterKey from
  // deriveMasterKey(credentialId) using this device's passkey. Neither the
  // wrapped-DEK fetch nor the credential id are threaded through yet —
  // finishRegistration/finishAuthentication in src/worker/index.ts are
  // still `501 not implemented` stubs. Generating a fresh, unpersisted DEK
  // here is a scaffold placeholder so the shell is exercisable before that
  // lands; it must not survive to a real build; a fresh DEK every page load
  // makes today's local storage unreadable on the next visit, which is
  // expected until the real key path exists.
  const dek = await generateDek();

  const storage = createEncryptedStorage(dek);
  const syncQueue = createSyncQueue(`wss://${location.host}/sync`);

  await mountShell(document.body, { storage, syncQueue });

  loadShellStylesheet();
}

/** The pre-auth shell (public/shell/index.html) links no post-auth CSS —
 * shell.css only matters once this bundle has loaded, so it's pulled in
 * here rather than paid for by every anonymous visitor. Served from the
 * same session-gated route as this module once serveGatedBundle
 * (src/worker/index.ts) actually streams bundle assets; today that route
 * still answers 404, so this is inert until that lands. */
function loadShellStylesheet(): void {
  if (document.getElementById("shell-css")) return;
  const link = document.createElement("link");
  link.id = "shell-css";
  link.rel = "stylesheet";
  link.href = "/app/shell.css";
  document.head.appendChild(link);
}
