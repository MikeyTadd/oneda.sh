// Data operations for the library tile — collections of files of any type/size, with
// searchable title/description/keywords, some collections optionally hidden behind their own
// passphrase (types.ts's own header comment explains the two-layer encryption this implies).
// No DOM here; index.ts owns presentation.

import { decryptRecord, derivePassphraseKey, encryptRecord, generateContentKey, unwrapDek, wrapDek } from "../../crypto/keys.js";
import { bufferToBase64Url, base64UrlToBuffer, splitIvAndCiphertext, joinIvAndCiphertext } from "../../crypto/codec.js";
import { getBlobBytes, putBlobBytes, deleteBlobKey } from "../../storage/blobs.js";
import { namespacedKey } from "../../storage/db.js";
import type { TileContext } from "../types.js";
import type { LibraryFile, LibraryFileMeta, LibraryMeta, LibraryRecord } from "./types.js";

/** 6MB per chunk — comfortably under any platform's request-body ceiling (design doc §3.3's
 * "encrypted in chunks, not as one in-memory buffer"), and small enough that upload/download
 * progress can be reported chunk-by-chunk instead of all-or-nothing. */
const CHUNK_BYTES = 6 * 1024 * 1024;

function libraryKey(id: string): string {
  return `library:${id}`;
}
function fileKey(id: string): string {
  return `file:${id}`;
}

export interface LibraryState {
  libraries: LibraryMeta[];
  files: LibraryFile[];
}

/** A hidden library's content key, held only in memory for this tab (never persisted, never
 * synced) — the whole point of the passphrase layer is that this is the one and only place
 * the key exists once the page is closed. Keyed by library id. */
export type ContentKeys = Map<string, CryptoKey>;

export async function loadAll(ctx: TileContext): Promise<LibraryState> {
  const keys = await ctx.storage.listKeys(`${ctx.dataNamespace}:`);
  const libraries: LibraryMeta[] = [];
  const files: LibraryFile[] = [];
  for (const key of keys) {
    const record = await ctx.storage.get<LibraryRecord>(key);
    if (!record || record.deleted) continue;
    if (record.kind === "library") libraries.push(record);
    else files.push(record);
  }
  return { libraries, files };
}

export async function createLibrary(ctx: TileContext, name: string): Promise<LibraryMeta> {
  const now = Date.now();
  const library: LibraryMeta = { kind: "library", id: crypto.randomUUID(), hidden: false, name, createdAt: now, updatedAt: now };
  await ctx.storage.put(namespacedKey(ctx.dataNamespace, libraryKey(library.id)), library);
  return library;
}

/** A hidden library's content key is generated once, right here, and never derived again —
 * only ever unwrapped back out via tryReveal below. Returns the key alongside the record so
 * the caller can start uploading into it immediately without a separate reveal round-trip. */
export async function createHiddenLibrary(ctx: TileContext, name: string, passphrase: string): Promise<{ library: LibraryMeta; contentKey: CryptoKey }> {
  const now = Date.now();
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const passphraseKey = await derivePassphraseKey(passphrase, salt);
  const contentKey = await generateContentKey();
  const wrapped = await wrapDek(contentKey, passphraseKey);
  const { ciphertext, iv } = await encryptRecord(contentKey, name);

  const library: LibraryMeta = {
    kind: "library",
    id: crypto.randomUUID(),
    hidden: true,
    createdAt: now,
    updatedAt: now,
    hiddenSalt: bufferToBase64Url(salt),
    wrappedContentKey: joinIvAndCiphertext(wrapped.iv, wrapped.ciphertext),
    encryptedName: joinIvAndCiphertext(iv, ciphertext),
  };
  await ctx.storage.put(namespacedKey(ctx.dataNamespace, libraryKey(library.id)), library);
  return { library, contentKey };
}

/** Tries one passphrase against every hidden library this device knows about — there is
 * deliberately no library picker (the whole point of "hidden" is that nothing prompts you
 * for which one), so the passphrase alone has to pick it out. A wrong passphrase just fails
 * to unwrap every candidate's content key (AES-GCM's auth tag, not a separate check we'd have
 * to keep from leaking anything) and this returns null — indistinguishable, from the outside,
 * from "no hidden libraries exist at all". */
export async function tryReveal(libraries: LibraryMeta[], passphrase: string): Promise<{ library: LibraryMeta; contentKey: CryptoKey; name: string } | null> {
  for (const library of libraries) {
    if (!library.hidden || !library.hiddenSalt || !library.wrappedContentKey || !library.encryptedName) continue;
    try {
      const salt = new Uint8Array(base64UrlToBuffer(library.hiddenSalt));
      const passphraseKey = await derivePassphraseKey(passphrase, salt);
      const { iv: wrapIv, ciphertext: wrapCiphertext } = splitIvAndCiphertext(base64UrlToBuffer(library.wrappedContentKey));
      const contentKey = await unwrapDek(wrapCiphertext, wrapIv, passphraseKey);
      const { iv: nameIv, ciphertext: nameCiphertext } = splitIvAndCiphertext(base64UrlToBuffer(library.encryptedName));
      const name = await decryptRecord<string>(contentKey, nameCiphertext, nameIv);
      return { library, contentKey, name };
    } catch {
      // Wrong passphrase for this library — AES-GCM's auth tag failed, try the next one.
      continue;
    }
  }
  return null;
}

