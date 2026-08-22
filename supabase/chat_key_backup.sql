-- ─────────────────────────────────────────────────────────────
-- CHAT KEY BACKUP — run this once in the Supabase SQL editor.
--
-- Fixes messages permanently showing "can't decrypt this message on
-- this device" whenever someone opens their account in a new browser
-- or on a new phone. Previously each device generated its own,
-- unrelated private key with no way to recover the old one — so any
-- thread encrypted before that point became unreadable there forever.
--
-- Adds:
--   profiles.key_backup — this account's ECDH private key (JWK),
--                          encrypted client-side with a passphrase the
--                          user chooses (Settings → Privacy → "Set up
--                          chat backup"), before it ever leaves the
--                          browser. Stored as JSON: { v, salt, iv, ct }
--                          — salt/iv/ct are all base64. The passphrase
--                          itself is never sent or stored anywhere;
--                          without it this column is just ciphertext,
--                          the same way profiles.pubkey being public
--                          is fine because it's a *public* key. A new
--                          device downloads this blob, asks for the
--                          passphrase, and unwraps it locally to
--                          restore the exact same private key —
--                          matching js/chat-crypto.js's
--                          wrapPrivateKeyBackup()/restoreKeyBackup().
-- ─────────────────────────────────────────────────────────────

alter table public.profiles add column if not exists key_backup text;

comment on column public.profiles.key_backup is 'Passphrase-encrypted (PBKDF2+AES-GCM, done client-side) backup of this account''s chat private key, so it can be restored on a new device. Ciphertext only — the passphrase never leaves the browser.';
