// Settings — the app's own screen, as opposed to a tile's.
//
// Pinned out of the nav order (nav.ts), reached from the app bar's gear on
// a phone, the rail's foot on a desktop, and the More sheet's "This app"
// block on both. Laid out the way a sibling project's settings screen is
// (F1 Apex): eyebrow-headed blocks of rows, a toggle row where a setting
// is a switch, one line of context under each head rather than a manual.
//
// Every control here does something. A row of settings that change
// nothing is a screen asking to be trusted about the ones that do — so
// what is not built yet is stated as a fact in a note, never rendered as
// a dead switch.

import { alert } from "./alerts.js";
import { appendChildren, clear, el, type ElChild } from "./dom.js";
import { ICONS, iconSvg } from "./icons.js";
import { openNavEditor, type NavEditDeps } from "./nav-edit.js";
import { openSheet, sheetFoot, sheetHead } from "./sheet.js";
import { applyUpdate, checkForUpdate, resetApp, shellVersion } from "./updates.js";
import { BAR_SLOTS } from "./nav.js";
import { prefs, setPref } from "./prefs.js";
import type { TileManifest } from "../tiles/types.js";

export interface SettingsDeps extends NavEditDeps {
  appName: string;
}

/** A row with its say on the left and one control on the right — the shape every
 * setting takes. `.toggle-row`/`.t-text`/`.t-title`/`.t-desc` are the system's,
 * so a select, a chip and a switch all sit in the same frame. */
const settingRow = (title: string, desc: string, control: ElChild): HTMLElement =>
  el("div.toggle-row", {}, [
    el("div.t-text", {}, [el("div.t-title", { text: title }), el("div.t-desc", { text: desc })]),
    control,
  ]);

/** The system's switch: a button that carries its state in aria-pressed, which
 * is what the stylesheet colours off. */
const switchControl = (on: boolean, label: string, onChange: (next: boolean) => void): HTMLElement =>
  el(
    "button.switch",
    {
      type: "button",
      "aria-pressed": String(on),
      "aria-label": label,
      onClick: (event: Event) => {
        const button = event.currentTarget as HTMLElement;
        const next = button.getAttribute("aria-pressed") !== "true";
        button.setAttribute("aria-pressed", String(next));
        onChange(next);
      },
    },
    [el("i")]
  );

const blockHead = (text: string, trailing?: HTMLElement | null): HTMLElement =>
  el("div.section-head", {}, [el("span.eyebrow", { text }), trailing ?? null]);

function icon(name: string): HTMLElement {
  const slot = el("span");
  slot.innerHTML = iconSvg(ICONS[name] ?? ICONS.tile ?? "", "ico");
  return slot.firstElementChild as HTMLElement;
}

/** Renders the whole screen into `container`. Called once when the shell
 * builds its views, and again on `nav-changed` so the navigation block
 * reflects an order changed from the editor or from a sync. */
export function renderSettings(container: HTMLElement, deps: SettingsDeps): void {
  const paint = () => {
    clear(container);
    // The bar's context line (shell.ts reads this on navigation). Uppercasing is
    // the stylesheet's job, so this stays in ordinary prose.
    const count = deps.manifests.length;
    container.dataset.context = count === 1 ? "1 tile" : `${count} tiles`;
    // No heading of its own: the sticky bar above already names the screen
    // (shell.ts's navigate()), and a page that prints its title twice reads
    // as two different things stacked. Same rule for every tile.
    //
    // Two columns on desktop, the app's shared `.split`: the main column
    // of settings on the left, the 380px side track on the right. That is
    // the layout every other screen uses and the conventional one — the
    // thing you came to operate gets the wide column, and the side carries
    // what you read once. About lives there. On a phone `.split` stacks in
    // DOM order, so About falls under the controls behind a hairline.
    const mainCol = el("div.main-col", {}, [
      navigationBlock(deps),
      tilesBlock(deps.manifests),
      alertsBlock(),
      accountBlock(),
    ]);
    const side = el("aside.side", {}, [aboutBlock(deps.appName), maintenanceBlock()]);
    appendChildren(container, el("div.split", {}, [mainCol, side]));
  };
  paint();
  window.addEventListener("nav-changed", paint);
}

