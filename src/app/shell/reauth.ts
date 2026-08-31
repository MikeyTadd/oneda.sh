// App-level re-auth (design doc section 1a): a fresh passkey prompt after the app has been
// hidden or idle for reauthIdleMs — independent of whether the phone itself is unlocked. The
// threat this defends is explicit in the doc: a phone left unlocked, or handed to someone,
// still shouldn't show decrypted content without this separate prompt. Whether it fires at
// all is not optional; only its idle timeout (prefs.ts's reauthIdleMs) is, and that timeout
// applies uniformly to sitting idle in the open app AND to being hidden — a one-second alt-tab
// and an hour in another app both go through the same clock rather than the first being
// treated as if it were the second.
//
// This never touches the DEK or re-derives anything — main.ts already holds a working DEK
// for the rest of the session. All this proves is "the passkey is still present", via a bare
// navigator.credentials.get() with no server round trip (the design doc calls this out
// directly: "this reuses the same passkey already established... no separate PIN/password
// system to build or remember"), so it works offline like everything else (section 1).
//
// A failed or cancelled attempt leaves the lock up rather than showing anything underneath —
// the overlay is opaque and the shell is made inert while it's up, so there is no partial or
// degraded view to fall through to, only locked or unlocked.

import { el } from "./dom.js";

const OVERLAY_ID = "reauth-gate";
const SHELL_ID = "shell";

let armed = false;
let idleMs = 60_000;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
// Set the moment the tab goes hidden, cleared the moment it doesn't matter any more (back
// visible, or already locked). Lets a return-to-foreground be judged by the same idle clock
// as sitting idle in the open app, instead of an unconditional lock that punished a one-second
// alt-tab exactly as hard as an hour away.
let hiddenAt: number | null = null;

/** Call once, after the shell has mounted — arming this before the reader has even seen the
 * app once would just relock what unlock() already unlocked seconds ago. `getIdleMs` is read
 * fresh each time a timer is (re)armed, so a preference change takes effect on the very next
 * reset rather than needing a reinstall. */
export function installReauthGate(getIdleMs: () => number): void {
  if (armed) return;
  armed = true;
  idleMs = getIdleMs();

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") {
      // The setTimeout underneath would drift or get throttled while hidden anyway (mobile
      // Safari especially), so the elapsed time is measured from this timestamp on return
      // rather than trusted to have kept firing accurately in the background.
      hiddenAt = Date.now();
      clearIdleTimer();
    } else {
      const elapsed = hiddenAt !== null ? Date.now() - hiddenAt : 0;
      hiddenAt = null;
      if (elapsed >= idleMs) lock();
      else armIdleTimer(idleMs - elapsed);
    }
  });

  for (const evt of ["pointerdown", "keydown", "touchstart"]) {
    document.addEventListener(evt, () => resetIdleTimer(getIdleMs()), { passive: true });
  }
  resetIdleTimer(idleMs);

  // A manual lock for "I'm stepping away right now" — the idle timeout and the
  // hidden-tab check both only catch it eventually, and eventually isn't the same as
  // immediately. Matches the shortcut other password/vault apps already use (Bitwarden),
  // rather than inventing a new one to remember. Skipped while typing anywhere, so it can't
  // fire from a text field that happens to use the same combo for its own editing.
  document.addEventListener("keydown", (event) => {
    if (!event.shiftKey || (!event.ctrlKey && !event.metaKey) || event.key.toLowerCase() !== "l") return;
    const target = event.target as HTMLElement | null;
    if (target && (target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable)) return;
    event.preventDefault();
    lock();
  });
}

/** Locks right now, on demand — the Settings/nav chrome's manual lock button and the keyboard
 * shortcut above both call this rather than duplicating what "locked" means. */
export function forceLock(): void {
  if (armed) lock();
}

/** Arms the timer for exactly `ms` without touching the configured idleMs — used for the
 * remainder of a budget already partly spent while hidden. A real interaction still resets
 * to the full configured duration via resetIdleTimer below. */
function armIdleTimer(ms: number): void {
  if (isLocked()) return; // already waiting on a prompt; nothing to extend
  clearIdleTimer();
  idleTimer = setTimeout(lock, ms);
}

