// Post-auth shell chrome: builds the desktop rail / phone tab bar from the
// tile registry's saved order, mounts every installed tile into its own
// view, and switches which markup is live at the 900px breakpoint.
//
// Structure is adapted from a sibling project's PWA shell (F1 Apex) — one
// saved order painting two navs, Settings pinned outside that order and
// hand-placed in fixed chrome — written fresh here against oneda's tile
// model rather than copied from that project.
//
// Uses appendChild()/forEach() rather than Element.append() or a for-of
// over a NodeList: this project's tsconfig pulls in @cloudflare/workers-
// types globally (needed for the Worker half of the codebase), and that
// package's HTMLRewriter typings declare their own ambient `Element`,
// which merges into and shadows lib.dom's `Element.append()` signature.
// The existing client code (../tiles/notes/index.ts) already works around
// this the same way.

import type { EncryptedStorage } from "../storage/db.js";
import type { SyncQueue } from "../sync/queue.js";
import { loadRegistry, loadTile, mountInstalledTiles } from "../tiles/registry.js";
import type { TileManifest } from "../tiles/types.js";
import { buildNav, defaultRoute, loadNavOrder, navById, order, split, SETTINGS, type NavDestination } from "./nav.js";
import { ICONS, iconSvg, MARK_SVG } from "./icons.js";

export interface ShellDeps {
  storage: EncryptedStorage;
  syncQueue: SyncQueue;
}

