// Pre-auth shell script (section 13.1). Performs the WebAuthn ceremony against /auth/*
// and, on success, dynamically imports the gated app bundle from /app/, which the Worker
// only serves once a session token exists (section 13.2). Nothing tile-related is
// reachable from this module before that point.
//
// Bundled (scripts/build-app.mjs, esbuild) rather than shipped as hand-written JS, which is
// what lets this import crypto/keys.ts and recovery.ts for real instead of hand-duplicating
// their logic — the previous version kept a second copy of the PRF/HKDF steps here with a
// comment asking future edits to keep the two in sync. Both modules are plain crypto/wordlist
// code with no tile or business logic, so importing them here doesn't smuggle anything past
// section 13.1's gate; esbuild only pulls in what's actually imported.

import { deriveMasterKeyFromPrf, generateDek, wrapDek, unwrapDek, makeNonExtractable, prfSalt } from "../app/crypto/keys.js";
import { base64UrlToBuffer, bufferToBase64Url, concatBytes, splitIvAndCiphertext } from "../app/crypto/codec.js";
import { guessDeviceLabel } from "../app/shell/device-label.js";
import { generateRecoveryPhrase, verifyPhraseChecksum, deriveRecoveryEncryptionKey, deriveRecoveryAuthVerifier } from "./recovery.js";

/** appendChild() in a loop, not Element.append(): this project's tsconfig pulls in
 * @cloudflare/workers-types globally, and that package's ambient Element declares its own
 * append() signature that shadows lib.dom's variadic one (see src/app/shell/dom.ts). */
function appendMany(parent: Node, ...children: Node[]): void {
  for (const child of children) parent.appendChild(child);
}

const statusEl = document.getElementById("status") as HTMLParagraphElement;
const unlockBtn = document.getElementById("unlock") as HTMLButtonElement;
const setupBtn = document.getElementById("setup") as HTMLButtonElement;
const recoverBtn = document.getElementById("recover") as HTMLButtonElement;
const wipeBtn = document.getElementById("wipe") as HTMLButtonElement;
const overlay = document.getElementById("overlay") as HTMLDivElement;

// Set when a passkey has been created but its PRF output still has to be fetched by a
// second ceremony — see setup(). Holds the credential between the two taps.
let pendingCredential: PublicKeyCredential | null = null;

unlockBtn.addEventListener("click", () => void unlock());
setupBtn.addEventListener("click", () => {
  if (pendingCredential) return void confirmSetup();
  return void setup();
});
recoverBtn.addEventListener("click", () => showRecoverForm());
wipeBtn.addEventListener("click", () => showWipeConfirm());

// The session cookie is HttpOnly (deliberately — this page's own JS has no business reading
// it), so this is the only way this screen can tell apart "you've never signed in", "you have
// a session, you're just refreshing" and "the account exists but not on this device" — the
// last matters because registration is a one-time bootstrap gate (register/start 403s once
// any account exists, see that handler), so "First time?" is dead weight — worse, a
// guaranteed failure — on every device but the very first ever to see this screen. Reusing a
// live session still runs the full passkey ceremony either way (the DEK lives in memory only
// and refresh always throws that away), which is why "authenticated" only changes the copy,
// not whether unlock() runs. Fire-and-forget: offline or a slow reply just leaves the generic
// first-visit copy and link up rather than blocking the screen on it.
void (async () => {
  try {
    const res = await fetch("/auth/whoami", { credentials: "include" });
    if (!res.ok) return;
    const { authenticated, accountExists } = (await res.json()) as {
      authenticated: boolean;
      accountExists: boolean;
    };
    if (accountExists) setupBtn.hidden = true;
    if (authenticated) statusEl.textContent = "Welcome back — confirm it's you";
  } catch {
    // No signal either way — leave the generic copy and link.
  }
})();

// Which step of the ceremony we're on, so a failure says where it happened rather than just
// what — the difference between "Setup failed" and "failed at credentials.create", which is
// the whole diagnosis when there's no console on a phone.
let currentStep = "idle";
function step(name: string): void {
  currentStep = name;
}

