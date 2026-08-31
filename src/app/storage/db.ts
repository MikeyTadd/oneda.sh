// Transparent-encryption IndexedDB wrapper (section 5.1). Tiles never touch raw crypto for
// storage — every put() encrypts with the DEK before writing, every get() decrypts after
// reading. Applies uniformly to green-lock and grey-lock tiles alike (section 1b) — the
// tier distinction is only about server access, never about local storage.

import { encryptRecord, decryptRecord } from "../crypto/keys.js";

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
}

/** Bound to a specific DEK (obtained post-auth, section 2.3) — construct once after the
 * app-level unlock succeeds (section 1a) and hand this down via the tile shared context
 * (section 4.3), never a raw CryptoKey. */
export function createEncryptedStorage(dek: CryptoKey): EncryptedStorage {
  return {
    async put<T>(key: string, value: T): Promise<void> {
      const db = await openDb();
      const { ciphertext, iv } = await encryptRecord(dek, value);
      const envelope: StoredEnvelope = { key, iv, ciphertext, updatedAt: Date.now() };
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE, "readwrite");
        tx.objectStore(STORE).put(envelope);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    },

    async get<T>(key: string): Promise<T | undefined> {
      const db = await openDb();
      const envelope = await new Promise<StoredEnvelope | undefined>((resolve, reject) => {
        const tx = db.transaction(STORE, "readonly");
        const req = tx.objectStore(STORE).get(key);
        req.onsuccess = () => resolve(req.result as StoredEnvelope | undefined);
        req.onerror = () => reject(req.error);
      });
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
