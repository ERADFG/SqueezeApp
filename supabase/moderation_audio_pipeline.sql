-- ============================================================
-- MODERATION PIPELINE — AUDIO TRANSCRIPT ADDITION
-- Run this in the Supabase SQL Editor, after moderation_pipeline.sql
-- and moderation_media_pipeline.sql. Additive/idempotent, same
-- pattern as the rest of this project's migrations — safe to re-run.
--
-- What this adds: nsfw-service/main.py now has an /audio-moderate
-- endpoint that transcribes a video's audio track (whisper) and runs
-- the transcript through the same toxicity + drug/weapon-sale-
-- language classifiers that already run on post text. This migration
-- gives that result somewhere to land — two new columns on
-- moderation_events, and two new optional (default-null) parameters
-- on log_moderation_event so api/moderate-media.js can log them
-- without breaking the existing call from api/moderate-text.js, which
-- never passes them.
-- ============================================================

alter table public.moderation_events
  add column if not exists audio_toxicity numeric,
  add column if not exists transcript_excerpt text;

-- IMPORTANT: CREATE OR REPLACE only replaces a function with the exact
-- same argument signature. Adding two new params, even with defaults,
-- makes this a *different* signature — CREATE OR REPLACE would leave
-- the old 11-arg version in place alongside a new 13-arg overload, and
-- Supabase's named-argument RPC calls (which only ever supply the
-- original 11) would then match BOTH overloads and fail with
-- "function is not unique". Drop the old signature explicitly first.
drop function if exists public.log_moderation_event(
  uuid, text, text, text, numeric, numeric, jsonb, text, numeric, jsonb, boolean
);

create or replace function public.log_moderation_event(
  p_user_id uuid,
  p_content_type text,
  p_content_ref text,
  p_excerpt text,
  p_toxicity numeric default null,
  p_spam numeric default null,
  p_doxxing_flags jsonb default '[]'::jsonb,
  p_decision text default 'allow',
  p_nsfw numeric default null,
  p_categories jsonb default '[]'::jsonb,
  p_csam_match boolean default false,
  p_audio_toxicity numeric default null,
  p_transcript_excerpt text default null
)
returns uuid
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  insert into public.moderation_events (
    user_id, content_type, content_ref, excerpt, toxicity, spam,
    doxxing_flags, decision, nsfw, categories, csam_match,
    audio_toxicity, transcript_excerpt
  ) values (
    p_user_id, p_content_type, p_content_ref, p_excerpt, p_toxicity, p_spam,
    coalesce(p_doxxing_flags, '[]'::jsonb), coalesce(p_decision, 'allow'),
    p_nsfw, coalesce(p_categories, '[]'::jsonb), coalesce(p_csam_match, false),
    p_audio_toxicity, p_transcript_excerpt
  )
  returning id into v_id;
  return v_id;
end;
$$;

grant execute on function public.log_moderation_event(
  uuid, text, text, text, numeric, numeric, jsonb, text, numeric, jsonb, boolean, numeric, text
) to authenticated, anon, service_role;