/** Surfaces the actual reason on screen. There's no console on a phone, and every failure
 * reading "try again" is useless when the interesting part is which step broke and why. */
function fail(what: string, err: unknown): void {
  const e = err as { name?: string; message?: string } | undefined;
  const detail = e?.name ? `${e.name}: ${e.message}` : String(err);
  statusEl.textContent = `${what} failed at ${currentStep} — ${detail}`;
  console.error(what, currentStep, err);
}

// Registered here so the lock screen itself works offline. Noticing updates and
// offering the refresh is the app's job, not this file's — see
// src/app/shell/updates.ts.
if ("serviceWorker" in navigator) {
  addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch((err) => console.error("sw", err));
  });
}

async function unlock(): Promise<void> {
  statusEl.textContent = "Waiting for Face ID…";
  try {
    step("login/start");
    const optionsRes = await fetch("/auth/login/start", { method: "POST", credentials: "include" });
    if (!optionsRes.ok) throw new Error(`login/start returned ${optionsRes.status}`);
    const options = (await optionsRes.json()) as any;

    const publicKey = {
      ...options,
      challenge: base64UrlToBuffer(options.challenge),
      allowCredentials: (options.allowCredentials ?? []).map((c: { id: string }) => ({
        ...c,
        id: base64UrlToBuffer(c.id),
      })),
      // Set here, never taken from the response: the salt has to reach the authenticator as
      // real bytes (it can't survive JSON), and it decides which master key gets derived, so
      // the client owns it rather than trusting the server to name it (section 2.2).
      extensions: { prf: { eval: { first: await prfSalt() } } },
    };

    step("credentials.get");
    const assertion = (await navigator.credentials.get({ publicKey })) as PublicKeyCredential | null;
    if (!assertion) throw new Error("cancelled");

    step("read-prf-result");
    const extResults = assertion.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
    const prfOutput = extResults.prf?.results?.first;
    if (!prfOutput) throw new Error("this passkey/browser didn't return a PRF result");

    step("login/finish");
    const finishRes = await fetch("/auth/login/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...serializeAssertion(assertion), deviceId: deviceId(), deviceLabel: guessDeviceLabel() }),
      credentials: "include",
    });
    if (!finishRes.ok) {
      const detail = (await finishRes.text()).slice(0, 120);
      // A passkey the server has never heard of — typically one left behind by a
      // registration that didn't complete. Tell the provider so it stops offering it.
      if (finishRes.status === 401) await signalUnknownCredential(assertion.id);
      throw new Error(`server returned ${finishRes.status}: ${detail}`);
    }
    const { wrappedDek, userHandle, acceptedCredentialIds } = (await finishRes.json()) as any;
    void signalAcceptedCredentials(userHandle, acceptedCredentialIds);

    step("derive-master-key");
    const masterKey = await deriveMasterKeyFromPrf(prfOutput);
    step("unwrap-dek");
    const { iv, ciphertext } = splitIvAndCiphertext(base64UrlToBuffer(wrappedDek));
    const dek = await unwrapDek(ciphertext, iv, masterKey);

    statusEl.textContent = "Unlocked — loading…";
    step("load-app-bundle");
    // Only reachable after a session exists (serveGatedBundle, src/worker/index.ts) — never
    // resolvable at build time, so this is a runtime-only import TS can't type-check.
    // @ts-expect-error runtime-only path
    const app = await import("/app/main.js");
    await app.start({ dek });
  } catch (err) {
    fail("Unlock", err);
  }
}

