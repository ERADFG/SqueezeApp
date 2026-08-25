-- ─────────────────────────────────────────────────────────────
-- VOICE NOTE DURATION — run this once in the Supabase SQL editor.
--
-- Fixes the voice-message progress bar not moving (or moving on some
-- devices/browsers but not others). The root cause: browsers report a
-- freshly-recorded webm clip's .duration as Infinity until a seek
-- workaround runs, and that workaround is unreliable across browsers
-- (works on some phones, not on some desktop browsers) — so any fix
-- that depends on the browser telling us the correct duration is
-- inherently flaky.
--
-- This sidesteps the problem instead of patching around it: the app
-- already knows exactly how long a voice note is the moment it's
-- recorded (it's timing the record button). Storing that known,
-- always-correct duration and using it to compute the progress bar's
-- percentage means playback progress no longer depends on the
-- browser's buggy .duration at all, on any device.
--
-- Adds:
--   messages.media_duration_ms — voice note length in milliseconds,
--                                 set at send time. NULL for
--                                 image/video attachments, and for
--                                 voice notes sent before this
--                                 migration (those still fall back to
--                                 the old browser-duration behavior).
-- ─────────────────────────────────────────────────────────────

alter table public.messages add column if not exists media_duration_ms integer;

comment on column public.messages.media_duration_ms is 'Voice note length in milliseconds, captured at recording time. NULL for non-audio attachments or voice notes sent before this column existed.';