function resetIdleTimer(ms: number): void {
  idleMs = ms;
  armIdleTimer(ms);
}

function clearIdleTimer(): void {
  if (idleTimer !== null) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
}

function isLocked(): boolean {
  return document.getElementById(OVERLAY_ID) !== null;
}

function lock(): void {
  if (isLocked()) return;
  clearIdleTimer();

  // Removes focus/interaction from everything underneath while the overlay is up — a
  // screen reader or Tab key shouldn't find a route to the content the opaque overlay is
  // hiding visually.
  document.getElementById(SHELL_ID)?.setAttribute("inert", "");

  const statusEl = el("p", { text: "Confirm it's you to continue" });
  const button = el<HTMLButtonElement>("button", { type: "button", text: "Unlock" });
  const overlay = el(`div#${OVERLAY_ID}`, {}, [fingerprintIcon(), statusEl, button]);
  injectStyleOnce();
  document.body.appendChild(overlay);

  const attempt = async (): Promise<void> => {
    statusEl.textContent = "Waiting for Face ID…";
    button.disabled = true;
    try {
      // No allowCredentials, no PRF: this only has to succeed against *a* resident
      // credential for this origin, which the browser's own passkey picker already
      // scopes to this RP — there's nothing here for the server to verify or even see.
      const assertion = await navigator.credentials.get({
        publicKey: { challenge: crypto.getRandomValues(new Uint8Array(32)), userVerification: "required" },
      });
      if (!assertion) throw new Error("cancelled");
      document.getElementById(SHELL_ID)?.removeAttribute("inert");
      overlay.remove();
      resetIdleTimer(idleMs);
    } catch {
      // Cancelled or failed — the overlay simply stays. There is no partial-content
      // fallback to drop into (design doc section 1a).
      statusEl.textContent = "Couldn't confirm — try again";
      button.disabled = false;
    }
  };
  button.addEventListener("click", () => void attempt());
}

function fingerprintIcon(): SVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("aria-hidden", "true");
  svg.setAttribute("class", "reauth-print");
  const paths = [
    "M18.9 7a8 8 0 0 1 1.1 5v1a6 6 0 0 0 .8 3",
    "M8 11a4 4 0 0 1 8 0v1a10 10 0 0 0 2 6",
    "M12 11v2a14 14 0 0 0 2.5 8",
    "M8 15a18 18 0 0 0 1.8 6",
    "M4.9 19a22 22 0 0 1 -.9 -7v-1a8 8 0 0 1 12 -6.95",
  ];
  for (const d of paths) {
    const p = document.createElementNS("http://www.w3.org/2000/svg", "path");
    p.setAttribute("d", d);
    svg.appendChild(p);
  }
  return svg;
}

/** Self-contained rather than added to shell.css: this overlay has to render correctly even
 * if the app's main stylesheet failed to load, since it's the last line of defence, not just
 * another screen. Colours are hardcoded to the same values shell.css's tokens resolve to
 * rather than referencing the custom properties, for the same reason. */
function injectStyleOnce(): void {
  if (document.getElementById("reauth-gate-style")) return;
  const style = document.createElement("style");
  style.id = "reauth-gate-style";
  style.textContent = `
    #${OVERLAY_ID} {
      position: fixed; inset: 0; z-index: 2147483647; background: #161826;
      display: flex; flex-direction: column; align-items: center; justify-content: center;
      gap: 0.75rem; padding: 2rem;
      font: 16px/1.4 "Inter", -apple-system, system-ui, sans-serif; color: #e9e9ed;
      text-align: center;
    }
    #${OVERLAY_ID} .reauth-print {
      width: 60px; height: 60px; fill: none; stroke: #9184d9; stroke-width: 1.7;
      stroke-linecap: round; stroke-linejoin: round;
    }
    #${OVERLAY_ID} p { opacity: 0.75; margin: 0; }
    #${OVERLAY_ID} button {
      margin-top: 0.75rem; padding: 0.75rem 1.5rem; border-radius: 999px; border: none;
      background: #9184d9; color: #161826; font-weight: 600; font-size: 1rem; cursor: pointer;
    }
    #${OVERLAY_ID} button:disabled { opacity: 0.6; }
  `;
  document.head.appendChild(style);
}
