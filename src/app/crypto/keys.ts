// Passkey-derived key management (section 2.2-2.3). This is the client-side counterpart
// to src/worker/auth/webauthn.ts — the Worker never sees any of the key material here.
//
// Flow: WebAuthn PRF output -> HKDF -> AES-256-GCM master key -> unwraps the random DEK.
// All actual tile data is encrypted with the DEK, never directly with the master key, so
// adding a second passkey or rotating the PRF path only means re-wrapping the DEK
// (section 2.3).

// Exactly 32 bytes, because that is what CTAP2's hmac-secret (which PRF is built on)
// takes, and not every platform hashes a shorter input up to length — Safari returns no
// PRF result for one, Chromium accepts it. Exported so the pre-auth bundle
// (src/preauth/auth.ts) derives against the identical salt without duplicating it.
let prfSaltPromise: Promise<Uint8Array> | null = null;
export function prfSalt(): Promise<Uint8Array> {
  prfSaltPromise ??= crypto.subtle
    .digest("SHA-256", new TextEncoder().encode("onedash:prf:master-key"))
    .then((buf) => new Uint8Array(buf));
  return prfSaltPromise;
}

export interface DerivedIdentity {
  masterKey: CryptoKey;
  dek: CryptoKey;
}

/** The HKDF half of the ceremony, split out so a caller that already ran its own
 * navigator.credentials.get() (the pre-auth login/setup flow, which needs the raw
 * assertion for other reasons too) can derive from the PRF output it already has,
 * rather than running a second, redundant ceremony through deriveMasterKey below. */
export async function deriveMasterKeyFromPrf(prfOutput: ArrayBuffer): Promise<CryptoKey> {
  const hkdfKey = await crypto.subtle.importKey("raw", prfOutput, "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: (await prfSalt()) as BufferSource, info: new TextEncoder().encode("onedash-master-key") },
    hkdfKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"]
  );
}

/** A bare `get()` against one specific credential, for a PRF output alone — no server round
 * trip, same shape whether it's proving an existing login (deriveMasterKey below) or
 * completing a two-tap credential creation (add-passkey.ts, when create() itself didn't
 * return a PRF result and a second ceremony has to fetch one). */
export async function getPrfOutput(credentialId: BufferSource): Promise<ArrayBuffer> {
  const assertion = (await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      allowCredentials: [{ id: credentialId, type: "public-key" }],
      userVerification: "required",
      extensions: { prf: { eval: { first: await prfSalt() } } } as unknown as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;

  if (!assertion) throw new Error("passkey authentication cancelled or failed");

  const extResults = assertion.getClientExtensionResults() as {
    prf?: { results?: { first?: ArrayBuffer } };
  };
  const prfOutput = extResults.prf?.results?.first;
  if (!prfOutput) throw new Error("authenticator did not return a PRF result");
  return prfOutput;
}

/** Runs its own WebAuthn PRF ceremony and derives the AES-256-GCM master key via HKDF.
 * Requires a platform authenticator with PRF extension support (section 2.1). For a caller
 * that already has a PRF output from a ceremony it ran itself, use
 * deriveMasterKeyFromPrf directly instead. */
export async function deriveMasterKey(credentialId: BufferSource): Promise<CryptoKey> {
  return deriveMasterKeyFromPrf(await getPrfOutput(credentialId));
}

/** Generates a fresh random DEK (section 2.3) — call once at account setup, never again
 * unless deliberately rotating (section 9b, "this device was compromised"). */
export async function generateDek(): Promise<CryptoKey> {
  return crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
}

/** Wraps the DEK with the master key for storage/sync (section 2.3) — safe to send to the
 * server, since it's useless without the PRF-derived master key. */
export async function wrapDek(dek: CryptoKey, masterKey: CryptoKey): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.wrapKey("raw", dek, masterKey, { name: "AES-GCM", iv });
  return { ciphertext, iv };
}

/** Non-extractable by default — a scripting attacker who can call encrypt/decrypt through
 * this key while the page is open still can't read the raw bytes out and take them offline.
 * `extractable: true` exists only for recovery (src/preauth/auth.ts), which has to re-wrap
 * the same DEK under a brand-new passkey's master key — `wrapKey` requires the key it's
 * wrapping to be extractable, since wrapping is export-then-encrypt under the hood. A caller
 * that asks for it back out should immediately re-derive a non-extractable copy for anything
 * that outlives the ceremony itself; see registerAccount/redeemRecovery. */
export async function unwrapDek(
  wrapped: ArrayBuffer,
  iv: Uint8Array,
  masterKey: CryptoKey,
  extractable = false
): Promise<CryptoKey> {
  return crypto.subtle.unwrapKey(
    "raw",
    wrapped,
    masterKey,
    { name: "AES-GCM", iv: iv as BufferSource },
    { name: "AES-GCM", length: 256 },
    extractable,
    ["encrypt", "decrypt"]
  );
}

/** Re-derives a non-extractable CryptoKey holding the same bytes. The one place this
 * matters: after recovery re-wraps the DEK under a new passkey (which needed it extractable
 * to do so), the copy the app actually runs with should go back to the same
 * can't-be-exported posture every other login path already has. */
export async function makeNonExtractable(dek: CryptoKey): Promise<CryptoKey> {
  const raw = await crypto.subtle.exportKey("raw", dek);
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

/** Record-level encryption under the DEK (section 2.3a) — the default for tile data.
 * Identity-bound/message-style content (messenger) should use OpenPGP.js instead;
 * this stays plain WebCrypto AES-GCM for simple blob fields. */
export async function encryptRecord(dek: CryptoKey, plaintext: unknown): Promise<{ ciphertext: ArrayBuffer; iv: Uint8Array }> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const bytes = new TextEncoder().encode(JSON.stringify(plaintext));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, dek, bytes);
  return { ciphertext, iv };
}

export async function decryptRecord<T = unknown>(dek: CryptoKey, ciphertext: ArrayBuffer, iv: Uint8Array): Promise<T> {
  const bytes = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv as BufferSource }, dek, ciphertext);
  return JSON.parse(new TextDecoder().decode(bytes)) as T;
}
