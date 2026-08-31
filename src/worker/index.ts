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
  type Env,
} from "./lib/session.js";
import { writeChallengeCookie, readChallengeCookie, clearChallengeCookie } from "./lib/challenge.js";
import { base64UrlToBytes, bytesToBase64Url, toArrayBuffer } from "./lib/bytes.js";
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
  return stub.fetch(new Request(forwardUrl, request));
}

interface CredentialRow {
  id: string;
  user_id: string;
  public_key: ArrayBuffer;
  sign_count: number;
  device_label: string;
}

async function handleAuth(request: Request, env: Env, url: URL): Promise<Response> {
  switch (url.pathname) {
    case "/auth/register/start": {
      // Bootstrap-only for now: registration is open exactly until the first account
      // exists. Adding a *second* passkey for that same account (a new device, section
      // 2.1/9b) needs its own authenticated "add device" flow — not built yet, since there's
      // no settings UI driving it — so it isn't gated in here.
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
        wrappedDek: string; // base64url(iv[12] || AES-GCM ciphertext of the DEK) — section 2.3
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

      const { credential } = verification.registrationInfo;
      const userId = challengePayload.userId;
      const deviceLabel = body.deviceLabel || "Unknown device";
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
      ]);

      const token = await createSession(env, userId, credential.id, deviceLabel);
      const res = Response.json({ ok: true });
      clearChallengeCookie(res.headers);
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

      const body = await request.json<AuthenticationResponseJSON>();
      const credRow = await env.DB.prepare(
        `SELECT id, user_id, public_key, sign_count, device_label FROM credentials WHERE id = ?`
      )
        .bind(body.id)
        .first<CredentialRow>();
      if (!credRow) {
        return new Response("unknown credential", { status: 401 });
      }

      let verification;
      try {
        verification = await finishAuthentication(env, challengePayload.challenge, body, {
          id: credRow.id,
          publicKey: new Uint8Array(credRow.public_key),
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
        .first<{ wrapped_dek: ArrayBuffer }>();
      if (!wrappedRow) {
        // Shouldn't happen — every credential is created alongside a wrapped_keys row in the
        // same batch above — but a device without key material can't be let past this point.
        return new Response("no key material for this credential", { status: 500 });
      }

      await env.DB.prepare(`UPDATE credentials SET sign_count = ? WHERE id = ?`)
        .bind(verification.authenticationInfo.newCounter, credRow.id)
        .run();

      const token = await createSession(env, credRow.user_id, credRow.id, credRow.device_label);
      const res = Response.json({ wrappedDek: bytesToBase64Url(wrappedRow.wrapped_dek) });
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

  // TODO: device list / revoke (section 9b), integration OAuth callbacks (section 9d),
  // R2 upload/download proxying (section 3.3), article-reader proxy (section 9a).
  return new Response("not found", { status: 404 });
}
