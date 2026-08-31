// Client for the R2 blob proxy (src/worker/index.ts's putBlob/getBlob/deleteBlob, section
// 3.3) — for content too large or too free-form to fit the small structured records
// EncryptedStorage/sync carry (a note's actual markdown body, tiles/notes/index.ts). The
// Worker only ever sees ciphertext under an opaque, client-generated key; it never sees a
// title, a folder, or anything that hints at content, per the design doc's key-naming rule.

import { encryptText, decryptText, encryptBytes, decryptBytes } from "../crypto/keys.js";
import { concatBytes } from "../crypto/codec.js";

export interface BlobStore {
  /** A fresh opaque key for a new blob — random, so it carries nothing about what it names. */
  newKey(): string;
  putText(key: string, text: string): Promise<void>;
  getText(key: string): Promise<string | undefined>;
  /** Raw bytes, DEK-bound — a library file's own chunks (tiles/library) when its library
   * isn't hidden. A hidden library's chunks go through putBlobBytes/getBlobBytes below
   * instead, under that library's own content key rather than the DEK. */
  putBytes(key: string, bytes: Uint8Array): Promise<void>;
  getBytes(key: string): Promise<Uint8Array | undefined>;
  /** Best-effort: an orphaned encrypted blob under a key nothing references any more is
   * storage waste, not a correctness or security problem, so a failed cleanup is worth
   * logging but never worth surfacing to whoever just deleted the record that named it. */
  delete(key: string): Promise<void>;
}

/** Bound to a specific DEK, the same way createEncryptedStorage (storage/db.ts) is — tiles
 * never touch a raw CryptoKey directly (tiles/types.ts), only this and EncryptedStorage. */
export function createBlobStore(dek: CryptoKey): BlobStore {
  return {
    newKey(): string {
      return crypto.randomUUID();
    },

    async putText(key: string, text: string): Promise<void> {
      const { ciphertext, iv } = await encryptText(dek, text);
      // Wrapped in a Blob rather than passed as ArrayBufferLike directly: the ambient
      // Workers-runtime fetch types (@cloudflare/workers-types, pulled in globally by
      // tsconfig — see dom.ts's append() note for the same class of collision) narrow
      // BodyInit in a way a plain browser ArrayBuffer doesn't satisfy.
      const body = new Blob([concatBytes(iv, new Uint8Array(ciphertext)) as BlobPart]);
      const res = await fetch(`/api/blobs/${encodeURIComponent(key)}`, {
        method: "PUT",
        credentials: "include",
        body,
      });
      if (!res.ok) throw new Error(`blob upload failed (${res.status})`);
    },

    async getText(key: string): Promise<string | undefined> {
      const res = await fetch(`/api/blobs/${encodeURIComponent(key)}`, { credentials: "include" });
      if (res.status === 404) return undefined;
      if (!res.ok) throw new Error(`blob download failed (${res.status})`);
      const bytes = new Uint8Array(await res.arrayBuffer());
      const iv = bytes.slice(0, 12);
      const ciphertext = bytes.slice(12).buffer;
      return decryptText(dek, ciphertext, iv);
    },

    putBytes(key: string, bytes: Uint8Array): Promise<void> {
      return putBlobBytes(key, bytes, dek);
    },

    getBytes(key: string): Promise<Uint8Array | undefined> {
      return getBlobBytes(key, dek);
    },

    delete(key: string): Promise<void> {
      return deleteBlobKey(key);
    },
  };
}

/** Same wire format and endpoint as BlobStore.putText/getText above, but encrypted under an
 * explicit key rather than the DEK the store was constructed with — a hidden library
 * (tiles/library) encrypts its files under its own per-library content key, never the
 * account DEK, so unlocking the app is never enough on its own to read one. Free functions
 * rather than a second BlobStore variant since only one tile ever needs a caller-supplied
 * key; every other tile's content is DEK-bound the ordinary way. */
export async function putBlobBytes(key: string, bytes: Uint8Array, cryptoKey: CryptoKey): Promise<void> {
  const { ciphertext, iv } = await encryptBytes(cryptoKey, bytes);
  const body = new Blob([concatBytes(iv, new Uint8Array(ciphertext)) as BlobPart]);
  const res = await fetch(`/api/blobs/${encodeURIComponent(key)}`, { method: "PUT", credentials: "include", body });
  if (!res.ok) throw new Error(`blob upload failed (${res.status})`);
}

export async function getBlobBytes(key: string, cryptoKey: CryptoKey): Promise<Uint8Array | undefined> {
  const res = await fetch(`/api/blobs/${encodeURIComponent(key)}`, { credentials: "include" });
  if (res.status === 404) return undefined;
  if (!res.ok) throw new Error(`blob download failed (${res.status})`);
  const bytes = new Uint8Array(await res.arrayBuffer());
  const iv = bytes.slice(0, 12);
  const ciphertext = bytes.slice(12).buffer;
  return decryptBytes(cryptoKey, ciphertext, iv);
}

export async function deleteBlobKey(key: string): Promise<void> {
  try {
    await fetch(`/api/blobs/${encodeURIComponent(key)}`, { method: "DELETE", credentials: "include" });
  } catch (err) {
    console.error("blob delete failed", err);
  }
}
