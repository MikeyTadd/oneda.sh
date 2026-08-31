// Notes: folders, markdown notes (bodies in R2 via ctx.blobs, metadata synced via
// ctx.storage — see store.ts/types.ts) and an editor with a formatted view, a toolbar, and a
// raw-markdown toggle (editor.ts). Uses the tile system's own "split" layout (registry.ts) —
// the exact structure Settings renders into (section > .split > .main-col + aside.side), not
// a second, hand-built one nested inside the "full"-layout wrapper. That extra nesting was
// the actual cause of a run of height/background bugs a purely visual fix kept missing:
// registry.ts's own .main-col wrapper, with our own .split rebuilt one level inside it,
// fighting each other over which one was supposed to fill the view. render() owns the
// editor (the tile's mainCol), renderSide() owns the folder tree and note list — mirrored via
// CSS (grid-template-columns, order) since here the narrow panel is navigation, not facts.

import type * as Y from "yjs";
import { base64UrlToBuffer } from "../../crypto/codec.js";
import { appendChildren, clear, el } from "../../shell/dom.js";
import { ICONS, iconSvg } from "../../shell/icons.js";
import type { Tile, TileContext } from "../types.js";
import { applyUpdate, textOf } from "./crdt.js";
import { createNoteEditor, type NoteEditor } from "./editor.js";
import {
  createFolder,
  createNote,
  deleteFolder,
  deleteNote,
  loadAll,
  loadNoteBody,
  moveNote,
  renameFolder,
  saveNote,
  type NotesState,
} from "./store.js";
import type { NoteFolder, NoteMeta, NoteUpdateRecord } from "./types.js";

let ctx: TileContext;
let state: NotesState = { folders: [], notes: [] };
let currentFolderId: string | null = null;
let currentNote: NoteMeta | null = null;
/** The live Yjs document for whichever note is open — kept for the note's whole open session
 * so every save's diff (store.ts's saveNote) lands on top of the actual merged state,
 * including anything just merged in from another device via onSync below, not a stale one
 * reloaded from scratch on every keystroke. */
