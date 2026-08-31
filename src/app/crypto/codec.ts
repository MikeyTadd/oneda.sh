// Base64url <-> binary and iv/ciphertext framing shared by every module that talks to the
// WebAuthn API or to a `wrapped_dek` column (both the pre-auth bundle and the post-auth app
// need this — the DEK gets wrapped under a fresh passkey from Settings just as much as it
// does during initial registration). One copy rather than two kept in sync by hand.

export function base64UrlToBuffer(value: string): ArrayBuffer {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

export function bufferToBase64Url(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

/** `wrapped_dek` columns hold `iv[12] || ciphertext` (base64url-encoded end to end) —
 * splitting/joining this exact framing happens wherever a wrapped DEK crosses the wire. */
export function splitIvAndCiphertext(buffer: ArrayBuffer): { iv: Uint8Array; ciphertext: ArrayBuffer } {
  const bytes = new Uint8Array(buffer);
  return { iv: bytes.slice(0, 12), ciphertext: bytes.slice(12).buffer };
}

export function joinIvAndCiphertext(iv: Uint8Array, ciphertext: ArrayBuffer): string {
  return bufferToBase64Url(concatBytes(iv, new Uint8Array(ciphertext)));
}
