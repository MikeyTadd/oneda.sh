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
  deleteFile,
  deleteLibrary,
  downloadFile,
  fileMeta,
  loadAll,
  renameLibrary,
  tryReveal,
  updateFileMeta,
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

type FileCategory = "image" | "video" | "audio" | "document";
const CATEGORY_LABELS: Record<FileCategory, string> = { image: "Images", video: "Videos", audio: "Audio", document: "Documents" };
function categoryOf(mimeType: string): FileCategory {
  if (mimeType.startsWith("image/")) return "image";
  if (mimeType.startsWith("video/")) return "video";
  if (mimeType.startsWith("audio/")) return "audio";
  return "document";
}
let activeCategory: FileCategory | null = null;
/** Shown by default; a chip toggles it off rather than it needing to be discovered — this is
 * a convenience filter, not the hidden-library gesture, so there's no reason to hide it by
 * default the way that one is. */
let filtersVisible = true;

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

/** A labeled field inside a sheet form (shell.css's `.form-field`) — the New library, Upload
 * and Edit file sheets below are the app's first multi-field forms, so a bare `.text-input`
 * (fine for the single-field passphrase prompt) needs a label to tell fields apart. */
function formField(label: string, control: HTMLElement): HTMLElement {
  return el("label.form-field", {}, [el("span.form-field-label", { text: label }), control]);
}

/** The same switch shell.css already styles for Settings (button carrying its state in
 * aria-pressed) — settings.ts's own copy is module-private, so this is a second, small one
 * rather than exporting across a tile boundary for one control. */
function switchControl(on: boolean, label: string, onChange: (next: boolean) => void): HTMLButtonElement {
  const btn = el<HTMLButtonElement>("button.switch", {
    type: "button",
    "aria-pressed": String(on),
    "aria-label": label,
    onClick: () => {
      const next = btn.getAttribute("aria-pressed") !== "true";
      btn.setAttribute("aria-pressed", String(next));
      onChange(next);
    },
  });
  btn.appendChild(el("i"));
  return btn;
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
    onClick: () => openNewLibrarySheet(),
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

  const renameBtn = el("button.chip.act", { type: "button", text: "Rename", onClick: () => openRenameLibrarySheet(library) });
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
  activeCategory = null;
  shellEl?.setAttribute("data-view", "files");
  paintSidebar();
  paintMain();
}

function backToList(): void {
  currentLibraryId = null;
  shellEl?.setAttribute("data-view", "list");
  paintMain();
}

function openNewLibrarySheet(): void {
  const node = openSheet("library-new", { label: "New library" });
  let hidden = false;

  const nameInput = el<HTMLInputElement>("input.text-input", { type: "text", placeholder: "e.g. Photos" });
  const passInput = el<HTMLInputElement>("input.text-input", { type: "password", placeholder: "Passphrase" });
  const passConfirm = el<HTMLInputElement>("input.text-input", { type: "password", placeholder: "Confirm passphrase" });
  const passFields = el("div", { hidden: true }, [formField("Passphrase", passInput), formField("Confirm passphrase", passConfirm)]);

  const hideRow = el("div.toggle-row", {}, [
    el("div.t-text", {}, [
      el("div.t-title", { text: "Hide behind a passphrase" }),
      el("div.t-desc", { text: "Nothing in the interface reveals it again afterward — only its own shortcut and this passphrase." }),
    ]),
    switchControl(false, "Hide behind a passphrase", (next) => {
      hidden = next;
      passFields.hidden = !next;
    }),
  ]);

  const status = el("p.empty", { text: "" });
  const createBtn = el<HTMLButtonElement>("button.btn.go", { type: "button", text: "Create", onClick: () => void submit() });

  async function submit(): Promise<void> {
    const name = nameInput.value.trim();
    if (!name) {
      status.textContent = "Give the library a name.";
      return;
    }
    createBtn.disabled = true;
    if (hidden) {
      const passphrase = passInput.value;
      if (!passphrase) {
        status.textContent = "Set a passphrase.";
        createBtn.disabled = false;
        return;
      }
      if (passphrase !== passConfirm.value) {
        status.textContent = "Passphrases don't match.";
        createBtn.disabled = false;
        return;
      }
      const { library, contentKey } = await createHiddenLibrary(ctx, name, passphrase);
      state.libraries.push(library);
      revealed.set(library.id, { contentKey, name });
    } else {
      const library = await createLibrary(ctx, name);
      state.libraries.push(library);
    }
    node.close();
    selectLibrary(state.libraries[state.libraries.length - 1]!.id);
  }

  node.append(
    el("div.sheet-inner", {}, [
      sheetHead(node, "New library"),
      el("div.sheet-scroll", {}, [formField("Name", nameInput), hideRow, passFields, status]),
      sheetFoot([el("button.btn.ghost", { type: "button", text: "Cancel", onClick: () => node.close() }), createBtn]),
    ])
  );
  nameInput.focus();
}