/** Builds the shell chrome into `root` (normally `document.body`), mounts
 * every installed tile, and wires up routing. Call once after the DEK is
 * available (never before the app-level unlock). */
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
  const orderedIds = order(saved, manifests);

  buildChrome(root, orderedIds);

  const container = document.getElementById("views")!;
  await mountInstalledTiles(container, { storage: deps.storage, syncQueue: deps.syncQueue }, registryEntries);
  // mountInstalledTiles marks each section with data-tile-id and
  // data-encryption-tier but knows nothing about routing — that's this
  // shell's concern, so the view-toggling class is added here.
  forEachEl(container.querySelectorAll<HTMLElement>("[data-tile-id]"), (section) => section.classList.add("view"));

  const settingsView = el("section.view#view-settings", { "data-tile-id": "settings" });
  appendChildren(settingsView, renderSettingsPlaceholder());
  container.appendChild(settingsView);

  paintNav(nav, orderedIds);
  wireRouter(nav, orderedIds);
  wireLayoutSwitch();
  wireMoreSheet(nav, orderedIds, deps.storage);

  navigate(location.hash.replace(/^#\/?/, "") || defaultRoute(orderedIds));
}

function buildChrome(root: HTMLElement, orderedIds: string[]): void {
  root.innerHTML = "";

  const shell = el("div#shell");

  const rail = el("nav#rail", { "aria-label": "Primary" });
  const railBrand = el("div.rail-brand");
  railBrand.innerHTML = MARK_SVG;
  appendChildren(railBrand, el("span", { text: "oneda" }));
  appendChildren(rail, railBrand, el("div.rail-nav#rail-nav"));

  const railFoot = el("div.rail-foot");
  const customiseBtn = el("button#rail-customise", { type: "button" });
  customiseBtn.innerHTML = iconSvg(ICONS.more ?? "", "ico");
  appendChildren(customiseBtn, el("span", { text: "Customise navigation" }));
  const settingsLink = el("a", { href: "#/settings", "data-tab": "settings" });
  settingsLink.innerHTML = iconSvg(ICONS.settings ?? "", "ico");
  appendChildren(settingsLink, el("span", { text: "Settings" }));
  appendChildren(railFoot, customiseBtn, settingsLink);
  appendChildren(rail, railFoot);

  const main = el("div#shell-main");

  const appbarWrap = el("div.bar-wrap#appbar-wrap");
  const appbar = el("header#appbar");
  const brand = el("a.brand", { href: "#/" + defaultRoute(orderedIds), "aria-label": "Home" });
  brand.innerHTML = MARK_SVG;
  const who = el("div.bar-who");
  appendChildren(who, el("span.title#appbar-title", { text: "" }));
  const bell = el("a", { href: "#/settings", "aria-label": "Settings" });
  bell.innerHTML = iconSvg(ICONS.settings ?? "", "ico");
  appendChildren(appbar, brand, who, bell);
  appendChildren(appbarWrap, appbar);

  const topbarWrap = el("div.bar-wrap#topbar-wrap");
  const topbar = el("div#topbar");
  const topWho = el("div.bar-who");
  appendChildren(topWho, el("span.title#topbar-title", { text: "" }));
  appendChildren(topbar, topWho);
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
 * and, on a phone, the More sheet's own fixed row (wireMoreSheet). */
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

function markCurrentTab(route: string): void {
  forEachEl(document.querySelectorAll<HTMLElement>("[data-tab]"), (link) => {
    if (link.dataset.tab === route) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  });
}

function navigate(route: string): void {
  forEachEl(document.querySelectorAll<HTMLElement>("#views .view"), (section) => {
    section.classList.toggle("active", section.dataset.tileId === route);
  });
  const label = document.querySelector<HTMLElement>(`[data-tab="${route}"] span`)?.textContent ?? route;
  forEachEl(document.querySelectorAll<HTMLElement>("#appbar-title, #topbar-title"), (t) => {
    t.textContent = label;
  });
  markCurrentTab(route);
  if (location.hash !== `#/${route}`) location.hash = `#/${route}`;
}

function wireRouter(nav: NavDestination[], orderedIds: string[]): void {
  window.addEventListener("hashchange", () => {
    const route = location.hash.replace(/^#\/?/, "") || defaultRoute(orderedIds);
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

function wireMoreSheet(nav: NavDestination[], orderedIds: string[], storage: EncryptedStorage): void {
  document.getElementById("rail-customise")?.addEventListener("click", () => openMoreSheet(nav, orderedIds, storage));
  document.getElementById("tabbar")?.addEventListener("click", (e) => {
    const target = (e.target as HTMLElement).closest(".tab-more");
    if (target) openMoreSheet(nav, orderedIds, storage);
  });
}

function openMoreSheet(nav: NavDestination[], orderedIds: string[], storage: EncryptedStorage): void {
  document.getElementById("more-sheet")?.remove();

  const dialog = el("dialog.sheet#more-sheet") as HTMLDialogElement;
  const inner = el("div.sheet-inner");
  const head = el("div.sheet-head");
  const close = el("button.sheet-close", { type: "button", "aria-label": "Close" });
  close.textContent = "✕";
  close.addEventListener("click", () => dialog.close());
  appendChildren(head, el("h2", { text: "More" }), close);

  const scroll = el("div.sheet-scroll");
  const { more } = split(orderedIds);
  for (const id of more) {
    const dest = navById(nav, id);
    if (!dest) continue;
    const row = el("a.sheet-row", { href: `#/${dest.id}` });
    row.innerHTML = iconSvg(ICONS[dest.icon] ?? ICONS.tile ?? "", "ico");
    appendChildren(row, el("span", { text: dest.label }));
    row.addEventListener("click", () => dialog.close());
    scroll.appendChild(row);
  }
  // Settings is pinned — never in `orderedIds` — so it is a hand-written
  // row here, under the same "This app" framing the desktop rail's foot
  // uses, not sorted in among the tile rows above it.
  const settingsRow = el("a.sheet-row", { href: "#/settings" });
  settingsRow.innerHTML = iconSvg(ICONS.settings ?? "", "ico");
  appendChildren(settingsRow, el("span", { text: SETTINGS.label }));
  settingsRow.addEventListener("click", () => dialog.close());
  scroll.appendChild(settingsRow);

  appendChildren(inner, head, scroll);
  dialog.appendChild(inner);
  document.body.appendChild(dialog);
  dialog.addEventListener("close", () => dialog.remove());
  dialog.addEventListener("click", (e) => {
    if (e.target === dialog) dialog.close();
  });
  dialog.showModal();
  void storage; // order editing (drag-to-reorder + saveNavOrder, nav.ts) is the next slice of this sheet
}

/** Settings is pinned nav (nav.ts), not a tile, so it has no registry
 * module of its own — the shell renders its (currently minimal) view
 * directly. Device list / passkey management / the nav order editor
 * (docs/DESIGN.md §9b) attach here as that backend work lands; kept a
 * placeholder rather than a stub screen, since the surrounding chrome is
 * this change's scope. */
function renderSettingsPlaceholder(): HTMLElement {
  const card = el("div.card");
  const p = document.createElement("p");
  p.textContent = "Devices, passkeys and integrations land here as each is built (docs/DESIGN.md §9b, §9d).";
  appendChildren(card, el("h2", { text: "Settings" }), p);
  return card;
}

function appendChildren(parent: HTMLElement, ...children: HTMLElement[]): void {
  for (const child of children) parent.appendChild(child);
}

function forEachEl<T extends Element>(list: NodeListOf<T>, fn: (item: T) => void): void {
  for (let i = 0; i < list.length; i++) {
    const item = list.item(i);
    if (item) fn(item);
  }
}

function el(spec: string, attrs: Record<string, string | boolean> = {}): HTMLElement {
  const parts = spec.split(/(?=[.#])/);
  const tag = parts[0] || "div";
  const node = document.createElement(tag);
  for (let i = 1; i < parts.length; i++) {
    const token = parts[i] ?? "";
    if (token[0] === ".") node.classList.add(token.slice(1));
    else if (token[0] === "#") node.id = token.slice(1);
  }
  for (const [key, value] of Object.entries(attrs)) {
    if (key === "text") node.textContent = String(value);
    else if (typeof value === "boolean") {
      if (value) node.setAttribute(key, "");
    } else node.setAttribute(key, value);
  }
  return node;
}
