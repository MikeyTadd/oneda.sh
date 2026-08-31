# oneda.sh — working notes for Claude

## Every tile shares one layout template — reuse it exactly, don't reinvent it

Every screen in this app (Settings, Notes, and every future tile) renders into the
same shell-provided structure from `tiles/registry.ts`:

```
section > .split > .main-col + aside.side
```

`registry.ts` builds this DOM itself for a `layout: "split"` tile — it calls
`tile.render(mainCol)` then `tile.renderSide(side)`. A `layout: "full"` tile instead
gets a bare `.main-col` with no `.split`/`.side` at all (`tile.render(mainCol)` only,
no side pane). **Pick `"split"` whenever the tile has a genuine secondary pane** (a
nav list, a folder tree, a settings-style "about" blurb) — do not hand-roll a second
`.split`/`.side`/`.main-col` inside a `"full"` tile's `.main-col`. That double-nesting
was the root cause of an entire session of Notes layout bugs (see git history around
commit `efdbe4b`) — every "fix" on top of it kept fighting the same wrong structure.

### The three layouts, and how each actually differs

All three reuse `.split`/`.main-col`/`.side` completely as-is — same padding
(`.main-col`: `22px 24px 40px`; `.side`: `22px`), same `--side-w` (380px) column
width, same hairline. The only things that ever change between tiles:

- **Right-side pane** (Settings' own layout — the default): `.side` is the second
  grid column, hairline on its left (`border-left: 1px solid var(--hairline)`).
  Desktop grid: `grid-template-columns: minmax(0, 1fr) var(--side-w);`
- **Left-side pane** (Notes): mirror it — `.side` becomes the *first* visual
  column via `order: -1` on the tile's own side-pane class, hairline flips to
  `border-right`, and the grid template flips to
  `grid-template-columns: var(--side-w) minmax(0, 1fr);`. Nothing about the base
  `.side`/`.main-col` padding rules is touched or overridden — only column order
  and which edge carries the hairline.
- **Full width, no side pane**: use `layout: "full"` (registry.ts gives a bare
  `.main-col`, no `.split`/`.side` in the DOM at all) rather than a `"split"` tile
  with an empty/unused side.

### Never do this again

- Never hand-pick a custom side-column width (e.g. "260px, folder names are
  short") — always `var(--side-w)`. The column width is part of the shared
  template, not a per-tile styling choice.
- Never zero out or override `.side`'s own `padding`/`margin-top`/`border-top` on
  desktop to "fix" spacing — if something looks wrong, the bug is almost always
  a *blanket, non-media-scoped* tile rule stomping the correct desktop-scoped
  base rule later in the cascade (same specificity, later in the file wins). Fix
  the override, don't add another one on top.
- A short/bounded side pane (a nav list) does not need `position: sticky` or
  `align-self: start` to avoid stretching to match a long main-column pane —
  restructure the content instead (e.g. put the primary action at the top of the
  side pane, not pinned to a bottom that only exists once the list is tall
  enough to reach it) so the natural content height is never the problem.
- If a tile's main pane needs a static header with only the body scrolling
  (e.g. an editor title/toolbar that shouldn't scroll away), do it with an
  internal flex column + `flex: 1; min-height: 0; overflow-y: auto` on the
  scrolling child — desktop-only, scoped under `@media (min-width: 900px)` —
  never let it change `.main-col`'s own padding or force a reading-width cap
  unless the content genuinely wants one (prose), which most tiles don't.
- There's a separate `@media (min-width: 900px) and (max-width: 1179px)`
  block (~line 5359) that folds a genuine right-side `.side` under `.main-col`
  at medium widths and turns it into a two-up grid (for a settings-style pane
  that has room to read two columns there). A tile's own side-pane class
  (`.notes-sidebar` etc.) is still a plain `.side` underneath, so it inherits
  this un-asked-for — it must be excluded (`.side:not(.notes-sidebar)`, and
  `.split:not(:has(> .notes-sidebar))` for the collapse-to-one-column part)
  the same way Notes' is. **Any new tile with its own side-pane class needs
  the same exclusion added to that block**, or its side pane will silently
  get a different padding and a two-up grid in that width range — this read
  as the whole layout "jumping" while resizing the window, and was only
  caught by sweeping computed styles across every width from 850–1500px,
  not by eyeballing a couple of screenshots.

Before touching any of `.split`/`.main-col`/`.side` in `shell.css`, read the
existing comment block directly above those rules (~line 448) and Settings'
`renderSettings()` in `src/app/shell/settings.ts` — that's the reference
implementation every other tile's split layout should match byte-for-byte,
mirrored only where explicitly noted above.