/** Navigation — the same editor the More sheet and the rail's foot open,
 * so there is one customiser reached three ways rather than three that
 * could disagree. */
function navigationBlock(deps: SettingsDeps): HTMLElement {
  const orderNow = deps.getOrder();
  const onBar = orderNow.slice(0, BAR_SLOTS).length;

  return el("section.set-block", {}, [
    blockHead("Navigation"),
    el("p.block-note", {
      text: "One order for every device. A desktop rail shows all of it; a phone shows the first few and folds the rest behind More.",
    }),
    settingRow(
      "Customise navigation",
      orderNow.length
        ? `${orderNow.length} tile${orderNow.length === 1 ? "" : "s"}, ${onBar} on the phone bar`
        : "No tiles installed yet",
      el("button.chip.act", { type: "button", text: "Customise", onClick: () => openNavEditor(deps) })
    ),
  ]);
}

/** Installed tiles, and how each is encrypted — the lock indicator of
 * docs/DESIGN.md §1b, spelled out where there is room for the sentence. */
function tilesBlock(manifests: TileManifest[]): HTMLElement {
  const rows = manifests.length
    ? el(
        "div.rows",
        {},
        manifests.map((tile) =>
          el("div.row", { "data-encryption-tier": tile.encryptionTier }, [
            icon(tile.icon),
            el("div.who", {}, [
              el("div.name", { text: tile.name }),
              el("div.sub", { text: `Stored under “${tile.dataNamespace}”` }),
            ]),
            el("span.tile-lock", {}, [
              icon("lock"),
              el("span", {
                text: tile.encryptionTier === "e2ee" ? "End-to-end" : "Client-side",
              }),
            ]),
          ])
        )
      )
    : el("p.empty", { text: "No tiles installed yet." });

  return el("section.set-block", {}, [
    blockHead("Tiles"),
    el("p.block-note", {
      text: "End-to-end means the server only ever holds ciphertext. Client-side means it is encrypted here, but a server component can read it to do its job.",
    }),
    rows,
  ]);
}

/** Alerts — the in-app toasts and the bell (alerts.ts, bell.ts). Both
 * controls here are live: the dwell is read on the next toast, and the
 * test button raises a real one. */
function alertsBlock(): HTMLElement {
  const slot = el("section.set-block");

  const paint = () => {
    const dwellSeconds = Math.round(prefs.alertDwellMs / 1000);
    const select = el<HTMLSelectElement>("select.dwell", {
      "aria-label": "How long an alert stays on screen",
      onChange: (event: Event) => {
        const value = Number((event.target as HTMLSelectElement).value);
        setPref("alertDwellMs", value);
      },
    });

    for (const seconds of [5, 10, 20, 30]) {
      const option = el<HTMLOptionElement>("option", { value: String(seconds * 1000), text: `${seconds} seconds` });
      if (seconds === dwellSeconds) option.selected = true;
      select.appendChild(option);
    }
    const forever = el<HTMLOptionElement>("option", { value: "0", text: "Until I dismiss it" });
    if (prefs.alertDwellMs === 0) forever.selected = true;
    select.appendChild(forever);

    clear(slot);
    appendChildren(
      slot,
      blockHead("Alerts"),
      el("p.block-note", {
        text: "Shown while the app is open, and kept in the bell afterwards. Separate from push notifications, which reach a closed app and need a permission.",
      }),
      settingRow(
        "Show alerts on screen",
        "Off, they still collect in the bell — you just aren't interrupted.",
        switchControl(prefs.alertToasts, "Show alerts on screen", (next) => setPref("alertToasts", next))
      ),
      settingRow(
        "Keep an alert on screen for",
        "Hovering or focusing one pauses the countdown while you read it.",
        select
      ),
      settingRow(
        "Test alert",
        "Raises a real one, so the bell picks it up as well.",
        el("button.chip.act", {
          type: "button",
          text: "Send a test",
          onClick: () =>
            alert({
              source: "settings-test",
              title: "Test alert",
              detail: "This is what an in-app alert looks like. It is now in the bell too.",
            }),
        })
      )
    );
  };

  paint();
  window.addEventListener("prefs-changed", (event) => {
    const key = (event as CustomEvent<{ key?: string }>).detail?.key;
    if (!key || key === "alertDwellMs") paint();
  });
  return slot;
}

