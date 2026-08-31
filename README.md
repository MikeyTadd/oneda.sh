# oneda.sh

Personal, single/few-user, end-to-end encrypted PWA productivity dashboard on Cloudflare Workers.

Full technical scope: [`docs/DESIGN.md`](docs/DESIGN.md).

## Architecture

```
Client (PWA) <--wss--> Durable Object (per user) <---> R2 (blobs) / D1 (structured records)
```

- **Server is a blind relay** — Workers, Durable Objects, R2, and D1 never hold a key
  capable of decrypting user content. Identity is a WebAuthn passkey; there are no
  passwords anywhere in the system.
- **Pre-auth / post-auth split** — `public/shell/` is the entire anonymous surface (a lock
  screen and nothing else). Everything else — tile bundles, sync logic, business logic —
  is served from a session-gated Worker route, not a public static file (see design doc
  §13).

## Layout

```
public/shell/        pre-auth PWA shell: lock screen, manifest, service worker
src/worker/           Cloudflare Worker: routing, WebAuthn, session gating, Cron trigger
src/worker/durable-objects/   per-user UserSession DO — pure relay, never decrypts
src/app/crypto/        passkey PRF -> HKDF -> DEK envelope encryption (WebCrypto)
src/app/storage/       transparent-encryption IndexedDB wrapper
src/app/sync/          offline sync queue over the DO WebSocket
src/app/tiles/         tile interface + registry + the reference `notes` tile
src/app/shell/         post-auth chrome: nav ordering, router, layout + stylesheet, sheets, bell/toast alerts (design doc §4.4)
migrations/            D1 schema
docs/DESIGN.md          full technical scope document
```

## Status

Scaffold only, following the build order in design doc §11:

1. ✅ Identity foundation — passkey registration/auth endpoints, PRF→DEK key derivation
   (stubs; challenge persistence and DB writes are marked `TODO`)
2. ⬜ App-level lock screen re-auth on foreground/idle timeout
3. 🚧 One tile end-to-end (`notes`) — local encrypted storage + sync queue wired, not yet
   tested against a live Durable Object
4. ✅ Tile registry pattern
5. ⬜ Push notifications, reminders, badging
6. ⬜ Messenger, gallery, and everything after — see design doc §11 for the rest of the order

## Local development

```
npm install
npx wrangler d1 create onedash_db   # then paste the id into wrangler.toml
npm run db:migrate:local
npm run dev
```

Secrets (`WEBAUTHN_RP_ID`, `WEBAUTHN_ORIGIN`, VAPID keys, integration OAuth credentials)
are set via `wrangler secret put`, never committed.
