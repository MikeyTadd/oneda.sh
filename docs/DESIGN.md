# onedash — technical scope

Personal, single/few-user productivity platform. iPhone PWA (installed to home screen), UK-only, no App Store distribution. End-to-end encrypted throughout — Cloudflare and any server component sees ciphertext only.

Domain: oneda.sh
Brand mark: teal squircle tile, horizontal dash + dot (status pulse)

---

## 1. Guiding principles

- **Server is a blind relay.** Cloudflare Workers, Durable Objects, R2, and D1 never hold a key that can decrypt user content. If Cloudflare were fully compromised, an attacker gets ciphertext only.
- **Passkey is the identity.** No usernames or passwords anywhere in the system.
- **Offline-first.** Every module must be usable with no connection; sync is a background reconciliation step, not a requirement to function.
- **Modular by construction.** New features are added as self-contained "tiles" without touching the shell or other tiles.
- **Universal sync — no exceptions.** Every piece of app state syncs: not just tile content, but settings, preferences, read/unread flags, pins, tile registry/layout choices, everything. A phone reset or fresh login on a new device should restore the app to an identical state, not just "your notes are back." No tile is allowed to keep purely local-only state that doesn't round-trip through sync.
- **Client only ever talks to your own domain.** All third-party API calls (YouTube, BMW/MINI, Hue, Ring, Monzo) are proxied through your Worker/Durable Object — the client never calls a third-party API directly. Requests flow client → Worker/DO → third-party API → back through the same channel (typically the existing WebSocket) → client. This keeps API keys/secrets out of client code entirely, lets you lock down CSP `connect-src` to just your own domain, and means a compromised script in the PWA can't exfiltrate data to an arbitrary external endpoint. See section 9e for the one confirmed exception.
- **UK-only scope accepted.** No need to handle EU PWA/push restrictions (DMA). No need to handle multi-region compliance, GDPR-at-scale, or App Store review.

---

## 1a. Threat model

**Defending against:** Cloudflare (or any component of the server-side infrastructure) being compromised or subpoenaed, and being unable to expose plaintext data even if that happens. The entire E2EE architecture in this document exists for this reason — the server is a blind relay by design, not by policy.

**Defending against (device level):** the phone or desktop being lost, stolen, or accessed by someone else while unlocked at the OS level. The app itself must require its own unlock — Face ID, passkey prompt, or device passcode fallback — before revealing any content, independent of whether the phone's own lock screen is bypassed or the device is left unlocked. This is an app-level gate, not just reliance on iOS's lock screen.

**Not defending against:** a highly resourced, targeted attacker (state-level) with physical access to an unlocked, authenticated session — this is a personal project, not a hardened target. No obligation for a security audit, penetration testing, or dedicated crypto review; standard, well-known primitives implemented correctly are the bar, not novel cryptography.

### Implication for build: app-level re-auth
- On app open/foreground (or after a configurable idle timeout), require a fresh Face ID / passkey prompt before rendering any decrypted content — this should sit in the shell, not be reimplemented per tile.
- Even if the phone itself is unlocked (e.g. handed to someone, left unattended), the PWA should not show data without this separate prompt.
- Use `navigator.credentials.get()` for the re-auth check — this reuses the same passkey already established for key derivation (section 2), so there's no separate PIN/password system to build or remember.
- Failed/cancelled auth should show a locked/blank state, not a degraded or partial view of content.

---

## 1b. Encryption tiers & the lock indicator

Every tile is client-side encrypted at rest, full stop — there is no plaintext tier. The distinction below is about whether the **server** can ever hold a key capable of decrypting the data, not whether local storage is protected.

### 🟢 Green lock — true E2EE
The server never possesses, even momentarily, a key that can decrypt this data. Only a device that has derived the key via the user's passkey (section 2) can read it.
- Applies to: notes/tasks, messenger, hidden gallery, pet health diary, RSS read/unread state and pins.
- Requirement to qualify: data must be encrypted **before** it ever leaves the client. If data arrives at a Worker from an external source (a webhook, a third-party API response), it does not automatically qualify — see the Monzo case below.

### ⚪ Grey lock — client-side encrypted, server-accessible
Data is encrypted at rest on the client (same IndexedDB encryption layer as everything else — see section 5.1), but the server legitimately needs to hold a key or plaintext at some point to do its job on the user's behalf.
- Applies to: YouTube/Spotify/BMW/Hue/Ring OAuth tokens (the Worker needs to use these to call the third-party API for you) and any content those integrations fetch server-side (RSS articles, vehicle status, light state).
- This is not a lesser security posture by accident — it's structurally required. A server can't call an API on your behalf using a token it can never read.

