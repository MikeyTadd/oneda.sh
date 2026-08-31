// Session token validation (section 9b). A session is issued only after a successful
// WebAuthn verification (src/worker/auth/webauthn.ts) and gates every protected route,
// including the tile bundle route in index.ts (section 13.2).

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
  revoked_at: number | null;
}

const SESSION_COOKIE = "onedash_session";

export function extractSessionToken(request: Request): string | null {
  const header = request.headers.get("Authorization");
  if (header?.startsWith("Bearer ")) return header.slice("Bearer ".length);

  const cookie = request.headers.get("Cookie");
  if (!cookie) return null;
  const match = cookie.match(new RegExp(`${SESSION_COOKIE}=([^;]+)`));
  return match?.[1] ?? null;
}

/**
 * Validates a session token against D1. Returns null for missing/unknown/revoked tokens —
 * callers must treat null as "anonymous" (401/404), never fall back to a degraded view.
 */
export async function validateSession(env: Env, token: string | null): Promise<SessionRow | null> {
  if (!token) return null;

  const row = await env.DB.prepare(
    `SELECT token, user_id, credential_id, device_label, revoked_at
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
