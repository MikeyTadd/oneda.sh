// Transparent-encryption IndexedDB wrapper (section 5.1). Tiles never touch raw crypto for
// storage — every put() encrypts with the DEK before writing, every get() decrypts after
// reading. Applies uniformly to green-lock and grey-lock tiles alike (section 1b) — the
// tier distinction is only about server access, never about local storage.

import { encryptRecord, decryptRecord } from "../crypto/keys.js";
import type { SyncQueue, SyncRecord } from "../sync/queue.js";

const DB_NAME = "onedash";
const DB_VERSION = 1;
const STORE = "records";

interface StoredEnvelope {
  key: string;
  iv: Uint8Array;
  ciphertext: ArrayBuffer;
  updatedAt: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/** Namespaced key helper — combines a tile's dataNamespace (section 4.1) with a record ID
 * so tiles can't collide with each other's storage. */
export function namespacedKey(dataNamespace: string, recordId: string): string {
  return `${dataNamespace}:${recordId}`;
}

export interface EncryptedStorage {
  put<T>(key: string, value: T): Promise<void>;
  get<T>(key: string): Promise<T | undefined>;
  delete(key: string): Promise<void>;
  listKeys(prefix: string): Promise<string[]>;
  /** Applies a record that arrived over the sync queue or a hydration pull (sync/hydrate.ts)
   * from another device: persists its ciphertext as-is (it was already encrypted under this
   * same DEK by the sending device, so re-encrypting here would be pointless) and returns the
   * decrypted value for whatever local code needs to react (a tile's onSync, a shell module's
   * own change listener). Skipped — returns the *local* value unchanged — when the local
   * envelope is already at least as new: there's no CRDT merge yet (registry.ts), so this is
   * the one guard standing between an offline edit and a hydration pull silently clobbering it
   * with what was already known before this device went offline. Never pushes back to sync —
   * that would echo the write straight back to its own sender. */
  receiveIncoming<T>(record: SyncRecord): Promise<T>;
}

async function writeEnvelope(db: IDBDatabase, envelope: StoredEnvelope): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(envelope);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function readEnvelope(db: IDBDatabase, key: string): Promise<StoredEnvelope | undefined> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(key);
    req.onsuccess = () => resolve(req.result as StoredEnvelope | undefined);
    req.onerror = () => reject(req.error);
  });
}

/** Every storage key is `${dataNamespace}:${recordId}` (namespacedKey above, and every
 * shell-level key like "shell:prefs" follows the same shape) — splitting it back apart is
 * how put() can push a SyncRecord without every caller assembling one by hand. */
function splitKey(key: string): { dataNamespace: string; recordId: string } {
  const sep = key.indexOf(":");
  if (sep === -1) return { dataNamespace: key, recordId: "" };
  return { dataNamespace: key.slice(0, sep), recordId: key.slice(sep + 1) };
}

/** Bound to a specific DEK (obtained post-auth, section 2.3) — construct once after the
 * app-level unlock succeeds (section 1a) and hand this down via the tile shared context
 * (section 4.3), never a raw CryptoKey. `sync`, when given, makes every put() reach every
 * other device: universal sync (section 1) with no per-call-site opt-in, since a caller
 * that forgot to also push would be exactly the "no exceptions" clause breaking quietly. */
export function createEncryptedStorage(dek: CryptoKey, sync?: SyncQueue): EncryptedStorage {
  return {
    async put<T>(key: string, value: T): Promise<void> {
      const db = await openDb();
      const { ciphertext, iv } = await encryptRecord(dek, value);
      const updatedAt = Date.now();
      const envelope: StoredEnvelope = { key, iv, ciphertext, updatedAt };
      await writeEnvelope(db, envelope);
      if (sync) sync.push({ ...splitKey(key), ciphertext, iv, updatedAt });
    },

    async receiveIncoming<T>(record: SyncRecord): Promise<T> {
      const db = await openDb();
      const key = namespacedKey(record.dataNamespace, record.recordId);
      const existing = await readEnvelope(db, key);
      if (existing && existing.updatedAt >= record.updatedAt) {
        return decryptRecord<T>(dek, existing.ciphertext, existing.iv);
      }
      const envelope: StoredEnvelope = {
        key,
        iv: record.iv,
        ciphertext: record.ciphertext,
        updatedAt: record.updatedAt,
      };
      await writeEnvelope(db, envelope);
      return decryptRecord<T>(dek, record.ciphertext, record.iv);
    },

    async get<T>(key: string): Promise<T | undefined> {
      const db = await openDb();
      const envelope = await readEnvelope(db, key);
      if (!envelope) return undefined;
      return decryptRecord<T>(dek, envelope.ciphertext, envelope.iv);
    },

    async delete(key: string): Promise<void> {
      const db = await openDb();
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).delete(key);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async listKeys(prefix: string): Promise<string[]> {
      const db = await openDb();
      return new Promise((resolve, reject) => {
        const keys: string[] = [];
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).openCursor();
        req.onsuccess = () => {
          const cursor = req.result;
          if (!cursor) return resolve(keys);
          if (typeof cursor.key === "string" && cursor.key.startsWith(prefix)) {
            keys.push(cursor.key);
          }
          cursor.continue();
        };
        req.onerror = () => reject(req.error);
      });
    },
  };
}
