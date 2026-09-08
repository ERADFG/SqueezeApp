-- ─────────────────────────────────────────────────────────────
-- FIX — "new row for relation messages violates check constraint
-- messages_body_check" when sending a caption-less photo, video, or
-- voice note in chat.
--
-- ROOT CAUSE: `public.messages.body` was originally created (before
-- any of the other supabase/*.sql migrations in this repo existed)
-- with an inline column constraint — something like
--   body text not null check (body <> '')
-- — which Postgres auto-named `messages_body_check`. Every migration
-- since then (chat_media.sql, chat_full_setup.sql / their
-- `messages_body_or_media_chk` / `messages_has_content_chk`
-- constraints) correctly allows body = '' for a caption-less
-- attachment, but none of them knew about — or dropped — this
-- original constraint, so it's stayed in place on the live table and
-- keeps rejecting exactly the empty-body-with-media inserts the app
-- is designed to send (see sendMessage()/sendGroupMessage() in
-- js/chat.js, which intentionally set body: '' when an attachment
-- has no caption).
--
-- This file only drops the stale constraint — the real "must have
-- body OR media OR shared_post_id" rule already lives in
-- messages_has_content_chk (chat_full_setup.sql) and keeps working.
-- Safe to re-run.
-- ─────────────────────────────────────────────────────────────

alter table public.messages alter column body drop not null;
alter table public.messages drop constraint if exists messages_body_check;

notify pgrst, 'reload schema';
