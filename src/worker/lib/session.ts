// Session issuance & validation (section 9b). A session is issued only after a successful
// WebAuthn verification (src/worker/auth/webauthn.ts) and gates every protected route,
// including the tile bundle route in index.ts (section 13.2).

import { getCookie, setCookie, clearCookie } from "./cookies.js";
import { bytesToBase64Url } from "./bytes.js";

export interface Env {
  DB: D1Database;
  BLOBS: R2Bucket;
  USER_SESSION: DurableObjectNamespace;
  ENVIRONMENT: string;
  WEBAUTHN_RP_ID?: string;
  WEBAUTHN_ORIGIN?: string;
  VAPID_PUBLIC_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
}

export interface SessionRow {
  token: string;
  user_id: string;
  credential_id: string;
  device_label: string;
  device_id: string | null;
  revoked_at: number | null;
}

export const SESSION_COOKIE = "onedash_session";
// Sessions are revoke-based (section 9b), not time-based, so the cookie itself is
// long-lived; a lost/stolen device is dealt with via device-list revocation, not expiry.
const SESSION_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 400;

export function extractSessionToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);
  return getCookie(request, SESSION_COOKIE);
}

/** Issues a session row for a just-verified credential and returns the raw token — callers
 * write it to the response via setSessionCookie.
 *
 * `deviceId` is the client's own persistent identifier (localStorage, never synced — see
 * src/preauth/auth.ts), not the credential: the same synced passkey can authenticate several
 * physical devices, and grouping by credential would collapse them into one indistinguishable
 * row. The upsert only touches `last_seen_at` on a repeat login from a device already known —
 * a fresh guessed label overwriting a name the reader chose in Settings would be its own bug. */
export async function createSession(
  env: Env,
  userId: string,
  credentialId: string,
  deviceLabel: string,
  deviceId: string
): Promise<string> {
  const token = bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO devices (id, user_id, label, created_at, last_seen_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET last_seen_at = excluded.last_seen_at`
    ).bind(deviceId, userId, deviceLabel, now, now),
    env.DB.prepare(
      `INSERT INTO sessions (token, user_id, credential_id, device_label, device_id, created_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(token, userId, credentialId, deviceLabel, deviceId, now, now),
  ]);
  return token;
}

export function setSessionCookie(headers: Headers, token: string): void {
  setCookie(headers, SESSION_COOKIE, token, { path: "/", maxAge: SESSION_COOKIE_MAX_AGE_SECONDS });
}

export function clearSessionCookie(headers: Headers): void {
  clearCookie(headers, SESSION_COOKIE, "/");
}

/**
 * Validates a session token against D1. Returns null for missing/unknown/revoked tokens —
 * callers must treat null as "anonymous" (401/404), never fall back to a degraded view.
 */
export async function validateSession(env: Env, token: string | null): Promise<SessionRow | null> {
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT token, user_id, credential_id, device_label, device_id, revoked_at
     FROM sessions WHERE token = ?`
  )
    .bind(token)
    .first<SessionRow>();

  if (!row || row.revoked_at !== null) return null;

  await env.DB.prepare(`UPDATE sessions SET last_seen_at = ? WHERE token = ?`)
    .bind(Date.now(), token)
    .run();

  return row;
}