export async function renameLibrary(ctx: TileContext, library: LibraryMeta, name: string, contentKey?: CryptoKey): Promise<LibraryMeta> {
  const now = Date.now();
  let updated: LibraryMeta;
  if (library.hidden) {
    if (!contentKey) throw new Error("hidden library must be revealed before it can be renamed");
    const { ciphertext, iv } = await encryptRecord(contentKey, name);
    updated = { ...library, updatedAt: now, encryptedName: joinIvAndCiphertext(iv, ciphertext) };
  } else {
    updated = { ...library, name, updatedAt: now };
  }
  await ctx.storage.put(namespacedKey(ctx.dataNamespace, libraryKey(library.id)), updated);
  return updated;
}

/** Deletes the library and every file in it — unlike a note folder (whose contents move up a
 * level), a library has nothing above it to move into, and an empty, name-only library left
 * behind would just be clutter. */
export async function deleteLibrary(ctx: TileContext, state: LibraryState, library: LibraryMeta): Promise<void> {
  const now = Date.now();
  for (const file of state.files.filter((f) => f.libraryId === library.id)) {
    await removeFileChunks(file);
    await ctx.storage.put(namespacedKey(ctx.dataNamespace, fileKey(file.id)), { ...file, deleted: true, updatedAt: now });
  }
  await ctx.storage.put(namespacedKey(ctx.dataNamespace, libraryKey(library.id)), { ...library, deleted: true, updatedAt: now });
}

async function removeFileChunks(file: LibraryFile): Promise<void> {
  for (let i = 0; i < file.chunkCount; i++) await deleteBlobKey(`${file.blobKeyPrefix}:${i}`);
}

export interface UploadProgress {
  sentBytes: number;
  totalBytes: number;
}

/** Splits `blob` into CHUNK_BYTES pieces and uploads each one under its own opaque R2 key
 * (`${prefix}:${index}`) — a fresh, random prefix per file, never derived from its name, per
 * the design doc's key-naming rule (§3.3). Encrypted under `contentKey` when the owning
 * library is hidden, the account DEK (ctx.blobs) otherwise — never the other way around,
 * since a hidden library's bytes readable via the DEK alone would defeat the whole point. */
export async function uploadFile(
  ctx: TileContext,
  libraryId: string,
  blob: Blob,
  meta: LibraryFileMeta,
  contentKey: CryptoKey | undefined,
  onProgress?: (p: UploadProgress) => void
): Promise<LibraryFile> {
  const prefix = crypto.randomUUID();
  const totalBytes = blob.size;
  const chunkCount = Math.max(1, Math.ceil(totalBytes / CHUNK_BYTES));
  let sent = 0;
  for (let i = 0; i < chunkCount; i++) {
    const chunk = new Uint8Array(await blob.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES).arrayBuffer());
    const key = `${prefix}:${i}`;
    if (contentKey) await putBlobBytes(key, chunk, contentKey);
    else await ctx.blobs.putBytes(key, chunk);
    sent += chunk.byteLength;
    onProgress?.({ sentBytes: sent, totalBytes });
  }

  const now = Date.now();
  const file: LibraryFile = {
    kind: "file",
    id: crypto.randomUUID(),
    libraryId,
    createdAt: now,
    updatedAt: now,
    mimeType: blob.type || "application/octet-stream",
    byteSize: totalBytes,
    chunkCount,
    blobKeyPrefix: prefix,
  };
  if (contentKey) {
    const { ciphertext, iv } = await encryptRecord(contentKey, meta);
    file.encryptedMeta = joinIvAndCiphertext(iv, ciphertext);
  } else {
    file.meta = meta;
  }
  await ctx.storage.put(namespacedKey(ctx.dataNamespace, fileKey(file.id)), file);
  return file;
}

/** The plaintext title/description/keywords for `file` — from `meta` directly for an
 * ordinary library, decrypted with `contentKey` for one that's hidden (only ever called once
 * the library has actually been revealed, so contentKey is always present in that case). */
export async function fileMeta(file: LibraryFile, contentKey?: CryptoKey): Promise<LibraryFileMeta> {
  if (file.meta) return file.meta;
  if (file.encryptedMeta && contentKey) {
    const { iv, ciphertext } = splitIvAndCiphertext(base64UrlToBuffer(file.encryptedMeta));
    return decryptRecord<LibraryFileMeta>(contentKey, ciphertext, iv);
  }
  return { title: "Untitled", description: "", keywords: [] };
}

/** Reassembles every chunk into one Blob, in order — see this module's header comment on why
 * that's an acceptable v1 trade-off (no byte-range streaming through decryption yet) rather
 * than a design flaw to route around. */
export async function downloadFile(file: LibraryFile, ctx: TileContext, contentKey: CryptoKey | undefined, onProgress?: (p: UploadProgress) => void): Promise<Blob> {
  const parts: Uint8Array[] = [];
  let received = 0;
  for (let i = 0; i < file.chunkCount; i++) {
    const key = `${file.blobKeyPrefix}:${i}`;
    const chunk = contentKey ? await getBlobBytes(key, contentKey) : await ctx.blobs.getBytes(key);
    if (!chunk) throw new Error(`missing chunk ${i} of ${file.chunkCount}`);
    parts.push(chunk);
    received += chunk.byteLength;
    onProgress?.({ sentBytes: received, totalBytes: file.byteSize });
  }
  return new Blob(parts as BlobPart[], { type: file.mimeType });
}

export async function deleteFile(ctx: TileContext, file: LibraryFile): Promise<void> {
  await removeFileChunks(file);
  await ctx.storage.put(namespacedKey(ctx.dataNamespace, fileKey(file.id)), { ...file, deleted: true, updatedAt: Date.now() });
}