async function setup(): Promise<void> {
  statusEl.textContent = "Setting up your passkey…";
  try {
    step("register/start");
    const startRes = await fetch("/auth/register/start", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userName: "onedash" }),
      credentials: "include",
    });
    if (!startRes.ok) {
      throw new Error(
        startRes.status === 403 ? "an account already exists on this server" : `register/start returned ${startRes.status}`
      );
    }
    const options = (await startRes.json()) as any;

    const publicKey = {
      ...options,
      challenge: base64UrlToBuffer(options.challenge),
      user: { ...options.user, id: base64UrlToBuffer(options.user.id) },
      excludeCredentials: (options.excludeCredentials ?? []).map((c: { id: string }) => ({
        ...c,
        id: base64UrlToBuffer(c.id),
      })),
      // Ask for the PRF output up front. Where the authenticator obliges (iOS 18+, Chrome)
      // that's the whole ceremony in one prompt and one tap.
      extensions: { prf: { eval: { first: await prfSalt() } } },
    };

    step("credentials.create");
    const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
    if (!credential) throw new Error("cancelled");

    step("read-prf-from-create");
    const ext = credential.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
    const prfOutput = ext.prf?.results?.first;
    if (prfOutput) {
      await runRecoverySetup(credential, prfOutput);
      return;
    }

    // No PRF output from create(), so it takes a second ceremony to fetch — and that needs
    // its own user activation. Safari treats the tap as spent by create() and rejects a
    // WebAuthn call made straight after it (NotAllowedError), so the second ceremony has to
    // be a real tap rather than something chained onto this one.
    step("awaiting-confirm-tap");
    pendingCredential = credential;
    setupBtn.textContent = "Confirm with Face ID";
    setupBtn.className = "";
    statusEl.textContent = "Passkey created. One more step to derive your key.";
  } catch (err) {
    fail("Setup", err);
  }
}

/** Second half of setup, on its own tap (see setup()). */
async function confirmSetup(): Promise<void> {
  statusEl.textContent = "Waiting for Face ID…";
  try {
    const credential = pendingCredential!;
    step("prf-second-ceremony");
    const prfOutput = await getPrfOutput(credential.rawId);
    await runRecoverySetup(credential, prfOutput);
  } catch (err) {
    fail("Setup", err);
  }
}

/** Derives the master key and generates the DEK, then hands off to the recovery-phrase
 * display/confirm before the account is ever created (registerAccount). Nothing is sent to
 * the server and no account exists yet at this point — closing the tab here leaves no trace,
 * which is deliberate: the phrase must be seen and confirmed before there's anything to lose
 * by not having it. */
async function runRecoverySetup(credential: PublicKeyCredential, prfOutput: ArrayBuffer): Promise<void> {
  step("derive-master-key");
  const masterKey = await deriveMasterKeyFromPrf(prfOutput);
  step("generate-dek");
  const dek = await generateDek();

  const phrase = await generateRecoveryPhrase();
  showRecoveryPhrase(phrase.words, () => showRecoveryConfirm(phrase.words, () => void registerAccount(credential, masterKey, dek, phrase.words)));
}

/** The one-time display. There is no path anywhere in this app back to this screen — see
 * src/preauth/recovery.ts's header — so the only thing this function is allowed to do wrong
 * is not show all 13 words clearly. */
function showRecoveryPhrase(words: string[], onContinue: () => void): void {
  overlay.hidden = false;
  overlay.innerHTML = "";
  const inner = document.createElement("div");
  inner.className = "overlay-inner";

  const h2 = document.createElement("h2");
  h2.textContent = "Your recovery phrase";
  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent =
    "Write these 13 words down, in order, somewhere safe. This is the only time they're shown — there is no way to see them again, and no other way back into this account if the passkey is lost.";

  const grid = document.createElement("div");
  grid.className = "phrase-grid";
  words.forEach((w, i) => {
    const cell = document.createElement("div");
    cell.className = "w";
    cell.innerHTML = `<b>${i + 1}.</b><span></span>`;
    (cell.querySelector("span") as HTMLSpanElement).textContent = w;
    grid.appendChild(cell);
  });

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "I've written it down";
  btn.addEventListener("click", onContinue);

  appendMany(inner, h2, sub, grid, btn);
  overlay.appendChild(inner);
}

/** Spot-checks three words rather than the whole phrase — enough to catch "I didn't actually
 * write it down" or a transcription slip, without the friction of retyping all 13. Wrong
 * answers send the reader back to the display, not to a retry counter: nothing has been
 * created yet, so there is nothing to rate-limit. */
