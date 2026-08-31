// onedash Worker entry point.
//
// Route shape follows section 13 (gating code delivery until authenticated):
//   - /                 public pre-auth shell (lock screen only, nothing sensitive)
//   - /auth/*           WebAuthn registration/authentication endpoints
//   - /app/*            tile bundles + app JS — SESSION-GATED, 401 for anonymous requests
//   - /api/*            REST endpoints (device list, integrations, etc.) — session-gated
//   - /sync             WebSocket upgrade, proxied to the caller's UserSession Durable Object
//
// The Worker itself never decrypts anything; it authenticates devices and routes bytes.

import {
  validateSession,
  extractSessionToken,
  createSession,
  setSessionCookie,
  clearSessionCookie,
  type Env,
  type SessionRow,
} from "./lib/session.js";
import { writeChallengeCookie, readChallengeCookie, clearChallengeCookie } from "./lib/challenge.js";
import {
  writeRecoverySessionCookie,
  readRecoverySessionCookie,
  clearRecoverySessionCookie,
} from "./lib/recovery-session.js";
import {
  base64UrlToBytes,
  bytesToBase64Url,
  toArrayBuffer,
  fromD1Blob,
  timingSafeEqual,
  type D1Blob,
} from "./lib/bytes.js";
import {
  startRegistration,
  finishRegistration,
  startAuthentication,
  finishAuthentication,
  type RegistrationResponseJSON,
  type AuthenticationResponseJSON,
} from "./auth/webauthn.js";

// Built by `npm run build:app` (scripts/build-app.mjs) from src/app/shell/main.ts and
// src/app/shell/shell.css — see serveGatedBundle below. Imported as raw text (wrangler.toml
// `[[rules]]`) rather than as executable code: this Worker only ever streams these bytes
// back to an authenticated caller, it never runs them.
import appBundleJs from "../../dist/app/main.js.txt";
import appBundleCss from "../../dist/app/shell.css.txt";

export { UserSession } from "./durable-objects/UserSession.js";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // "/", "/shell/*", "/icons/*" are served automatically by the [assets] binding in
    // wrangler.toml (public/) before this handler runs at all — that's the entire
    // pre-auth surface (section 13.1) and it never touches this fetch() function.
    // Everything below is deliberately session-gated (section 13.2).

    if (url.pathname.startsWith("/auth/")) {
      return handleAuth(request, env, url);
    }

    if (url.pathname === "/sync") {
      return handleSyncUpgrade(request, env);
    }

    if (url.pathname.startsWith("/app/")) {
      return serveGatedBundle(request, env, url);
    }

    if (url.pathname.startsWith("/api/")) {
      return handleApi(request, env, url);
    }

    return new Response("not found", { status: 404 });
  },

  // Section 6.1 / 9a: Cron Trigger drives reminder-fire checks and RSS polling.
  // Kept intentionally thin here — real logic lives in dedicated modules as those
  // tiles are built (build order, section 11, steps 5 and later).
  async scheduled(_controller: ScheduledController, _env: Env, _ctx: ExecutionContext): Promise<void> {
    // TODO: sweep `reminders` where fire_at <= now AND fired_at IS NULL, trigger push.
    // TODO: poll subscribed RSS feeds once that tile exists (section 9a).
  },
} satisfies ExportedHandler<Env>;

async function serveGatedBundle(request: Request, env: Env, url: URL): Promise<Response> {
  const session = await validateSession(env, extractSessionToken(request));
  if (!session) {
    return new Response("unauthorized", { status: 401 });
  }

  // The session check above is the actual security boundary (section 13.2) — everything
  // past this point is a plain in-memory string, never re-checked per asset.
  const asset = url.pathname.slice("/app/".length);
  const noStore = { "cache-control": "no-store" };
  switch (asset) {
    case "main.js":
      return new Response(appBundleJs, {
        headers: { "content-type": "application/javascript; charset=utf-8", ...noStore },
      });
    case "shell.css":
      return new Response(appBundleCss, {
        headers: { "content-type": "text/css; charset=utf-8", ...noStore },
      });
    default:
      return new Response("not found", { status: 404 });
  }
}