let currentNoteDoc: Y.Doc | null = null;
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
  layout: "split",

  async init(tileCtx: TileContext) {
    ctx = tileCtx;
    state = await loadAll(ctx);
  },

  // registry.ts builds `section > .split > .main-col + aside.side` and calls render(mainCol)
  // then renderSide(side) — the identical structure Settings gets, not a second one rebuilt
  // inside it. `data-view` (the phone drill-down: list, then a note, never both) lives on
  // that shared `.split` ancestor, reached via .closest() since render()/renderSide() each
  // only get their own pane.
  render(container: HTMLElement) {
    container.classList.add("notes-main");
    mainEl = container;
    shellEl = container.closest<HTMLElement>(".split");
    shellEl?.setAttribute("data-view", "list");
    paintEmptyMain();
  },

  renderSide(container: HTMLElement) {
    container.classList.add("notes-sidebar", "side-left");
    sidebarEl = container;
    shellEl = container.closest<HTMLElement>(".split");
    paintSidebar();
  },

  onSync(value: unknown) {
    const record = value as { kind?: string };
    if (record?.kind === "note-update") {
      // The whole point of the CRDT (design doc §5.3, crdt.ts's own header): merge a remote
      // edit into the live document immediately if this is the note currently open, so the
      // next local save's diff lands on top of it instead of silently overwriting it. A
      // note-update never changes what the folder/note list shows, so — unlike every other
      // kind of change here — this deliberately skips the full reload/repaint below.
      const update = record as NoteUpdateRecord;
      if (update.noteId === currentNote?.id && currentNoteDoc) {
        applyUpdate(currentNoteDoc, new Uint8Array(base64UrlToBuffer(update.update)));
        editor?.setMarkdown(textOf(currentNoteDoc));
      }
      return;
    }
    // A remote change to a folder or note's own metadata — a full reload is simple and
    // correct; the list this repaints from is never more than a personal note collection,
    // not something a re-fetch needs to be careful about the size of.
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

/** Every folder, depth-first, indentation included — the flat list the "move to folder"
 * picker (openNote) needs, since a <select> has no notion of a tree. */
function flattenFolders(parentId: string | null = null, depth = 0): Array<{ folder: NoteFolder; depth: number }> {
  const out: Array<{ folder: NoteFolder; depth: number }> = [];
  for (const folder of childFolders(parentId)) {
    out.push({ folder, depth });
    out.push(...flattenFolders(folder.id, depth + 1));
  }
  return out;
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
  // Same `.btn.ghost.wide` as Maintenance's "Check for updates" (settings.ts) — a full-width
  // action button pinned above the list it acts on, not a footer chasing a growing note list.
  const newNoteBtn = el<HTMLButtonElement>("button.btn.ghost.wide", {
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

  appendChildren(sidebarEl, el("div.notes-sidebar-top", {}, [newNoteBtn]), el("div.notes-sidebar-head", {}, [crumbBar, newFolderBtn]), list);
}

function breadcrumbTrail(folderId: string | null): Array<{ id: string | null; name: string }> {
  // Not "Notes" — the bar above already names the tile (settings.ts's own rule: a screen
  // that prints its own title under that one reads as two different things stacked), and
  // this crumb sits one line under it.
  const trail: Array<{ id: string | null; name: string }> = [{ id: null, name: "All notes" }];
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
  // .dwell for the same compact <select> chrome the idle-lock/alert-dwell pickers already use
  // (settings.ts) — a fresh visual style for one more small dropdown would be a third copy.
  const moveSelect = el<HTMLSelectElement>("select.notes-move.dwell", { "aria-label": "Move to folder" });
  moveSelect.appendChild(el("option", { value: "", text: "No folder" }));
  for (const { folder, depth } of flattenFolders()) {
    const option = el<HTMLOptionElement>("option", { value: folder.id, text: `${"— ".repeat(depth)}${folder.name}` });
    if (folder.id === note.folderId) option.selected = true;
    moveSelect.appendChild(option);
  }
  moveSelect.addEventListener("change", () => void moveCurrentNote(moveSelect.value || null));

  const deleteBtn = el("button.chip.act", { type: "button", text: "Delete", onClick: () => void removeNote(note) });
  const editorHost = el("div.notes-editor-host");
  appendChildren(mainEl, el("div.notes-main-head", {}, [backBtn, titleInput, moveSelect, deleteBtn]), editorHost);

  const { doc, markdown } = await loadNoteBody(ctx, note);
  currentNoteDoc = doc;
  editor = createNoteEditor(editorHost, markdown, () => scheduleSave());
}

/** Always acts on `currentNote`, never a `note` captured in the moveSelect listener's own
 * closure at open time — that closure goes stale the moment the title or body changes during
 * the session, and moveNote's `{ ...note, folderId }` spread would otherwise silently discard
 * whatever was typed since, reverting the title/body sync had already saved right back to
 * what they were when the note was first opened. flushPendingSave first for the same reason:
 * an edit still sitting in the debounce timer needs to land before this reads currentNote. */
async function moveCurrentNote(folderId: string | null): Promise<void> {
  if (!currentNote) return;
  await flushPendingSave();
  const updated = await moveNote(ctx, currentNote, folderId);
  state.notes = state.notes.map((n) => (n.id === updated.id ? updated : n));
  currentNote = updated;
  paintSidebar();
}

async function removeNote(note: NoteMeta): Promise<void> {
  if (!confirm(`Delete "${note.title || "Untitled"}"? This can't be undone.`)) return;
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  await deleteNote(ctx, note);
  state.notes = state.notes.filter((n) => n.id !== note.id);
  if (currentNote?.id === note.id) {
    // Not closeNote(): its flush would save the still-open editor's last content right back
    // over the tombstone deleteNote() just wrote, resurrecting the note on the next reload —
    // exactly the bug this was. There is nothing left to save; only the view resets.
    currentNote = null;
    currentNoteDoc = null;
    editor = null;
    shellEl?.setAttribute("data-view", "list");
    paintSidebar();
    paintEmptyMain();
  } else {
    paintSidebar();
  }
}

async function closeNote(): Promise<void> {
  await flushPendingSave();
  currentNote = null;
  currentNoteDoc = null;
  editor = null;
  shellEl?.setAttribute("data-view", "list");
  paintSidebar(); // the title (or content) may just have changed — the list should say so
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
  if (!currentNote || !currentNoteDoc || !editor || !titleInput) return;
  const title = titleInput.value.trim();
  const body = editor.getMarkdown();
  const updated = await saveNote(ctx, currentNote, currentNoteDoc, title, body);
  currentNote = updated;
  state.notes = state.notes.map((n) => (n.id === updated.id ? updated : n));
}

export default notesTile;
