-- ─────────────────────────────────────────────────────────────
-- CHAT E2E ENCRYPTION — run this once in the Supabase SQL editor.
--
-- Adds the columns the new js/chat-crypto.js needs:
--   profiles.pubkey   — each user's ECDH (P-256) public key, stored
--                        as a JSON-stringified JWK. Public by design
--                        (that's the point of a public key) — no RLS
--                        change needed, it rides on the existing
--                        "anyone can read profiles" policy, and the
--                        existing "user can update own profile" policy
--                        already lets a user set their own pubkey.
--   messages.iv        — base64 AES-GCM IV for that row. NULL means
--                        the row is legacy/unencrypted plaintext
--                        (old messages sent before this migration, or
--                        messages sent while the recipient had no
--                        pubkey yet) — the client falls back to
--                        rendering `body` as-is when `iv` is NULL.
--   messages.body       — unchanged column, just now holds base64
--                        AES-GCM ciphertext instead of plaintext once
--                        both sides have a pubkey. Supabase/Postgres
--                        (and anyone with DB access) only ever sees
--                        ciphertext for encrypted rows — the AES key
--                        is derived client-side via ECDH and never
--                        leaves the browser.
-- ─────────────────────────────────────────────────────────────

alter table public.profiles add column if not exists pubkey text;
alter table public.messages add column if not exists iv text;

comment on column public.profiles.pubkey is 'ECDH P-256 public key (JWK, JSON-encoded) used to derive per-conversation AES-GCM keys client-side. Public by design.';
comment on column public.messages.iv is 'Base64 AES-GCM IV for this message. NULL = legacy/unencrypted plaintext body.';
