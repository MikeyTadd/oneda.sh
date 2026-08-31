// Post-auth shell chrome: builds the desktop rail / phone tab bar from the
// tile registry's saved order, mounts every installed tile into its own
// view, wires the bell + toast system, and switches which markup is live
// at the 900px breakpoint.
//
// Structure is adapted from a sibling project's PWA shell (F1 Apex) — one
// saved order painting two navs, Settings pinned outside that order and
// hand-placed in fixed chrome, a shared sheet/dialog for every popup, a
// bell fed by a generic alert queue — written fresh here against oneda's
// tile model rather than copied from that project.

import type { EncryptedStorage } from "../storage/db.js";
import type { SyncQueue, SyncStatus } from "../sync/queue.js";
import { loadRegistry, loadTile, mountInstalledTiles } from "../tiles/registry.js";
import type { TileManifest } from "../tiles/types.js";
import { configureAlerts, connectAlerts } from "./alerts.js";
import { watchAlerts } from "./bell.js";
import { appendChildren, el, forEachEl } from "./dom.js";
import { ICONS, iconSvg } from "./icons.js";
import { openMoreSheet, type NavEditDeps } from "./nav-edit.js";
import { buildNav, defaultRoute, loadNavOrder, navById, order, saveNavOrder, split, type NavDestination } from "./nav.js";
import { loadPrefs, prefs } from "./prefs.js";
import { renderSettings } from "./settings.js";

/** The app's name, in the one place the shell prints it. */
const APP_NAME = "oneda";

export interface ShellDeps {
  storage: EncryptedStorage;
  syncQueue: SyncQueue;
}

/** Builds the shell chrome into `root` (normally `document.body`), mounts
 * every installed tile, and wires up routing, the bell and toasts. Call
 * once after the DEK is available (never before the app-level unlock). */