function showRecoveryConfirm(words: string[], onConfirmed: () => void): void {
  const positions = pickThreeDistinct(words.length - 1); // exclude the checksum word (index 12)
  overlay.innerHTML = "";
  const inner = document.createElement("div");
  inner.className = "overlay-inner";

  const h2 = document.createElement("h2");
  h2.textContent = "Confirm you've saved it";
  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent = "Type back these three words from what you just wrote down.";

  const inputs: HTMLInputElement[] = [];
  const rows = document.createElement("div");
  for (const pos of positions) {
    const row = document.createElement("div");
    row.className = "confirm-row";
    const label = document.createElement("label");
    label.textContent = `Word ${pos + 1}`;
    const input = document.createElement("input");
    input.className = "word-input";
    input.autocapitalize = "none";
    input.autocomplete = "off";
    input.spellcheck = false;
    appendMany(row, label, input);
    rows.appendChild(row);
    inputs.push(input);
  }

  const err = document.createElement("p");
  err.className = "err";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Confirm";
  btn.addEventListener("click", () => {
    const ok = positions.every((pos, i) => (inputs[i]?.value ?? "").trim().toLowerCase() === words[pos]);
    if (ok) return void onConfirmed();
    err.textContent = "That doesn't match — have another look at what you wrote down.";
  });

  const back = document.createElement("button");
  back.type = "button";
  back.className = "ghost";
  back.textContent = "Show the phrase again";
  back.addEventListener("click", () => showRecoveryPhrase(words, () => showRecoveryConfirm(words, onConfirmed)));

  appendMany(inner, h2, sub, rows, err, btn, back);
  overlay.innerHTML = "";
  overlay.appendChild(inner);
}

function pickThreeDistinct(exclusiveMax: number): number[] {
  const set = new Set<number>();
  while (set.size < 3) set.add(Math.floor(Math.random() * exclusiveMax));
  return [...set].sort((a, b) => a - b);
}

/** Wraps the DEK under both the passkey's master key and the recovery phrase, and registers
 * the account. The phrase itself never leaves this function — only its derived, one-way
 * auth verifier and the phrase-wrapped DEK travel to the server (src/preauth/recovery.ts). */
async function registerAccount(credential: PublicKeyCredential, masterKey: CryptoKey, dek: CryptoKey, phraseWords: string[]): Promise<void> {
  overlay.hidden = true;
  statusEl.textContent = "Setting up your passkey…";
  try {
    step("wrap-dek");
    const { iv, ciphertext } = await wrapDek(dek, masterKey);

    step("wrap-recovery-dek");
    const recoverySalt = crypto.getRandomValues(new Uint8Array(16));
    const recoveryKey = await deriveRecoveryEncryptionKey(phraseWords, recoverySalt);
    const { iv: rIv, ciphertext: rCiphertext } = await wrapDek(dek, recoveryKey);
    const authVerifier = await deriveRecoveryAuthVerifier(phraseWords, recoverySalt);

    step("register/finish");
    const finishRes = await fetch("/auth/register/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        response: serializeAttestation(credential),
        deviceLabel: guessDeviceLabel(),
        deviceId: deviceId(),
        wrappedDek: bufferToBase64Url(concatBytes(iv, new Uint8Array(ciphertext))),
        recoverySalt: bufferToBase64Url(recoverySalt),
        recoveryWrappedDek: bufferToBase64Url(concatBytes(rIv, new Uint8Array(rCiphertext))),
        recoveryAuthVerifier: bufferToBase64Url(authVerifier),
      }),
      credentials: "include",
    });
    if (!finishRes.ok) {
      throw new Error(`server returned ${finishRes.status}: ${(await finishRes.text()).slice(0, 120)}`);
    }

    pendingCredential = null;
    statusEl.textContent = "Set up — loading…";
    step("load-app-bundle");
    // Only reachable after a session exists (serveGatedBundle, src/worker/index.ts) — never
    // resolvable at build time, so this is a runtime-only import TS can't type-check.
    // @ts-expect-error runtime-only path
    const app = await import("/app/main.js");
    await app.start({ dek });
  } catch (err) {
    fail("Setup", err);
  }
}

// --- Recovery redemption: the phrase, with no passkey at all ---

