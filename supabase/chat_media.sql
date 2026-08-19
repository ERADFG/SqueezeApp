-- ─────────────────────────────────────────────────────────────
-- CHAT MEDIA — lets DM messages carry an image, video, or voice
-- note, with or without a text caption.
--
-- Media is uploaded to the same public "media" storage bucket posts
-- and replies already use (see MEDIA_BUCKET / uploadMedia() in
-- js/common.js) — no new bucket or storage policy needed, since that
-- bucket's insert/select policies are already scoped to "any
-- authenticated user can upload, anyone can read the public URL".
--
-- NOTE ON ENCRYPTION: unlike message text (see chat_e2e_encryption.sql
-- / js/chat-crypto.js), attached media is NOT end-to-end encrypted.
-- It's a plain public URL, same trust model as post/reply media. A
-- message's `body`/`iv` (caption) still go through the normal E2E
-- path independently — a photo can have an encrypted caption, an
-- unencrypted one, or no caption at all (body = '').
-- ─────────────────────────────────────────────────────────────

alter table public.messages add column if not exists media_url text;
alter table public.messages add column if not exists media_type text
  check (media_type in ('image', 'video', 'audio'));

comment on column public.messages.media_url is
  'Public URL of an attached image/video/voice-note in the shared "media" storage bucket. NULL = text-only message.';
comment on column public.messages.media_type is
  'image | video | audio (voice note). NULL when media_url is NULL.';

-- A message must either say something or attach something.
alter table public.messages drop constraint if exists messages_body_or_media_chk;
alter table public.messages add constraint messages_body_or_media_chk
  check (coalesce(body, '') <> '' or media_url is not null);
