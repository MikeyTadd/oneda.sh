// Shell preferences — the app's own settings, as opposed to any tile's
// data. Stored under one key so they round-trip through sync like
// everything else (docs/DESIGN.md §1, "universal sync — no exceptions"):
// a fresh sign-in on a new device restores these along with the content.
//
// Deliberately tiny. A preference belongs here only once something reads
// it — a control that changes nothing is a screen asking to be trusted
// about the ones that do.

import type { EncryptedStorage } from "../storage/db.js";

export interface Prefs {
  /** How long an in-app toast stays before withdrawing itself, in ms.
   * 0 means "until dismissed". Read by alerts.ts via configureAlerts(). */
  alertDwellMs: number;
}

export const DEFAULT_PREFS: Prefs = {
  alertDwellMs: 10_000,
};

const PREFS_KEY = "shell:prefs";

/** The live copy. Read synchronously by anything painting a control;
 * `loadPrefs()` fills it once at boot before the shell paints. */
export const prefs: Prefs = { ...DEFAULT_PREFS };

let storage: EncryptedStorage | null = null;

export async function loadPrefs(store: EncryptedStorage): Promise<void> {
  storage = store;
  const saved = await store.get<Partial<Prefs>>(PREFS_KEY);
  // Merged over the defaults rather than replacing them, so a device on an
  // older build that has never heard of a newer preference still gets its
  // default instead of `undefined`.
  Object.assign(prefs, DEFAULT_PREFS, saved ?? {});
}

/** Writes one preference and tells the app it moved. The event carries the
 * key, so a listener can repaint only what it owns. */
export function setPref<K extends keyof Prefs>(key: K, value: Prefs[K]): void {
  prefs[key] = value;
  void storage?.put(PREFS_KEY, prefs);
  window.dispatchEvent(new CustomEvent("prefs-changed", { detail: { key } }));
}