function showRecoverForm(): void {
  overlay.hidden = false;
  overlay.innerHTML = "";
  const inner = document.createElement("div");
  inner.className = "overlay-inner";

  const h2 = document.createElement("h2");
  h2.textContent = "Recover with your phrase";
  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent = "Enter all 13 words, separated by spaces, in order.";

  const textarea = document.createElement("textarea");
  textarea.className = "phrase-input";
  textarea.autocapitalize = "none";
  textarea.spellcheck = false;

  const err = document.createElement("p");
  err.className = "err";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Recover";

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    overlay.hidden = true;
  });

  btn.addEventListener("click", async () => {
    const words = textarea.value
      .trim()
      .toLowerCase()
      .split(/\s+/)
      .filter(Boolean);
    if (words.length !== 13) {
      err.textContent = `That's ${words.length} words — a full phrase is 13.`;
      return;
    }
    if (!(await verifyPhraseChecksum(words))) {
      err.textContent = "One of these words doesn't look right — check the phrase and try again.";
      return;
    }
    btn.disabled = true;
    err.textContent = "";
    await redeemRecovery(words, err, btn);
  });

  appendMany(inner, h2, sub, textarea, err, btn, cancel);
  overlay.appendChild(inner);
}

/** The escape hatch for when the lock screen itself is the problem — a stale session cookie,
 * a broken local cache — and Settings' own "Reset this device" can't be reached because
 * reaching it means getting past this screen first. Mirrors what
 * src/app/shell/updates.ts's resetApp() does, since that lives in the gated bundle and can't
 * be imported here (section 13.1) — the two lists of what gets cleared must be kept in step
 * by hand if either one changes. Nothing server-side is touched beyond ending this device's
 * own session; the account, its passkeys and its recovery phrase are all untouched. */
function showWipeConfirm(): void {
  overlay.hidden = false;
  overlay.innerHTML = "";
  const inner = document.createElement("div");
  inner.className = "overlay-inner";

  const h2 = document.createElement("h2");
  h2.textContent = "Sign out and clear this device";
  const sub = document.createElement("p");
  sub.className = "sub";
  sub.textContent =
    "Clears everything this browser has stored — cached data, preferences, this device's session — and reloads to a clean lock screen. Your account, passkeys and recovery phrase are untouched; this only affects this device.";

  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = "Clear this device";
  btn.addEventListener("click", () => void wipeThisDevice(btn));

  const cancel = document.createElement("button");
  cancel.type = "button";
  cancel.className = "ghost";
  cancel.textContent = "Cancel";
  cancel.addEventListener("click", () => {
    overlay.hidden = true;
  });

  appendMany(inner, h2, sub, btn, cancel);
  overlay.appendChild(inner);
}

async function wipeThisDevice(btn: HTMLButtonElement): Promise<void> {
  btn.disabled = true;
  btn.textContent = "Clearing…";

  // Ends the session server-side first — the cookie is HttpOnly, so this page can never
  // drop it itself, and leaving the device signed in would be exactly the wrong half to skip.
  await fetch("/auth/logout", { method: "POST", credentials: "include" }).catch(() => {});

  await new Promise<void>((resolve) => {
    try {
      const request = indexedDB.deleteDatabase("onedash");
      request.onsuccess = () => resolve();
      request.onerror = () => resolve();
      request.onblocked = () => resolve();
      setTimeout(resolve, 3000);
    } catch {
      resolve();
    }
  });

  try {
    localStorage.clear();
    sessionStorage.clear();
  } catch {
    // Private mode, or storage disabled. Nothing to clear.
  }

  for (const cookie of document.cookie.split(";")) {
    const name = cookie.split("=")[0]?.trim();
    if (name) document.cookie = `${name}=;expires=Thu, 01 Jan 1970 00:00:00 GMT;path=/`;
  }

  if ("caches" in window) {
    await Promise.all((await caches.keys()).map((key) => caches.delete(key)));
  }
  if ("serviceWorker" in navigator) {
    const registrations = await navigator.serviceWorker.getRegistrations();
    await Promise.all(registrations.map((r) => r.unregister()));
  }

  location.replace("/");
}