### Monzo — correcting an earlier oversimplification
Section 9d originally called Monzo "E2EE." That's not quite right once the webhook flow is considered: Monzo's webhook delivers the transaction to the Worker as plaintext — the Worker necessarily sees it before any encryption happens. That data point is **grey lock at the moment of ingestion**, even if it's immediately encrypted for storage afterward.
- **Default (grey lock, simpler):** Worker encrypts the transaction with a server-held key immediately on receipt, before writing to D1. Stronger than plaintext storage, but the Worker did see plaintext transiently and the storage key isn't purely passkey-derived.
- **Path to true green lock (more complex):** Worker stores the raw webhook payload only in a short-lived, minimal buffer; the client fetches and re-encrypts it with the DEK on next sync, after which the Worker's temporary copy is deleted. This closes the gap but adds a sync-dependent ingestion step and a window where unsynced data sits server-side unencrypted-by-the-user's-key.
- Pick one deliberately rather than assuming green lock by default — flag Monzo's actual tile UI with whichever is implemented.

### UI requirement: lock indicator per tile
- Every tile displays a small padlock icon (in its card/header) reflecting its tier: **green** for true E2EE, **grey** for client-side-encrypted-but-server-accessible.
- Add an `encryptionTier: "e2ee" | "client-encrypted"` field to the tile manifest (section 4.1) — the shell renders the icon from this declared value, so it's an explicit, visible property of every tile rather than something inferred or hidden in code.
- This also acts as a design discipline: if a new tile can't honestly claim green, its manifest should say so, and the UI will show it — no tile should ever silently claim stronger protection than it has.

---

## 2. Identity & key management

