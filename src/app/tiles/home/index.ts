// Home: the app's front door — first in the nav, first tile installed on a fresh account
// (registry.ts's TILE_LOADERS insertion order), and the default route nav.ts's order()
// always puts first regardless of a saved order (see that function's own comment). Its job
// is a dashboard of small widgets, one per other installed tile, not a workspace of its own —
// so it has no data model of its own, just reads.
//
// A widget reads another tile's data directly through the same shared ctx.storage/ctx.blobs
// every tile gets (main.ts constructs one of each for the whole app; a tile's dataNamespace
// is just a key prefix, not a separate store) — the same way any tile's own store.ts would,
// just against a namespace that isn't this tile's own. Adding a new tile's widget later means
// adding one entry to WIDGETS below and a `loadHomeSummary()`-shaped export from that tile's
// store module; nothing else about the tile system needs to know Home exists.

import { appendChildren, clear, el } from "../../shell/dom.js";
import { ICONS, iconSvg } from "../../shell/icons.js";
import { loadAll as loadNotes } from "../notes/store.js";
import type { NoteMeta } from "../notes/types.js";
import type { Tile, TileContext } from "../types.js";

let ctx: TileContext;
let container: HTMLElement | null = null;

const homeTile: Tile = {
  id: "home",
  name: "Home",
  icon: "home",
  dataNamespace: "home",
  encryptionTier: "e2ee", // section 1b — every widget on it only ever shows other tiles' E2EE data
  layoutHint: "neutral",

  async init(tileCtx: TileContext) {
    ctx = tileCtx;
    // A widget's data can change while Home isn't the visible view — another tile's own
    // write doesn't reach onSync below (registry.ts's onIncoming only calls a tile's onSync
    // for its own dataNamespace, and a local write like "New note" never round-trips through
    // sync at all) — so it repaints on the way back in instead, the one moment that matters
    // for a screen that is only ever a snapshot of other tiles' data. All tiles mount once at
    // login (registry.ts) and are then just toggled visible/hidden, never re-rendered, which
    // is why this can't simply rely on render() running again.
    window.addEventListener("hashchange", () => {
      if (location.hash.replace(/^#\/?/, "") === "home") void paint();
    });
  },

  render(host: HTMLElement) {
    host.classList.add("home-main");
    container = host;
    void paint();
  },

  onSync() {
    void paint();
  },
};

async function paint(): Promise<void> {
  if (!container) return;
  clear(container);
  appendChildren(container, await notesWidget());
}

function icon(name: string): HTMLElement {
  const slot = el("span");
  slot.innerHTML = iconSvg(ICONS[name] ?? ICONS.tile ?? "", "ico");
  return slot.firstElementChild as HTMLElement;
}

const sectionHead = (text: string): HTMLElement => el("div.section-head", {}, [el("span.eyebrow", { text })]);

/** Notes' own five most recently touched, newest first — a dashboard widget is a glance, not
 * a second copy of the tile it's summarising, so this reads notes/store.ts's data directly
 * rather than re-implementing folder/note listing here. */
async function notesWidget(): Promise<HTMLElement> {
  const state = await loadNotes({ ...ctx, dataNamespace: "notes" });
  const recent = [...state.notes].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 5);

  const newNoteBtn = el<HTMLButtonElement>("button.chip.act", {
    type: "button",
    text: "New note",
    onClick: () => {
      location.hash = "#/notes";
    },
  });

  const body: HTMLElement =
    recent.length === 0
      ? el("p.empty", { text: "No notes yet." })
      : el(
          "div.notes-list",
          {},
          recent.map((note) => noteRow(note))
        );

  return el("section.set-block", {}, [sectionHead("Notes"), body, newNoteBtn]);
}

function noteRow(note: NoteMeta): HTMLElement {
  return el(
    "button.row",
    {
      type: "button",
      onClick: () => {
        location.hash = "#/notes";
      },
    },
    [icon("notes"), el("div.who", {}, [el("div.name", { text: note.title || "Untitled" }), el("div.sub", { text: relativeTime(note.updatedAt) })])]
  );
}

function relativeTime(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

export default homeTile;