/** The account. Stated rather than mocked up: the passkey endpoints in
 * src/worker/index.ts still answer 501, so there is genuinely nothing to
 * sign in to yet, and a "Sign in" button that cannot would be the one
 * thing on this screen that lies. */
interface Device {
  id: string;
  deviceLabel: string;
  createdAt: number;
  lastSeenAt: number | null;
  isCurrent: boolean;
}

function relativeTime(ms: number): string {
  const mins = Math.round((Date.now() - ms) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

/** A device row for the device list — not "add a device" itself, which needs no dedicated
 * flow or code here at all. A passkey is the credential, not the device: iCloud Keychain /
 * Google Password Manager sync the same credential (including whatever backs PRF) to every
 * device signed into that account, and WebAuthn's own cross-device flow ("use a passkey on
 * another device", the QR/hybrid transport every platform picker offers) lets a phone that
 * does hold it answer for a browser that doesn't. Either way the server sees the identical
 * credential_id it already has a wrapped_keys row for, so ordinary login/finish is the whole
 * story — ../shell.ts's unlock() path, unchanged. A device only reaches recovery
 * (src/preauth/auth.ts) when the passkey is reachable from *nowhere*: not synced, no other
 * device to relay through. That's a strictly narrower case than "a new device". */
function deviceRow(device: Device, onChanged: () => void): HTMLElement {
  const sub = device.lastSeenAt
    ? `Last used ${relativeTime(device.lastSeenAt)}`
    : `Added ${relativeTime(device.createdAt)}, never signed in since`;

  const nameLine = el("div.name", {}, [
    device.deviceLabel,
    device.isCurrent ? el("span.device-badge", { text: "This device" }) : null,
  ]);

  const renameBtn = el("button.chip.act", { type: "button", text: "Rename", onClick: () => openRenameSheet(device, onChanged) });
  const signOutBtn = el("button.chip.act", {
    type: "button",
    text: "Sign out",
    onClick: () => openSignOutConfirm(device, onChanged),
  });

  return el("div.row", {}, [
    icon("device"),
    el("div.who", {}, [nameLine, el("div.sub", { text: sub })]),
    el("div.device-actions", {}, [renameBtn, signOutBtn]),
  ]);
}

function openRenameSheet(device: Device, onChanged: () => void): void {
  const node = openSheet("confirm", { label: "Rename device" });
  const input = el<HTMLInputElement>("input.text-field", { type: "text", value: device.deviceLabel, maxlength: 60 });
  const err = el("p.err", { text: "" });

  const save = el<HTMLButtonElement>("button.btn.go", {
    type: "button",
    text: "Save",
    onClick: async () => {
      const deviceLabel = input.value.trim();
      if (!deviceLabel) {
        err.textContent = "Give it a name.";
        return;
      }
      save.disabled = true;
      const res = await fetch(`/api/devices/${encodeURIComponent(device.id)}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ deviceLabel }),
        credentials: "include",
      });
      if (!res.ok) {
        save.disabled = false;
        err.textContent = "Couldn't save that — try again.";
        return;
      }
      node.close();
      onChanged();
    },
  });

  appendChildren(
    node,
    el("div.sheet-inner", {}, [
      sheetHead(node, "Rename device", device.deviceLabel),
      el("div.sheet-scroll", {}, [input, err]),
      sheetFoot([el("button.btn.ghost", { type: "button", text: "Cancel", onClick: () => node.close() }), save]),
    ])
  );
  input.focus();
  input.select();
}

/**
 * Revokes the device's sessions rather than deleting its passkey — section 9b's own
 * distinction: this stops it syncing and calling the API from this moment on, it does not
 * retroactively erase what it already has cached, and the passkey itself can still sign back
 * in later (a false alarm, a phone found again) without a trip through recovery.
 */
function openSignOutConfirm(device: Device, onChanged: () => void): void {
  const node = openSheet("confirm", { label: "Sign out device" });
  const go = el<HTMLButtonElement>("button.btn.go.danger", {
    type: "button",
    text: "Sign out",
    onClick: async () => {
      go.disabled = true;
      const res = await fetch(`/api/devices/${encodeURIComponent(device.id)}/signout`, {
        method: "POST",
        credentials: "include",
      });
      if (!res.ok) {
        go.disabled = false;
        return;
      }
      const { signedOutSelf } = (await res.json()) as { signedOutSelf: boolean };
      if (signedOutSelf) {
        // The session this very page is running on no longer exists — there is nothing left
        // to repaint into, only the lock screen to land back on.
        location.reload();
        return;
      }
      node.close();
      onChanged();
    },
  });

  appendChildren(
    node,
    el("div.sheet-inner", {}, [
      sheetHead(node, "Sign out device", device.deviceLabel),
      el("div.sheet-scroll", {}, [
        el("p.confirm-lead", {
          text: device.isCurrent
            ? "This ends this device's own session — you'll need your passkey again."
            : `This ends "${device.deviceLabel}"'s session. It does not erase anything already cached there, and it can sign back in again with the same passkey.`,
        }),
      ]),
      sheetFoot([el("button.btn.ghost", { type: "button", text: "Cancel", onClick: () => node.close() }), go]),
    ])
  );
}

