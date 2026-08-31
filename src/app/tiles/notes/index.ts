// Notes: folders, markdown notes (bodies in R2 via ctx.blobs, metadata synced via
// ctx.storage — see store.ts/types.ts) and an editor with a formatted view, a toolbar, and a
// raw-markdown toggle (editor.ts). One own responsive layout rather than the shared
// tile `.split` — a folder tree and note list is real navigation, not a side note about the
// main column, and needs its own mobile drill-down (list, then editor) independent of the
// shell's single split-stacks-under-a-hairline behaviour.

import { appendChildren, clear, el } from "../../shell/dom.js";
import { ICONS, iconSvg } from "../../shell/icons.js";
import type { Tile, TileContext } from "../types.js";
import { createNoteEditor, type NoteEditor } from "./editor.js";
import {
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  loadAll,
  loadNoteBody,
  renameFolder,
  saveNote,
  type NotesState,
} from "./store.js";
import type { NoteFolder, NoteMeta } from "./types.js";

let ctx: TileContext;
let state: NotesState = { folders: [], notes: [] };
let currentFolderId: string | null = null;
let currentNote: NoteMeta | null = null;
let editor: NoteEditor | null = null;
let titleInput: HTMLInputElement | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

let shellEl: HTMLElement | null = null;
let sidebarEl: HTMLElement | null = null;
let mainEl: HTMLElement | null = null;

const notesTile: Tile = {
  id: "notes",
  name: "Notes",
  icon: "notes",
  dataNamespace: "notes",
  encryptionTier: "e2ee", // section 1b — green lock: bodies and metadata are both E2EE
  layoutHint: "neutral", // section 14
  layout: "full",

  async init(tileCtx: TileContext) {
    ctx = tileCtx;
    state = await loadAll(ctx);
  },

  render(container: HTMLElement) {
    const shell = el("div.notes-shell", { "data-view": "list" });
    const sidebar = el("div.notes-sidebar");
    const main = el("div.notes-main");
    appendChildren(shell, sidebar, main);
    container.appendChild(shell);
    shellEl = shell;
    sidebarEl = sidebar;
    mainEl = main;
    paintSidebar();
    paintEmptyMain();
  },

  onSync() {
    // A remote change could be to any folder or note — a full reload is simple and correct;
    // the list this repaints from is never more than a personal note collection, not
    // something a re-fetch needs to be careful about the size of.
    void loadAll(ctx).then((next) => {
      state = next;
      paintSidebar();
    });
  },
};

// ── sidebar: breadcrumb, folder list, note list ─────────────────────────────

function childFolders(parentId: string | null): NoteFolder[] {
  return state.folders.filter((f) => f.parentId === parentId).sort((a, b) => a.name.localeCompare(b.name));
}
function notesIn(folderId: string | null): NoteMeta[] {
  return state.notes.filter((n) => n.folderId === folderId).sort((a, b) => b.updatedAt - a.updatedAt);
}
function folderById(id: string | null): NoteFolder | undefined {
  return id ? state.folders.find((f) => f.id === id) : undefined;
}

/** Same shape as settings.ts's device/passkey rows (`.row` > icon + `.who` > `.name`/`.sub`
 * + an action cluster) — a folder or note picked from a list is the same kind of thing to
 * look at as a device or passkey picked from one, so it reuses the row this app already has
 * rather than a fresh one. */
function icon(name: string): HTMLElement {
  const slot = el("span");
  slot.innerHTML = iconSvg(ICONS[name] ?? ICONS.tile ?? "", "ico");
  return slot.firstElementChild as HTMLElement;
}

function paintSidebar(): void {
  if (!sidebarEl) return;
  clear(sidebarEl);

  const crumbs = breadcrumbTrail(currentFolderId);
  const crumbBar = el("div.notes-crumbs");
  crumbs.forEach((crumb, i) => {
    if (i > 0) appendChildren(crumbBar, el("span.notes-crumb-sep", { text: "/" }));
    appendChildren(
      crumbBar,
      el("button.notes-crumb", {
        type: "button",
        text: crumb.name,
        disabled: i === crumbs.length - 1,
        onClick: () => {
          currentFolderId = crumb.id;
          paintSidebar();
        },
      })
    );
  });

  const newFolderBtn = el<HTMLButtonElement>("button.chip.act", {
    type: "button",
    text: "New folder",
    onClick: () => promptNewFolder(),
  });
  const newNoteBtn = el<HTMLButtonElement>("button.btn.go", {
    type: "button",
    text: "New note",
    onClick: () => void addNote(),
  });

  const list = el("div.notes-list");
  for (const folder of childFolders(currentFolderId)) {
    list.appendChild(folderRow(folder));
  }
  for (const note of notesIn(currentFolderId)) {
    list.appendChild(noteRow(note));
  }
  if (childFolders(currentFolderId).length === 0 && notesIn(currentFolderId).length === 0) {
    list.appendChild(el("p.empty", { text: "Nothing here yet." }));
  }

  appendChildren(
    sidebarEl,
    el("div.notes-sidebar-head", {}, [crumbBar, newFolderBtn]),
    list,
    el("div.notes-sidebar-foot", {}, [newNoteBtn])
  );
}

