// Yjs-based CRDT for a note's body (design doc §5.3): two devices editing the same note while
// both offline must merge when they reconnect, not silently lose one side's edits to
// last-write-wins — store.ts's own header covers how the resulting updates travel (small,
// synced through the ordinary tile_records mechanism, never a whole blob overwritten wholesale
// on every save).
//
// The editor itself (editor.ts) is unaware Yjs exists at all — it hands back a whole markdown
// string on every change, the same getMarkdown()/setMarkdown() boundary it always has. What's
// new is what happens to that string in between: instead of overwriting one stored blob
// outright, it's diffed against a shared Y.Text and applied as a targeted insert/delete, so
// two devices typing in different parts of the same note while offline merge correctly once
// they sync, instead of one clobbering the other.

import * as Y from "yjs";

const TEXT_KEY = "body";

export function createNoteDoc(): Y.Doc {
  return new Y.Doc();
}

function text(doc: Y.Doc): Y.Text {
  return doc.getText(TEXT_KEY);
}

export function textOf(doc: Y.Doc): string {
  return text(doc).toString();
}

/** Common-prefix/common-suffix diff — the same trick most plain-text CRDT integrations use
 * for "a whole new string arrived, but really only one spot changed". A per-keystroke Yjs
 * binding (the smoother approach editors like ProseMirror get via y-prosemirror) isn't
 * available here since this editor hands back a full string per change, not per-keystroke
 * deltas — this is the honest middle ground: still a real CRDT insert/delete at the actual
 * edit point, not a blind delete-everything-insert-everything that would throw away every
 * bit of merge granularity. Two devices typing in genuinely different parts of the same note
 * while both offline still merge correctly; two edits at the exact same spot still resolve
 * (Yjs's own conflict rule), just without a finer split than "where the prefix/suffix match
 * ends".
 *
 * Returns the update produced by this specific edit (or null if `next` matches the doc's
 * current text already) — captured via Yjs's own update event fired by the transaction below,
 * not a full-state re-encode, so what gets persisted/synced per edit is just the delta. */
export function applyMarkdownEdit(doc: Y.Doc, next: string): Uint8Array | null {
  const y = text(doc);
  const prev = y.toString();
  if (prev === next) return null;

  let prefix = 0;
  const maxPrefix = Math.min(prev.length, next.length);
  while (prefix < maxPrefix && prev[prefix] === next[prefix]) prefix++;

  let suffix = 0;
  const maxSuffix = Math.min(prev.length, next.length) - prefix;
  while (suffix < maxSuffix && prev[prev.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;

  const deleteLength = prev.length - prefix - suffix;
  const inserted = next.slice(prefix, next.length - suffix);

  let update: Uint8Array | null = null;
  const capture = (u: Uint8Array) => {
    update = u;
  };
  doc.on("update", capture);
  doc.transact(() => {
    if (deleteLength > 0) y.delete(prefix, deleteLength);
    if (inserted.length > 0) y.insert(prefix, inserted);
  });
  doc.off("update", capture);
  return update;
}

/** Merges an update from another device (or an earlier session of this one) into `doc` —
 * commutative and idempotent by construction (Yjs's core guarantee), so updates can arrive in
 * any order, any number of times, any number of them missing entirely, and every device that
 * has eventually seen the same set converges on the same text. */
export function applyUpdate(doc: Y.Doc, update: Uint8Array): void {
  Y.applyUpdate(doc, update);
}

/** The doc's full current state, for the periodic compaction store.ts does once a note has
 * accumulated enough incremental updates — collapses the whole history into one blob so
 * storage doesn't grow without bound, without losing anything: every applied update is
 * already folded into this state. */
export function encodeSnapshot(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

export function loadFromSnapshot(snapshot: Uint8Array | null): Y.Doc {
  const doc = createNoteDoc();
  if (snapshot) Y.applyUpdate(doc, snapshot);
  return doc;
}
