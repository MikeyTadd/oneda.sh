// Data operations for the notes tile — folders and note metadata through ctx.storage (synced,
// small, structured); a note's body as a Yjs CRDT document (crdt.ts), its last compacted
// snapshot in R2 (large, free-form — ctx.blobs) and every edit since that snapshot as its own
// small, synced NoteUpdateRecord (types.ts) rather than the body being one blob overwritten
// wholesale on every save. That's what actually delivers design doc §5.3's requirement: two
// devices editing the same note while both offline merge on reconnect instead of one save
// silently discarding the other. No DOM here; index.ts and editor.ts own presentation.

import type * as Y from "yjs";
import { base64UrlToBuffer, bufferToBase64Url } from "../../crypto/codec.js";
import { namespacedKey } from "../../storage/db.js";
import type { TileContext } from "../types.js";
import { applyMarkdownEdit, applyUpdate, createNoteDoc, encodeSnapshot, loadFromSnapshot, textOf } from "./crdt.js";
import type { NoteFolder, NoteMeta, NoteRecord, NoteUpdateRecord } from "./types.js";

function folderKey(id: string): string {
  return `folder:${id}`;
}
function noteKey(id: string): string {
  return `note:${id}`;
}
function noteUpdatePrefix(noteId: string): string {
  return `note-update:${noteId}:`;
}
function noteUpdateKey(noteId: string, updateId: string): string {
  return `${noteUpdatePrefix(noteId)}${updateId}`;
}

/** Once a note has this many un-compacted updates sitting in sync, the next save folds them
 * all into a fresh snapshot instead of adding a 21st — otherwise a note edited daily for a
 * year would carry hundreds of tiny records forever, all needing to be fetched and replayed
 * every time it's opened. Picked as "clearly before it'd be noticeable", not tuned against
 * any measurement — there's no wrong answer here, just a point past which the tradeoff (a
 * few extra small syncs vs. an unbounded pile of them) stops being worth deferring. */
const COMPACT_AFTER_UPDATES = 20;

export interface NotesState {
  folders: NoteFolder[];
  notes: NoteMeta[];
}

/** Every non-deleted folder/note record this device knows about. Called once at tile
 * init (after registry.ts's hydration pull) and again after any local write, rather than
 * kept as long-lived mutable state here — index.ts owns when to re-render. NoteUpdateRecords
 * live under this same namespace but are never part of this listing — they're loaded on
 * demand, per note, by loadNoteBody below. */
export async function loadAll(ctx: TileContext): Promise<NotesState> {
  const keys = await ctx.storage.listKeys(`${ctx.dataNamespace}:`);
  const folders: NoteFolder[] = [];
  const notes: NoteMeta[] = [];
  for (const key of keys) {
    const record = await ctx.storage.get<NoteRecord>(key);
    if (!record || record.deleted) continue;
    if (record.kind === "folder") folders.push(record);
    else if (record.kind === "note") notes.push(record);
  }
  return { folders, notes };
}

export async function createFolder(ctx: TileContext, name: string, parentId: string | null): Promise<NoteFolder> {
  const now = Date.now();
  const folder: NoteFolder = { kind: "folder", id: crypto.randomUUID(), name, parentId, createdAt: now, updatedAt: now };
  await ctx.storage.put(namespacedKey(ctx.dataNamespace, folderKey(folder.id)), folder);
  return folder;
}

export async function renameFolder(ctx: TileContext, folder: NoteFolder, name: string): Promise<NoteFolder> {
  const updated: NoteFolder = { ...folder, name, updatedAt: Date.now() };
  await ctx.storage.put(namespacedKey(ctx.dataNamespace, folderKey(folder.id)), updated);
  return updated;
}

/** Deletes the folder itself but not what was in it — a note or subfolder loses its parent
 * (falls back to the root) rather than cascading, since a silent mass-delete triggered by
 * one tap on a folder icon is exactly the kind of surprise a notes app must not spring. */
export async function deleteFolder(ctx: TileContext, state: NotesState, folder: NoteFolder): Promise<void> {
  const now = Date.now();
  const tombstone: NoteFolder = { ...folder, deleted: true, updatedAt: now };
  await ctx.storage.put(namespacedKey(ctx.dataNamespace, folderKey(folder.id)), tombstone);

  for (const child of state.folders) {
    if (child.parentId === folder.id) {
      await ctx.storage.put(namespacedKey(ctx.dataNamespace, folderKey(child.id)), { ...child, parentId: null, updatedAt: now });
    }
  }
  for (const note of state.notes) {
    if (note.folderId === folder.id) {
      await ctx.storage.put(namespacedKey(ctx.dataNamespace, noteKey(note.id)), { ...note, folderId: null, updatedAt: now });
    }
  }
}

