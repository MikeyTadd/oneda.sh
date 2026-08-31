// Library: many named collections of files of any type/size, searchable by title,
// description and keywords, with some collections optionally hidden behind their own
// passphrase (store.ts's own header comment covers the two-layer encryption that implies).
// Uses the tile system's own "split" layout (registry.ts) the same way Notes does — see
// notes/index.ts's header for why that matters — with the library list as the (mirrored,
// left-hand) side and the selected library's files as the main column.

import { appendChildren, clear, el } from "../../shell/dom.js";
import { ICONS, iconSvg } from "../../shell/icons.js";
import { openSheet, sheetFoot, sheetHead } from "../../shell/sheet.js";
import type { Tile, TileContext } from "../types.js";
import {
  createHiddenLibrary,
  createLibrary,
  deleteLibrary,
  downloadFile,
  fileMeta,
  loadAll,
  renameLibrary,
  tryReveal,
  uploadFile,
  type LibraryState,
} from "./store.js";
import type { LibraryFile, LibraryFileMeta, LibraryMeta } from "./types.js";

let ctx: TileContext;
let state: LibraryState = { libraries: [], files: [] };

/** A hidden library's content key and decrypted name, kept only in memory for this tab —
 * never persisted, never synced (store.ts's own comment on ContentKeys). A page reload
 * re-hides everything, which is the intended behavior, not a bug to work around. */
const revealed = new Map<string, { contentKey: CryptoKey; name: string }>();

let currentLibraryId: string | null = null;
let searchQuery = "";

let shellEl: HTMLElement | null = null;
let sidebarEl: HTMLElement | null = null;
let mainEl: HTMLElement | null = null;
let shortcutBound = false;

const libraryTile: Tile = {
  id: "library",
  name: "Library",
  icon: "library",
  dataNamespace: "library",
  encryptionTier: "e2ee",
  layoutHint: "neutral",
  layout: "split",
  // Checked by shell.ts's nav painting (nav.ts's NavDestination) to attach the 5-tap counter
  // this tile's own hidden-reveal shortcut listens for on a phone — see bindRevealShortcut.
  tapReveal: true,

  async init(tileCtx: TileContext) {
    ctx = tileCtx;
    state = await loadAll(ctx);
    bindRevealShortcut();
  },

  render(container: HTMLElement) {
    container.classList.add("library-main");
    mainEl = container;
    shellEl = container.closest<HTMLElement>(".split");
    shellEl?.setAttribute("data-view", "list");
    paintMain();
  },

  renderSide(container: HTMLElement) {
    container.classList.add("library-sidebar", "side-left");
    sidebarEl = container;
    shellEl = container.closest<HTMLElement>(".split");
    paintSidebar();
  },

  onSync() {
    void loadAll(ctx).then((next) => {
      state = next;
      // A library revealed on this device that was deleted from another one shouldn't
      // linger in the revealed set forever with a dangling content key.
      for (const id of [...revealed.keys()]) {
        if (!next.libraries.some((l) => l.id === id && l.hidden)) revealed.delete(id);
      }
      paintSidebar();
      paintMain();
    });
  },
};

