// Notes' own record shapes — stored one-per-record via ctx.storage (metadata only) under
// dataNamespace "notes", with `kind` disambiguating a folder from a note within one flat
// listKeys("notes:") scan rather than needing two separate key prefixes to remember. A
// note's actual markdown body never lives here — see store.ts and ../../storage/blobs.ts.

export interface NoteFolder {
  kind: "folder";
  id: string;
  name: string;
  /** null = a top-level folder. */
  parentId: string | null;
  createdAt: number;
  updatedAt: number;
  /** Soft-delete flag carried inside the encrypted record itself (docs/DESIGN.md's tombstone
   * column is server-side metadata the Worker can see; a folder's *name* can't go anywhere
   * the server can read, so "is this deleted" has to travel the same way). */
  deleted?: boolean;
}

export interface NoteMeta {
  kind: "note";
  id: string;
  /** null = unfiled, shown at the folder root. */
  folderId: string | null;
  title: string;
  /** The R2 object key for this note's body's last *compacted* Yjs snapshot (opaque, random —
   * see blobs.ts and crdt.ts). Never the note's own id or title: that would be exactly the
   * content-revealing key the design doc's R2 section rules out. The current body is this
   * snapshot plus every NoteUpdateRecord (below) synced since it was written — see store.ts's
   * loadNoteBody. */
  blobKey: string;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

/** One incremental edit to a note's body, as a Yjs CRDT update (crdt.ts) rather than the whole
 * body text — design doc §5.3's actual requirement: two devices editing the same note while
 * both offline must merge on reconnect, not last-write-wins. Deliberately its own record kind,
 * outside `NoteRecord` below — `loadAll`'s folder/note listing scan (store.ts) skips these
 * entirely, since a heavily-edited note could have dozens of them and none of that matters to
 * what the sidebar shows. Every one is a fresh key (store.ts's noteUpdateKey, a random id per
 * edit) — never overwritten, only ever added to and later compacted away, which is exactly the
 * append-only shape the ordinary sync mechanism (EncryptedStorage.receiveIncoming) already
 * handles correctly with no special-casing: each key is new, so there's nothing for its
 * last-write-wins guard to even compare against. */
export interface NoteUpdateRecord {
  kind: "note-update";
  id: string;
  noteId: string;
  /** base64url(Yjs update bytes) — JSON-safe, same convention as a wrapped key elsewhere in
   * this codebase (recovery.ts, library/types.ts). */
  update: string;
  createdAt: number;
}

export type NoteRecord = NoteFolder | NoteMeta;
