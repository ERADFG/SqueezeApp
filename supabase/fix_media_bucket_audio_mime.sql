-- ─────────────────────────────────────────────────────────────
-- FIX: voice notes fail to upload with "mime type audio/webm is
-- not supported" (and similarly for audio/mp4, audio/ogg).
--
-- Root cause: the shared "media" storage bucket (see MEDIA_BUCKET /
-- uploadMedia() in js/common.js — created outside these migrations,
-- directly in the Supabase dashboard, back when it only had to hold
-- post/reply images and videos) has an allowed_mime_types allow-list
-- that was never updated when voice notes were added in
-- chat_media.sql. Supabase Storage rejects the upload at the bucket
-- level before it ever reaches app code, which is what surfaces as
-- that raw "mime type ... is not supported" error in the UI.
--
-- This sets the bucket to accept the actual set of types every
-- uploader in this app can produce:
--  - images: compressImageFile()/compressGifFile() output + originals
--  - video:  uploaded as-is (see the note in uploadMedia())
--  - audio:  startVoiceRecording()'s MediaRecorder, whichever of
--            audio/webm, audio/mp4, audio/ogg the browser picked
--
-- Safe to run repeatedly — it's a plain update, not an insert.
-- ─────────────────────────────────────────────────────────────

update storage.buckets
set allowed_mime_types = array[
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav'
],
    file_size_limit = coalesce(file_size_limit, 52428800) -- 50MB, only if not already set
where id = 'media';

-- If this project genuinely never had the bucket at all, create it
-- now with the right allow-list already in place (no-op everywhere
-- the bucket already exists, per the `where not exists` guard).
insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
select 'media', 'media', true, array[
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav'
], 52428800
where not exists (select 1 from storage.buckets where id = 'media');
