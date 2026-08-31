// In-app alerts: a thing happened while you were looking at something else.
// Deliberately not about any one tile — a source, a title, a line of
// detail, somewhere to go, and nothing about who raised it. Any tile can
// call `alert()` (messenger: "new message", the RSS tile: "3 new
// articles", a reminder firing) and every one renders the same toast and
// the same bell panel row, rather than each tile inventing its own popup.
//
// Not Web Push. Push reaches a device whose app is closed and costs a
// permission prompt; this is shown to someone already looking at the app
// and needs none. The two are complementary — section 6 of docs/DESIGN.md
// is push for the closed app, this is for the open one.
//
// Adapted from a sibling project's `alerts.js` (F1 Apex) — the collapsing
// toast, the sticky-alert exception, the seen/unseen split — written fresh
// here against this project's storage layer instead of a synced-doc one.

import type { EncryptedStorage } from "../storage/db.js";
import { el } from "./dom.js";

export interface AlertAction {
  label: string;
  onClick: () => void;
}

export interface AlertEntry {
  id: string;
  source: string;
  title: string;
  detail: string;
  href: string;
  more: number;
  at: number;
  action: AlertAction | null;
  /** Cannot be cleared from the bell; only doing the thing removes it —
   * for an alert where dismissing is not a valid answer. */
  sticky: boolean;
  seen: boolean;
}

export interface RaiseAlert {
  id?: string;
  source: string;
  title: string;
  detail?: string;
  href?: string;
  more?: number;
  at?: number;
  action?: AlertAction | null;
  sticky?: boolean;
}

/** How long a toast stays before withdrawing itself, in ms. 0 means "until
 * dismissed". Settings can override this later; a sane default works
 * before that exists and for any caller that never sets one. */
let dwellMs = 10_000;

export function configureAlerts(opts: { dwellMs?: number }): void {
  if (typeof opts.dwellMs === "number" && Number.isFinite(opts.dwellMs) && opts.dwellMs >= 0) {
    dwellMs = opts.dwellMs;
  }
}

/** How many alerts the bell remembers; beyond this the oldest fall off. */
const HISTORY = 30;
const ALERTS_KEY = "shell:alerts";

/** Newest first. */
let history: AlertEntry[] = [];
let storage: EncryptedStorage | null = null;

/** Loads any persisted history and wires future changes to save back —
 * read state syncs with the account like any other shell state (golden
 * rule, docs/DESIGN.md §1), not just per-device memory. */
export async function connectAlerts(store: EncryptedStorage): Promise<void> {
  storage = store;
  history = (await store.get<AlertEntry[]>(ALERTS_KEY)) ?? [];
  window.dispatchEvent(new CustomEvent("alerts-changed"));
}

function persist(): void {
  void storage?.put(ALERTS_KEY, history);
}

/** One live toast per source, so a busy source cannot stack the screen. */
const showing = new Map<string, HTMLElement>();
let stack: HTMLElement | null = null;

function host(): HTMLElement {
  if (!stack || !stack.isConnected) {
    stack = el("div#alert-stack", { role: "status", "aria-live": "polite", "aria-relevant": "additions" });
    document.body.appendChild(stack);
  }
  return stack;
}

/** Raise an alert: shows a toast now, and adds it to the bell's history. A
 * second alert from the same source replaces the toast rather than
 * queueing behind it — the newest headline is the one worth reading, and
 * `more` carries the rest. Raising the same `id` twice (a poll seeing the
 * same event again) is a no-op, which is what makes a repeat source safe
 * to call idempotently. */
export function alert(raise: RaiseAlert): AlertEntry | null {
  if (!raise.source || !raise.title) return null;
  const at = raise.at ?? Date.now();
  const key = raise.id || `${raise.source}:${at}`;
  if (history.some((a) => a.id === key)) return null;

  const entry: AlertEntry = {
    id: key,
    source: raise.source,
    title: raise.title,
    detail: raise.detail ?? "",
    href: raise.href ?? "",
    more: raise.more ?? 0,
    at,
    action: raise.action ?? null,
    sticky: raise.sticky ?? false,
    seen: false,
  };

  history.unshift(entry);
  if (history.length > HISTORY) history.length = HISTORY;
  persist();
  window.dispatchEvent(new CustomEvent("alerts-changed"));

  showToast(entry);
  return entry;
}

function showToast(entry: AlertEntry): void {
  const previous = showing.get(entry.source);
  if (previous) previous.remove();

  const body = el("div.alert-body", {}, [
    el("span.alert-title", { text: entry.title }),
    entry.detail ? el("span.alert-detail", { text: entry.detail }) : null,
    entry.more > 0 ? el("span.alert-more", { text: `+${entry.more} more` }) : null,
    entry.action
      ? el("button.alert-action", {
          type: "button",
          text: entry.action.label,
          onClick: (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            entry.sticky = false;
            remove(entry);
            dismiss(entry.source);
            entry.action?.onClick();
          },
        })
      : null,
  ]);

  const card = entry.href
    ? (el("a.alert", { href: entry.href, onClick: () => dismiss(entry.source) }, [body]) as HTMLAnchorElement)
    : el("div.alert", {}, [body]);

  card.appendChild(
    el("button.alert-x", {
      "aria-label": "Dismiss",
      text: "×",
      onClick: (event: Event) => {
        event.preventDefault();
        event.stopPropagation();
        dismiss(entry.source);
      },
    })
  );

  showing.set(entry.source, card);
  host().appendChild(card);

  // Hovering means reading it; cancel the withdraw timer while it's held.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = () => {
    if (dwellMs > 0) timer = setTimeout(() => dismiss(entry.source), dwellMs);
  };
  const hold = () => clearTimeout(timer);
  arm();
  card.addEventListener("pointerenter", hold);
  card.addEventListener("pointerleave", arm);
  card.addEventListener("focusin", hold);
}

/** Takes a source's toast off the screen. Its history entry stays. */
export function dismiss(source: string): void {
  const card = showing.get(source);
  if (!card) return;
  showing.delete(source);
  card.classList.add("alert-out");
  const drop = () => card.remove();
  card.addEventListener("animationend", drop, { once: true });
  setTimeout(drop, 400);
}

/** What the bell shows. Newest first. */
export function recent(): AlertEntry[] {
  return history.slice();
}

/** Drops one alert from the history. Takes the entry `alert()` returned
 * rather than an index, so a removal can't land on the wrong row if
 * something else arrives while a panel is open. Refuses on a sticky entry
 * — only its action retires it. */
export function remove(entry: AlertEntry | null | undefined): boolean {
  if (!entry || entry.sticky) return false;
  const at = history.indexOf(entry);
  if (at === -1) return false;
  history.splice(at, 1);
  persist();
  window.dispatchEvent(new CustomEvent("alerts-changed"));
  return true;
}

export function unseen(): number {
  return history.filter((a) => !a.seen).length;
}

/** Opening the bell is looking at them. */
export function markAllSeen(): void {
  let changed = false;
  for (const entry of history) {
    if (!entry.seen) {
      entry.seen = true;
      changed = true;
    }
  }
  if (changed) {
    persist();
    window.dispatchEvent(new CustomEvent("alerts-changed"));
  }
}

/** Clears the history; sticky alerts survive — "Clear all" is a tidy-up,
 * not a way to decline something that needs a real answer. */
export function clearAlerts(): void {
  const kept = history.filter((entry) => entry.sticky);
  history = kept;
  for (const source of [...showing.keys()]) dismiss(source);
  persist();
  window.dispatchEvent(new CustomEvent("alerts-changed"));
}