export async function createNote(ctx: TileContext, folderId: string | null): Promise<NoteMeta> {
  const now = Date.now();
  const note: NoteMeta = {
    kind: "note",
    id: crypto.randomUUID(),
    folderId,
    title: "",
    blobKey: ctx.blobs.newKey(),
    createdAt: now,
    updatedAt: now,
  };
  await ctx.blobs.putBytes(note.blobKey, encodeSnapshot(createNoteDoc()));
  await ctx.storage.put(namespacedKey(ctx.dataNamespace, noteKey(note.id)), note);
  return note;
}

/** Loads the note's last compacted snapshot (R2) and replays every NoteUpdateRecord synced
 * since — merging them is exactly what makes this a CRDT rather than "whoever saved last
 * wins": Yjs updates are commutative and idempotent, so it doesn't matter which device wrote
 * which update or in what order they're replayed here, only that all of them are. Returns the
 * live Y.Doc itself, not just its text — the editor session keeps editing this same document
 * (index.ts holds onto it for as long as the note stays open) so every subsequent save's diff
 * (crdt.ts's applyMarkdownEdit) lands on top of the merged state, not a stale one. */
export async function loadNoteDoc(ctx: TileContext, note: NoteMeta): Promise<Y.Doc> {
  const snapshot = await ctx.blobs.getBytes(note.blobKey);
  const doc = loadFromSnapshot(snapshot ?? null);

  const updateKeys = await ctx.storage.listKeys(namespacedKey(ctx.dataNamespace, noteUpdatePrefix(note.id)));
  for (const key of updateKeys) {
    const record = await ctx.storage.get<NoteUpdateRecord>(key);
    if (record) applyUpdate(doc, new Uint8Array(base64UrlToBuffer(record.update)));
  }
  return doc;
}

export async function loadNoteBody(ctx: TileContext, note: NoteMeta): Promise<{ doc: Y.Doc; markdown: string }> {
  const doc = await loadNoteDoc(ctx, note);
  return { doc, markdown: textOf(doc) };
}

/** Persists an edit — the body's diff as a small synced CRDT update (or nothing, if only the
 * title changed), the metadata (title, updatedAt) through the ordinary last-write-wins record
 * it's always been. A title change and the text it was derived from travel separately but
 * both reach every device, same as before this file changed shape. */
export async function saveNote(ctx: TileContext, note: NoteMeta, doc: Y.Doc, title: string, body: string): Promise<NoteMeta> {
  const update = applyMarkdownEdit(doc, body);
  if (update) {
    const record: NoteUpdateRecord = { kind: "note-update", id: crypto.randomUUID(), noteId: note.id, update: bufferToBase64Url(update), createdAt: Date.now() };
    await ctx.storage.put(namespacedKey(ctx.dataNamespace, noteUpdateKey(note.id, record.id)), record);
    await compactIfDue(ctx, note, doc);
  }
  const updated: NoteMeta = { ...note, title, updatedAt: Date.now() };
  await ctx.storage.put(namespacedKey(ctx.dataNamespace, noteKey(note.id)), updated);
  return updated;
}

async function compactIfDue(ctx: TileContext, note: NoteMeta, doc: Y.Doc): Promise<void> {
  const updateKeys = await ctx.storage.listKeys(namespacedKey(ctx.dataNamespace, noteUpdatePrefix(note.id)));
  if (updateKeys.length < COMPACT_AFTER_UPDATES) return;
  await ctx.blobs.putBytes(note.blobKey, encodeSnapshot(doc));
  for (const key of updateKeys) await ctx.storage.delete(key);
}

export async function moveNote(ctx: TileContext, note: NoteMeta, folderId: string | null): Promise<NoteMeta> {
  const updated: NoteMeta = { ...note, folderId, updatedAt: Date.now() };
  await ctx.storage.put(namespacedKey(ctx.dataNamespace, noteKey(note.id)), updated);
  return updated;
}

export async function deleteNote(ctx: TileContext, note: NoteMeta): Promise<void> {
  const tombstone: NoteMeta = { ...note, deleted: true, updatedAt: Date.now() };
  await ctx.storage.put(namespacedKey(ctx.dataNamespace, noteKey(note.id)), tombstone);
  await ctx.blobs.delete(note.blobKey);
  const updateKeys = await ctx.storage.listKeys(namespacedKey(ctx.dataNamespace, noteUpdatePrefix(note.id)));
  for (const key of updateKeys) await ctx.storage.delete(key);
}
