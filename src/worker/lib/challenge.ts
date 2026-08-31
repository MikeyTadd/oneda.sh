// Challenge persistence between /auth/*/start and /auth/*/finish (section 2.1). The scaffold
// left this as a placeholder — "e.g. a short-lived KV entry or signed cookie" — this picks
// the cookie option, since it needs no new binding.
//
// No signing/HMAC: the challenge isn't secret (the server hands the same value to the client
// in the /start response), so there's nothing to keep confidential. HttpOnly + Secure keeps
// page script from reading or forging it, and the real security boundary is unchanged either
// way — finishRegistration/finishAuthentication verify a signature over this challenge
// against the credential's stored public key, which a tampered cookie value alone cannot
// satisfy.

import { getCookie, setCookie, clearCookie } from "./cookies.js";

const CHALLENGE_COOKIE = "onedash_challenge";
const CHALLENGE_TTL_SECONDS = 5 * 60;

export interface ChallengePayload {
  challenge: string;
  /** Set for registration only — the account id the challenge was issued for. */
  userId?: string;
  exp: number;
}

export function writeChallengeCookie(headers: Headers, payload: Omit<ChallengePayload, "exp">): void {
  const full: ChallengePayload = { ...payload, exp: Date.now() + CHALLENGE_TTL_SECONDS * 1000 };
  setCookie(headers, CHALLENGE_COOKIE, btoa(JSON.stringify(full)), {
    maxAge: CHALLENGE_TTL_SECONDS,
    path: "/auth",
  });
}

export function readChallengeCookie(request: Request): ChallengePayload | null {
  const raw = getCookie(request, CHALLENGE_COOKIE);
  if (!raw) return null;
  try {
    const payload = JSON.parse(atob(raw)) as ChallengePayload;
    if (typeof payload.challenge !== "string" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function clearChallengeCookie(headers: Headers): void {
  clearCookie(headers, CHALLENGE_COOKIE, "/auth");
}
