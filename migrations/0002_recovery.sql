-- Recovery phrase backing (design doc section 2.1/10.3). One row per account — the phrase
-- is shown once at registration and never redisplayed, so there is nothing here to update
-- afterward except by going through recovery itself.
--
-- auth_verifier is a one-way hash of a key derived independently from the one that wraps
-- wrapped_dek (src/app/crypto/recovery.ts) — the Worker can gate /auth/recover on it without
-- ever holding anything that decrypts the DEK. Losing this row (or the phrase) is
-- unrecoverable by design; there is no second fallback underneath the recovery phrase.
CREATE TABLE recovery_keys (
  user_id TEXT PRIMARY KEY REFERENCES users(id),
  salt BLOB NOT NULL,
  wrapped_dek BLOB NOT NULL,     -- iv[12] || AES-GCM ciphertext of the DEK, same shape as wrapped_keys
  auth_verifier BLOB NOT NULL,   -- SHA-256 of the independently-derived auth key
  created_at INTEGER NOT NULL
);