async function handleSyncUpgrade(request: Request, env: Env): Promise<Response> {
  const session = await validateSession(env, extractSessionToken(request));
  if (!session) {
    return new Response("unauthorized", { status: 401 });
  }

  const id = env.USER_SESSION.idFromName(session.user_id);
  const stub = env.USER_SESSION.get(id);

  const forwardUrl = new URL(request.url);
  forwardUrl.pathname = "/ws";
  // The DO's id is derived from this same string (idFromName above), but a Durable Object
  // has no way to ask "what name was I looked up by" — this is the only way it learns whose
  // session it is, which persist() (UserSession.ts) needs for the tile_records rows it writes.
  forwardUrl.searchParams.set("userId", session.user_id);
  return stub.fetch(new Request(forwardUrl, request));
}

interface CredentialRow {
  id: string;
  user_id: string;
  public_key: D1Blob;
  sign_count: number;
  device_label: string;
  revoked_at?: number | null;
}

async function handleAuth(request: Request, env: Env, url: URL): Promise<Response> {
  switch (url.pathname) {
    case "/auth/register/start": {
      // Bootstrap-only for now: registration is open exactly until the first account
      // exists. This is not what stands between the account and a second device — a synced
      // (iCloud Keychain / Google Password Manager) or cross-device-relayed (WebAuthn's own
      // "use a passkey on another device" hybrid flow) passkey is the *same* credential_id
      // everywhere, so ordinary login/finish already handles that with no registration
      // involved, and recover/finish (section 2.1) handles a passkey reachable from nowhere
      // at all. What's still missing is narrower: registering a genuinely distinct,
      // independent passkey for a session that's already authenticated — a hardware key, or
      // deliberately not relying on platform sync — which would need its own authenticated
      // "add another credential" endpoint. No settings UI drives that yet, so it isn't gated
      // in here.
      const { count } = (await env.DB.prepare(`SELECT COUNT(*) as count FROM users`).first<{ count: number }>())!;
      if (count > 0) {
        return new Response("registration is closed", { status: 403 });
      }

      const { userName } = await request.json<{ userName: string }>();
      const userId = crypto.randomUUID();
      const options = await startRegistration(env, userId, userName);

      const res = Response.json(options);
      writeChallengeCookie(res.headers, { challenge: options.challenge, userId });
      return res;
    }
    case "/auth/register/finish": {
      const challengePayload = readChallengeCookie(request);
      if (!challengePayload?.userId) {
        return new Response("challenge expired or missing", { status: 400 });
      }

      const body = await request.json<{
        response: RegistrationResponseJSON;
        deviceLabel: string;
        deviceId: string; // client-persisted, distinct from the credential (section 9b)
        wrappedDek: string; // base64url(iv[12] || AES-GCM ciphertext of the DEK) — section 2.3
        // The recovery phrase's server-side half (section 2.1/10.3). Mandatory: an account
        // with no recovery row is one bad passkey day away from permanent data loss, and
        // that is not a state this endpoint is willing to create.
        recoverySalt: string;
        recoveryWrappedDek: string;
        recoveryAuthVerifier: string; // base64url(SHA-256(authKey)) — never the key itself
      }>();

      let verification;
      try {
        verification = await finishRegistration(env, challengePayload.challenge, body.response);
      } catch (err) {
        console.error("registration verification threw", err);
        return new Response("verification failed", { status: 401 });
      }
      if (!verification.verified || !verification.registrationInfo) {
        return new Response("verification failed", { status: 401 });
      }
      if (!body.recoverySalt || !body.recoveryWrappedDek || !body.recoveryAuthVerifier) {
        return new Response("recovery phrase data missing", { status: 400 });
      }

      const { credential } = verification.registrationInfo;
      const userId = challengePayload.userId;
      const deviceLabel = body.deviceLabel || "Unknown device";
      const deviceId = body.deviceId || crypto.randomUUID();
      const now = Date.now();

      await env.DB.batch([
        env.DB.prepare(`INSERT INTO users (id, created_at) VALUES (?, ?)`).bind(userId, now),
        env.DB.prepare(
          `INSERT INTO credentials (id, user_id, public_key, sign_count, device_label, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(credential.id, userId, toArrayBuffer(credential.publicKey), credential.counter, deviceLabel, now),
        env.DB.prepare(
          `INSERT INTO wrapped_keys (credential_id, user_id, wrapped_dek, updated_at) VALUES (?, ?, ?, ?)`
        ).bind(credential.id, userId, toArrayBuffer(base64UrlToBytes(body.wrappedDek)), now),
        env.DB.prepare(
          `INSERT INTO recovery_keys (user_id, salt, wrapped_dek, auth_verifier, created_at) VALUES (?, ?, ?, ?, ?)`
        ).bind(
          userId,
          toArrayBuffer(base64UrlToBytes(body.recoverySalt)),
          toArrayBuffer(base64UrlToBytes(body.recoveryWrappedDek)),
          toArrayBuffer(base64UrlToBytes(body.recoveryAuthVerifier)),
          now
        ),
      ]);

      const token = await createSession(env, userId, credential.id, deviceLabel, deviceId);
      const res = Response.json({ ok: true });
      clearChallengeCookie(res.headers);
      setSessionCookie(res.headers, token);
      return res;
    }
    case "/auth/passkeys/add/start": {
      // Registering a second, independent credential for an account that's already
      // authenticated — the gap register/start's own comment calls out: ordinary login
      // covers a synced or cross-device-relayed passkey (the same credential_id showing up
      // on another device), but a genuinely distinct passkey (a hardware key, a second
      // platform not sharing the first's keychain) needs its own ceremony, gated on a
      // session rather than the bootstrap "no account yet" check.
      const session = await validateSession(env, extractSessionToken(request));
      if (!session) return new Response("unauthorized", { status: 401 });

      const options = await startRegistration(env, session.user_id, "onedash");
      const res = Response.json(options);
      writeChallengeCookie(res.headers, { challenge: options.challenge, userId: session.user_id });
      return res;
    }
    case "/auth/passkeys/add/finish": {
      const session = await validateSession(env, extractSessionToken(request));
      if (!session) return new Response("unauthorized", { status: 401 });

      const challengePayload = readChallengeCookie(request);
      if (!challengePayload?.userId || challengePayload.userId !== session.user_id) {
        return new Response("challenge expired or missing", { status: 400 });
      }

      const body = await request.json<{
        response: RegistrationResponseJSON;
        deviceLabel: string;
        // Wrapped by the client under the new passkey's own master key, from the DEK
        // already sitting in this authenticated session's memory (section 2.3) — unlike
        // registration or recovery, there's no fresh DEK to generate and no server-side
        // unwrap involved, just one more wrapping of the same key.
        wrappedDek: string;
      }>();

      let verification;
      try {
        verification = await finishRegistration(env, challengePayload.challenge, body.response);
      } catch (err) {
        console.error("add-passkey verification threw", err);
        return new Response("verification failed", { status: 401 });
      }
      if (!verification.verified || !verification.registrationInfo) {
        return new Response("verification failed", { status: 401 });
      }

      const { credential } = verification.registrationInfo;
      const deviceLabel = body.deviceLabel || "Unknown device";
      const now = Date.now();

      // No INSERT INTO users or sessions: this only adds a second entry point to the DEK
      // the account already has. The session making this call stays exactly as it was.
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO credentials (id, user_id, public_key, sign_count, device_label, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(credential.id, session.user_id, toArrayBuffer(credential.publicKey), credential.counter, deviceLabel, now),
        env.DB.prepare(
          `INSERT INTO wrapped_keys (credential_id, user_id, wrapped_dek, updated_at) VALUES (?, ?, ?, ?)`
        ).bind(credential.id, session.user_id, toArrayBuffer(base64UrlToBytes(body.wrappedDek)), now),
      ]);

      const res = Response.json({ ok: true });
      clearChallengeCookie(res.headers);
      return res;
    }
    case "/auth/whoami": {
      // Lets the pre-auth screen (src/preauth/auth.ts) tell apart three states the session
      // cookie alone can't distinguish (it's HttpOnly, so that page's JS can't read it):
      // "you've never signed in", "you have a session, you're just refreshing" and "this
      // account already exists but not on this device/browser" — the last is what decides
      // whether the "First time? Set up your passkey" link would work or 403 (the same
      // `COUNT(*)` register/start's bootstrap gate uses). Deliberately answers with nothing
      // but two booleans: this route runs before any credential ceremony, so it must never
      // leak which account or device it is.
      const [session, userCount] = await Promise.all([
        validateSession(env, extractSessionToken(request)),
        env.DB.prepare(`SELECT COUNT(*) as count FROM users`).first<{ count: number }>(),
      ]);
      return Response.json({ authenticated: session !== null, accountExists: (userCount?.count ?? 0) > 0 });
    }
    case "/auth/logout": {
      // Ends this device's session and clears the cookie. What makes Settings'
      // reset honest: the cookie is HttpOnly by design, so the page cannot drop
      // it itself, and a reset that left the device signed in would be exactly
      // the wrong half to skip. Revoked rather than deleted — section 9b wants
      // the row to survive as a record for the device list.
      const token = extractSessionToken(request);
      if (token) {
        await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE token = ? AND revoked_at IS NULL`)
          .bind(Date.now(), token)
          .run();
      }
      const res = new Response(null, { status: 204 });
      clearSessionCookie(res.headers);
      return res;
    }
    case "/auth/recover/start": {
      // No auth of any kind — this is the "I no longer have a passkey" entry point, so
      // there is nothing to authenticate with yet. Single-user bootstrap (register/start's
      // own gate above) means at most one row can ever exist here, so there's no username
      // to ask for: this is *the* account or there isn't one to recover.
      const row = await env.DB.prepare(`SELECT user_id, salt FROM recovery_keys LIMIT 1`).first<{
        user_id: string;
        salt: D1Blob;
      }>();
      if (!row) {
        return new Response("no recovery phrase was ever set up on this account", { status: 404 });
      }
      return Response.json({ userId: row.user_id, salt: bytesToBase64Url(fromD1Blob(row.salt)) });
    }
    case "/auth/recover/verify": {
      const body = await request.json<{ userId: string; verifier: string }>();
      const row = await env.DB.prepare(`SELECT auth_verifier, wrapped_dek FROM recovery_keys WHERE user_id = ?`)
        .bind(body.userId)
        .first<{ auth_verifier: D1Blob; wrapped_dek: D1Blob }>();

      const presented = base64UrlToBytes(body.verifier || "");
      // Compared even on a miss (row undefined -> a zero verifier that can never match) so a
      // request for an unknown userId doesn't return measurably faster than a wrong phrase
      // for a real one.
      const stored = row ? fromD1Blob(row.auth_verifier) : new Uint8Array(32);
      if (!row || !timingSafeEqual(presented, stored)) {
        return new Response("verification failed", { status: 401 });
      }

      // Proven possession of the phrase — safe to hand back the wrapped DEK now, and to let
      // this device attach a fresh passkey to the account (recovery-session.ts's whole job).
      const options = await startRegistration(env, body.userId, "onedash");
      const res = Response.json({ wrappedDek: bytesToBase64Url(fromD1Blob(row.wrapped_dek)), registrationOptions: options });
      writeChallengeCookie(res.headers, { challenge: options.challenge, userId: body.userId });
      writeRecoverySessionCookie(res.headers, body.userId);
      return res;
    }
    case "/auth/recover/finish": {
      const recoverySession = readRecoverySessionCookie(request);
      const challengePayload = readChallengeCookie(request);
      // Both cookies, and they have to agree on which account this is for — finish is only
      // reachable at all because verify already proved phrase possession; without that
      // cookie this would be an unauthenticated way to attach a passkey to someone else's
      // account, no different from register/finish with the bootstrap gate turned off.
      if (!recoverySession || !challengePayload?.userId || challengePayload.userId !== recoverySession.userId) {
        return new Response("recovery not verified or expired", { status: 401 });
      }

      const body = await request.json<{
        response: RegistrationResponseJSON;
        deviceLabel: string;
        deviceId: string;
        wrappedDek: string; // the *original* DEK, re-wrapped under this new passkey's master key
      }>();

      let verification;
      try {
        verification = await finishRegistration(env, challengePayload.challenge, body.response);
      } catch (err) {
        console.error("recovery verification threw", err);
        return new Response("verification failed", { status: 401 });
      }
      if (!verification.verified || !verification.registrationInfo) {
        return new Response("verification failed", { status: 401 });
      }

      const { credential } = verification.registrationInfo;
      const userId = recoverySession.userId;
      const deviceLabel = body.deviceLabel || "Unknown device";
      const deviceId = body.deviceId || crypto.randomUUID();
      const now = Date.now();

      // No INSERT INTO users: recovery attaches a credential to an account that already
      // exists, it never creates one. The account row from the original registration is
      // untouched — this only replaces the lost passkey's entry point to the same DEK.
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO credentials (id, user_id, public_key, sign_count, device_label, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`
        ).bind(credential.id, userId, toArrayBuffer(credential.publicKey), credential.counter, deviceLabel, now),
        env.DB.prepare(
          `INSERT INTO wrapped_keys (credential_id, user_id, wrapped_dek, updated_at) VALUES (?, ?, ?, ?)`
        ).bind(credential.id, userId, toArrayBuffer(base64UrlToBytes(body.wrappedDek)), now),
      ]);

      const token = await createSession(env, userId, credential.id, deviceLabel, deviceId);
      const res = Response.json({ ok: true });
      clearChallengeCookie(res.headers);
      clearRecoverySessionCookie(res.headers);
      setSessionCookie(res.headers, token);
      return res;
    }
    case "/auth/login/start": {
      const options = await startAuthentication(env);
      const res = Response.json(options);
      writeChallengeCookie(res.headers, { challenge: options.challenge });
      return res;
    }
    case "/auth/login/finish": {
      const challengePayload = readChallengeCookie(request);
      if (!challengePayload) {
        return new Response("challenge expired or missing", { status: 400 });
      }

      const body = await request.json<AuthenticationResponseJSON & { deviceId: string; deviceLabel: string }>();
      const credRow = await env.DB.prepare(
        `SELECT id, user_id, public_key, sign_count, device_label, revoked_at FROM credentials WHERE id = ?`
      )
        .bind(body.id)
        .first<CredentialRow>();
      if (!credRow) {
        return new Response("unknown credential", { status: 401 });
      }
      if (credRow.revoked_at !== null && credRow.revoked_at !== undefined) {
        // A retired passkey (POST /api/passkeys/:id/revoke) — rejected before the ceremony is
        // even verified, same as an unknown credential, rather than let a stale passkey the
        // reader thought they'd removed still work.
        return new Response("credential revoked", { status: 401 });
      }

      let verification;
      try {
        verification = await finishAuthentication(env, challengePayload.challenge, body, {
          id: credRow.id,
          publicKey: fromD1Blob(credRow.public_key),
          counter: credRow.sign_count,
        });
      } catch (err) {
        console.error("authentication verification threw", err);
        return new Response("verification failed", { status: 401 });
      }
      if (!verification.verified) {
        return new Response("verification failed", { status: 401 });
      }

      const wrappedRow = await env.DB.prepare(`SELECT wrapped_dek FROM wrapped_keys WHERE credential_id = ?`)
        .bind(credRow.id)
        .first<{ wrapped_dek: D1Blob }>();
      if (!wrappedRow) {
        // Shouldn't happen — every credential is created alongside a wrapped_keys row in the
        // same batch above — but a device without key material can't be let past this point.
        return new Response("no key material for this credential", { status: 500 });
      }

      await env.DB.prepare(`UPDATE credentials SET sign_count = ? WHERE id = ?`)
        .bind(verification.authenticationInfo.newCounter, credRow.id)
        .run();

      // Everything this account legitimately has, for the client's Signal API housekeeping
      // (section 9b): the passkey provider prunes anything it holds for us that isn't in
      // this list. It must therefore be the complete set of *active* credentials — a revoked
      // one is exactly what this should tell the keychain to forget, not keep offering.
      const accepted = await env.DB.prepare(`SELECT id FROM credentials WHERE user_id = ? AND revoked_at IS NULL`)
        .bind(credRow.user_id)
        .all<{ id: string }>();

      const deviceId = body.deviceId || crypto.randomUUID();
      const deviceLabel = body.deviceLabel || "Unknown device";
      const token = await createSession(env, credRow.user_id, credRow.id, deviceLabel, deviceId);
      const res = Response.json({
        wrappedDek: bytesToBase64Url(fromD1Blob(wrappedRow.wrapped_dek)),
        // The user handle as the authenticator knows it — the same bytes registration put in
        // `userID`, which is the UTF-8 of the account id (auth/webauthn.ts).
        userHandle: bytesToBase64Url(new TextEncoder().encode(credRow.user_id)),
        acceptedCredentialIds: accepted.results.map((r) => r.id),
      });
      clearChallengeCookie(res.headers);
      setSessionCookie(res.headers, token);
      return res;
    }
    default:
      return new Response("not found", { status: 404 });
  }
}

async function handleApi(request: Request, env: Env, url: URL): Promise<Response> {
  const session = await validateSession(env, extractSessionToken(request));
  if (!session) {
    return new Response("unauthorized", { status: 401 });
  }

  if (url.pathname === "/api/devices" && request.method === "GET") {
    return listDevices(env, session);
  }
  const renameMatch = url.pathname.match(/^\/api\/devices\/([^/]+)$/);
  if (renameMatch?.[1] && request.method === "PATCH") {
    return renameDevice(request, env, session, decodeURIComponent(renameMatch[1]));
  }
  const signoutMatch = url.pathname.match(/^\/api\/devices\/([^/]+)\/signout$/);
  if (signoutMatch?.[1] && request.method === "POST") {
    return signOutDevice(env, session, decodeURIComponent(signoutMatch[1]));
  }

  if (url.pathname === "/api/passkeys" && request.method === "GET") {
    return listPasskeys(env, session);
  }
  if (url.pathname === "/api/passkeys/current/wrapped-key" && request.method === "GET") {
    return currentWrappedKey(env, session);
  }
  const revokeMatch = url.pathname.match(/^\/api\/passkeys\/([^/]+)\/revoke$/);
  if (revokeMatch?.[1] && request.method === "POST") {
    return revokePasskey(env, session, decodeURIComponent(revokeMatch[1]));
  }
  const renamePasskeyMatch = url.pathname.match(/^\/api\/passkeys\/([^/]+)$/);
  if (renamePasskeyMatch?.[1] && request.method === "PATCH") {
    return renamePasskey(request, env, session, decodeURIComponent(renamePasskeyMatch[1]));
  }

  if (url.pathname === "/api/tile-records" && request.method === "GET") {
    return listTileRecords(request, env, session);
  }

  const blobMatch = url.pathname.match(/^\/api\/blobs\/([^/]+)$/);
  if (blobMatch?.[1]) {
    const key = decodeURIComponent(blobMatch[1]);
    if (request.method === "PUT") return putBlob(request, env, session, key);
    if (request.method === "GET") return getBlob(env, session, key);
    if (request.method === "DELETE") return deleteBlob(env, session, key);
  }

  // TODO: integration OAuth callbacks (section 9d), article-reader proxy (section 9a).
  return new Response("not found", { status: 404 });
}

interface TileRecordRow {
  id: string;
  ciphertext: D1Blob;
  updated_at: number;
}

/** The durable half of sync (UserSession.ts's persist()) — everything the server has stored
 * for one namespace, for a device that's never seen it (sync/hydrate.ts). `id` is
 * `${dataNamespace}:${recordId}`; since dataNamespace is a fixed tile id that never itself
 * contains a colon, slicing it off the front is exactly reversing how it was assembled,
 * whatever colons recordId itself might contain (a note's own key nests a "note:"/"folder:"
 * prefix inside its recordId, section 4.1). */
async function listTileRecords(request: Request, env: Env, session: SessionRow): Promise<Response> {
  const dataNamespace = new URL(request.url).searchParams.get("dataNamespace");
  if (!dataNamespace) return new Response("dataNamespace required", { status: 400 });

  const rows = await env.DB.prepare(
    `SELECT id, ciphertext, updated_at FROM tile_records
     WHERE user_id = ? AND data_namespace = ? AND deleted_at IS NULL
     ORDER BY seq ASC`
  )
    .bind(session.user_id, dataNamespace)
    .all<TileRecordRow>();

  return Response.json(
    rows.results.map((row) => ({
      dataNamespace,
      recordId: row.id.slice(dataNamespace.length + 1),
      wrapped: bytesToBase64Url(fromD1Blob(row.ciphertext)),
      updatedAt: row.updated_at,
    }))
  );
}

/** Namespaced by account so one user's opaque key can never collide with — or be guessed
 * into overwriting or reading — another's, on top of the key itself already being a random
 * UUID the client generates and never anything content-revealing (section 3.3). This Worker
 * only ever proxies bytes; it has no DEK and never will. */
function blobR2Key(userId: string, key: string): string {
  return `${userId}/${key}`;
}

async function putBlob(request: Request, env: Env, session: SessionRow, key: string): Promise<Response> {
  const body = await request.arrayBuffer();
  await env.BLOBS.put(blobR2Key(session.user_id, key), body);
  return Response.json({ ok: true });
}

async function getBlob(env: Env, session: SessionRow, key: string): Promise<Response> {
  const object = await env.BLOBS.get(blobR2Key(session.user_id, key));
  if (!object) return new Response("not found", { status: 404 });
  return new Response(object.body, { headers: { "content-type": "application/octet-stream" } });
}

async function deleteBlob(env: Env, session: SessionRow, key: string): Promise<Response> {
  await env.BLOBS.delete(blobR2Key(session.user_id, key));
  return Response.json({ ok: true });
}

interface DeviceRow {
  id: string;
  label: string;
  created_at: number;
  last_seen_at: number;
}

/** One row per device (the `devices` table, section 9b) — a distinct thing from the
 * credentials list: a synced passkey can be the identical credential on several physical
 * devices, so grouping this by credential_id (an earlier version of this endpoint did)
 * collapsed them into one row and showed the same label on every device that shared it.
 * `devices.id` is the client's own persistent identifier instead, immune to that. */
async function listDevices(env: Env, session: SessionRow): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, label, created_at, last_seen_at FROM devices WHERE user_id = ? ORDER BY last_seen_at DESC`
  )
    .bind(session.user_id)
    .all<DeviceRow>();

  return Response.json(
    rows.results.map((row) => ({
      id: row.id,
      deviceLabel: row.label,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
      isCurrent: row.id === session.device_id,
    }))
  );
}

async function renameDevice(request: Request, env: Env, session: SessionRow, deviceId: string): Promise<Response> {
  const body = await request.json<{ deviceLabel: string }>();
  const deviceLabel = (body.deviceLabel ?? "").trim().slice(0, 60);
  if (!deviceLabel) {
    return new Response("a name is required", { status: 400 });
  }

  // The `user_id` check is the ownership boundary — without it this would rename any
  // device on the server by id, not just the caller's own.
  const result = await env.DB.prepare(`UPDATE devices SET label = ? WHERE id = ? AND user_id = ?`)
    .bind(deviceLabel, deviceId, session.user_id)
    .run();
  if (result.meta.changes === 0) {
    return new Response("not found", { status: 404 });
  }
  return Response.json({ ok: true, deviceLabel });
}

/** Revokes the device's sessions, never a credential (design doc section 9b: "revoking a
 * device deletes its session token server-side" — a passkey that also authenticates other,
 * still-trusted devices must not be touched by signing this one out). Signing out the device
 * making this very call is allowed and does exactly what it says: the response still
 * succeeds, and the caller's own next request finds its session gone. */
async function signOutDevice(env: Env, session: SessionRow, deviceId: string): Promise<Response> {
  const owned = await env.DB.prepare(`SELECT id FROM devices WHERE id = ? AND user_id = ?`)
    .bind(deviceId, session.user_id)
    .first();
  if (!owned) {
    return new Response("not found", { status: 404 });
  }

  await env.DB.prepare(`UPDATE sessions SET revoked_at = ? WHERE device_id = ? AND user_id = ? AND revoked_at IS NULL`)
    .bind(Date.now(), deviceId, session.user_id)
    .run();

  return Response.json({ ok: true, signedOutSelf: deviceId === session.device_id });
}

interface PasskeyRow {
  id: string;
  device_label: string;
  created_at: number;
  revoked_at: number | null;
}

/** One row per registered credential — distinct from listDevices above the same way the
 * design doc distinguishes them: a passkey is what gets in and unwraps the DEK, a device is
 * whatever holds the cached data, and this screen is about the former. Includes revoked
 * passkeys (with revoked_at set) so the account keeps a record of what it retired, rather
 * than only showing what still works. */
async function listPasskeys(env: Env, session: SessionRow): Promise<Response> {
  const rows = await env.DB.prepare(
    `SELECT id, device_label, created_at, revoked_at FROM credentials WHERE user_id = ? ORDER BY created_at DESC`
  )
    .bind(session.user_id)
    .all<PasskeyRow>();

  return Response.json(
    rows.results.map((row) => ({
      id: row.id,
      deviceLabel: row.device_label,
      createdAt: row.created_at,
      revokedAt: row.revoked_at,
      isCurrent: row.id === session.credential_id,
    }))
  );
}

/** The wrapped DEK for *this session's own* credential — the one piece "add a second
 * passkey" (settings.ts) needs to re-derive an extractable copy of the DEK it can wrap under
 * a brand-new passkey's master key: it hands back the current credential's id (so the client
 * knows exactly which passkey to prompt for, via allowCredentials, rather than an ambiguous
 * picker) alongside the ciphertext, never the credential's own public key or anything about
 * other credentials on the account. */
async function currentWrappedKey(env: Env, session: SessionRow): Promise<Response> {
  const row = await env.DB.prepare(`SELECT wrapped_dek FROM wrapped_keys WHERE credential_id = ?`)
    .bind(session.credential_id)
    .first<{ wrapped_dek: D1Blob }>();
  if (!row) {
    return new Response("no key material for this credential", { status: 500 });
  }
  return Response.json({
    credentialId: session.credential_id,
    wrappedDek: bytesToBase64Url(fromD1Blob(row.wrapped_dek)),
  });
}

async function revokePasskey(env: Env, session: SessionRow, credentialId: string): Promise<Response> {
  const owned = await env.DB.prepare(`SELECT id, revoked_at FROM credentials WHERE id = ? AND user_id = ?`)
    .bind(credentialId, session.user_id)
    .first<{ id: string; revoked_at: number | null }>();
  if (!owned) {
    return new Response("not found", { status: 404 });
  }
  if (owned.revoked_at !== null) {
    return Response.json({ ok: true }); // already revoked — nothing left to do
  }

  // Never leaves the account with zero working passkeys: that's not "the reader chose to lock
  // themselves out", it's a bug, since recovery (section 2.1) exists precisely so revoking a
  // lost passkey never has to mean losing the account, and only works if something else can
  // still get in to *use* it. Add a second passkey first — that's what this feature is for.
  const { count } = (await env.DB.prepare(
    `SELECT COUNT(*) as count FROM credentials WHERE user_id = ? AND revoked_at IS NULL AND id != ?`
  )
    .bind(session.user_id, credentialId)
    .first<{ count: number }>())!;
  if (count < 1) {
    return new Response("can't revoke your only remaining passkey", { status: 409 });
  }

  await env.DB.prepare(`UPDATE credentials SET revoked_at = ? WHERE id = ?`).bind(Date.now(), credentialId).run();
  return Response.json({ ok: true });
}

/** The credential's `device_label` is only ever the platform's own guess at registration
 * time (guessDeviceLabel, src/app/shell/device-label.ts) — "iPhone" for every iPhone that's
 * ever created one, with no way to tell "my iPhone's own keychain" apart from "iPhone,
 * relayed from someone else's" without renaming it, the same way a device already can. */
async function renamePasskey(request: Request, env: Env, session: SessionRow, credentialId: string): Promise<Response> {
  const body = await request.json<{ deviceLabel: string }>();
  const deviceLabel = (body.deviceLabel ?? "").trim().slice(0, 60);
  if (!deviceLabel) {
    return new Response("a name is required", { status: 400 });
  }

  const result = await env.DB.prepare(`UPDATE credentials SET device_label = ? WHERE id = ? AND user_id = ?`)
    .bind(deviceLabel, credentialId, session.user_id)
    .run();
  if (result.meta.changes === 0) {
    return new Response("not found", { status: 404 });
  }
  return Response.json({ ok: true, deviceLabel });
}