function openRenameLibrarySheet(library: LibraryMeta): void {
  const node = openSheet("library-rename", { label: "Rename library" });
  const input = el<HTMLInputElement>("input.text-input", { type: "text", value: displayName(library) });

  function submit(): void {
    const name = input.value.trim();
    node.close();
    if (!name || name === displayName(library)) return;
    const contentKey = library.hidden ? revealed.get(library.id)?.contentKey : undefined;
    void renameLibrary(ctx, library, name, contentKey).then((updated) => {
      state.libraries = state.libraries.map((l) => (l.id === updated.id ? updated : l));
      const entry = revealed.get(library.id);
      if (entry) revealed.set(library.id, { ...entry, name });
      paintSidebar();
      if (currentLibraryId === library.id) paintMain();
    });
  }

  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      submit();
    }
  });

  node.append(
    el("div.sheet-inner", {}, [
      sheetHead(node, "Rename library"),
      el("div.sheet-scroll", {}, [formField("Name", input)]),
      sheetFoot([el("button.btn.ghost", { type: "button", text: "Cancel", onClick: () => node.close() }), el<HTMLButtonElement>("button.btn.go", { type: "button", text: "Save", onClick: submit })]),
    ])
  );
  input.focus();
  input.select();
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
  const uploadBtn = el<HTMLButtonElement>("button.chip.act", { type: "button", text: "Upload", onClick: () => openUploadSheet(library) });

  const list = el("div.notes-list");

  const searchInput = el<HTMLInputElement>("input.text-input.library-search", {
    type: "search",
    placeholder: "Search title, description, keywords",
    value: searchQuery,
    oninput: (event: Event) => {
      searchQuery = (event.target as HTMLInputElement).value;
      void paintFileList(list, library);
    },
  });
  const filterToggle = el<HTMLButtonElement>("button.chip", {
    type: "button",
    text: "Filter",
    "aria-pressed": String(filtersVisible),
    onClick: () => {
      filtersVisible = !filtersVisible;
      paintMain();
    },
  });

  const children: HTMLElement[] = [el("div.notes-main-head", {}, [backBtn, title, uploadBtn]), el("div.library-toolbar", {}, [searchInput, filterToggle])];
  if (filtersVisible) children.push(typeFilterRow(library));
  children.push(list);
  appendChildren(mainEl, ...children);
  void paintFileList(list, library);
}

function typeFilterRow(library: LibraryMeta): HTMLElement {
  const files = state.files.filter((f) => f.libraryId === library.id);
  const present = new Set(files.map((f) => categoryOf(f.mimeType)));

  const chip = (label: string, active: boolean, onClick: () => void): HTMLElement =>
    el("button.chip", { type: "button", text: label, "aria-pressed": String(active), onClick: () => {
      onClick();
      paintMain();
    } });

  const chips = [chip("All", activeCategory === null, () => (activeCategory = null))];
  for (const cat of Object.keys(CATEGORY_LABELS) as FileCategory[]) {
    if (!present.has(cat)) continue;
    chips.push(chip(CATEGORY_LABELS[cat], activeCategory === cat, () => (activeCategory = cat)));
  }
  return el("div.library-filters", {}, chips);
}

