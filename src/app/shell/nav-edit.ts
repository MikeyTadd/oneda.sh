// More, and the editor behind it.
//
// Two sheets that are really one flow: More is where a tile goes when it
// is not on the bar, and the way you change which tiles those are is one
// row further down the same list. Putting the editor in Settings only
// would mean someone who wants a tile back on the bar has to know to look
// there for it — so it is reachable from both.
//
// Both are built on ./sheet.ts, so Escape, the focus trap and the backdrop
// are the platform's. Neither writes until told to: More writes nothing at
// all, and the editor writes on Save — so backing out with Escape discards
// by construction.
//
// Adapted from a sibling project's `views/nav-edit.js` (F1 Apex), written
// fresh here against oneda's tile-derived nav.

import { clear, el } from "./dom.js";
import { ICONS, iconSvg } from "./icons.js";
import { BAR_SLOTS, defaultOrder, navById, SETTINGS, split, type NavDestination } from "./nav.js";
import { openSheet, sheetFoot, sheetHead } from "./sheet.js";
import type { TileManifest } from "../tiles/types.js";

export interface NavEditDeps {
  /** Every destination this session has, Settings included. */
  nav: NavDestination[];
  /** The installed tiles, for Reset's "back to registry order". */
  manifests: TileManifest[];
  /** The live order, read fresh each time a sheet opens. */
  getOrder: () => string[];
  /** Persists a new order and repaints both navs (shell.ts). */
  setOrder: (ids: string[]) => void;
}

function glyph(dest: NavDestination): HTMLElement {
  const span = el("span.glyph-slot");
  span.innerHTML = iconSvg(ICONS[dest.icon] ?? ICONS.tile ?? "", "ico");
  return span.firstElementChild as HTMLElement;
}

function destRow(dest: NavDestination, onNavigate: () => void): HTMLElement {
  return el("a.row", { href: `#/${dest.id}`, onClick: onNavigate }, [
    glyph(dest),
    el("div.who", {}, [el("div.name", { text: dest.label }), el("div.sub", { text: dest.sub ?? "" })]),
  ]);
}

/**
 * The overflow sheet. Shows whatever did not fit on the phone's bar, then
 * a "This app" block carrying the customiser and Settings.
 *
 * @param opts.straightToEditor the desktop rail's edit button has no
 *   overflow to show — it opens this only to reach the editor, so it skips
 *   straight there rather than showing a list of nothing.
 */
export function openMoreSheet(deps: NavEditDeps, { straightToEditor = false } = {}): HTMLDialogElement {
  if (straightToEditor) return openNavEditor(deps);

  const node = openSheet("more-sheet", { label: "More" });
  const inner = el("div.sheet-inner");
  node.appendChild(inner);

  const { more } = split(deps.getOrder());
  const blocks: HTMLElement[] = [];

  if (more.length) {
    blocks.push(
      el("div.sheet-block", {}, [
        el("span.eyebrow", { text: "Tiles" }),
        el(
          "div.rows",
          {},
          more
            .map((id) => navById(deps.nav, id))
            .filter((d): d is NavDestination => d !== null)
            .map((d) => destRow(d, () => node.close()))
        ),
      ])
    );
  }

  // Settings is the last row of the last block, on purpose. It is pinned
  // out of the order (nav.ts), so this is where it lives on a phone —
  // under "This app" beside the customiser, rather than shuffling between
  // the bar and More with the tiles. It is the one destination here that
  // is not a tile, and the one opened least often, so it is the one that
  // most needs to be in the same place every time.
  const settings = navById(deps.nav, SETTINGS.id);
  blocks.push(
    el("div.sheet-block", {}, [
      el("span.eyebrow", { text: "This app" }),
      el("div.rows", {}, [
        el(
          "button.row",
          {
            type: "button",
            onClick: () => {
              node.close();
              openNavEditor(deps);
            },
          },
          [
            glyph({ id: "more", label: "More", icon: "more" }),
            el("div.who", {}, [
              el("div.name", { text: "Customise navigation" }),
              el("div.sub", { text: `Choose the ${BAR_SLOTS} on the bar, and the order` }),
            ]),
          ]
        ),
        settings ? destRow(settings, () => node.close()) : null,
      ])
    ]),
  );

  inner.appendChild(sheetHead(node, "More", "Everything not on the bar"));
  inner.appendChild(el("div.sheet-scroll", {}, blocks));
  return node;
}

