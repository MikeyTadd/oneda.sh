// Data operations for the notes tile — folders and note metadata through ctx.storage (synced,
// small, structured), a note's markdown body through ctx.blobs (large, free-form, R2). No DOM
// here; index.ts and editor.ts own presentation.

import { namespacedKey } from "../../storage/db.js";
import type { TileContext } from "../types.js";
import type { NoteFolder, NoteMeta, NoteRecord } from "./types.js";

function folderKey(id: string): string {
  return `folder:${id}`;
}
function noteKey(id: string): string {
  return `note:${id}`;
}

export interface NotesState {
  folders: NoteFolder[];
  notes: NoteMeta[];
}

/** Every non-deleted folder/note record this device knows about. Called once at tile
 * init (after registry.ts's hydration pull) and again after any local write, rather than
 * kept as long-lived mutable state here — index.ts owns when to re-render. */
export async function loadAll(ctx: TileContext): Promise<NotesState> {
  const keys = await ctx.storage.listKeys(`${ctx.dataNamespace}:`);
  const folders: NoteFolder[] = [];
  const notes: NoteMeta[] = [];
  for (const key of keys) {
    const record = await ctx.storage.get<NoteRecord>(key);
    if (!record || record.deleted) continue;
    if (record.kind === "folder") folders.push(record);
    else notes.push(record);
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
  await ctx.blobs.putText(note.blobKey, "");
  await ctx.storage.put(namespacedKey(ctx.dataNamespace, noteKey(note.id)), note);
  return note;
}

export async function loadNoteBody(ctx: TileContext, note: NoteMeta): Promise<string> {
  return (await ctx.blobs.getText(note.blobKey)) ?? "";
}

/** Persists both halves of an edit — the body to R2, the metadata (title, updatedAt) through
 * sync — since a title change and the text it was derived from should never be visible to
 * one device and not the other. */
export async function saveNote(ctx: TileContext, note: NoteMeta, title: string, body: string): Promise<NoteMeta> {
  await ctx.blobs.putText(note.blobKey, body);
  const updated: NoteMeta = { ...note, title, updatedAt: Date.now() };
  await ctx.storage.put(namespacedKey(ctx.dataNamespace, noteKey(note.id)), updated);
  return updated;
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
}
