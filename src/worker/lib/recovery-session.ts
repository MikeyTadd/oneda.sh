// The short-lived proof that a caller passed /auth/recover/verify, carried between that
// request and /auth/recover/finish. Unlike the WebAuthn challenge cookie (challenge.ts),
// this cookie *is* the gate — finishing recovery inserts a new passkey onto an existing
// account, and the only thing standing between that and anyone who can reach the Worker is
// "did this device's earlier request present a verifier that matched the stored hash?".
// HttpOnly + Secure is exactly the property that matters here: a page script (and so an
// attacker's own script) can't read or fabricate it, and it is only ever set by the server
// after a successful compare (index.ts's timingSafeEqual against the stored auth_verifier).

import { getCookie, setCookie, clearCookie } from "./cookies.js";

const RECOVERY_COOKIE = "onedash_recovery";
const RECOVERY_TTL_SECONDS = 5 * 60;

export interface RecoverySessionPayload {
  userId: string;
  exp: number;
}

export function writeRecoverySessionCookie(headers: Headers, userId: string): void {
  const payload: RecoverySessionPayload = { userId, exp: Date.now() + RECOVERY_TTL_SECONDS * 1000 };
  setCookie(headers, RECOVERY_COOKIE, btoa(JSON.stringify(payload)), {
    maxAge: RECOVERY_TTL_SECONDS,
    path: "/auth",
  });
}

export function readRecoverySessionCookie(request: Request): RecoverySessionPayload | null {
  const raw = getCookie(request, RECOVERY_COOKIE);
  if (!raw) return null;
  try {
    const payload = JSON.parse(atob(raw)) as RecoverySessionPayload;
    if (typeof payload.userId !== "string" || payload.exp < Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}

export function clearRecoverySessionCookie(headers: Headers): void {
  clearCookie(headers, RECOVERY_COOKIE, "/auth");
}
