// One-time pull of everything the server has durably stored for a namespace (section 3.2,
// UserSession.ts's persist()). The WebSocket only ever relays a *live* change to whoever else
// happens to be connected at that exact moment — a fresh device, or one whose local IndexedDB
// was cleared, has no other way to learn about data written before it ever connected. Call
// this once per namespace right before the code that reads local storage for it (shell.ts for
// "shell", registry.ts for each installed tile's own namespace) so local storage is caught up
// before anything renders from it.

import { base64UrlToBuffer } from "../crypto/codec.js";
import type { EncryptedStorage } from "../storage/db.js";

interface HydrationRow {
  dataNamespace: string;
  recordId: string;
  // iv[12] || ciphertext, base64url — same framing as a wrapped_dek column, and split the
  // same way (codec.ts's splitIvAndCiphertext) once EncryptedStorage.receiveIncoming needs it.
  wrapped: string;
  updatedAt: number;
}

export async function hydrateNamespace(storage: EncryptedStorage, dataNamespace: string): Promise<void> {
  let rows: HydrationRow[];
  try {
    const res = await fetch(`/api/tile-records?dataNamespace=${encodeURIComponent(dataNamespace)}`, {
      credentials: "include",
    });
    if (!res.ok) return; // offline or a transient error — local storage is still usable
    rows = (await res.json()) as HydrationRow[];
  } catch {
    return;
  }

  for (const row of rows) {
    const bytes = new Uint8Array(base64UrlToBuffer(row.wrapped));
    const iv = bytes.slice(0, 12);
    const ciphertext = bytes.slice(12).buffer;
    // receiveIncoming already refuses to overwrite a local record that's at least as new
    // (storage/db.ts) — the one guard between an offline edit and this pull clobbering it.
    await storage.receiveIncoming({ dataNamespace, recordId: row.recordId, ciphertext, iv, updatedAt: row.updatedAt });
  }
}
