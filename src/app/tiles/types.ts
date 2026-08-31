// Tile interface (section 4.1). Every module under src/app/tiles/<id>/ implements this
// and nothing else touches the shell — adding a tile means writing the module and adding
// its id to the registry (section 4.2), no shell changes.

import type { EncryptedStorage } from "../storage/db.js";
import type { SyncQueue } from "../sync/queue.js";

export type EncryptionTier = "e2ee" | "client-encrypted"; // section 1b — drives the lock icon
export type LayoutHint = "desktop-primary" | "mobile-primary" | "neutral"; // section 14

/** Shared context passed to every tile (section 4.3) — tiles never touch raw crypto or
 * the WebSocket directly, only these namespaced helpers. */
export interface TileContext {
  dataNamespace: string;
  storage: EncryptedStorage;
  syncQueue: SyncQueue;
}

export interface TileManifest {
  id: string;
  name: string;
  icon: string;
  dataNamespace: string;
  encryptionTier: EncryptionTier;
  layoutHint?: LayoutHint;
}

export interface Tile extends TileManifest {
  init(ctx: TileContext): Promise<void>;
  render(container: HTMLElement): void;
  onSync(update: unknown): void;
}