/** The checksum already passed (showRecoverForm), so this is genuinely a 12-word phrase —
 * whether it's the *right* one is what /auth/recover/verify decides, without ever seeing it:
 * only the independently-derived auth verifier crosses the wire (src/preauth/recovery.ts). */
async function redeemRecovery(words: string[], err: HTMLParagraphElement, btn: HTMLButtonElement): Promise<void> {
  try {
    step("recover/start");
    const startRes = await fetch("/auth/recover/start", { method: "POST", credentials: "include" });
    if (startRes.status === 404) throw new Error("no recovery phrase was ever set up on this account");
    if (!startRes.ok) throw new Error(`recover/start returned ${startRes.status}`);
    const { userId, salt: saltB64 } = (await startRes.json()) as any;
    const salt = new Uint8Array(base64UrlToBuffer(saltB64));

    step("recover/verify");
    const verifier = await deriveRecoveryAuthVerifier(words, salt);
    const verifyRes = await fetch("/auth/recover/verify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, verifier: bufferToBase64Url(verifier) }),
      credentials: "include",
    });
    if (!verifyRes.ok) throw new Error("that phrase doesn't match");
    const { wrappedDek, registrationOptions } = (await verifyRes.json()) as any;

    step("unwrap-recovered-dek");
    const recoveryKey = await deriveRecoveryEncryptionKey(words, salt);
    const { iv, ciphertext } = splitIvAndCiphertext(base64UrlToBuffer(wrappedDek));
    // Extractable: this DEK still has to be re-wrapped under the new passkey's master key
    // below, which needs it (see keys.ts's unwrapDek). Swapped for a non-extractable copy
    // right after, so what the app actually runs with is no different from an ordinary login.
    const dek = await unwrapDek(ciphertext, iv, recoveryKey, true);

    step("recover-create-passkey");
    const publicKey = {
      ...registrationOptions,
      challenge: base64UrlToBuffer(registrationOptions.challenge),
      user: { ...registrationOptions.user, id: base64UrlToBuffer(registrationOptions.user.id) },
      excludeCredentials: (registrationOptions.excludeCredentials ?? []).map((c: { id: string }) => ({
        ...c,
        id: base64UrlToBuffer(c.id),
      })),
      extensions: { prf: { eval: { first: await prfSalt() } } },
    };
    const credential = (await navigator.credentials.create({ publicKey })) as PublicKeyCredential | null;
    if (!credential) throw new Error("cancelled");

    let prfOutput = (credential.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } }).prf
      ?.results?.first;
    if (!prfOutput) {
      // Same second-ceremony story as setup() — a fresh tap is required here too.
      prfOutput = await getPrfOutput(credential.rawId);
    }

    step("recover-wrap-dek");
    const masterKey = await deriveMasterKeyFromPrf(prfOutput);
    const { iv: newIv, ciphertext: newCiphertext } = await wrapDek(dek, masterKey);
    const dekForApp = await makeNonExtractable(dek);

    step("recover/finish");
    const finishRes = await fetch("/auth/recover/finish", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        response: serializeAttestation(credential),
        deviceLabel: guessDeviceLabel(),
        deviceId: deviceId(),
        wrappedDek: bufferToBase64Url(concatBytes(newIv, new Uint8Array(newCiphertext))),
      }),
      credentials: "include",
    });
    if (!finishRes.ok) throw new Error(`recover/finish returned ${finishRes.status}`);

    overlay.hidden = true;
    statusEl.textContent = "Recovered — loading…";
    step("load-app-bundle");
    // Only reachable after a session exists (serveGatedBundle, src/worker/index.ts) — never
    // resolvable at build time, so this is a runtime-only import TS can't type-check.
    // @ts-expect-error runtime-only path
    const app = await import("/app/main.js");
    await app.start({ dek: dekForApp });
  } catch (e) {
    btn.disabled = false;
    fail("Recovery", e);
    err.textContent = (e as Error)?.message || "Recovery failed";
  }
}

