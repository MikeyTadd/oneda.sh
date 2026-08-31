// Shell preferences — the app's own settings, as opposed to any tile's
// data. Stored under one key so they round-trip through sync like
// everything else (docs/DESIGN.md §1, "universal sync — no exceptions"):
// a fresh sign-in on a new device restores these along with the content.
//
// Deliberately tiny. A preference belongs here only once something reads
// it — a control that changes nothing is a screen asking to be trusted
// about the ones that do.

import type { EncryptedStorage } from "../storage/db.js";
import type { SyncQueue } from "../sync/queue.js";

export interface Prefs {
  /** How long an in-app toast stays before withdrawing itself, in ms.
   * 0 means "until dismissed". Read by alerts.ts via configureAlerts(). */
  alertDwellMs: number;
  /** Whether an alert also interrupts with a toast. Off, it still reaches the
   * bell — the record is never the thing being switched off, only the tap on
   * the shoulder. */
  alertToasts: boolean;
  /** How long the app can sit idle in the foreground before it demands a fresh
   * passkey prompt (reauth.ts, design doc section 1a). Only how *long*, never
   * *whether* — the app re-locking on every return to the foreground and after
   * this timeout is the one setting on this screen that isn't optional, since
   * it's the thing that makes the app-level lock mean something independent of
   * the phone's own screen lock. */
  reauthIdleMs: number;
}

export const DEFAULT_PREFS: Prefs = {
  alertDwellMs: 10_000,
  alertToasts: true,
  reauthIdleMs: 60_000,
};

const PREFS_KEY = "shell:prefs";

/** The live copy. Read synchronously by anything painting a control;
 * `loadPrefs()` fills it once at boot before the shell paints. */
export const prefs: Prefs = { ...DEFAULT_PREFS };

let storage: EncryptedStorage | null = null;

export async function loadPrefs(store: EncryptedStorage, sync?: SyncQueue): Promise<void> {
  storage = store;
  const saved = await store.get<Partial<Prefs>>(PREFS_KEY);
  // Merged over the defaults rather than replacing them, so a device on an
  // older build that has never heard of a newer preference still gets its
  // default instead of `undefined`.
  Object.assign(prefs, DEFAULT_PREFS, saved ?? {});

  // A preference changed on another device arrives here, not through setPref (which is
  // only the local-write path) — without this, "no exceptions" would still have one: the
  // device that didn't make the change.
  sync?.onIncoming((record) => {
    if (record.dataNamespace !== "shell" || record.recordId !== "prefs") return;
    void storage!.receiveIncoming<Partial<Prefs>>(record).then((incoming) => {
      Object.assign(prefs, DEFAULT_PREFS, incoming);
      window.dispatchEvent(new CustomEvent("prefs-changed", { detail: {} }));
    });
  });
}

/** Writes one preference and tells the app it moved. The event carries the
 * key, so a listener can repaint only what it owns. */
export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  prefs[key] = value;
  void storage?.put(PREFS_KEY, prefs);
  window.dispatchEvent(new CustomEvent("prefs-changed", { detail: { key } }));
}