function icon(name: string): HTMLElement {
  const slot = el("span");
  slot.innerHTML = iconSvg(ICONS[name] ?? ICONS.tile ?? "", "ico");
  return slot.firstElementChild as HTMLElement;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

function displayName(library: LibraryMeta): string {
  if (!library.hidden) return library.name || "Untitled library";
  return revealed.get(library.id)?.name ?? "Hidden library";
}

/** Non-hidden libraries, plus hidden ones currently revealed — anything else is exactly as
 * absent from this list as it is from plain view, which is the entire point. */
function visibleLibraries(): LibraryMeta[] {
  return state.libraries.filter((l) => !l.hidden || revealed.has(l.id)).sort((a, b) => displayName(a).localeCompare(displayName(b)));
}

// ── sidebar: the library list ────────────────────────────────────────────

function paintSidebar(): void {
  if (!sidebarEl) return;
  clear(sidebarEl);

  // Same `.btn.ghost.wide` as Notes' "New note" (tiles/notes/index.ts) — the top-of-sidebar
  // action pattern this template uses, not a footer chasing a growing list.
  const newLibraryBtn = el<HTMLButtonElement>("button.btn.ghost.wide", {
    type: "button",
    text: "New library",
    onClick: () => void promptNewLibrary(),
  });

  const list = el("div.notes-list");
  const libraries = visibleLibraries();
  if (libraries.length === 0) {
    list.appendChild(el("p.empty", { text: "No libraries yet." }));
  } else {
    for (const library of libraries) list.appendChild(libraryRow(library));
  }

  appendChildren(sidebarEl, el("div.notes-sidebar-top", {}, [newLibraryBtn]), list);
}

function libraryRow(library: LibraryMeta): HTMLElement {
  const openBtn = el("button.notes-row-main", { type: "button", onClick: () => selectLibrary(library.id) });
  appendChildren(openBtn, el("div.name", { text: displayName(library) }));

  const renameBtn = el("button.chip.act", { type: "button", text: "Rename", onClick: () => void promptRenameLibrary(library) });
  const deleteBtn = el("button.chip.act", { type: "button", text: "Delete", onClick: () => void removeLibrary(library) });

  return el("div.row", { "data-current": library.id === currentLibraryId ? "true" : undefined }, [
    icon(library.hidden ? "lock" : "folder"),
    el("div.who", {}, [openBtn]),
    el("div.device-actions", {}, [renameBtn, deleteBtn]),
  ]);
}

function selectLibrary(id: string): void {
  currentLibraryId = id;
  searchQuery = "";
  shellEl?.setAttribute("data-view", "files");
  paintSidebar();
  paintMain();
}

function backToList(): void {
  currentLibraryId = null;
  shellEl?.setAttribute("data-view", "list");
  paintMain();
}

async function promptNewLibrary(): Promise<void> {
  const name = prompt("Library name")?.trim();
  if (!name) return;
  const hidden = confirm(`Hide "${name}" behind its own passphrase?\n\nOK = hidden, Cancel = a normal library.`);

  if (!hidden) {
    const library = await createLibrary(ctx, name);
    state.libraries.push(library);
  } else {
    const passphrase = await promptPassphrase(`Set a passphrase for "${name}"`);
    if (!passphrase) return;
    const confirmed = await promptPassphrase("Confirm that passphrase");
    if (confirmed !== passphrase) {
      alert("Passphrases didn't match — try again from “New library”.");
      return;
    }
    const { library, contentKey } = await createHiddenLibrary(ctx, name, passphrase);
    state.libraries.push(library);
    revealed.set(library.id, { contentKey, name });
  }

  selectLibrary(state.libraries[state.libraries.length - 1]!.id);
}

function promptRenameLibrary(library: LibraryMeta): void {
  const current = displayName(library);
  const name = prompt("Rename library", current)?.trim();
  if (!name || name === current) return;
  const contentKey = library.hidden ? revealed.get(library.id)?.contentKey : undefined;
  void renameLibrary(ctx, library, name, contentKey).then((updated) => {
    state.libraries = state.libraries.map((l) => (l.id === updated.id ? updated : l));
    const entry = revealed.get(library.id);
    if (entry) revealed.set(library.id, { ...entry, name });
    paintSidebar();
    if (currentLibraryId === library.id) paintMain();
  });
}

function removeLibrary(library: LibraryMeta): void {
  if (!confirm(`Delete "${displayName(library)}" and everything in it? This can't be undone.`)) return;
  void deleteLibrary(ctx, state, library)
    .then(() => loadAll(ctx))
    .then((next) => {
      state = next;
      revealed.delete(library.id);
      if (currentLibraryId === library.id) {
        currentLibraryId = null;
        shellEl?.setAttribute("data-view", "list");
      }
      paintSidebar();
      paintMain();
    });
}

// ── main: the selected library's files ───────────────────────────────────

function paintMain(): void {
  if (!mainEl) return;
  clear(mainEl);

  const library = state.libraries.find((l) => l.id === currentLibraryId);
  if (!library) {
    appendChildren(mainEl, el("p.empty.notes-empty-main", { text: "Select a library, or create one." }));
    return;
  }

  const backBtn = el("button.notes-back", { type: "button", "aria-label": "Back to libraries", onClick: () => backToList() });
  backBtn.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14.5 5.5L8 12l6.5 6.5"/></svg>';
  const title = el("div.notes-title", {}, [displayName(library)]);
  const uploadBtn = el<HTMLButtonElement>("button.chip.act", { type: "button", text: "Upload", onClick: () => void promptUpload(library) });

  const searchInput = el<HTMLInputElement>("input.text-input.library-search", {
    type: "search",
    placeholder: "Search title, description, keywords",
    value: searchQuery,
    oninput: (event: Event) => {
      searchQuery = (event.target as HTMLInputElement).value;
      void paintFileList(list, library);
    },
  });

  const list = el("div.notes-list");
  appendChildren(mainEl, el("div.notes-main-head", {}, [backBtn, title, uploadBtn]), searchInput, list);
  void paintFileList(list, library);
}

async function paintFileList(container: HTMLElement, library: LibraryMeta): Promise<void> {
  const contentKey = library.hidden ? revealed.get(library.id)?.contentKey : undefined;
  const files = state.files.filter((f) => f.libraryId === library.id);
  const rows = await Promise.all(files.map(async (file) => ({ file, meta: await fileMeta(file, contentKey) })));

  const q = searchQuery.trim().toLowerCase();
  const filtered = q
    ? rows.filter(
        ({ meta }) =>
          meta.title.toLowerCase().includes(q) || meta.description.toLowerCase().includes(q) || meta.keywords.some((k) => k.toLowerCase().includes(q))
      )
    : rows;

  clear(container);
  if (filtered.length === 0) {
    container.appendChild(el("p.empty", { text: q ? "No matching files." : "Nothing here yet." }));
    return;
  }
  for (const { file, meta } of filtered) container.appendChild(fileRow(file, meta, contentKey));
}

function fileRow(file: LibraryFile, meta: LibraryFileMeta, contentKey: CryptoKey | undefined): HTMLElement {
  return el("button.row", { type: "button", onClick: () => void openPreview(file, meta, contentKey) }, [
    icon("notes"),
    el("div.who", {}, [el("div.name", { text: meta.title || "Untitled" }), el("div.sub", { text: meta.description || formatSize(file.byteSize) })]),
  ]);
}

async function promptUpload(library: LibraryMeta): Promise<void> {
  const input = el<HTMLInputElement>("input", { type: "file", style: "display:none" });
  document.body.appendChild(input);
  const file = await new Promise<File | null>((resolve) => {
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.click();
  });
  input.remove();
  if (!file) return;

  const title = prompt("Title", file.name)?.trim();
  if (!title) return;
  const description = prompt("Description (optional)")?.trim() ?? "";
  const keywordsRaw = prompt("Keywords, comma separated (optional)")?.trim() ?? "";
  const keywords = keywordsRaw
    ? keywordsRaw
        .split(",")
        .map((k) => k.trim())
        .filter(Boolean)
    : [];

  const contentKey = library.hidden ? revealed.get(library.id)?.contentKey : undefined;
  const status = el("p.empty", { text: "Uploading… 0%" });
  mainEl?.appendChild(status);
  try {
    const uploaded = await uploadFile(ctx, library.id, file, { title, description, keywords }, contentKey, (p) => {
      status.textContent = `Uploading… ${Math.round((p.sentBytes / p.totalBytes) * 100)}%`;
    });
    state.files.push(uploaded);
    if (currentLibraryId === library.id) paintMain();
  } catch (err) {
    console.error("library upload failed", err);
    status.textContent = "Upload failed.";
  }
}

async function openPreview(file: LibraryFile, meta: LibraryFileMeta, contentKey: CryptoKey | undefined): Promise<void> {
  const node = openSheet("library-preview", { label: meta.title || "File" });
  const scroll = el("div.sheet-scroll", {}, [el("p.empty", { text: "Loading…" })]);
  node.append(el("div.sheet-inner", {}, [sheetHead(node, meta.title || "Untitled", formatSize(file.byteSize)), scroll]));

  try {
    const blob = await downloadFile(file, ctx, contentKey, (p) => {
      const status = scroll.querySelector("p.empty");
      if (status) status.textContent = `Loading… ${Math.round((p.sentBytes / p.totalBytes) * 100)}%`;
    });
    const url = URL.createObjectURL(blob);
    clear(scroll);

    if (file.mimeType.startsWith("image/")) {
      scroll.appendChild(el<HTMLImageElement>("img.library-preview-media", { src: url, alt: meta.title }));
    } else if (file.mimeType.startsWith("video/")) {
      scroll.appendChild(el<HTMLVideoElement>("video.library-preview-media", { src: url, controls: true, autoplay: true }));
    } else if (file.mimeType.startsWith("audio/")) {
      scroll.appendChild(el<HTMLAudioElement>("audio.library-preview-media", { src: url, controls: true, autoplay: true }));
    } else {
      scroll.appendChild(el("p.empty", { text: "This file type can't be previewed here." }));
    }
    if (meta.description) scroll.appendChild(el("p.empty", { text: meta.description }));
    scroll.appendChild(el<HTMLAnchorElement>("a.btn.ghost.wide", { href: url, download: meta.title || "file", text: "Download" }));
  } catch (err) {
    console.error("library file download failed", err);
    clear(scroll);
    scroll.appendChild(el("p.empty", { text: "Failed to load this file." }));
  }
}

// ── the hidden-library reveal shortcut ───────────────────────────────────
//
// Deliberately not a button anywhere — Ctrl/Cmd+Shift+H on a desktop (matching the existing
// Ctrl/Cmd+Shift+L lock shortcut's shape, shell/reauth.ts), a 5-tap on this tile's own nav
// label on a phone (shell.ts's nav painting, gated on the `tapReveal` manifest flag above).
// Either one just opens the same passphrase prompt; which library it reveals (or re-hides,
// on a second matching entry) is decided entirely by the passphrase itself — see this
// module's own header comment and store.ts's tryReveal.

function bindRevealShortcut(): void {
  if (shortcutBound) return;
  shortcutBound = true;

  window.addEventListener("keydown", (event) => {
    if (!event.shiftKey || (!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== "h") return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    event.preventDefault();
    void handleRevealPrompt();
  });

  window.addEventListener("tile-tap-reveal", (event) => {
    if ((event as CustomEvent<{ tileId: string }>).detail?.tileId !== "library") return;
    void handleRevealPrompt();
  });
}

async function handleRevealPrompt(): Promise<void> {
  const passphrase = await promptPassphrase("Library passphrase");
  if (!passphrase) return;

  // Try what's already revealed first: the same passphrase entered again is how a library
  // gets re-hidden, and that has to win over incidentally revealing some other library that
  // happens to share the same passphrase.
  for (const [id] of revealed) {
    const library = state.libraries.find((l) => l.id === id);
    if (!library) continue;
    const match = await tryReveal([library], passphrase);
    if (match) {
      revealed.delete(id);
      if (currentLibraryId === id) {
        currentLibraryId = null;
        shellEl?.setAttribute("data-view", "list");
      }
      paintSidebar();
      paintMain();
      return;
    }
  }

  const match = await tryReveal(state.libraries, passphrase);
  if (!match) return; // wrong passphrase, or nothing hidden to find — no hint either way
  revealed.set(match.library.id, { contentKey: match.contentKey, name: match.name });
  paintSidebar();
}

/** A masked-input prompt, reused for both setting a hidden library's passphrase and the
 * reveal shortcut above — the one piece of custom UI in this tile worth building instead of
 * the plain window.prompt() every other text entry here uses (promptNewLibrary,
 * promptRenameLibrary, promptUpload), since a passphrase needs its input actually hidden. */
function promptPassphrase(title: string): Promise<string | null> {
  return new Promise((resolve) => {
    const node = openSheet("library-passphrase", { label: title });
    let resolved = false;
    const finish = (value: string | null) => {
      if (resolved) return;
      resolved = true;
      resolve(value);
      node.close();
    };

    const input = el<HTMLInputElement>("input.text-input", { type: "password", placeholder: "Passphrase" });
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        finish(input.value);
      }
    });
    node.addEventListener("close", () => finish(null));

    node.append(
      el("div.sheet-inner", {}, [
        sheetHead(node, title),
        el("div.sheet-scroll", {}, [input]),
        sheetFoot([
          el("button.btn.ghost", { type: "button", text: "Cancel", onClick: () => node.close() }),
          el<HTMLButtonElement>("button.btn.go", { type: "button", text: "Continue", onClick: () => finish(input.value) }),
        ]),
      ])
    );
    input.focus();
  });
}

export default libraryTile;
