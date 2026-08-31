// The bell: what you missed while a toast was on screen and you were not.
// Two buttons — the phone app bar's and the desktop top bar's — painted
// from the same alert history (./alerts.ts) so pressing either opens the
// identical panel. The panel is memory for the life of the tab; the
// durable "have I read this" answer for any one tile's own content is that
// tile's job (its own read marks, synced like anything else per the golden
// rule), not the bell's.
//
// Adapted from a sibling project's `alert-bell.js` (F1 Apex) — written
// fresh here against this project's `el()` (./dom.ts) and without that
// project's `documentAlerts` preference gate, since oneda has no such flag
// yet; the bell shows whenever there is a bell element in the chrome.

import { clearAlerts, markAllSeen, recent, remove, type AlertEntry } from "./alerts.js";
import { el } from "./dom.js";
import { ICONS, iconSvg } from "./icons.js";

const BELL_IDS = ["appbar-bell", "topbar-bell"];

let panel: HTMLElement | null = null;
let openedFrom: HTMLElement | null = null;

function bells(): HTMLElement[] {
  return BELL_IDS.map((id) => document.getElementById(id)).filter((b): b is HTMLElement => b !== null);
}

/** Shows the unread dot on both bells, or clears it. Call after any
 * `alerts-changed` event — `watchAlerts()` below already does. */
export function paintBell(): void {
  const count = unseenCount();
  for (const bell of bells()) {
    let dot = bell.querySelector<HTMLElement>(".dot-new");
    if (count > 0) {
      if (!dot) {
        dot = el<HTMLElement>("span.dot-new");
        bell.appendChild(dot);
      }
      bell.setAttribute("aria-label", `Alerts, ${count} unread`);
    } else {
      dot?.remove();
      bell.setAttribute("aria-label", "Alerts");
    }
  }
}

function unseenCount(): number {
  return recent().filter((a) => !a.seen).length;
}

function closePanel(): void {
  if (!panel) return;
  panel.remove();
  panel = null;
  document.removeEventListener("keydown", onKey);
  document.removeEventListener("pointerdown", onOutside, true);
}

function onKey(event: KeyboardEvent): void {
  if (event.key === "Escape") closePanel();
}

function onOutside(event: Event): void {
  if (!panel) return;
  const target = event.target as Node;
  if (panel.contains(target)) return;
  if (bells().some((b) => b.contains(target))) return;
  closePanel();
}

function whenText(at: number): string {
  const mins = Math.max(0, Math.round((Date.now() - at) / 60000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function pastRow(entry: AlertEntry): HTMLElement {
  const bodyChildren = [
    el("span.alert-title", { text: entry.title }),
    entry.detail ? el("span.alert-detail", { text: entry.detail }) : null,
    el("span.alert-when", { text: whenText(entry.at) }),
    entry.action
      ? el("button.alert-action", {
          type: "button",
          text: entry.action.label,
          onClick: (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            entry.sticky = false;
            remove(entry);
            closePanel();
            entry.action?.onClick();
          },
        })
      : null,
  ];
  const body = entry.href
    ? el("a.alert-past-body", { href: entry.href, onClick: closePanel }, bodyChildren)
    : el("div.alert-past-body", {}, bodyChildren);

  return el("div.alert-past", {}, [
    body,
    entry.sticky
      ? null
      : el("button.alert-past-x", {
          type: "button",
          "aria-label": `Dismiss: ${entry.title}`,
          text: "×",
          onClick: (event: Event) => {
            event.preventDefault();
            event.stopPropagation();
            remove(entry);
            redraw();
          },
        }),
  ]);
}

function redraw(): void {
  if (!panel || !openedFrom) return;
  openPanel(openedFrom);
}

function openPanel(anchor: HTMLElement): void {
  closePanel();
  openedFrom = anchor;
  const items = recent();

  panel = el<HTMLElement>("div.alert-panel", { role: "dialog", "aria-label": "Alerts" }, [
    el("div.alert-panel-head", {}, [
      el("span", { text: "Alerts" }),
      items.some((a) => !a.sticky)
        ? el("button.alert-panel-clear", {
            type: "button",
            text: "Clear all",
            onClick: () => {
              clearAlerts();
              redraw();
            },
          })
        : null,
      el("button.alert-panel-x", { type: "button", "aria-label": "Close", text: "×", onClick: closePanel }),
    ]),
    items.length
      ? el(
          "div.alert-panel-list",
          {},
          items.map((a) => pastRow(a))
        )
      : el("p.alert-panel-empty", { text: "No alerts." }),
  ]);

  document.body.appendChild(panel);
  const box = anchor.getBoundingClientRect();
  panel.style.top = `${Math.round(box.bottom + 8)}px`;

  // On a phone the panel spans the screen — no room to hang it off the
  // bell; on desktop it anchors to the bell's own rectangle. Same 900px
  // breakpoint the rest of the shell switches on.
  if (window.matchMedia("(min-width: 900px)").matches) {
    panel.style.left = "auto";
    panel.style.right = `${Math.max(8, Math.round(window.innerWidth - box.right))}px`;
  } else {
    panel.style.left = "12px";
    panel.style.right = "12px";
  }

  markAllSeen();
  document.addEventListener("keydown", onKey);
  // Capture, so a click on a link underneath still closes this first.
  document.addEventListener("pointerdown", onOutside, true);
}

/** Wires both bell buttons and puts the icon in them, once at boot. Call
 * after the shell chrome (shell.ts) has built the bar elements. */
export function watchAlerts(): void {
  for (const bell of bells()) {
    if (!bell.querySelector(".ico")) bell.innerHTML = iconSvg(ICONS.bell ?? "", "ico");
    bell.addEventListener("click", () => {
      if (panel) closePanel();
      else openPanel(bell);
    });
  }
  window.addEventListener("alerts-changed", paintBell);
  paintBell();
}
