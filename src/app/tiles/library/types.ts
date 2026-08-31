// Library's own record shapes — one flat kind of collection ("library"), each holding files.
// Stored one-per-record via ctx.storage (metadata only) under dataNamespace "library", `kind`
// disambiguating the two the same way notes/types.ts does. A file's actual bytes never live
// here — see store.ts and ../../storage/blobs.ts's putBlobBytes/getBlobBytes.
//
// A hidden library carries a second, inner layer of encryption under its own content key
// (crypto/keys.ts's generateContentKey/derivePassphraseKey) instead of using the account DEK
// directly — the whole point of "hidden" is that unlocking the app (having the DEK) is not
// enough on its own to read it. `hidden` and the bookkeeping fields needed to attempt a
// passphrase (hiddenSalt, wrappedContentKey) stay in the clear at the DEK layer, same as a
// note's blobKey; everything that would actually reveal what the library is or holds
// (its name, and every file's title/description/keywords/bytes) goes through the content key
// instead, and just isn't present in plaintext form at all when hidden is true.

export interface LibraryMeta {
  kind: "library";
  id: string;
  hidden: boolean;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;

  /** Present only when hidden is false. */
  name?: string;

  /** Present only when hidden is true — see this module's own header comment. */
  hiddenSalt?: string; // base64url PBKDF2 salt for derivePassphraseKey
  wrappedContentKey?: string; // base64url(iv[12] || AES-GCM-wrapped raw content key)
  encryptedName?: string; // base64url(iv[12] || ciphertext) of the real name, under the content key
}

export interface LibraryFileMeta {
  title: string;
  description: string;
  keywords: string[];
}

export interface LibraryFile {
  kind: "file";
  id: string;
  libraryId: string;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;

  mimeType: string;
  byteSize: number;
  /** How many chunks the body was split into — see store.ts's CHUNK_BYTES. Each chunk is its
   * own R2 object under `${blobKeyPrefix}:${index}` (storage/blobs.ts). */
  chunkCount: number;
  blobKeyPrefix: string;

  /** Present only when the owning library is not hidden. */
  meta?: LibraryFileMeta;

  /** Present only when the owning library is hidden — base64url(iv[12] || ciphertext) of a
   * JSON-encoded LibraryFileMeta, under the library's content key. */
  encryptedMeta?: string;
}

export type LibraryRecord = LibraryMeta | LibraryFile;