async function getPrfOutput(credentialId: BufferSource): Promise<ArrayBuffer> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ id: credentialId, type: "public-key" }],
      userVerification: "required",
      extensions: { prf: { eval: { first: await prfSalt() } } } as unknown as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  const prfOutput = (assertion?.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } } | undefined)
    ?.prf?.results?.first;
  if (!prfOutput) throw new Error("authenticator did not return a PRF result");
  return prfOutput;
}

// --- Keeping the passkey provider's list honest (section 9b) ---
//
// Failed registrations leave passkeys on the device that the server has no record of. They
// still show up in the picker, and choosing one just fails, so the provider is told what is
// real and prunes the rest. Both calls are best-effort: older platforms don't implement
// them, and neither is worth failing a working login over.

/** Reconciles the provider against the account's actual credentials. Destructive by design
 * — anything absent from `ids` is removed — so `ids` must be the server's complete set. */
async function signalAcceptedCredentials(userHandle: string, ids: string[]): Promise<void> {
  try {
    const pkc = PublicKeyCredential as unknown as {
      signalAllAcceptedCredentials?: (opts: { rpId: string; userId: string; allAcceptedCredentialIds: string[] }) => Promise<void>;
    };
    if (!pkc.signalAllAcceptedCredentials || !userHandle) return;
    // Never signal an empty set. The call means "these are all the credentials that exist",
    // so an empty list is an instruction to delete every passkey for this account — an
    // account that has just authenticated one, which is proof the list is wrong rather than
    // genuinely empty.
    if (!Array.isArray(ids) || ids.length === 0) return;
    await pkc.signalAllAcceptedCredentials({ rpId: location.hostname, userId: userHandle, allAcceptedCredentialIds: ids });
  } catch (err) {
    console.warn("signalAllAcceptedCredentials", err);
  }
}

/** Reports a single credential the server rejected as unknown. */
async function signalUnknownCredential(credentialId: string): Promise<void> {
  try {
    const pkc = PublicKeyCredential as unknown as {
      signalUnknownCredential?: (opts: { rpId: string; credentialId: string }) => Promise<void>;
    };
    if (!pkc.signalUnknownCredential || !credentialId) return;
    await pkc.signalUnknownCredential({ rpId: location.hostname, credentialId });
  } catch (err) {
    console.warn("signalUnknownCredential", err);
  }
}

const DEVICE_ID_KEY = "onedash:device-id";

/** This browser's own persistent identity, distinct from any passkey (design doc section
 * 9b): a passkey synced via iCloud Keychain or Google Password Manager is deliberately the
 * *same* credential on every device signed into that account, so it can never be what tells
 * two devices apart. localStorage is per-origin-per-browser and never synced anywhere by
 * design — that lack of sync is exactly the property this needs. Sent with every
 * register/login/recover finish call so the server's `devices` row survives across whichever
 * passkey happens to authenticate this browser on a given day. */
function deviceId(): string {
  try {
    let id = localStorage.getItem(DEVICE_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(DEVICE_ID_KEY, id);
    }
    return id;
  } catch {
    // Private mode, or storage disabled. Every visit then looks like a new device to the
    // server, which is the honest outcome — nothing here can actually remember it.
    return crypto.randomUUID();
  }
}

// --- WebAuthn JSON <-> binary plumbing ---

function serializeAssertion(assertion: PublicKeyCredential) {
  const response = assertion.response as AuthenticatorAssertionResponse;
  return {
    id: assertion.id,
    rawId: bufferToBase64Url(assertion.rawId),
    type: assertion.type,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      authenticatorData: bufferToBase64Url(response.authenticatorData),
      signature: bufferToBase64Url(response.signature),
      userHandle: response.userHandle ? bufferToBase64Url(response.userHandle) : null,
    },
    clientExtensionResults: {},
  };
}

function serializeAttestation(credential: PublicKeyCredential) {
  const response = credential.response as AuthenticatorAttestationResponse;
  return {
    id: credential.id,
    rawId: bufferToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: bufferToBase64Url(response.clientDataJSON),
      attestationObject: bufferToBase64Url(response.attestationObject),
      transports: response.getTransports ? response.getTransports() : [],
    },
    clientExtensionResults: {},
  };
}
