// Post-auth shell navigation.
//
// One saved order drives both the desktop rail (every destination) and the
// phone's bottom bar (the first BAR_SLOTS, the rest behind More) — so a
// phone and a laptop signed into the same account never disagree about what
// "third" means. The pattern — one order, two renderings, Settings pinned
// out of that order rather than sorted into it — is adapted from the shell
// of a sibling project (F1 Apex); this file is oneda's own implementation
// of that shape against oneda's own model (installed tiles), not a copy of
// its code.
//
// Unlike that sibling project, oneda's destinations are not a fixed list —
// they are whatever tiles the tile registry (../tiles/registry.ts) has
// installed, in that registry's own order (section 4.2 of docs/DESIGN.md).
// So there is no static NAV array here: buildNav() derives destinations
// from the installed tile manifests each time the registry changes.

import type { EncryptedStorage } from "../storage/db.js";
import type { TileManifest } from "../tiles/types.js";

/** How many installed tiles the phone's bottom bar shows before More. */
export const BAR_SLOTS = 4;

export interface NavDestination {
  id: string;
  label: string;
  icon: string;
  pinned?: boolean;
}

/**
 * Settings is not a tile — it is the app's own settings screen (device
 * list, passkeys, integrations, the "which tiles are installed" editor
 * itself). It is `pinned`: never in `defaultOrder()`, so `order()` can
 * never place it on the bar or make it the front door, and a reorder can
 * never move it. It is the screen you open once and then not again for
 * weeks, and a screen that moves is a screen you have to look for — the
 * same reasoning the sibling project's shell.md documents for its own
 * pinned Settings entry.
 */
export const SETTINGS: NavDestination = {
  id: "settings",
  label: "Settings",
  icon: "settings",
  pinned: true,
};

/** Every destination the nav can hold this session: one entry per
 * installed tile, in registry order, plus Settings. */
export function buildNav(tiles: TileManifest[]): NavDestination[] {
  return [...tiles.map((t) => ({ id: t.id, label: t.name, icon: t.icon })), SETTINGS];
}

export const navById = (nav: NavDestination[], id: string): NavDestination | null =>
  nav.find((d) => d.id === id) ?? null;

/** The order shipped to an account with nothing saved yet: installed tiles,
 * in registry order. Settings is never in it — pinned ids are never in the
 * default order, which is what makes them unmovable. */
export function defaultOrder(tiles: TileManifest[]): string[] {
  return tiles.map((t) => t.id);
}

/**
 * The saved order, repaired against this session's actual installed tiles.
 *
 * Two repairs, both routine rather than exceptional: a device synced before
 * a tile was installed is missing its id (appended, at the end — the same
 * place a tile nobody has arranged yet belongs); a device synced after a
 * tile was uninstalled carries an id this session no longer has (dropped).
 * Settings is "unknown" to this function by construction, since it is never
 * in `defaultOrder()` — so an order saved before Settings was pinned has it
 * silently dropped here, the same repair as any other unknown id, not a
 * special case.
 */
export function order(saved: string[] | undefined, tiles: TileManifest[]): string[] {
  const def = defaultOrder(tiles);
  const known = new Set(def);
  const seen = new Set<string>();
  const out: string[] = [];

  for (const id of Array.isArray(saved) ? saved : []) {
    if (!known.has(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  for (const id of def) {
    if (!seen.has(id)) out.push(id);
  }
  return out;
}

/** The destinations on the phone's bar, and the ones behind More. */
export function split(orderedIds: string[]): { bar: string[]; more: string[] } {
  return { bar: orderedIds.slice(0, BAR_SLOTS), more: orderedIds.slice(BAR_SLOTS) };
}

/** Where the app opens. `order()` has already dropped anything this session
 * doesn't have, so the first id is always real; Settings is the fallback
 * only for the (transient, first-run) case of no tiles installed at all —
 * the app must never open on nothing. */
export function defaultRoute(orderedIds: string[]): string {
  return orderedIds[0] ?? SETTINGS.id;
}

const NAV_ORDER_KEY = "shell:nav-order";

/** Nav order is the user's own arrangement, so it syncs like any other
 * account state (docs/DESIGN.md §1, "if it can sync, it syncs") — stored
 * under a fixed key alongside the tile registry itself
 * (`shell:tile-registry` in ../tiles/registry.ts), not per-device. */
export async function loadNavOrder(storage: EncryptedStorage): Promise<string[] | undefined> {
  return storage.get<string[]>(NAV_ORDER_KEY);
}

export async function saveNavOrder(storage: EncryptedStorage, ids: string[]): Promise<void> {
  await storage.put(NAV_ORDER_KEY, ids);
}
