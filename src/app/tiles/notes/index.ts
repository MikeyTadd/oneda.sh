// Reference tile implementation (build order, section 11, step 3 — "pick notes or tasks,
// prove the whole loop works"). Deliberately minimal: local encrypted CRUD + push to the
// sync queue on write, render incoming updates. CRDT merge (Yjs, section 5.3) slots into
// onSync/init once two-device conflict resolution is needed — not required to prove the
// offline + sync loop end-to-end first.

import type { Tile, TileContext } from "../types.js";
import { namespacedKey } from "../../storage/db.js";

interface Note {
  id: string;
  text: string;
  updatedAt: number;
}

let ctx: TileContext;
let notes: Map<string, Note> = new Map();
let listEl: HTMLUListElement | null = null;

const notesTile: Tile = {
  id: "notes",
  name: "Notes",
  icon: "notes",
  dataNamespace: "notes",
  encryptionTier: "e2ee", // section 1b — green lock, never leaves the client unencrypted
  layoutHint: "neutral", // section 14
  // Section 4.5. A list of notes has nothing a side track would carry, so
  // it takes the full width rather than declaring a column it would leave
  // empty. Stated rather than left to the default, since it is a design
  // decision about this screen and not an oversight.
  layout: "full",

  async init(tileCtx: TileContext) {
    ctx = tileCtx;
    const keys = await ctx.storage.listKeys(`${ctx.dataNamespace}:`);
    for (const key of keys) {
      const note = await ctx.storage.get<Note>(key);
      if (note) notes.set(note.id, note);
    }
  },

  render(container: HTMLElement) {
    // No heading: the shell's sticky bar already names the tile, and a
    // screen that prints its own title under that one reads as two
    // different things stacked (docs/DESIGN.md §4.4).
    const form = document.createElement("form");
    const input = document.createElement("input");
    input.placeholder = "New note";
    form.appendChild(input);
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      if (input.value.trim()) {
        void createNote(input.value.trim());
        input.value = "";
      }
    });
    container.appendChild(form);

    listEl = document.createElement("ul");
    container.appendChild(listEl);
    renderList();
  },

  onSync(update: unknown) {
    const note = update as Note;
    notes.set(note.id, note);
    renderList();
  },
};

async function createNote(text: string): Promise<void> {
  const note: Note = { id: crypto.randomUUID(), text, updatedAt: Date.now() };
  notes.set(note.id, note);
  // storage.put encrypts under the DEK transparently (section 5.1); the DEK itself lives
  // in the shell and is never touched directly by tile code.
  await ctx.storage.put(namespacedKey(ctx.dataNamespace, note.id), note);
  // TODO: also ctx.syncQueue.push(...) with the same ciphertext once the shell threads the
  // DEK's raw envelope (iv + ciphertext) alongside storage.put, so sync and local storage
  // share one encryption call instead of encrypting twice.
  renderList();
}

function renderList(): void {
  if (!listEl) return;
  listEl.innerHTML = "";
  for (const note of [...notes.values()].sort((a, b) => b.updatedAt - a.updatedAt)) {
    const li = document.createElement("li");
    li.textContent = note.text;
    listEl.appendChild(li);
  }
}

export default notesTile;
