// The recovery phrase (design doc section 2.1/10.3): the only way back into the account if
// the passkey is lost. Shown once, at registration, never again — there is no re-display
// path anywhere in this app, by deliberate choice. Losing it after that point is permanent
// and is the user's risk to carry, not a failure mode this code tries to soften.
//
// Two independent keys come out of the same phrase, via HKDF with different `info` strings
// — never the same key doing both jobs:
//   - an *encryption* key, which wraps/unwraps the DEK and never leaves the device;
//   - an *auth* key, whose SHA-256 the server stores as a one-way verifier so it can gate
//     recovery without ever holding anything that decrypts the DEK (section 1's "server is
//     a blind relay" applies to recovery exactly as it does to a passkey login).
// Storing a hash of a key derived independently from the encryption key is safe under that
// principle in a way storing a hash of the encryption key itself would not be.

import { WORDLIST } from "./wordlist.js";

const WORD_COUNT = 12;
const PBKDF2_ITERATIONS = 600_000; // OWASP's 2023 floor for PBKDF2-SHA256.

export interface RecoveryPhrase {
  /** 12 random words plus one checksum word, 13 total — what gets shown and written down. */
  words: string[];
}

/** Draws one word index uniformly from [0, 2048). Masking (not modulo) a 16-bit random value
 * down to 11 bits is exactly uniform, since 2^11 evenly divides 2^16 — no rejection sampling
 * needed. */
function randomWordIndex(): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return (buf[0] ?? 0) & 0x7ff;
}

/** The 13th word: SHA-256 of the first 12 (space-joined, lowercase) folded into an index the
 * same way. Catches a mistyped or misheard word before it ever reaches a key derivation —
 * the only signal available, since a wrong phrase otherwise fails silently by unwrapping
 * into garbage rather than raising an error. Not a security boundary; a typo-detector. */
async function checksumWord(words: string[]): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(words.join(" ")));
  const firstTwoBytes = new DataView(digest).getUint16(0, false);
  return WORDLIST[firstTwoBytes & 0x7ff]!;
}

export async function generateRecoveryPhrase(): Promise<RecoveryPhrase> {
  const words = Array.from({ length: WORD_COUNT }, () => WORDLIST[randomWordIndex()]!);
  words.push(await checksumWord(words));
  return { words };
}

/** True if the 13th word matches what the first 12 checksum to. */
export async function verifyPhraseChecksum(words: string[]): Promise<boolean> {
  if (words.length !== WORD_COUNT + 1) return false;
  const expected = await checksumWord(words.slice(0, WORD_COUNT));
  return expected === words[WORD_COUNT];
}

async function importPhraseKey(words: string[]): Promise<CryptoKey> {
  // Only the 12 real words go into derivation; the checksum word is a client-side sanity
  // check and carries no additional entropy worth mixing in.
  const bytes = new TextEncoder().encode(words.slice(0, WORD_COUNT).join(" ").trim().toLowerCase());
  return crypto.subtle.importKey("raw", bytes, "PBKDF2", false, ["deriveKey", "deriveBits"]);
}

/** The DEK-wrapping key. Never sent anywhere, never derivable by the server. */
export async function deriveRecoveryEncryptionKey(words: string[], salt: Uint8Array): Promise<CryptoKey> {
  const keyMaterial = await importPhraseKey(words);
  return crypto.subtle.deriveKey(
    { name: "PBKDF2", hash: "SHA-256", salt: salt as BufferSource, iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    { name: "AES-GCM", length: 256 },
    false,
    ["wrapKey", "unwrapKey"]
  );
}

/** The verifier the server is allowed to see the hash of. Derived under a different
 * PBKDF2 salt suffix than the encryption key so the two are cryptographically unrelated,
 * not just conventionally kept apart. */
export async function deriveRecoveryAuthVerifier(words: string[], salt: Uint8Array): Promise<Uint8Array> {
  const keyMaterial = await importPhraseKey(words);
  const authSalt = new Uint8Array(salt.length + 1);
  authSalt.set(salt, 0);
  authSalt[salt.length] = 0x41; // "A" for auth — distinct from the 0x00 the enc key implicitly uses.
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", hash: "SHA-256", salt: authSalt as BufferSource, iterations: PBKDF2_ITERATIONS },
    keyMaterial,
    256
  );
  const digest = await crypto.subtle.digest("SHA-256", bits);
  return new Uint8Array(digest);
}
