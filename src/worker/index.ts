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

import { validateSession, extractSessionToken, type Env } from "./lib/session.js";
import { startRegistration, startAuthentication } from "./auth/webauthn.js";
// finishRegistration / finishAuthentication are wired in once challenge persistence
// (see handleAuth below) is implemented — imported there, not here, to avoid unused
// imports in the meantime.

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

  // TODO: once tile bundles are built, fetch the requested asset from R2/KV and stream it
  // back. Keeping this behind the session check above is the actual security boundary
  // described in section 13.2 — do not move bundle serving in front of validateSession.
  return new Response("not found", { status: 404 });
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

async function handleAuth(request: Request, env: Env, url: URL): Promise<Response> {
  // Registration and authentication ceremonies (section 2.1). Challenges must be persisted
  // between the /start and /finish calls (e.g. a short-lived KV entry or signed cookie) —
  // omitted here as a scaffold placeholder.
  switch (url.pathname) {
    case "/auth/register/start": {
      const { userId, userName } = await request.json<{ userId: string; userName: string }>();
      const options = await startRegistration(env, userId, userName);
      return Response.json(options);
    }
    case "/auth/register/finish": {
      // const { expectedChallenge, response } = await request.json();
      // const verification = await finishRegistration(env, expectedChallenge, response);
      // TODO: on verification.verified, insert into credentials + wrapped_keys, issue session.
      return new Response("not implemented", { status: 501 });
    }
    case "/auth/login/start": {
      const options = await startAuthentication(env);
      return Response.json(options);
    }
    case "/auth/login/finish": {
      // const { expectedChallenge, response, credential } = await request.json();
      // const verification = await finishAuthentication(env, expectedChallenge, response, credential);
      // TODO: on verification.verified, insert a sessions row, return the token.
      return new Response("not implemented", { status: 501 });
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
