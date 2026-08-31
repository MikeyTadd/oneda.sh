// Base64url <-> bytes helpers shared across the auth routes. Mirrors the encoding used by
// the WebAuthn JSON wire format and by public/shell/auth.js on the client side.

export function base64UrlToBytes(value: string): Uint8Array {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(value.length + ((4 - (value.length % 4)) % 4), "=");
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function bytesToBase64Url(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = "";
  for (const byte of arr) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** D1 BLOB binds want a plain ArrayBuffer; a Uint8Array view (e.g. a subarray from a
 * library) can't be bound directly if its underlying buffer is larger than the view. */
export function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

/** What a D1 BLOB column actually reads back as. Verified against the Workers binding, not
 * assumed: D1 hands back a plain `number[]`, *not* the ArrayBuffer the column type suggests.
 * Both forms are accepted here so this keeps working if that ever changes. */
export type D1Blob = number[] | ArrayBuffer | Uint8Array;

/** Normalises a D1 BLOB read into a Uint8Array. Always go through this rather than
 * `new Uint8Array(row.some_blob)` — that happens to work for both shapes, but any other
 * ArrayBuffer-shaped access (`.byteLength`, `.slice()`) silently misbehaves on a number[],
 * so the honest type plus this one conversion point is what keeps that from biting. */
export function fromD1Blob(value: D1Blob): Uint8Array {
  if (value instanceof Uint8Array) return value;
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  return Uint8Array.from(value);
}
