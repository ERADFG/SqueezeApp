-- ============================================================
-- MODERATION PIPELINE — FOUNDATION
-- Run this in the Supabase SQL Editor. Additive/idempotent, same
-- pattern as your other migrations — safe to re-run.
--
-- NOTE: this file was referenced by MODERATION_SETUP.md and by
-- api/moderate-text.js (log_moderation_event) / js/moderation.js
-- (is_disposable_email) but was missing from the project — without
-- it, every text-moderation call was throwing on the log step and
-- signup's disposable-email check was calling a function that
-- doesn't exist. This recreates it to match what those files expect.
--
-- What this adds:
--   1. moderation_events   — audit log every moderation decision
--      writes to (text AND media). The admin queue in
--      moderation_media_pipeline.sql reads from this table.
--   2. disposable_email_domains + is_disposable_email() — throwaway
--      signup blocking, loaded by load_disposable_domains.sql.
--   3. login_attempts + is_locked_out()/record_login_attempt() —
--      brute-force lockout (5 failed attempts / 15 min).
-- ============================================================

-- ── 1. Moderation event log ────────────────────────────────

create table if not exists public.moderation_events (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid references public.profiles(id) on delete set null,
  content_type   text not null,              -- 'text' | 'chat' | 'media' | 'avatar' | 'community_image' | ...
  content_ref    text,                       -- post/reply/community id, cast to text (nullable)
  excerpt        text,                       -- first ~200 chars, for text; media URL for media
  toxicity       numeric,
  spam           numeric,
  nsfw           numeric,                    -- media only
  doxxing_flags  jsonb not null default '[]'::jsonb,
  categories     jsonb not null default '[]'::jsonb,  -- e.g. [{"label":"weapon_sale","score":0.91}]
  csam_match     boolean not null default false,
  decision       text not null,              -- 'allow' | 'soft_flag' | 'block' | 'human_review'
  reviewed_by    uuid references public.profiles(id),
  reviewed_at    timestamptz,
  review_outcome text,                       -- 'upheld' | 'overturned', set by admin_review_moderation_item
  created_at     timestamptz not null default now()
);

create index if not exists moderation_events_decision_idx on public.moderation_events(decision, created_at desc);
create index if not exists moderation_events_user_idx on public.moderation_events(user_id);

alter table public.moderation_events enable row level security;

-- No client access at all by default — every write comes from server
-- code using the service-role key (api/moderate-text.js,
-- api/moderate-media.js), which bypasses RLS entirely. Reads go
-- through the admin_list_moderation_queue() SECURITY DEFINER RPC
-- below, not direct table access, so no SELECT policy is needed for
-- normal users. Admins get read access via that RPC's own is_admin()
-- check, not RLS — but we add a narrow admin SELECT policy too so
-- an admin can query the table directly from the SQL editor if
-- needed for investigation.
drop policy if exists moderation_events_admin_select on public.moderation_events;
create policy moderation_events_admin_select on public.moderation_events
  for select
  using (public.is_admin());

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
  p_csam_match boolean default false
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
    doxxing_flags, decision, nsfw, categories, csam_match
  ) values (
    p_user_id, p_content_type, p_content_ref, p_excerpt, p_toxicity, p_spam,
    coalesce(p_doxxing_flags, '[]'::jsonb), coalesce(p_decision, 'allow'),
    p_nsfw, coalesce(p_categories, '[]'::jsonb), coalesce(p_csam_match, false)
  )
  returning id into v_id;
  return v_id;
end;
$$;

-- Callable by anyone with a session (client-side callers exist too,
-- e.g. future direct calls) as well as service role. The function
-- itself doesn't expose or leak other users' data, so this is safe.
grant execute on function public.log_moderation_event(uuid, text, text, text, numeric, numeric, jsonb, text, numeric, jsonb, boolean) to authenticated, anon, service_role;

-- ── 2. Disposable email blocking ───────────────────────────

create table if not exists public.disposable_email_domains (
  domain text primary key
);

alter table public.disposable_email_domains enable row level security;
drop policy if exists disposable_domains_read on public.disposable_email_domains;
create policy disposable_domains_read on public.disposable_email_domains
  for select
  using (true); -- just a domain list, no sensitive data; needed so is_disposable_email() works under RLS

create or replace function public.is_disposable_email(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.disposable_email_domains d
    where lower(split_part(p_email, '@', 2)) = d.domain
  );
$$;

grant execute on function public.is_disposable_email(text) to authenticated, anon, service_role;

-- ── 3. Login lockout ────────────────────────────────────────

create table if not exists public.login_attempts (
  id           bigint generated always as identity primary key,
  identifier   text not null,   -- lowercased email or username
  success      boolean not null,
  attempted_at timestamptz not null default now()
);

create index if not exists login_attempts_identifier_idx on public.login_attempts(identifier, attempted_at desc);

alter table public.login_attempts enable row level security;
-- Write-only from the client (anon/authenticated can insert their own
-- attempt record, never read others' — same "write-only" shape as
-- reports.sql uses).
drop policy if exists login_attempts_insert on public.login_attempts;
create policy login_attempts_insert on public.login_attempts
  for insert
  with check (true);

create or replace function public.record_login_attempt(p_identifier text, p_success boolean)
returns void
language sql
security definer
set search_path = public
as $$
  insert into public.login_attempts (identifier, success)
  values (lower(trim(p_identifier)), p_success);
$$;

create or replace function public.is_locked_out(p_identifier text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select count(*) >= 5
  from public.login_attempts
  where identifier = lower(trim(p_identifier))
    and success = false
    and attempted_at > now() - interval '15 minutes';
$$;

grant execute on function public.record_login_attempt(text, boolean) to authenticated, anon, service_role;
grant execute on function public.is_locked_out(text) to authenticated, anon, service_role;