function breadcrumbTrail(folderId: string | null): Array<{ id: string | null; name: string }> {
  const trail: Array<{ id: string | null; name: string }> = [{ id: null, name: "Notes" }];
  const chain: NoteFolder[] = [];
  let cursor = folderById(folderId);
  while (cursor) {
    chain.unshift(cursor);
    cursor = folderById(cursor.parentId);
  }
  for (const folder of chain) trail.push({ id: folder.id, name: folder.name });
  return trail;
}

function folderRow(folder: NoteFolder): HTMLElement {
  const openBtn = el("button.notes-row-main", {
    type: "button",
    onClick: () => {
      currentFolderId = folder.id;
      paintSidebar();
    },
  });
  appendChildren(openBtn, el("div.name", { text: folder.name }));

  const renameBtn = el("button.chip.act", { type: "button", text: "Rename", onClick: () => promptRenameFolder(folder) });
  const deleteBtn = el("button.chip.act", { type: "button", text: "Delete", onClick: () => void removeFolder(folder) });

  return el("div.row", {}, [icon("folder"), el("div.who", {}, [openBtn]), el("div.device-actions", {}, [renameBtn, deleteBtn])]);
}

function noteRow(note: NoteMeta): HTMLElement {
  // No separate actions to make room for (unlike a folder's rename/delete), so the whole
  // row is the button — the same shape shell.css already gives any other fully-clickable row.
  return el("button.row", { type: "button", "data-current": note.id === currentNote?.id ? "true" : undefined, onClick: () => void openNote(note) }, [
    icon("notes"),
    el("div.who", {}, [el("div.name", { text: note.title || "Untitled" })]),
  ]);
}

function promptNewFolder(): void {
  const name = prompt("Folder name")?.trim();
  if (!name) return;
  void createFolder(ctx, name, currentFolderId).then((folder) => {
    state.folders.push(folder);
    paintSidebar();
  });
}

function promptRenameFolder(folder: NoteFolder): void {
  const name = prompt("Rename folder", folder.name)?.trim();
  if (!name || name === folder.name) return;
  void renameFolder(ctx, folder, name).then((updated) => {
    state.folders = state.folders.map((f) => (f.id === updated.id ? updated : f));
    paintSidebar();
  });
}

function removeFolder(folder: NoteFolder): void {
  if (!confirm(`Delete "${folder.name}"? Its notes and subfolders move to the level above, nothing is deleted.`)) return;
  void deleteFolder(ctx, state, folder).then(() => loadAll(ctx)).then((next) => {
    state = next;
    if (currentFolderId === folder.id) currentFolderId = folder.parentId;
    paintSidebar();
  });
}

// ── main: the editor ─────────────────────────────────────────────────────

function paintEmptyMain(): void {
  if (!mainEl) return;
  clear(mainEl);
  appendChildren(mainEl, el("p.empty.notes-empty-main", { text: "Select a note, or start a new one." }));
}

async function addNote(): Promise<void> {
  const note = await createNote(ctx, currentFolderId);
  state.notes.push(note);
  paintSidebar();
  await openNote(note);
}

async function openNote(note: NoteMeta): Promise<void> {
  await flushPendingSave();
  currentNote = note;
  shellEl?.setAttribute("data-view", "editor");
  paintSidebar(); // repaint to move the "current" highlight
  if (!mainEl) return;
  clear(mainEl);

  const backBtn = el("button.notes-back", { type: "button", "aria-label": "Back to notes", onClick: () => closeNote() });
  backBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5L8 12l6.5 6.5"/></svg>';
  titleInput = el<HTMLInputElement>("input.notes-title", {
    type: "text",
    value: note.title,
    placeholder: "Untitled",
    oninput: () => scheduleSave(),
  });
  const deleteBtn = el("button.chip.act", { type: "button", text: "Delete", onClick: () => void removeNote(note) });
  const editorHost = el("div.notes-editor-host");
  appendChildren(mainEl, el("div.notes-main-head", {}, [backBtn, titleInput, deleteBtn]), editorHost);

  const body = await loadNoteBody(ctx, note);
  editor = createNoteEditor(editorHost, body, () => scheduleSave());
}

async function removeNote(note: NoteMeta): Promise<void> {
  if (!confirm(`Delete "${note.title || "Untitled"}"? This can't be undone.`)) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await deleteNote(ctx, note);
  state.notes = state.notes.filter((n) => n.id !== note.id);
  if (currentNote?.id === note.id) closeNote();
  else paintSidebar();
}

function closeNote(): void {
  void flushPendingSave();
  currentNote = null;
  editor = null;
  shellEl?.setAttribute("data-view", "list");
  paintEmptyMain();
}

function scheduleSave(): void {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flushPendingSave(), 800);
}

async function flushPendingSave(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (!currentNote || !editor || !titleInput) return;
  const title = titleInput.value.trim();
  const body = editor.getMarkdown();
  const updated = await saveNote(ctx, currentNote, title, body);
  currentNote = updated;
  state.notes = state.notes.map((n) => (n.id === updated.id ? updated : n));
}

export default notesTile;