### 2.1 Passkey registration
- WebAuthn `navigator.credentials.create()`, platform authenticator.
- Passkey provider: iCloud Keychain (device-native) or 1Password (cross-device, PRF supported on iOS + browser extension as of 2026, with a known non-spec-compliant PRF response bug to test around).
- Registration triggers a **recovery phrase display** (one-time, shown once, user must confirm they've saved it) — this is the only recovery path if the passkey is lost. No recovery phrase = permanent data loss on passkey loss.

### 2.2 Key derivation
- On auth, call WebAuthn `get()` with the **PRF extension**, using a fixed per-purpose salt (e.g. one salt for "master key", allows deriving multiple sub-keys later if needed).
- PRF output → HKDF → AES-256-GCM master key.
- Master key never leaves memory unencrypted; never written to storage.
- **Cross-device:** same passkey + same salt = same derived key on any device (phone, desktop) — no key transfer needed, each device re-derives independently.

### 2.3 Envelope encryption (recommended over raw PRF-as-key)
- Generate one random **data encryption key (DEK)** at account setup.
- Wrap (encrypt) the DEK with the PRF-derived key.
- Store the wrapped DEK (ciphertext) — safe to sync via Cloudflare, since it's useless without the PRF key.
- All actual data encrypted with the DEK, not directly with PRF output.
- **Why:** allows adding a second passkey (e.g. desktop + phone both registered) or rotating the PRF-key path later without re-encrypting all data — just re-wrap the DEK.

### 2.3a Concrete crypto library: OpenPGP.js
- Use **OpenPGP.js** (Proton's open-source, MIT-licensed JavaScript OpenPGP implementation) as the actual encryption engine, rather than hand-rolling raw WebCrypto AES-GCM calls throughout the app. It runs natively in-browser — no native/WASM plumbing beyond what the library already bundles.
- **Passkey integration is straightforward:** generate an OpenPGP keypair per identity at registration time; protect the OpenPGP private key with a passphrase, where that "passphrase" is the PRF-derived key from section 2.2 (or the unwrapped DEK from above) rather than anything the user types. OpenPGP's standard passphrase-protected private key mechanism works with any secret you supply — it doesn't care that the secret came from a passkey rather than a typed password.
- **Post-quantum support is already built in and standards-based**, not experimental: OpenPGP.js implements the IETF's **RFC 9980** (published June 2026, co-authored by Proton and BSI) — hybrid **ML-KEM + classical elliptic curve** for encryption, **ML-DSA** for signatures, **SLH-DSA** as a standalone signature scheme. This is the same code path protecting Proton Mail's production traffic, not a toy implementation.
- **Practical split:** use OpenPGP.js for identity-bound, message-style encryption (messenger content, anything keyed to a specific recipient/identity). For simple record-level blob encryption (a notes tile entry, a Monzo transaction field) plain WebCrypto AES-256-GCM under the DEK remains simpler and sufficiently strong — no need to route every small encrypted field through full OpenPGP message formatting.

### 2.4 Guest accounts (messenger-specific)
- Guest generates an ephemeral keypair client-side on first visit, no passkey required.
- Identity lives only in memory/session storage — gone when tab closes, unless upgraded.
- **Upgrade to persistent:** guest taps "save my identity" → `navigator.credentials.create()` inline → PRF derives a key → encrypts and stores guest's keypair → same recovery-phrase requirement as 2.1.
- Messages sent before upgrading are not retroactively tied to the persistent identity.

---

## 3. Cloudflare architecture

```
Client (PWA) <--wss--> Durable Object (per user) <---> R2 (blobs) / D1 (structured records)
```

### 3.1 Durable Objects
- One DO instance per user (keyed by user ID derived from passkey credential ID, or a random account ID established at signup).
- Responsibilities:
  - Accept WebSocket connections from each of the user's devices.
  - Broadcast incoming ciphertext updates to all other connected devices for that user (real-time sync).
  - Persist state to D1/R2 for devices that reconnect later.
  - Never decrypts anything — pure relay + coordination.

### 3.2 D1 (structured data)
- Stores: encrypted message records, encrypted task/note records, wrapped DEK, tile registry metadata, sync version/vector clocks.
- Schema stores ciphertext blobs + non-sensitive metadata only (timestamps, record IDs, sync sequence numbers) — never plaintext content.

### 3.3 R2 (blob storage)
- Stores: encrypted photos/videos, encrypted file attachments, encrypted thumbnails.
- Uploaded/downloaded via a Worker that proxies bytes — Worker does not decrypt.
- Large files encrypted in chunks (streaming AES-GCM), not as one in-memory buffer.
- **Object keys (filenames/paths) must never reveal content.** A file encrypted as ciphertext but stored as `cv.docx` or `passport-scan.jpg` still leaks exactly what it is to anyone with R2 access (including Cloudflare itself, or anyone who later gets bucket access). Generate a random UUID/opaque ID as the R2 object key for every upload — no original filename, extension, or folder structure that hints at content.
- The real filename (`cv.docx`), MIME type, and any folder/organization structure are themselves metadata — encrypt these as part of the record's metadata blob (stored in D1 alongside the object key), not left as plaintext R2 key/path components. Only the app, after decrypting, ever reconstructs "this is called cv.docx."
- Same applies to the gallery module (section 9) — photo/video object keys must be opaque, never derived from original filenames, dates, or any user-visible label.

### 3.3a Architectural reference: Proton Drive SDK
- **Proton Drive's TypeScript SDK** (`ProtonDriveApps/sdk` on GitHub, MIT-licensed) is a working, production-informed reference for exactly this problem: chunked E2EE file upload/download, encrypted metadata (filenames, folder structure), and the general shape of a "blind server, encrypted client" file storage system.
- Treat this as a **pattern to study and adapt**, not a dependency to import directly — it's coupled to Proton's own backend API and, per Proton's own early-stage disclaimer, still maturing. The value is in reading how they structure chunk boundaries, encrypted filename metadata, and thumbnail handling, then reimplementing that shape against your own Worker/R2/D1 stack.
- Confirms the filename-obfuscation approach above isn't a one-off idea — it's the same pattern Proton uses in production for exactly this reason.

### 3.4 Workers
- HTTP endpoints for: passkey registration challenge/verification, R2 upload/download proxying, push subscription registration.
- WebAuthn server-side verification (standard library, e.g. `@simplewebauthn/server` equivalent for Workers runtime).

---

## 4. Modular tile system

### 4.1 Tile interface
Each tile is a self-contained module implementing:
```
{
  id: string,               // unique tile ID, e.g. "notes", "messenger", "gallery"
  name: string,
  icon: string,              // tabler icon name or custom SVG
  dataNamespace: string,     // prefix for its IndexedDB/D1 keys, avoids collisions
  encryptionTier: "e2ee" | "client-encrypted",  // drives the lock icon shown in the shell — see section 1b
  layoutHint?: "desktop-primary" | "mobile-primary" | "neutral",
  init(ctx): Promise,        // called on load, receives shared crypto/sync context
  render(container): void,   // mounts its UI into the shell
  onSync(update): void       // receives decrypted updates relevant to its namespace
}
```

### 4.2 Registry
- A simple array/JSON list of installed tile IDs, stored locally (and synced like any other data).
- Dashboard shell dynamically `import()`s each tile's module on load.
- Adding a new app = write the module + add its ID to the registry. No shell changes.

### 4.3 Shared context passed to every tile
- `deriveKey(salt)` — access to the crypto layer without each tile reimplementing PRF logic.
- `syncQueue.push(record)` — queue a local change for sync.
- `storage.get/put(namespacedKey)` — IndexedDB wrapper, encryption handled transparently at this layer (tiles never touch raw crypto for storage).

### 4.4 Post-auth shell — navigation, layout, style

`src/app/shell/` (`nav.ts`, `shell.ts`, `shell.css`, `icons.ts`, `main.ts` — the `/app/main.js` entry point `public/shell/auth.js` dynamically imports on a successful passkey ceremony, section 13.1). Structure — one saved order painting both a desktop rail and a phone bottom bar, with Settings pinned out of that order rather than sorted into it — is adapted from a sibling project's PWA shell (F1 Apex); written fresh here against oneda's own tile model, not copied from that project.

- **One order, two renderings.** `nav.ts`'s `order()` repairs the saved id list against the tiles this build actually has (an id from an older/newer device is appended/dropped, never crashes the shell); `split()` gives the phone's bar the first `BAR_SLOTS` and hands the rest to a More sheet. Both navs are painted from the same list, so a phone and a laptop on the same account can't disagree about ordering.
- **Settings is pinned, not a tile.** It has no registry entry and is never in `defaultOrder()`, so a reorder can never move it, and it can never take a bar slot or become the front door. It is hand-placed: under "Customise navigation" in the desktop rail's foot, and as a fixed row in the phone's More sheet.
- **Nav order syncs** under `shell:nav-order`, alongside the tile registry's own `shell:tile-registry` key — the golden rule in section 1 applies to arrangement, not just content.
- **Two layouts at 900px**, one shell: a fixed-width rail with every destination on desktop, a bottom tab bar with the first four plus More on a phone. `shell.css` carries the full token scale (spacing, radii, colour) and is oneda's own palette (teal `#14b8a6` on `#0b0f0e`), not the sibling project's.
- Not yet wired: `src/worker/index.ts`'s `serveGatedBundle` is still the pre-existing `501`/`404` stub (section 13.2) — these files exist as source under `src/app/shell/` and need an actual bundle-serving route before `/app/main.js` resolves in production.

---

## 5. Offline & sync

### 5.1 Local storage
- IndexedDB via a thin wrapper: `put(key, plaintextObj)` → encrypts with DEK → stores ciphertext. `get(key)` → decrypts transparently.
- Cache API for larger cached blobs (thumbnails, downloaded episodes/files) if applicable to a given tile.
- **This applies to every tile, regardless of encryption tier (section 1b).** Green-lock and grey-lock tiles both go through the exact same IndexedDB wrapper — the tier distinction is only about what the server can access, never about local storage. Nothing lives in IndexedDB unencrypted.

### 5.2 Sync queue
- Local writes append to a pending-changes queue immediately (works fully offline).
- On reconnect, queue flushes: each change sent over the DO's WebSocket as an encrypted record + metadata (tile namespace, timestamp, vector clock).

### 5.3 Conflict resolution
- **Use a CRDT library (Yjs recommended)** rather than hand-rolled last-write-wins — required for any tile where two devices might edit the same record while both offline (notes, tasks).
- Yjs documents can be encrypted as a whole unit before leaving the device — DO relays the encrypted CRDT update blob, decrypts nothing.
- Simpler tiles (e.g. an append-only message log) may not need CRDT — ordering by server-assigned sequence number is sufficient.

---

## 6. Push notifications & alerts

Alerts are core to this app, not an add-on — tasks, calendar, and event reminders all depend on timely notification. Build this early (see build order, section 11) rather than treating it as a late nice-to-have.

- Web Push API + service worker, works on iOS 16.4+ as an installed home-screen PWA (confirmed fine for UK, non-EU).
- **Silent push pattern:**
  1. New encrypted data arrives at the DO.
  2. DO triggers a Worker to send a **generic push payload** (no content) via Web Push to the offline/backgrounded device.
  3. Device's service worker wakes, `fetch`es the actual encrypted update from the DO/D1.
  4. Decrypts locally, then renders the real notification (sender, preview) via the Notifications API.
- Web Push protocol itself encrypts the push payload in transit (separate from your app's E2EE) — the "new message" ping is never plaintext to Apple/Google either.
- **Accepted metadata leakage:** push infra (APNs/FCM) knows a push happened, when, and to which device — unavoidable, same as Signal/WhatsApp.

### 6.1 Reminders for tasks, calendar, and events
- Scheduled reminders (e.g. "task due in 1 hour", "event starts in 15 minutes") need a **trigger mechanism**, since a PWA cannot reliably fire a notification at a future time entirely on-device with the app closed.
- Approach: store the reminder's target time in D1 (encrypted) alongside a lightweight, non-sensitive scheduling record. A Cloudflare **Cron Trigger** (or Durable Object alarm — `DurableObject.alarm()`) checks/fires at the right time and sends the same silent-push-then-fetch-and-decrypt pattern as above.
- **Known iOS limitation to accept up front:** background delivery timing is not exact on iOS — the OS can delay a push under battery/resource pressure. "Something is better than nothing" is the right bar here: reminders will generally arrive close to on-time but should not be relied on for precision-critical alerts (e.g. don't build anything safety-critical on this).
- Reminder data itself (task title, event details) stays encrypted end-to-end like any other tile content — only the trigger timestamp needs to be readable by the Worker/Cron job to know when to fire.

### 6.2 Badging API
- Once installed to the home screen, use the **Badging API** (`navigator.setAppBadge(count)` / `navigator.clearAppBadge()`) to show an unread/pending count directly on the app icon — e.g. unread messages + overdue tasks combined, or per-tile if that's more useful.
- Update the badge from the service worker on push receipt (so it updates even if the app isn't open), and from the shell on app foreground (so it clears/updates once the user has seen the content).
- Supported in Safari/iOS for installed PWAs — check current badge count semantics (numeric vs. simple dot) against latest WebKit behavior at build time, since this has evolved.
- Keep the count meaningful, not just "any unread exists" — a stale or inflated badge count trains you to ignore it.

---

## 7. Messenger module

- 1:1 and group E2EE messaging.
- Recommend adapting **Signal protocol** primitives (X3DH for initial key exchange, Double Ratchet for forward secrecy) rather than custom crypto — use an existing library (e.g. `libsignal` bindings or a maintained JS port) rather than reimplementing.
- Guest account flow as in 2.4.
- Invite links: room/conversation key material passed in the **URL fragment** (`#...`), never a query param — fragments are never sent to the server, so Cloudflare never sees the key even in access logs.
- Shared files/photos in a conversation reuse the R2 blob pattern from section 3.3/9.

---

## 8. Calls module (voice/video)

- **Cloudflare Realtime** (SFU) for media routing at the transport level — DTLS-encrypted by default, Cloudflare's TURN relay cannot read media even without additional work.
- **True E2EE on top:** WebRTC **Insertable Streams** (Encoded Transform API) — intercept encoded frames after encoding/before packetizing, apply your own AES-GCM encryption keyed by the call's session key, before SRTP wraps it again.
- **Group calls:** use **MLS protocol** for group key agreement (handles key rotation as participants join/leave) — reference implementation: Cloudflare's open-source **Orange Meets**, which uses this exact SFU + MLS pattern.
- Call identity ties into the same passkey-derived keypair used for messaging — one identity across text and calls.
- **Scope flag:** this is the most complex module in the whole system. Treat as a later-phase addition, not part of an MVP.

---

## 9. Hidden encrypted gallery

- Photos/videos encrypted client-side (AES-256-GCM), chunked encryption for video, before upload to R2 via Worker proxy.
- Generate + encrypt thumbnails locally for gallery grid rendering without decrypting full files.
- **Two-layer unlock:**
  1. **Keyword** typed into an ordinary-looking search box reveals the hidden gallery *section* in the UI (obscurity/discovery layer only — not a security boundary).
  2. **Passkey prompt (Face ID)** required before actual decryption of any content — this is the real security gate.
- Do not rely on the keyword alone as security — treat it purely as a UI-discovery convenience.

---

## 9a. RSS news reader tile

**Tier: integration (server-side fetch), except for the user's own reading state, which follows universal sync (see guiding principles) and is treated like any other tile data.**

### Fetching
- Feed content itself is public data — no need for E2EE on the article text/links/images.
- A Cloudflare **Cron Trigger** polls subscribed RSS/Atom feeds on a schedule (e.g. every 15–30 min), stores new items in D1 (plaintext is fine here — public content).
- New items trigger the same silent-push pattern as section 6, so new articles can raise an alert without the user having the app open.

### User's own data (encrypted, synced like any tile)
- Subscribed feed list.
- Read/unread state per article.
- Pinned articles (saved for later) — pin flag plus, if wanted, a cached copy of the article content stored the same way as any encrypted tile record, so a pinned article remains available even if the source feed later removes it.
- All of the above encrypted with the DEK and synced via the Durable Object exactly like notes/tasks — this is personal usage data (what you've read, what you've saved), not public feed content, so it follows the standard E2EE tile pattern despite the feed-fetching mechanism itself being server-side/unencrypted.

### Unread counts
- Feed into the Badging API (section 6.2) alongside messages/tasks — unread article count can be part of the combined badge total or broken out per-tile, per your preference at build time.

### In-app article reader (clicking through from a headline)
Per the proxy-through-domain principle (section 9e), reading a full article stays entirely on your own domain — the client never connects to the source site directly.
- Client sends the article URL to the Worker (not a direct client-side `fetch()` to the source).
- Worker fetches the raw article HTML server-side and runs it through **Readability.js**-style extraction (same approach as Firefox/Safari reader mode) — strips ads/nav/clutter, returns clean article text + image references.
- Worker returns the structured, clean result to the client, which renders it in the app's own styled reader UI — no request to the source domain appears in the client's network activity.
- **Images need the same treatment, not just the article text.** Rendering `<img src="https://original-site.com/photo.jpg">` directly would make the browser connect to the external domain to load it, breaking the single-domain rule just for images. The Worker should fetch and re-host each image (proxy the bytes through its own route) so the client only ever requests images from `oneda.sh`.
- **Fallback:** provide a "view original" link that opens the source site normally (leaving the app) for cases where extraction produces a poor result — paywalled articles, heavily interactive pages, sites that actively resist scraping. Don't try to force every article through the reader view if extraction clearly failed.

---

## 9b. Device management & remote sign-out

Given passkeys can be registered from multiple devices (section 2.1) and a lost/stolen device is part of the stated threat model (section 1a), the app needs a way to see and revoke device access remotely.

### Session model
- On successful passkey auth, the Worker issues a **session token** for that device, stored in D1 alongside a device label (e.g. "iPhone", "MacBook — Chrome") and last-seen timestamp.
- All subsequent API/WebSocket access from that device is validated against this session token.

### Device list & revocation
- A settings screen lists all active sessions/devices tied to the account.
- Revoking a device deletes its session token server-side — that device's next API call or WebSocket reconnect is rejected, effectively signing it out.
- This should be usable **from any other authenticated device** — the classic "sign out a lost phone from your laptop" flow.

### Important limitation to design around
- Revoking a session stops **future** sync and API access — it does **not** retroactively erase data already stored locally (IndexedDB) on the lost device, since a PWA can't be forced to wipe storage while offline or uncooperative.
- It also does **not** rotate the underlying encryption key. Since the DEK is unwrapped via the passkey's PRF output (section 2.2–2.3), a device that already derived the key once could still decrypt any data it has locally cached, even after its session is revoked — revocation blocks new access, not already-extracted plaintext.
- **For a genuinely compromised device** (not just "misplaced and found later"), the real remedy is **DEK rotation**: generate a new DEK, re-encrypt data with it, re-wrap it only for the passkeys/devices you still trust, and revoke the lost device's passkey registration entirely if it was iCloud Keychain/1Password-synced to that device specifically. This is a heavier operation than a simple "sign out" and should be a distinct, clearly-labeled action in settings (e.g. "revoke access" vs. the more severe "this device was compromised — rotate encryption key").

---

## 9c. Pet health diary tile

**Tier: E2EE — this is personal data like notes/tasks, no different tier treatment needed.**

- Free-text notes (vet visits, symptoms, behavior) — encrypted tile record, same pattern as the notes tile.
- Weight tracker — logged entries (date + weight), rendered as a simple time-series chart in the tile UI. Data stored encrypted like any tile record; charting happens client-side after decryption.
- Vet appointment reminders — reuses the same reminder mechanism as tasks/calendar (section 6.1: encrypted appointment data + a non-sensitive trigger timestamp read by the Cron/alarm job), so upcoming appointments alert the same way other reminders do, with the same iOS timing-precision caveat.
- No new sync/crypto pattern required — this tile is a good candidate to build once the first tile (notes/tasks) proves the pattern, since it reuses that same shape (notes) plus the existing reminder system (section 6.1) plus a lightweight chart for the weight log.

---

## 9d. Third-party integration tiles

General pattern for all of these: OAuth (or local pairing for Hue) token stored per the tile's tier, standard API calls, no new architecture needed beyond what's already defined. Each is its own tile per the modular system (section 4).

### BMW/MINI (vehicle status & remote control)
**Tier: integration** — vehicle telematics/commands aren't sensitive personal content.
- Official route: **BMW CarData** — OAuth 2.0 Device Code Flow REST API plus an MQTT streaming service for live per-vehicle push updates. Covers MINI too (same backend).
- Alternative: **Smartcar** — third-party unified API, partnered with BMW Group Europe, simpler integration than BMW's own API directly.
- Remote commands (flash lights, horn, remote start/climate) require **Remote Services** active on the vehicle — often a separate paid subscription through MyBMW/MINI Connected, independent of API access itself.
- Token stored in D1, refreshed centrally, same pattern as YouTube/Spotify.

### Philips Hue (lighting control)
**Tier: integration** — light state isn't sensitive content.
- **Local API** (recommended when on home network): REST API on the Hue Bridge itself (`https://<bridge-ip>/clip/v2/`), one-time pairing via physical bridge button press, no OAuth needed. Full control of lights/scenes/groups, works without internet, lower latency.
- **Cloud API** (needed for "lights on when I arrive home" from outside the house): OAuth 2.0 via Hue's Remote API, routes through Philips' cloud.
- Local API requires the PWA to reach the bridge's local IP — works at home, not over the open internet unless proxied via something like Cloudflare Tunnel back to the home network.
- "Arriving home" trigger could use device geolocation client-side, or a Worker-side check, to decide when to fire the lighting command.

### Ring (doorbell & camera)
**Tier: integration** for status/live-view control, but treat cached footage/snapshots with gallery-level handling given the privacy sensitivity of home footage.
- Official route (2026): **Ring Developer API** — covers doorbell presses, motion events, live video (WebRTC/RTSP), device status, event history. Webhooks deliver real-time events (button press, motion) with HMAC-SHA256 signed payloads — verify the signature before processing.
- Unofficial alternative: `ring-client-api` (npm) or `python-ring-doorbell` (pip) — mature, widely used (basis of Home Assistant's Ring integration), reverse-engineered but stable in practice. Fallback if the official API's developer registration/Appstore-oriented flow is more than needed for personal use.
- Doorbell press/motion events feed into the same push/badge pattern as other alerts (section 6).
- **Footage handling:** any cached motion clips, snapshots, or thumbnails stored in R2 should follow the same opaque-filename rule as the gallery module (section 3.3) — this is footage of your home, meaningfully more sensitive than a Hue light state or YouTube token, even if not run through full E2EE. At minimum: random object keys, no plaintext metadata revealing time/location/device in the filename itself.

### Monzo (bill & budget manager)
**Tier: grey lock by default, with a path to green lock — see section 1b for why the webhook flow means this can't automatically claim true E2EE.** This is still genuinely sensitive personal data (balances, transactions, spending patterns) and should never become a plaintext copy sitting in Cloudflare — it just needs an honest tier label rather than an overstated one.

- Monzo's Developer API is explicitly designed for exactly this use case — their own docs state it's for personal use / a small whitelist of users, not public apps.
- Auth: OAuth 2.0 with Strong Customer Authentication, approved via push notification in the actual Monzo app.
- **Webhooks** for real-time transaction notifications — a purchase or bill payment pushes to your Worker the moment it happens, no polling required.
- Flow: webhook → Worker receives the raw transaction from Monzo (this hop is unavoidably plaintext, since Monzo sends it that way) → Worker immediately encrypts the relevant fields with the DEK before writing to D1 → from that point on, follows the standard encrypted tile pattern (sync, offline storage, etc.) like any other tile record.
- Bill detection: match incoming transactions against known payee/amount patterns (rent, utilities, subscriptions) to auto-tag as a bill.
- Budget tracking: category totals and spend-vs-limit computed **client-side after decryption**, never computed/aggregated server-side on plaintext.
- Bill due reminders reuse the existing reminder mechanism (section 6.1) — e.g. "rent due in 3 days."
- The OAuth access/refresh token itself should also be encrypted at rest in D1 (unlike the YouTube/Spotify/BMW/Hue tokens, which can stay in plaintext per the earlier integration-tier decision) — a Monzo token is meaningfully higher-stakes than a YouTube token if Cloudflare were ever compromised.

---

## 9e. Proxy-through-domain architecture (and the Spotify exception)

Per the guiding principle above, all third-party API traffic is proxied through your own Worker/DO rather than called directly from the client. Concretely:

```
Client (PWA) --wss--> Worker/DO --https--> YouTube / BMW / Hue / Ring / Monzo API
                                  <-------- response
Client (PWA) <--wss-- Worker/DO relays result back
```

- Client's network requests never leave `oneda.sh` — third-party domains never appear in the PWA's own `fetch`/WebSocket calls.
- OAuth tokens, API keys, and client secrets for these integrations live only in the Worker's environment — never shipped to or reachable from client code.
- CSP `connect-src` can be locked to your own domain only, since the client genuinely never needs to reach anywhere else.

### Confirmed exception: Spotify Web Playback SDK
- If you want an actual in-browser Spotify **player** (not just remote-control of an already-playing device — see earlier discussion), the **Web Playback SDK** requires a direct browser-to-Spotify connection to stream DRM-protected audio via EME. This is structural to how the SDK works and cannot be proxied through your Worker.
- This means choosing the full in-app player breaks the "client only touches my domain" rule for that one tile specifically.
- **This is now an open decision, not a given:** if the single-domain principle matters more than having a genuinely embedded player, use the Spotify **Web API** instead (remote-control of the real Spotify app running elsewhere) — that stays fully proxy-compatible, at the cost of not having a custom in-app playback UI. If the embedded player experience matters more, accept the Spotify SDK as a documented, deliberate exception rather than an oversight.
- Whichever is chosen, it should be a conscious call recorded in section 12 (open decisions), not something discovered mid-build.

---

## 10. Security hardening

### 10.1 Transport
- `wss://` (TLS) for all client-server traffic — standard.
- Browser already negotiates hybrid **X25519 + ML-KEM-768** post-quantum key exchange at the TLS layer automatically (Chrome; Safari from iOS/macOS 26) — no app code needed for this layer.
- **Optional additional hardening:** app-layer ML-KEM handshake over the WebSocket, independent of TLS. **Use OpenPGP.js** (section 2.3a) for this rather than a separate library — it already implements the standardized hybrid ML-KEM key exchange via RFC 9980, so this isn't a second dependency, just the same library already in use for content encryption doing double duty at the transport-hardening layer.
- **SSL interception:** cannot be reliably detected client-side — browsers don't expose certificate details to JS by design, and a trusted-root MITM (e.g. corporate/parental-control CA) is invisible to your app entirely. This is why app-layer E2EE matters — it makes transport-layer interception irrelevant, since only ciphertext is ever exposed regardless.

### 10.2 Data at rest
- AES-256-GCM for all stored content (messages, files, photos, notes) — already at practical maximum strength; 256-bit AES is quantum-resistant on its own (Grover's algorithm only halves effective strength, still infeasible).
- Nothing stored in IndexedDB/R2/D1 in plaintext, ever.

### 10.3 Recovery & failure modes (must design deliberately, not as an afterthought)
- Lost passkey + no recovery phrase saved = **permanent, unrecoverable data loss.** This must be surfaced clearly to the user at registration time, not buried in fine print.
- Consider: recovery phrase encrypts a *backup* wrapped-DEK, stored separately, so losing the passkey but having the phrase still allows recovery.

---

## 11. Suggested build order (avoid building breadth-first)

1. **Identity foundation** — passkey registration, PRF key derivation, DEK envelope encryption. Get this fully solid before anything else.
2. **App-level lock screen** — Face ID/passkey re-auth gate on open/foreground (section 1a). Build alongside step 1 since it's part of the same identity layer.
3. **One tile end-to-end** — pick notes or tasks. Local encrypted storage, offline-first, syncs via a single Durable Object to a second device. Prove the whole loop works.
4. **Tile registry pattern** — generalize the shell so a second tile can be added without touching the first.
5. **Push notifications, reminders, and badging** — silent push + fetch-and-decrypt, Cron/alarm-triggered reminders, Badging API. Prioritize this early given tasks/calendar depend on it directly (section 6).
6. **Messenger (1:1 only)** — Signal-protocol-based, no groups yet.
7. **Hidden gallery** — R2 chunked encryption, two-layer unlock.
8. **Guest accounts** — ephemeral + passkey upgrade flow, applied to the messenger.
9. **Group messaging** — extends messenger with multi-party key agreement.
10. **Calls** — Cloudflare Realtime + Insertable Streams + MLS. Treat as its own project phase.
11. **Post-quantum app-layer hardening** — optional, once everything else is stable.

Each step should be fully working and tested before starting the next — this system fails if built breadth-first across all modules at once.

---

## 12. Open decisions to make before/during build

- Passkey provider: iCloud Keychain only, or also support 1Password/cross-device from day one?
- CRDT library choice: Yjs vs. alternatives.
- Signal protocol library: which JS/WASM implementation to adopt.
- Recovery phrase UX: shown once vs. re-displayable from settings (re-displaying requires re-deriving, which is fine, just a UX decision).
- Whether desktop is a native app, a separate PWA, or the same PWA responsive at wider viewports.
- Monzo webhook ingestion: accept grey lock at ingestion (simpler), or build the client-side re-encryption step for true green lock (section 1b)?
- **Spotify: Web API (remote-control, stays proxy-compatible) vs. Web Playback SDK (real in-app player, breaks the single-domain rule for that one tile) — see section 9e.**

---

## 13. Gating code delivery until authenticated

Goal: an anonymous visitor to oneda.sh should see essentially nothing — no tile logic, no sync code, no business logic — until they've successfully authenticated with a passkey. Two layers are needed; client-side lazy loading alone is not sufficient, since a determined visitor can just fetch bundle URLs directly regardless of when the UI chooses to load them.

### 13.1 Client-side: minimal pre-auth shell
- The initial page load ships only: a lock/login screen, the WebAuthn `get()` call, and just enough styling to render it. No tile registry, no tile modules, no sync/crypto logic beyond what's needed to perform the passkey challenge.
- All tile code, the registry system, IndexedDB wrapper, and sync queue logic live in a **separate bundle**, loaded via dynamic `import()` only after a successful auth response.
- This reduces what's visible in dev tools / view-source for a casual visitor, and keeps the initial load fast — but treat this as UX/hygiene, not security. A bundle URL that exists on the server can still be requested directly with `curl`, bypassing the UI entirely.

### 13.2 Server-side: actual enforcement
- The real control is on the Worker serving the code: tile bundles and any non-trivial application JS should be served from a route that checks for a **valid session token** (issued only after successful WebAuthn verification) before returning the file — anonymous requests get a 401/404, not the code.
- The pre-auth shell bundle (13.1) can stay on a public, unauthenticated route, since it deliberately contains nothing sensitive.
- This means: no session token → no access to tile source, sync logic, or schema details at all, not just "the UI doesn't show it."
- Static asset hosting (e.g. plain R2/Pages) doesn't support this per-file gating on its own — this needs to go through a Worker that checks the session before serving each protected bundle, not a CDN-level public file.

### 13.3 What this does and doesn't achieve
- Does: stop casual poking, reduce reconnaissance surface, avoid leaking your data schema/sync protocol details to anyone just browsing to the domain.
- Doesn't: replace the actual security boundary, which remains the passkey + encryption (sections 2–3). Someone who genuinely wants your code badly enough (e.g. intercepting it after a legitimate login) will still eventually see it — this is about not handing it out for free to anyone who visits the URL, not making the client code itself unreadable.

---

## 14. Desktop vs. mobile tile priority

The PWA is one responsive codebase across viewports (per open decision in section 12), but individual tiles should adapt their depth of experience by platform rather than rendering identically everywhere.

### Desktop-primary tiles
Build the full experience here; mobile gets a lighter/control-only view.
- **Spotify player** — iOS Safari drops background playback when backgrounded (see section on Spotify SDK limitations); desktop keeps the tab open and active, making it the only platform where a full custom player is practical. Mobile view: compact "now playing" strip with basic transport controls only.
- **Hidden gallery** — larger screen better suited to browsing/reviewing photos and video.
- **File sharing/attachments** — drag-and-drop and larger storage browsing both favor desktop.

### Mobile-primary tiles
This is where these are actually used day to day.
- **Messenger** — inherently a mobile-first, on-the-go use case.
- **Push notifications** — mobile-first concept by nature.
- **Dashboard home/status tiles** — glanceable, quick-check pattern suits phone use.
- **Voice notes / quick capture** — phone is the always-on-hand device.

### Platform-neutral tiles
No meaningful bias either way; build one UI, responsive layout only.
- Notes/tasks (CRDT sync makes either device equally valid)
- YouTube subscriptions
- Calendar/events

### Implementation note
Each tile module (section 4.1) should expose an optional `layoutHint` (`"desktop-primary"`, `"mobile-primary"`, `"neutral"`) so the shell can decide default view density, but the underlying data/sync layer stays identical across platforms — only the rendered UI depth changes.