function accountBlock(): HTMLElement {
  const idleSelect = el<HTMLSelectElement>("select.dwell", {
    "aria-label": "Re-lock after this much idle time",
    onChange: (event: Event) => setPref("reauthIdleMs", Number((event.target as HTMLSelectElement).value)),
  });
  for (const [seconds, label] of [
    [30, "30 seconds"],
    [60, "1 minute"],
    [300, "5 minutes"],
    [900, "15 minutes"],
  ] as const) {
    const option = el<HTMLOptionElement>("option", { value: String(seconds * 1000), text: label });
    if (seconds * 1000 === prefs.reauthIdleMs) option.selected = true;
    idleSelect.appendChild(option);
  }
  // A change made on another device arrives as an incoming sync record, not a local
  // onChange — without this the select would keep showing the value it had when this
  // screen was opened, even though the app underneath is already honouring the new one.
  window.addEventListener("prefs-changed", () => {
    idleSelect.value = String(prefs.reauthIdleMs);
  });

  const deviceRows = el("div.rows", {}, [el("p.empty", { text: "Loading…" })]);

  const paintDevices = () => {
    void fetch("/api/devices", { credentials: "include" })
      .then((res) => (res.ok ? (res.json() as Promise<Device[]>) : Promise.reject(res.status)))
      .then((devices) => {
        clear(deviceRows);
        appendChildren(deviceRows, ...devices.map((d) => deviceRow(d, paintDevices)));
      })
      .catch(() => {
        clear(deviceRows);
        appendChildren(deviceRows, el("p.empty", { text: "Couldn't load your devices." }));
      });
  };
  paintDevices();

  return el("section.set-block", {}, [
    blockHead("Account"),
    el("p.block-note", {
      text: "Every passkey registered to this account. Renaming is just a label; signing one out ends its session without touching what it's already cached (section 9b).",
    }),
    deviceRows,
    settingRow(
      "Re-lock when idle",
      "A fresh Face ID prompt after this long with nothing open, and every time you come back to the app — independent of your phone's own lock screen.",
      idleSelect
    ),
    el("p.nav-note", {
      text: "A lost device is dealt with above, not with a key change: revoking it stops future sync and API access, but doesn't erase what it already cached locally or rotate the encryption key. If a device is actually compromised rather than lost, the real remedy is generating a new DEK — not built yet (section 9b).",
    }),
  ]);
}

