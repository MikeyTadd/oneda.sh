// Tile registry (section 4.2). The installed-tile list is itself synced data (universal
// sync, section 1 guiding principles) — this module only handles dynamic loading; the
// list of installed ids is read from/written to encrypted storage like any other record.

import type { Tile, TileContext } from "./types.js";

/** Static map of importable tile modules, keyed by id. Each entry is a dynamic import so
 * an uninstalled tile's code never loads (build order, section 11, step 4). Add one line
 * here per new tile module — nothing else in the shell needs to change. */
const TILE_LOADERS: Record<string, () => Promise<{ default: Tile }>> = {
  notes: () => import("./notes/index.js"),
};

export interface TileRegistryEntry {
  tileId: string;
  order: number;
}

const REGISTRY_KEY = "shell:tile-registry";

export async function loadRegistry(ctx: TileContext): Promise<TileRegistryEntry[]> {
  const entries = await ctx.storage.get<TileRegistryEntry[]>(REGISTRY_KEY);
  return entries ?? [];
}

export async function saveRegistry(ctx: TileContext, entries: TileRegistryEntry[]): Promise<void> {
  await ctx.storage.put(REGISTRY_KEY, entries);
  // Registry changes are themselves tile data and must round-trip through sync
  // (universal sync — no exceptions) rather than staying purely local.
}

export async function loadTile(tileId: string): Promise<Tile> {
  const loader = TILE_LOADERS[tileId];
  if (!loader) throw new Error(`unknown tile id: ${tileId}`);
  const mod = await loader();
  return mod.default;
}

/** Instantiates and mounts every registered tile into the shell. Called once, post-auth,
 * after the DEK is available (never before the app-level unlock, section 1a). */
export async function mountInstalledTiles(
  container: HTMLElement,
  baseCtx: Omit<TileContext, "dataNamespace" | "syncQueue"> & { syncQueue: TileContext["syncQueue"] },
  entries: TileRegistryEntry[]
): Promise<void> {
  const sorted = [...entries].sort((a, b) => a.order - b.order);
  for (const entry of sorted) {
    const tile = await loadTile(entry.tileId);
    const tileCtx: TileContext = { ...baseCtx, dataNamespace: tile.dataNamespace };
    await tile.init(tileCtx);

    const section = document.createElement("section");
    section.dataset.tileId = tile.id;
    section.dataset.encryptionTier = tile.encryptionTier; // section 1b: lock icon driven by this

    // The shell owns the frame; the tile only ever fills columns (section
    // 4.5). Both shapes put the tile's content in a `.main-col`, so page
    // padding and column rhythm are declared once in the stylesheet rather
    // than by each tile — and a tile can change which layout it wants
    // without touching any CSS.
    const mainCol = document.createElement("div");
    mainCol.className = "main-col";

    if (tile.layout === "split") {
      const split = document.createElement("div");
      split.className = "split";
      const side = document.createElement("aside");
      side.className = "side";
      split.appendChild(mainCol);
      split.appendChild(side);
      section.appendChild(split);
      container.appendChild(section);
      tile.render(mainCol);
      // Mandatory for a split tile — the type makes it so, because a
      // declared side track that nothing fills is dead space, not an
      // absent track.
      tile.renderSide(side);
    } else {
      section.appendChild(mainCol);
      container.appendChild(section);
      tile.render(mainCol);
    }

    baseCtx.syncQueue.onIncoming((update) => {
      tile.onSync(update);
    });
  }
}
