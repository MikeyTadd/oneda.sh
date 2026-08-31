-- A passkey and a device are different things (credentials already covers the first): a
-- passkey is what gets into the account and unwraps the DEK, and it can be the *same*
-- passkey on several devices at once via iCloud Keychain / Google Password Manager sync —
-- that's the entire point of sync. A device is whatever holds the encrypted local cache
-- (IndexedDB, the service worker's cache) and needs signing out or renaming on its own,
-- independent of which passkey happened to authenticate it on a given day.
--
-- `id` is generated client-side (a random UUID in localStorage, never synced — see
-- src/preauth/auth.ts) and sent with every register/login/recover finish call, so the same
-- browser installation is recognised as the same device across logins even when a different
-- passkey (a re-registration, a recovered one) authenticates it, and two different devices
-- sharing one synced passkey are never collapsed into a single row the way grouping by
-- credential_id did.
CREATE TABLE devices (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  label TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL
);

ALTER TABLE sessions ADD COLUMN device_id TEXT REFERENCES devices(id);