export async function mountShell(root: HTMLElement, deps: ShellDeps): Promise<void> {
  const registryEntries = await loadRegistry({ storage: deps.storage, syncQueue: deps.syncQueue, dataNamespace: "shell" });
  const tileIds = [...registryEntries].sort((a, b) => a.order - b.order).map((e) => e.tileId);

  // The registry only stores ids + order (../tiles/registry.ts); manifests
  // (name/icon/encryptionTier) come from the loaded tile modules themselves,
  // so the nav needs the same lazy-import the mount pass already does.
  const manifests: TileManifest[] = [];
  for (const id of tileIds) {
    try {
      manifests.push(await loadTile(id));
    } catch {
      // An id the registry names but this build can't load (removed tile,
      // bad id) — order()'s repair drops anything unknown to it, so this
      // tile simply doesn't reach the nav rather than crashing the shell.
    }
  }

  const nav = buildNav(manifests);
  const saved = await loadNavOrder(deps.storage);
  // The one mutable copy of the order. The editor writes through
  // `navEdit.setOrder` below rather than to its own copy, so the navs, the
  // router's fallback and the Settings screen can never drift apart.
  let orderedIds = order(saved, manifests);

  buildChrome(root);

  const container = document.getElementById("views")!;
  await mountInstalledTiles(container, { storage: deps.storage, syncQueue: deps.syncQueue }, registryEntries);
  // mountInstalledTiles marks each section with data-tile-id and
  // data-encryption-tier but knows nothing about routing — that's this
  // shell's concern, so the view-toggling class is added here.
  forEachEl(container.querySelectorAll<HTMLElement>("[data-tile-id]"), (section) => section.classList.add("view"));

  const navEdit: NavEditDeps = {
    nav,
    manifests,
    getOrder: () => orderedIds,
    setOrder: (ids) => {
      orderedIds = ids;
      void saveNavOrder(deps.storage, ids);
      paintNav(nav, orderedIds);
      markCurrentTab(currentRoute);
      // Both navs have just been rebuilt, so anything painted from the
      // order repaints too — Settings' navigation block listens for this.
      window.dispatchEvent(new CustomEvent("nav-changed"));
    },
  };

  const settingsView = el("section.view#view-settings", { "data-tile-id": "settings" });
  container.appendChild(settingsView);
  renderSettings(settingsView, { ...navEdit, appName: APP_NAME });

  // onStatus fires immediately with the current value, so the chip is never
  // blank waiting for the first change.
  deps.syncQueue.onStatus(paintConnection);

  paintNav(nav, orderedIds);
  wireRouter(nav, () => orderedIds);
  wireLayoutSwitch();
  wireMoreSheet(navEdit);

  await loadPrefs(deps.storage);
  configureAlerts({ dwellMs: prefs.alertDwellMs, toasts: prefs.alertToasts });
  window.addEventListener("prefs-changed", (event) => {
    const key = (event as CustomEvent<{ key?: string }>).detail?.key;
    if (!key || key === "alertDwellMs") configureAlerts({ dwellMs: prefs.alertDwellMs, toasts: prefs.alertToasts });
  });
  await connectAlerts(deps.storage);
  watchAlerts();

  navigate(location.hash.replace(/^#\/?/, "") || defaultRoute(orderedIds));
}

/** Whether the sync socket is up, said in the chrome rather than left to be
 * inferred from data quietly going stale. Built once per layout — both are in
 * the DOM at all times and only one of them is visible, so the chip is
 * duplicated rather than moved. Wears the system's pill, with its states mapped
 * onto the ones it already has: green up, amber trying, red down. */
function connectionChip(where: "rail" | "appbar"): HTMLElement {
  const chip = el(`span.live-pill#conn-${where}`, { role: "status", "aria-live": "polite" });
  appendChildren(chip, el("span.bulb"), el("span.conn-label", { text: "" }));
  return chip;
}

const CONNECTION_COPY: Record<SyncStatus, { cls: string; label: string }> = {
  online: { cls: "live", label: "Connected" },
  connecting: { cls: "hold", label: "Connecting" },
  offline: { cls: "red", label: "Offline" },
};

function paintConnection(status: SyncStatus): void {
  const { cls, label } = CONNECTION_COPY[status];
  forEachEl(document.querySelectorAll<HTMLElement>("#conn-rail, #conn-appbar"), (chip) => {
    chip.className = `live-pill ${cls}`;
    chip.title = `Connection: ${label}`;
    const text = chip.querySelector(".conn-label");
    if (text) text.textContent = label;
  });
}

function buildChrome(root: HTMLElement): void {
  root.innerHTML = "";

  const shell = el("div#shell");

  const rail = el("nav#rail", { "aria-label": "Primary" });
  const railBrand = el("div.rail-brand");
  appendChildren(railBrand, connectionChip("rail"));
  appendChildren(rail, railBrand, el("div.rail-nav#rail-nav"));

  const railFoot = el("div.rail-foot");
  const customiseBtn = el("button.rail-edit#rail-edit", { type: "button" });
  customiseBtn.innerHTML = iconSvg(ICONS.more ?? "", "ico");
  appendChildren(customiseBtn, el("span", { text: "Customise navigation" }));
  const settingsLink = el("a.rail-edit.rail-cog", { href: "#/settings", "data-tab": "settings" });
  settingsLink.innerHTML = iconSvg(ICONS.settings ?? "", "ico");
  appendChildren(settingsLink, el("span", { text: "Settings" }));
  appendChildren(railFoot, customiseBtn, settingsLink);
  appendChildren(rail, railFoot);

  const main = el("div#shell-main");

  // Phone app bar: brand mark, title, the bell beside the Settings gear —
  // never instead of it, since the gear is the one route to Settings that
  // holds however the nav order is arranged (nav.ts).
  const appbarWrap = el("div.bar-wrap#appbar-wrap");
  const appbar = el("header#appbar");
  const who = el("div.bar-who");
  appendChildren(who, el("span.context#appbar-context", { text: "" }), el("span.title#appbar-title", { text: "" }));
  const appbarBell = el("button.bar-bell#appbar-bell", { type: "button", "aria-label": "Alerts" });
  const gear = el("a.bar-bell", { href: "#/settings", "aria-label": "Settings" });
  gear.innerHTML = iconSvg(ICONS.settings ?? "", "ico");
  appendChildren(appbar, who, connectionChip("appbar"), appbarBell, gear);
  appendChildren(appbarWrap, appbar);

  // Desktop top bar: no gear here (Settings is a rail destination), so the
  // bell has the corner to itself.
  const topbarWrap = el("div.bar-wrap#topbar-wrap");
  const topbar = el("div#topbar");
  const topWho = el("div.bar-who");
  appendChildren(topWho, el("span.context#topbar-context", { text: "" }), el("span.title#topbar-title", { text: "" }));
  const topbarBell = el("button.bar-bell#topbar-bell", { type: "button", "aria-label": "Alerts" });
  appendChildren(topbar, topWho, el("span.grow"), topbarBell);
  appendChildren(topbarWrap, topbar);

  const views = el("main#views");

  appendChildren(main, appbarWrap, topbarWrap, views);

  const tabbar = el("nav#tabbar", { "aria-label": "Primary" });

  appendChildren(shell, rail, main);
  appendChildren(root, shell, tabbar);
}

/** Paints both navs from the saved order — the rail lists every
 * destination, the bar shows the first BAR_SLOTS and hands the rest to
 * More. Settings is never painted from here: it lives in the rail's foot
 * and, on a phone, the More sheet's own fixed row (openMoreSheet). */
function paintNav(nav: NavDestination[], orderedIds: string[]): void {
  const rail = document.getElementById("rail-nav")!;
  rail.innerHTML = "";
  if (orderedIds.length === 0) {
    appendChildren(rail, el("div.rail-nav-empty", { text: "No tiles installed yet" }));
  }
  for (const id of orderedIds) {
    const dest = navById(nav, id);
    if (!dest) continue;
    const link = el("a", { href: `#/${dest.id}`, "data-tab": dest.id });
    link.innerHTML = iconSvg(ICONS[dest.icon] ?? ICONS.tile ?? "", "ico");
    appendChildren(link, el("span", { text: dest.label }));
    rail.appendChild(link);
  }

  const tabbar = document.getElementById("tabbar")!;
  tabbar.innerHTML = "";
  const { bar, more } = split(orderedIds);
  for (const id of bar) {
    const dest = navById(nav, id);
    if (!dest) continue;
    const link = el("a.tab", { href: `#/${dest.id}`, "data-tab": dest.id });
    link.innerHTML = iconSvg(ICONS[dest.icon] ?? ICONS.tile ?? "", "ico");
    appendChildren(link, el("span", { text: dest.label }));
    tabbar.appendChild(link);
  }
  // More is always present, even with nothing behind it — it is also the
  // phone's only route to Settings and to the order editor, so a bar that
  // filled every slot would otherwise be a bar you could never change back.
  const moreTab = el("button.tab.tab-more", { type: "button", "aria-haspopup": "dialog" });
  moreTab.innerHTML = iconSvg(ICONS.more ?? "", "ico");
  appendChildren(moreTab, el("span", { text: "More" }));
  moreTab.dataset.moreCount = String(more.length);
  tabbar.appendChild(moreTab);
}

/** Which nav entry is lit. Split out of navigate() because a reorder has
 * to re-mark without navigating — the route has not changed, but the
 * elements carrying the mark have all just been replaced. A route the
 * phone's bar cannot show lights More instead, so the bar is never left
 * claiming you are nowhere. */
function markCurrentTab(route: string | null): void {
  if (!route) return;
  let onBar = false;
  forEachEl(document.querySelectorAll<HTMLElement>("[data-tab]"), (link) => {
    if (link.dataset.tab === route) {
      link.setAttribute("aria-current", "page");
      if (link.classList.contains("tab")) onBar = true;
    } else {
      link.removeAttribute("aria-current");
    }
  });
  const more = document.querySelector<HTMLElement>(".tab-more");
  if (more) {
    if (onBar) more.removeAttribute("aria-current");
    else more.setAttribute("aria-current", "page");
  }
}

let currentRoute: string | null = null;

/** The small uppercase line above the title — what this screen is *of*, where
 * that is a fact worth a row of its own. Empty collapses the bar back to a
 * single line, which is what most screens want. */
export function setBarContext(text: string): void {
  forEachEl(document.querySelectorAll<HTMLElement>("#appbar-context, #topbar-context"), (c) => {
    c.textContent = text;
  });
}

function navigate(route: string): void {
  currentRoute = route;
  forEachEl(document.querySelectorAll<HTMLElement>("#views .view"), (section) => {
    section.classList.toggle("active", section.dataset.tileId === route);
  });
  const label = document.querySelector<HTMLElement>(`[data-tab="${route}"] span`)?.textContent ?? route;
  forEachEl(document.querySelectorAll<HTMLElement>("#appbar-title, #topbar-title"), (t) => {
    t.textContent = label;
  });
  // Read off the view rather than pushed by it, so it can't be left behind on a
  // screen that has nothing to say: a view that wants a context line declares one
  // (data-context) and every other route clears it by having none.
  const view = document.querySelector<HTMLElement>(`#views .view[data-tile-id="${route}"]`);
  setBarContext(view?.dataset.context ?? "");
  markCurrentTab(route);
  if (location.hash !== `#/${route}`) location.hash = `#/${route}`;
}

/** `getOrder` rather than a snapshot: the fallback route is the first
 * entry in the *current* order, so a reorder moves the front door with it
 * instead of stranding the router on the order that existed at boot. */
function wireRouter(nav: NavDestination[], getOrder: () => string[]): void {
  window.addEventListener("hashchange", () => {
    const route = location.hash.replace(/^#\/?/, "") || defaultRoute(getOrder());
    if (navById(nav, route)) navigate(route);
  });
}

/** Render different DOM per layout from JS, not CSS alone: a dense tile
 * grid collapsing to a single phone column is a re-render, not a reflow,
 * for the same reason the sibling shell's docs give — CSS can restyle a row
 * but not restructure it. Kept minimal here since no tile needs it yet;
 * this is the hook a future dense tile (e.g. a table view) attaches to. */
function wireLayoutSwitch(): void {
  const mq = window.matchMedia("(min-width: 900px)");
  const onChange = () => document.body.classList.toggle("is-desktop", mq.matches);
  mq.addEventListener("change", onChange);
  onChange();
}

/** The rail's "Customise navigation" button goes straight to the editor —
 * a desktop rail shows every destination, so it has no overflow list to
 * offer. The phone's More tab opens the overflow sheet, with the editor
 * one row further down it. Both live in ./nav-edit.ts. */
function wireMoreSheet(navEdit: NavEditDeps): void {
  document.getElementById("rail-edit")?.addEventListener("click", () => {
    openMoreSheet(navEdit, { straightToEditor: true });
  });
  document.getElementById("tabbar")?.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest(".tab-more");
    if (target) openMoreSheet(navEdit);
  });
}
