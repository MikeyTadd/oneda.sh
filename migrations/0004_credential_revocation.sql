-- A revoked passkey (section 2.1/9b): registering a second, independent credential and then
-- retiring the first is the account's only way to move off a passkey without losing access to
-- the DEK (unlike a device sign-out, which only ends a session and leaves every credential
-- able to log back in). Marked rather than deleted, same reasoning as sessions.revoked_at —
-- credentials FKs from wrapped_keys and sessions would otherwise have to cascade or be
-- refused, and the row is worth keeping as a record of what used to grant access.
ALTER TABLE credentials ADD COLUMN revoked_at INTEGER;
