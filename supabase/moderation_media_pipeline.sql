-- ============================================================
-- MODERATION PIPELINE — MEDIA + CATEGORIES + CSAM + ADMIN QUEUE
-- Run AFTER moderation_pipeline.sql and admin_panel_advanced.sql
-- (needs public.is_admin() and public.moderation_events). Additive/
-- idempotent — safe to re-run.
--
-- What this adds:
--   1. moderation_status/flags/checked_at columns on posts, replies,
--      profiles, communities.
--   2. A RESTRICTIVE select policy on posts/replies so blocked or
--      still-checking content is actually hidden from other users —
--      not just labeled. RESTRICTIVE policies AND with whatever
--      permissive policy you already have, so this can only narrow
--      visibility, never widen it, and doesn't require touching or
--      even knowing the name of your existing policy.
--   3. csam_hash_matches — audit log for the hash-matching provider
--      (see CSAM_SETUP.md — this table only logs what the provider
--      returns, it does not do any detection itself).
--   4. admin_list_moderation_queue() / admin_review_moderation_item()
--      — the review queue the admin panel's new Moderation tab uses.
--
-- IMPORTANT — read before running:
-- Avatars and community images are handled differently from posts.
-- Hiding a user's entire profile because their avatar got flagged
-- would be wrong (RLS is row-level, not column-level), so instead
-- api/moderate-media.js reverts avatar_url/banner_url to the
-- previous value on a block and just logs the event — there's no
-- RLS gate needed or added for those two columns.
-- ============================================================

-- ── 1. Columns ──────────────────────────────────────────────
-- Default 'visible' so existing rows and any text-only insert are
-- unaffected. api/moderate-media.js explicitly sets 'pending' at
-- insert time for anything with media, then flips it after checking.

do $$
begin
  alter table public.posts add column if not exists moderation_status text not null default 'visible';
  alter table public.posts add column if not exists moderation_flags jsonb;
  alter table public.posts add column if not exists moderation_checked_at timestamptz;
  alter table public.posts add constraint posts_moderation_status_check
    check (moderation_status in ('visible','pending','blocked','human_review'));
exception when duplicate_object then null;
end $$;

do $$
begin
  alter table public.replies add column if not exists moderation_status text not null default 'visible';
  alter table public.replies add column if not exists moderation_flags jsonb;
  alter table public.replies add column if not exists moderation_checked_at timestamptz;
  alter table public.replies add constraint replies_moderation_status_check
    check (moderation_status in ('visible','pending','blocked','human_review'));
exception when duplicate_object then null;
end $$;

alter table public.profiles add column if not exists avatar_moderation_flags jsonb;
alter table public.communities add column if not exists image_moderation_flags jsonb;

-- ── 2. Enforcement — RESTRICTIVE select policies ───────────
-- These narrow visibility on top of whatever SELECT policy you
-- already have; they never replace or widen it.

drop policy if exists posts_moderation_gate on public.posts;
create policy posts_moderation_gate on public.posts
  as restrictive
  for select
  using (
    moderation_status in ('visible', 'human_review')  -- human_review stays visible while pending human review, matching your "innocent until reviewed" cooldown-style approach; flip to just 'visible' below if you'd rather hide human_review items too
    or author_id = auth.uid()
    or public.is_admin()
  );

drop policy if exists replies_moderation_gate on public.replies;
create policy replies_moderation_gate on public.replies
  as restrictive
  for select
  using (
    moderation_status in ('visible', 'human_review')
    or author_id = auth.uid()
    or public.is_admin()
  );

-- ── 3. CSAM hash-match audit log ───────────────────────────
-- Populated only by api/moderate-media.js calling your approved
-- provider (Thorn Safer / Google CSAI Match / Microsoft PhotoDNA —
-- see CSAM_SETUP.md). This table never stores the image itself,
-- only the match verdict and provider reference, and is not
-- readable by anyone except admins.

create table if not exists public.csam_hash_matches (
  id                uuid primary key default gen_random_uuid(),
  content_type      text not null,       -- 'post' | 'reply' | 'avatar' | 'community_image'
  content_id        uuid,
  user_id           uuid references public.profiles(id) on delete set null,
  provider          text not null,       -- 'thorn_safer' | 'google_csai' | 'photodna'
  matched           boolean not null,
  provider_ref      text,                -- provider's report/case id, for audit trail
  reported_to_ncmec boolean not null default false,
  created_at        timestamptz not null default now()
);

alter table public.csam_hash_matches enable row level security;
drop policy if exists csam_matches_admin_select on public.csam_hash_matches;
create policy csam_matches_admin_select on public.csam_hash_matches
  for select
  using (public.is_admin());
-- No insert/update policy for any client role — only the service-role
-- key from api/moderate-media.js writes here, which bypasses RLS.

-- ── 4. Admin moderation queue RPCs ─────────────────────────

create or replace function public.admin_list_moderation_queue(status_filter text default 'human_review')
returns setof public.moderation_events
language sql
stable
security definer
set search_path = public
as $$
  select *
  from public.moderation_events
  where public.is_admin()
    and (status_filter is null or decision = status_filter)
  order by created_at desc
  limit 200;
$$;

grant execute on function public.admin_list_moderation_queue(text) to authenticated;

-- p_table must be 'posts' or 'replies'. p_decision: 'approve' (set
-- visible, overturns the flag) or 'remove' (set blocked, upholds it).
create or replace function public.admin_review_moderation_item(
  p_event_id uuid,
  p_table text,
  p_content_id uuid,
  p_decision text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if p_table not in ('posts', 'replies') then
    raise exception 'invalid table';
  end if;
  if p_decision not in ('approve', 'remove') then
    raise exception 'invalid decision';
  end if;

  if p_table = 'posts' then
    update public.posts
      set moderation_status = case when p_decision = 'approve' then 'visible' else 'blocked' end
      where id = p_content_id;
  else
    update public.replies
      set moderation_status = case when p_decision = 'approve' then 'visible' else 'blocked' end
      where id = p_content_id;
  end if;

  update public.moderation_events
    set reviewed_by = auth.uid(),
        reviewed_at = now(),
        review_outcome = case when p_decision = 'approve' then 'overturned' else 'upheld' end
    where id = p_event_id;
end;
$$;

grant execute on function public.admin_review_moderation_item(uuid, text, uuid, text) to authenticated;
