-- ─────────────────────────────────────────────────────────────
-- FIX: video uploads fail with "Couldn't reach the server — check
-- your connection and try again", even on a fast, working connection.
--
-- Root cause: the client (MAX_FILE_MB in js/supabase-config.js) lets
-- people pick files up to 100MB, but the "media" storage bucket's own
-- file_size_limit was set to 50MB by fix_media_bucket_audio_mime.sql.
-- Videos are the file type most likely to land between 50–100MB, so
-- they're the ones that hit this: the upload passes client-side
-- validation, then gets rejected at the bucket level. That rejection
-- response isn't sent with CORS headers, so the browser's fetch()
-- throws a bare network-level "Failed to fetch" instead of a readable
-- "file too large" — which friendlyUploadError() in js/common.js then
-- (reasonably, given what it has to work with) reports as a
-- connection problem instead of a size problem.
--
-- This raises the bucket's limit to match the client's, so a file
-- that's allowed to be picked is also allowed to upload. Safe to run
-- repeatedly — it's a plain update.
-- ─────────────────────────────────────────────────────────────

update storage.buckets
set file_size_limit = 104857600 -- 100MB, matching MAX_FILE_MB in js/supabase-config.js
where id = 'media';
