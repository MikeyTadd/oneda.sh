-- onedash initial schema
-- Ciphertext blobs + non-sensitive metadata only. Never plaintext content (section 3.2).

CREATE TABLE users (
  id TEXT PRIMARY KEY,               -- random account id, established at signup
  created_at INTEGER NOT NULL
);

-- WebAuthn credentials registered for a user (one row per passkey/device, section 2.1 / 9b).
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,               -- WebAuthn credential ID (base64url)
  user_id TEXT NOT NULL REFERENCES users(id),
  public_key BLOB NOT NULL,
  sign_count INTEGER NOT NULL DEFAULT 0,
  device_label TEXT NOT NULL,        -- e.g. "iPhone", "MacBook — Chrome" (section 9b)
  created_at INTEGER NOT NULL
);

-- Wrapped DEK per credential (section 2.3): DEK is wrapped by each passkey's PRF-derived key
-- independently, so any registered device can unwrap it without key transfer.
CREATE TABLE wrapped_keys (
  credential_id TEXT PRIMARY KEY REFERENCES credentials(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  wrapped_dek BLOB NOT NULL,         -- ciphertext only, useless without the PRF key
  updated_at INTEGER NOT NULL
);

-- Active device sessions, for remote sign-out (section 9b).
CREATE TABLE sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  credential_id TEXT NOT NULL REFERENCES credentials(id),
  device_label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  revoked_at INTEGER
);

-- Generic encrypted tile records (notes, tasks, pet diary, RSS read state, etc.).
-- One table for all e2ee/client-encrypted tile data; dataNamespace scopes it per tile (section 4.1).
CREATE TABLE tile_records (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  data_namespace TEXT NOT NULL,      -- e.g. "notes", "petdiary", "rss"
  ciphertext BLOB NOT NULL,
  seq INTEGER NOT NULL,              -- sync sequence number for this user
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX idx_tile_records_user_ns ON tile_records(user_id, data_namespace);
CREATE INDEX idx_tile_records_user_seq ON tile_records(user_id, seq);

-- Tile registry: which tiles are installed + layout, synced like any other data (section 4.2).
CREATE TABLE tile_registry (
  user_id TEXT NOT NULL REFERENCES users(id),
  tile_id TEXT NOT NULL,
  ciphertext BLOB NOT NULL,          -- encrypted registry entry (order, layout prefs, etc.)
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, tile_id)
);

-- Reminder trigger timestamps (section 6.1). Only the fire time is readable server-side;
-- the reminder's actual content (task title, event details) lives in tile_records, encrypted.
CREATE TABLE reminders (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  tile_record_id TEXT NOT NULL REFERENCES tile_records(id),
  fire_at INTEGER NOT NULL,
  fired_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX idx_reminders_fire_at ON reminders(fire_at) WHERE fired_at IS NULL;

-- Web Push subscriptions per device (section 6).
CREATE TABLE push_subscriptions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  session_token TEXT NOT NULL REFERENCES sessions(token),
  endpoint TEXT NOT NULL,
  p256dh TEXT NOT NULL,
  auth TEXT NOT NULL,
  created_at INTEGER NOT NULL
);

-- R2 blob metadata (section 3.3): opaque object_key only, real filename/MIME encrypted in `metadata`.
CREATE TABLE blobs (
  object_key TEXT PRIMARY KEY,       -- random UUID, R2 key — never a real filename
  user_id TEXT NOT NULL REFERENCES users(id),
  data_namespace TEXT NOT NULL,      -- e.g. "gallery", "attachments"
  metadata BLOB NOT NULL,            -- encrypted: real filename, MIME type, folder path
  byte_size INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- Third-party integration OAuth tokens (grey lock, section 1b / 9d).
-- Monzo tokens are additionally encrypted at rest per section 9d, same column either way.
CREATE TABLE integration_tokens (
  user_id TEXT NOT NULL REFERENCES users(id),
  provider TEXT NOT NULL,            -- "youtube" | "spotify" | "bmw" | "hue" | "ring" | "monzo"
  token_blob BLOB NOT NULL,          -- plaintext for low-stakes providers, encrypted for Monzo
  encrypted INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, provider)
);
