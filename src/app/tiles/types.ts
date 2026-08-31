// Tile interface (section 4.1). Every module under src/app/tiles/<id>/ implements this
// and nothing else touches the shell — adding a tile means writing the module and adding
// its id to the registry (section 4.2), no shell changes.

import type { BlobStore } from "../storage/blobs.js";
import type { EncryptedStorage } from "../storage/db.js";
import type { SyncQueue } from "../sync/queue.js";

export type EncryptionTier = "e2ee" | "client-encrypted"; // section 1b — drives the lock icon
export type LayoutHint = "desktop-primary" | "mobile-primary" | "neutral"; // section 14

/** How the shell frames a tile's view (section 4.5).
 *
 * `"full"` is one column the width of the content area. `"split"` is the
 * app's two-column layout — a main column plus a 380px side track on a
 * desktop, stacked under a hairline on a phone.
 *
 * The default is `"full"` on purpose: a split declares both columns, so a
 * tile given one it was not designed for ends up with a track of dead
 * space rather than simply not having a track. Which is why `"split"`
 * makes `renderSide()` mandatory below — deciding what goes in the side
 * column is part of designing the screen, not an afterthought. */
export type TileLayout = "full" | "split";

/** Shared context passed to every tile (section 4.3) — tiles never touch raw crypto or
 * the WebSocket directly, only these namespaced helpers. */
export interface TileContext {
  dataNamespace: string;
  storage: EncryptedStorage;
  syncQueue: SyncQueue;
  /** For content too large or free-form for storage/sync's small structured records (a
   * note's markdown body) — encrypted the same way, under the same DEK, just held in R2
   * instead of D1 (section 3.3). Always provided, like storage/syncQueue, even though most
   * tiles never call it. */
  blobs: BlobStore;
}

export interface TileManifest {
  id: string;
  name: string;
  icon: string;
  dataNamespace: string;
  encryptionTier: EncryptionTier;
  layoutHint?: LayoutHint;
  /** Section 4.5. Omitted means `"full"`. */
  layout?: TileLayout;
}

interface TileBase extends TileManifest {
  init(ctx: TileContext): Promise<void>;
  /** Mounts the tile's main column. The shell owns the frame around it —
   * a tile never builds its own `.split` or page padding. */
  render(container: HTMLElement): void;
  onSync(update: unknown): void;
}

/** A tile is one of two shapes, and the type is what enforces it: declare
 * `layout: "split"` and `renderSide()` becomes required, so a two-column
 * tile cannot ship with an empty side track. A `"full"` tile has no side
 * to fill and may not define one. */
export type Tile =
  | (TileBase & { layout?: "full"; renderSide?: never })
  | (TileBase & {
      layout: "split";
      /** Mounts the side track. Required for a split tile. */
      renderSide(container: HTMLElement): void;
    });
