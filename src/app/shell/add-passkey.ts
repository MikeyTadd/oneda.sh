// Registers a genuinely second, independent passkey for an account that's already
// authenticated (docs/DESIGN.md, register/start's own comment) — the case ordinary login
// doesn't cover: a synced or cross-device-relayed passkey is the *same* credential
// everywhere, but a hardware key or a platform that won't share the first one's keychain
// needs its own credential and its own wrap of the DEK. Driven from Settings' Passkeys block.

import { deriveMasterKey, getPrfOutput, deriveMasterKeyFromPrf, wrapDek, unwrapDek, prfSalt } from "../crypto/keys.js";
import { base64UrlToBuffer, joinIvAndCiphertext, splitIvAndCiphertext } from "../crypto/codec.js";
import { guessDeviceLabel } from "./device-label.js";
import { appendChildren, el } from "./dom.js";
import { openSheet, sheetFoot, sheetHead } from "./sheet.js";

/** Opens the sheet and runs the whole ceremony; `onAdded` repaints the passkey list once a
 * new row actually exists to show. */
export function openAddPasskeySheet(onAdded: () => void): void {
  const node = openSheet("confirm", { label: "Add a passkey" });
  const lead = el("p.confirm-lead", {
    text:
      "Both passkeys unlock this exact same account and the exact same data — a passkey only gets you in, it doesn't own a separate copy of anything. The only reason to add one is a device that won't share this passkey's own sync (a hardware key, a different platform): a normal new device on the same iCloud Keychain or Google Password Manager already signs in with the one you have, no extra step needed. You'll confirm your current passkey once, then create the new one.",
  });
  const status = el("p.block-note", { text: "" });
  const err = el("p.err", { text: "" });
  const go = el<HTMLButtonElement>("button.btn.go", { type: "button", text: "Continue", onClick: () => void run() });

  appendChildren(
    node,
    el("div.sheet-inner", {}, [
      sheetHead(node, "Add a passkey"),
      el("div.sheet-scroll", {}, [lead, status, err]),
      sheetFoot([el("button.btn.ghost", { type: "button", text: "Cancel", onClick: () => node.close() }), go]),
    ])
  );

  async function run(): Promise<void> {
    go.disabled = true;
    err.textContent = "";
    try {
      status.textContent = "Confirming your current passkey…";
      const keyRes = await fetch("/api/passkeys/current/wrapped-key", { credentials: "include" });
      if (!keyRes.ok) throw new Error(`couldn't read the current key (${keyRes.status})`);
      const { credentialId, wrappedDek } = (await keyRes.json()) as { credentialId: string; wrappedDek: string };

      // Re-derives the master key fresh via its own ceremony rather than reusing the DEK
      // already sitting in this session's memory: that DEK is deliberately non-extractable
      // (crypto/keys.ts), and wrapKey requires the key it wraps to have been created
      // extractable. Unwrapping again here, this once, is what produces a copy allowed out.
      const currentMasterKey = await deriveMasterKey(base64UrlToBuffer(credentialId));
      const { iv: currentIv, ciphertext: currentCiphertext } = splitIvAndCiphertext(base64UrlToBuffer(wrappedDek));
      const extractableDek = await unwrapDek(currentCiphertext, currentIv, currentMasterKey, true);

      status.textContent = "Create the new passkey…";
      const startRes = await fetch("/auth/passkeys/add/start", { method: "POST", credentials: "include" });
      if (!startRes.ok) throw new Error(`couldn't start registration (${startRes.status})`);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- server JSON, shape
      // matches @simplewebauthn's PublicKeyCredentialCreationOptionsJSON (same as preauth's).
      const options = (await startRes.json()) as any;

      const publicKey = {
        ...options,
        challenge: base64UrlToBuffer(options.challenge),
        user: { ...options.user, id: base64UrlToBuffer(options.user.id) },
        excludeCredentials: (options.excludeCredentials ?? []).map((c: { id: string }) => ({
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
        // Same gap setup() hits in the pre-auth flow (src/preauth/auth.ts): not every
        // authenticator returns PRF from create() itself, so fetch it with an immediate
        // second ceremony against the credential that was just made.
        status.textContent = "Confirm once more to finish…";
        prfOutput = await getPrfOutput(credential.rawId);
      }

      const newMasterKey = await deriveMasterKeyFromPrf(prfOutput);
      const { ciphertext: newCiphertext, iv: newIv } = await wrapDek(extractableDek, newMasterKey);

      const finishRes = await fetch("/auth/passkeys/add/finish", {
        method: "POST",
        headers: { "content-type": "application/json" },
        credentials: "include",
        body: JSON.stringify({
          response: credential.toJSON ? credential.toJSON() : credentialToJson(credential),
          deviceLabel: guessDeviceLabel(),
          wrappedDek: joinIvAndCiphertext(newIv, newCiphertext),
        }),
      });
      if (!finishRes.ok) throw new Error(`couldn't finish registration (${finishRes.status})`);

      node.close();
      onAdded();
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      err.textContent = `Couldn't add a passkey — ${message}`;
      status.textContent = "";
      go.disabled = false;
    }
  }
}

/** `PublicKeyCredential.toJSON()` isn't implemented everywhere yet — falls back to the same
 * manual shape the pre-auth bundle builds for the same reason (src/preauth/auth.ts). */
function credentialToJson(credential: PublicKeyCredential): unknown {
  const response = credential.response as AuthenticatorAttestationResponse;
  const toB64Url = (buf: ArrayBuffer) =>
    btoa(String.fromCharCode(...new Uint8Array(buf)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  return {
    id: credential.id,
    rawId: toB64Url(credential.rawId),
    type: credential.type,
    response: {
      clientDataJSON: toB64Url(response.clientDataJSON),
      attestationObject: toB64Url(response.attestationObject),
    },
    clientExtensionResults: {},
  };
}