/**
 * Two escape hatches, both aimed at a build that is still moving. The update
 * check exists because the browser refetches sw.js on its own schedule and "am I
 * on the newest build?" is otherwise unanswerable from inside an installed app;
 * the reset exists because the answer is sometimes "no, and the cache is why".
 */
function maintenanceBlock(): HTMLElement {
  const status = el("p.empty.maint-note", { text: "" });

  const check = el<HTMLButtonElement>("button.btn.ghost.wide", {
    type: "button",
    text: "Check for updates",
    onClick: async () => {
      check.disabled = true;
      status.textContent = "Checking…";
      const result = await checkForUpdate();
      check.disabled = false;
      if (result.state === "ready") {
        status.textContent = "New version found — refreshing.";
        applyUpdate(result.worker);
        return;
      }
      status.textContent =
        result.state === "unsupported"
          ? "No service worker on this device — nothing to update."
          : "You are on the newest version.";
    },
  });

  const reset = el("button.btn.ghost.wide.danger", {
    type: "button",
    text: "Reset this device",
    onClick: () => confirmReset(),
  });

  // F1 Apex's own maintenanceBlock (views/settings.js): the buttons sit inside a
  // dedicated .maint wrapper, not as bare siblings — that wrapper is the only thing
  // that puts a gap between them, so leaving it out is what had them touching.
  return el("section.set-block", {}, [blockHead("Maintenance"), el("div.maint", {}, [check, reset, status])]);
}

/**
 * A reset takes the encrypted records with the cache, so it asks — and lists what
 * goes, rather than asking "are you sure?" about a scope the reader would have to
 * guess at.
 *
 * The sentence that matters is the last one: on this account nothing is stored in
 * a form the server could give back, so a reset is not a sync away from being
 * undone. It is the whole point of the app and the sharpest edge of it.
 */
function confirmReset(): void {
  const node = openSheet("confirm", { label: "Reset this device" });
  const go = el<HTMLButtonElement>("button.btn.go.danger", {
    type: "button",
    text: "Reset and reload",
    onClick: () => {
      go.disabled = true;
      go.textContent = "Resetting…";
      void resetApp();
    },
  });

  node.append(
    el("div.sheet-inner", {}, [
      sheetHead(node, "Reset this device", "This cannot be undone"),
      el("div.sheet-scroll", {}, [
        el("p.confirm-lead", {
          text: "Everything this app has stored on this device is deleted, and it reloads from scratch:",
        }),
        el("ul.confirm-list", {}, [
          el("li", { text: "Every tile's records, held encrypted on this device" }),
          el("li", { text: "Preferences, navigation order and this device's alerts" }),
          el("li", { text: "The cached shell and the service worker itself" }),
          el("li", { text: "This device's session — you will need your passkey again" }),
        ]),
        el("p.empty", {
          text: "Your passkey is not touched, and anything already synced is still on the server as ciphertext. Anything that had not synced yet is gone, and nobody can recover it.",
        }),
      ]),
      sheetFoot([
        el("button.btn.ghost", { type: "button", text: "Cancel", onClick: () => node.close() }),
        go,
      ]),
    ])
  );
}

function aboutBlock(appName: string): HTMLElement {
  // F1 Apex's own row(k, v) (views/settings.js): `.row` with `.who .name.muted`
  // on the left, `.val` on the right — the shape every About fact takes there,
  // Version included.
  const versionValue = el("span.val", { text: "…" });
  void shellVersion().then((v) => {
    // Null while the first install is still in flight, which is a real state and
    // worth saying rather than printing a confident blank.
    versionValue.textContent = v ?? "Installing…";
  });

  return el("section.set-block", {}, [
    blockHead("About"),
    el("p.nav-note", {
      text: `${appName} is a personal, end-to-end encrypted dashboard. Everything you put in it is encrypted on this device before it leaves, and the server never holds a key that can read it.`,
    }),
    el("div.rows", {}, [
      el("div.row", {}, [el("div.who", {}, [el("div.name.muted", { text: "Version" })]), versionValue]),
    ]),
  ]);
}