/**
 * The editor.
 *
 * Reorder by moving one step at a time rather than by dragging. A drag on
 * a touch screen inside a scrolling sheet is genuinely hard to get right —
 * it fights the scroll, it has no keyboard equivalent, and it is invisible
 * to a screen reader — and this list is a handful of rows long, so two taps
 * is not a hardship. The buttons are the accessible answer for free.
 *
 * The cut line is drawn *between* rows rather than implied by counting
 * them: which side of it a tile is on is the whole subject of the sheet.
 */
export function openNavEditor(deps: NavEditDeps): HTMLDialogElement {
  let ids = deps.getOrder();

  const node = openSheet("nav-editor", { label: "Customise navigation" });
  const inner = el("div.sheet-inner");
  node.appendChild(inner);

  const list = el("div.nav-edit");

  const move = (index: number, delta: number) => {
    const to = index + delta;
    if (to < 0 || to >= ids.length) return;
    const next = [...ids];
    const a = next[index]!;
    const b = next[to]!;
    next[index] = b;
    next[to] = a;
    ids = next;
    paint();
  };

  function paint(): void {
    clear(list);
    ids.forEach((id, index) => {
      const dest = navById(deps.nav, id);
      if (!dest) return;

      // Both halves are labelled, not just the second one. The tint alone
      // says "these are different" without saying *how* — and on a desktop,
      // where every row below is on the rail too, an unlabelled highlight
      // reads as decoration rather than as the phone's bar.
      if (index === 0) {
        list.appendChild(
          el("div.nav-cut.first", {}, [
            el("span.eyebrow", { text: `Phone bar · first ${BAR_SLOTS}` }),
            el("span.rule"),
          ])
        );
      }
      if (index === BAR_SLOTS) {
        list.appendChild(
          el("div.nav-cut", {}, [el("span.eyebrow", { text: "Behind More on a phone" }), el("span.rule")])
        );
      }

      const onBar = index < BAR_SLOTS;
      list.appendChild(
        el("div.nav-row", { class: onBar ? "on-bar" : undefined }, [
          el("span.slot", { text: onBar ? String(index + 1) : "" }),
          glyph(dest),
          el("div.who", {}, [
            el("div.name", { text: dest.label }),
            el("div.sub", {
              // The first row is the front door, and nothing else says so —
              // it is the only property of this list not visible from its shape.
              text: index === 0 ? "Opens when you start the app" : (dest.sub ?? ""),
            }),
          ]),
          el("div.nav-move", {}, [
            el("button.icon-btn", {
              type: "button",
              "aria-label": `Move ${dest.label} up`,
              disabled: index === 0,
              text: "↑",
              onClick: () => move(index, -1),
            }),
            el("button.icon-btn", {
              type: "button",
              "aria-label": `Move ${dest.label} down`,
              disabled: index === ids.length - 1,
              text: "↓",
              onClick: () => move(index, 1),
            }),
          ]),
        ])
      );
    });

    if (ids.length === 0) {
      list.appendChild(
        el("p.empty", { text: "No tiles installed yet, so there is nothing to arrange. Settings stays where it is either way." })
      );
    }
  }
  paint();

  const notes = el("p.nav-note", {}, [
    // Said plainly rather than left to be inferred from a tint, because the
    // person most likely to be reading this is on a desktop, where every
    // row below is on the rail and the fold is invisible.
    "A desktop rail has room for all of them, so it shows the lot in this order. A phone does not, so the highlighted ",
    el("b", { text: String(BAR_SLOTS) }),
    " are its bottom bar and the rest sit behind More. The first is where the app opens, on both.",
  ]);

  inner.appendChild(
    sheetHead(node, "Customise navigation", "The order is yours everywhere; only a phone has to fold")
  );
  inner.appendChild(
    el("div.sheet-scroll", {}, [
      list,
      notes,
      el("p.nav-note", {
        // Said rather than left to be noticed as an absence: someone looking
        // for Settings in this list needs to be told where it went, not left
        // to conclude it has been lost.
        text: "Settings is not in the list — it sits under this button, in the rail's foot and in More, so it is always in the same place.",
      }),
      el("p.nav-note", {
        text: "This order is part of your account, so it follows you to every device you sign in on.",
      }),
    ])
  );
  inner.appendChild(
    sheetFoot([
      el("button.btn.ghost", {
        type: "button",
        text: "Reset",
        onClick: () => {
          ids = [...defaultOrder(deps.manifests)];
          paint();
        },
      }),
      el("button.btn.go", {
        type: "button",
        text: "Save",
        onClick: () => {
          deps.setOrder(ids);
          node.close();
        },
      }),
    ])
  );
  return node;
}