async function paintFileList(container: HTMLElement, library: LibraryMeta): Promise<void> {
  const contentKey = library.hidden ? revealed.get(library.id)?.contentKey : undefined;
  const files = state.files.filter((f) => f.libraryId === library.id && (activeCategory === null || categoryOf(f.mimeType) === activeCategory));
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

function openUploadSheet(library: LibraryMeta): void {
  const node = openSheet("library-upload", { label: "Upload a file" });
  let chosenFile: File | null = null;

  const fileInput = el<HTMLInputElement>("input.text-input", { type: "file" });
  const titleInput = el<HTMLInputElement>("input.text-input", { type: "text", placeholder: "Title" });
  const descInput = el<HTMLTextAreaElement>("textarea.text-input", { rows: 3, placeholder: "Description (optional)" });
  const keywordsInput = el<HTMLInputElement>("input.text-input", { type: "text", placeholder: "e.g. holiday, receipt, cat" });

  fileInput.addEventListener("change", () => {
    chosenFile = fileInput.files?.[0] ?? null;
    if (chosenFile && !titleInput.value.trim()) titleInput.value = chosenFile.name;
  });

  const status = el("p.empty", { text: "" });
  const uploadBtn = el<HTMLButtonElement>("button.btn.go", { type: "button", text: "Upload", onClick: () => void submit() });

  async function submit(): Promise<void> {
    if (!chosenFile) {
      status.textContent = "Choose a file first.";
      return;
    }
    const title = titleInput.value.trim() || chosenFile.name;
    const description = descInput.value.trim();
    const keywords = keywordsInput.value
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);

    uploadBtn.disabled = true;
    fileInput.disabled = true;
    status.textContent = "Uploading… 0%";
    const contentKey = library.hidden ? revealed.get(library.id)?.contentKey : undefined;
    try {
      const uploaded = await uploadFile(ctx, library.id, chosenFile, { title, description, keywords }, contentKey, (p) => {
        status.textContent = `Uploading… ${Math.round((p.sentBytes / p.totalBytes) * 100)}%`;
      });
      state.files.push(uploaded);
      node.close();
      if (currentLibraryId === library.id) paintMain();
    } catch (err) {
      console.error("library upload failed", err);
      status.textContent = "Upload failed.";
      uploadBtn.disabled = false;
      fileInput.disabled = false;
    }
  }

  node.append(
    el("div.sheet-inner", {}, [
      sheetHead(node, "Upload a file"),
      el("div.sheet-scroll", {}, [formField("File", fileInput), formField("Title", titleInput), formField("Description", descInput), formField("Keywords, comma separated", keywordsInput), status]),
      sheetFoot([el("button.btn.ghost", { type: "button", text: "Cancel", onClick: () => node.close() }), uploadBtn]),
    ])
  );
}

function openEditFileSheet(file: LibraryFile, meta: LibraryFileMeta, contentKey: CryptoKey | undefined): void {
  const node = openSheet("library-edit", { label: "Edit file" });
  const titleInput = el<HTMLInputElement>("input.text-input", { type: "text", value: meta.title });
  const descInput = el<HTMLTextAreaElement>("textarea.text-input", { rows: 3, text: meta.description });
  const keywordsInput = el<HTMLInputElement>("input.text-input", { type: "text", value: meta.keywords.join(", ") });
  const status = el("p.empty", { text: "" });
  const saveBtn = el<HTMLButtonElement>("button.btn.go", { type: "button", text: "Save", onClick: () => void submit() });

  async function submit(): Promise<void> {
    const title = titleInput.value.trim();
    if (!title) {
      status.textContent = "Give it a title.";
      return;
    }
    saveBtn.disabled = true;
    const description = descInput.value.trim();
    const keywords = keywordsInput.value
      .split(",")
      .map((k) => k.trim())
      .filter(Boolean);
    const updated = await updateFileMeta(ctx, file, { title, description, keywords }, contentKey);
    state.files = state.files.map((f) => (f.id === updated.id ? updated : f));
    node.close();
    paintMain();
  }

  node.append(
    el("div.sheet-inner", {}, [
      sheetHead(node, "Edit file"),
      el("div.sheet-scroll", {}, [formField("Title", titleInput), formField("Description", descInput), formField("Keywords, comma separated", keywordsInput), status]),
      sheetFoot([el("button.btn.ghost", { type: "button", text: "Cancel", onClick: () => node.close() }), saveBtn]),
    ])
  );
  titleInput.focus();
}

async function removeFile(file: LibraryFile): Promise<void> {
  if (!confirm("Delete this file? This can't be undone.")) return;
  await deleteFile(ctx, file);
  state.files = state.files.filter((f) => f.id !== file.id);
  paintMain();
}

async function openPreview(file: LibraryFile, meta: LibraryFileMeta, contentKey: CryptoKey | undefined): Promise<void> {
  const node = openSheet("library-preview", { label: meta.title || "File" });
  const scroll = el("div.sheet-scroll", {}, [el("p.empty", { text: "Loading…" })]);
  const editBtn = el<HTMLButtonElement>("button.btn.ghost", { type: "button", text: "Edit", onClick: () => openEditFileSheet(file, meta, contentKey) });
  const deleteBtn = el<HTMLButtonElement>("button.btn.ghost.danger", {
    type: "button",
    text: "Delete",
    onClick: () => {
      node.close();
      void removeFile(file);
    },
  });
  const foot = sheetFoot([editBtn, deleteBtn]);
  node.append(el("div.sheet-inner", {}, [sheetHead(node, meta.title || "Untitled", formatSize(file.byteSize)), scroll, foot]));

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
    foot.insertBefore(el<HTMLAnchorElement>("a.btn.ghost.wide", { href: url, download: meta.title || "file", text: "Download" }), editBtn);
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
 * reveal shortcut above — the one piece of custom UI in this tile that isn't the standard
 * form-field shape (openNewLibrarySheet etc.), since a passphrase needs its input actually
 * hidden and its own single-purpose sheet. */
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
