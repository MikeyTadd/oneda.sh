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
  /** The R2 object key for this note's markdown body (opaque, random — see blobs.ts).
   * Never the note's own id or title: that would be exactly the content-revealing key the
   * design doc's R2 section rules out. */
  blobKey: string;
  createdAt: number;
  updatedAt: number;
  deleted?: boolean;
}

export type NoteRecord = NoteFolder | NoteMeta;
