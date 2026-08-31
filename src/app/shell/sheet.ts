// The dialog every popup in the shell is built from — a bottom sheet on a
// phone, a centred card on desktop, and a native `<dialog>` in both, so
// Escape, the focus trap and the backdrop are the platform's job rather
// than hand-rolled three times. One live sheet at a time: opening a second
// closes the first, so a control opened from inside an already-open sheet
// can't leave two backdrops stacked with no way back past the first.
//
// Adapted from a sibling project's `sheet.js` (F1 Apex) — same shape,
// written fresh here against this project's `el()` (./dom.ts).

import { el } from "./dom.js";

let openDialog: HTMLDialogElement | null = null;

export interface OpenSheetOptions {
  /** Accessible name — a sheet has no visible heading of its own to point at. */
  label: string;
  /** Default true. A form worth not losing to a stray click outside it (Library's own sheets
   * — a passphrase, a file mid-upload) sets this false: Escape and the sheet's own `.sheet-x`
   * button still close it (native `<dialog>` cancel behavior, untouched either way), only the
   * backdrop-click shortcut is what this disables. */
  dismissOnBackdrop?: boolean;
}

/** Opens `cls` (e.g. "more-sheet", "alert-sheet") as a modal sheet, already
 * shown. The returned dialog removes itself from the DOM on close — build
 * its contents into `.sheet-inner` before/after calling this as needed. */
export function openSheet(cls: string, { label, dismissOnBackdrop = true }: OpenSheetOptions): HTMLDialogElement {
  openDialog?.close();
  const node = el(`dialog.sheet.${cls}`, { "aria-label": label }) as HTMLDialogElement;
  node.addEventListener("close", () => {
    if (openDialog === node) openDialog = null;
    node.remove();
  });
  if (dismissOnBackdrop) {
    // The dialog's own box is the full-bleed sheet, so a click landing on it
    // rather than on `.sheet-inner` came from the backdrop.
    node.addEventListener("click", (e) => {
      if (e.target === node) node.close();
    });
  }
  document.body.appendChild(node);
  openDialog = node;
  node.showModal();
  return node;
}

/** The head every sheet shares: a grab handle (phone only, hidden ≥900px
 * via shell.css), a title, an optional sub-line, and a close button. */
export function sheetHead(node: HTMLDialogElement, title: string, sub = ""): HTMLElement {
  return el("header.sheet-head", {}, [
    el("span.grab", { "aria-hidden": "true" }),
    el("div.sheet-who", {}, [
      el("div.sheet-name", {}, [el("div.line", {}, [el("span.t", { text: title })]), el("span.s", { text: sub })]),
      el("button.sheet-x", { type: "button", "aria-label": "Close", text: "✕", onClick: () => node.close() }),
    ]),
  ]);
}

/** The foot every sheet with actions shares: buttons in a row, right-aligned. */
export function sheetFoot(buttons: HTMLElement[]): HTMLElement {
  return el("footer.sheet-foot", {}, buttons);
}
