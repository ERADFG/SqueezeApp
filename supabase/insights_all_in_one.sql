-- ============================================================
-- INSIGHTS — ALL-IN-ONE SETUP
--
-- Everything the Insights page needs, combined into one file so
-- there's no ambiguity about run order or what's already been
-- applied. Safe to run this whole file even if you've already
-- run some or all of analytics_setup.sql / analytics_engagement.sql
-- / analytics_engagement_v2.sql before — every statement here is
-- additive (create table if not exists, create or replace
-- function, add column if not exists), so re-running is a no-op
-- for anything already in place.
--
-- Paste this entire file into the Supabase SQL editor and run it
-- once, top to bottom.
-- ============================================================

-- ANALYTICS / INSIGHTS
--
-- Backs a new "Insights" page (insights.html / js/insights.js),
-- reachable via an Analytics button on your own profile. Everything
-- here is owner-only (checked with auth.uid() inside every RPC) —
-- nobody can see another account's numbers.
--
-- Two new inputs feed it, both read server-side the same way
-- supabase/ip_ban.sql already does (never trusted from the client):
--   1. profiles.country — set from Vercel's x-vercel-ip-country edge
--      header by api/ip.js, which already runs on every signed-in
--      page load (renderAuthArea() -> isClientIpBanned()).
--   2. public.profile_views — one row per profile-page load, written
--      by api/log-profile-view.js (same header, plus the caller's
--      access token when signed in) via js/profile.js.
--
-- Everything else (gender/age of followers, follower growth, post
-- view totals) is computed from tables that already exist
-- (add_age_gender.sql, the `follows` table, posts.view_count) — no
-- new input needed for those.
--
-- Run after add_age_gender.sql and view_counts.sql. Additive/
-- idempotent — safe to re-run.
-- ============================================================

-- ── 1. profiles.country ─────────────────────────────────────
alter table public.profiles add column if not exists country text;
comment on column public.profiles.country is 'Best-effort ISO 3166-1 alpha-2 country code, set server-side from the Vercel edge geo header. Nullable — older accounts and anyone whose traffic never hit api/ip.js just won''t have one yet.';

create or replace function public.update_my_country(p_country text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or p_country is null or trim(p_country) = '' then
    return;
  end if;
  update public.profiles set country = upper(trim(p_country)) where id = auth.uid() and country is distinct from upper(trim(p_country));
end;
$$;
grant execute on function public.update_my_country(text) to authenticated;

-- ── 2. profile_views ────────────────────────────────────────
create table if not exists public.profile_views (
  id         bigserial primary key,
  viewed_id  uuid not null references public.profiles(id) on delete cascade,
  viewer_id  uuid references public.profiles(id) on delete set null,
  country    text,
  created_at timestamptz not null default now()
);
create index if not exists profile_views_viewed_idx on public.profile_views(viewed_id, created_at desc);

alter table public.profile_views enable row level security;
-- No direct client policies on purpose — every write/read goes
-- through the SECURITY DEFINER functions below, same pattern as
-- public.user_ips in ip_ban.sql.

create or replace function public.log_profile_view(p_username text, p_country text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid;
begin
  select id into v_id from public.profiles where lower(username) = lower(p_username);
  if v_id is null then
    return;
  end if;
  if auth.uid() is not null and auth.uid() = v_id then
    return; -- visiting your own profile never counts as a view
  end if;
  insert into public.profile_views (viewed_id, viewer_id, country)
    values (v_id, auth.uid(), nullif(upper(trim(coalesce(p_country, ''))), ''));
end;
$$;
grant execute on function public.log_profile_view(text, text) to anon, authenticated;

-- ── 3. get_profile_view_stats(p_days) — Overview tab ────────
-- Total views in the window, a follower/non-follower split (same
-- framing as the Content/Overview "0.4% followers / 99.6% non-
-- followers" line in the reference screenshots), and a daily series
-- for the trend line.
create or replace function public.get_profile_view_stats(p_days integer default 30)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_total integer;
  v_follower_views integer;
  v_series json;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  select count(*) into v_total
    from public.profile_views
    where viewed_id = v_uid and created_at >= now() - (p_days || ' days')::interval;

  select count(*) into v_follower_views
    from public.profile_views pv
    where pv.viewed_id = v_uid
      and pv.created_at >= now() - (p_days || ' days')::interval
      and pv.viewer_id is not null
      and exists(select 1 from public.follows f where f.follower_id = pv.viewer_id and f.followee_id = v_uid);

  select coalesce(json_agg(row_to_json(d)), '[]'::json) into v_series
  from (
    select to_char(gs::date, 'YYYY-MM-DD') as day, coalesce(v.cnt, 0) as views
    from generate_series((now() - (p_days || ' days')::interval)::date, now()::date, interval '1 day') gs
    left join (
      select created_at::date as vd, count(*) as cnt
      from public.profile_views
      where viewed_id = v_uid and created_at >= now() - (p_days || ' days')::interval
      group by vd
    ) v on v.vd = gs::date
    order by gs
  ) d;

  return json_build_object(
    'total_views', v_total,
    'follower_views', v_follower_views,
    'non_follower_views', greatest(v_total - v_follower_views, 0),
    'series', v_series
  );
end;
$$;
grant execute on function public.get_profile_view_stats(integer) to authenticated;

-- ── 4. get_follower_growth(p_days) — Overview + Audience tabs ─
-- New followers gained per day, from follows.created_at. This can
-- only show growth, not net change — this schema has no unfollow
-- log, follows.delete() just removes the row — so it's framed as
-- "new followers" throughout the UI, not "net followers".
create or replace function public.get_follower_growth(p_days integer default 30)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_new integer;
  v_series json;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  select count(*) into v_new
    from public.follows
    where followee_id = v_uid and created_at >= now() - (p_days || ' days')::interval;

  select coalesce(json_agg(row_to_json(d)), '[]'::json) into v_series
  from (
    select to_char(gs::date, 'YYYY-MM-DD') as day, coalesce(f.cnt, 0) as new_followers
    from generate_series((now() - (p_days || ' days')::interval)::date, now()::date, interval '1 day') gs
    left join (
      select created_at::date as fd, count(*) as cnt
      from public.follows
      where followee_id = v_uid and created_at >= now() - (p_days || ' days')::interval
      group by fd
    ) f on f.fd = gs::date
    order by gs
  ) d;

  return json_build_object('new_followers', v_new, 'series', v_series);
end;
$$;
grant execute on function public.get_follower_growth(integer) to authenticated;

-- ── 5. get_audience_demographics() — Audience tab ───────────
-- Gender / age / country breakdown of the caller's CURRENT followers.
-- Straight from profiles — a follower who never set a given field
-- just doesn't count toward any bucket for that dimension (no
-- fabricated "unknown" slice).
create or replace function public.get_audience_demographics()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_total integer;
  v_gender json;
  v_age json;
  v_country json;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  select count(*) into v_total from public.follows where followee_id = v_uid;

  select coalesce(json_agg(row_to_json(g)), '[]'::json) into v_gender
  from (
    select p.gender, count(*) as cnt
    from public.follows f join public.profiles p on p.id = f.follower_id
    where f.followee_id = v_uid and p.gender is not null
    group by p.gender
    order by cnt desc
  ) g;

  select coalesce(json_agg(row_to_json(a)), '[]'::json) into v_age
  from (
    select case
      when p.age between 13 and 17 then '13-17'
      when p.age between 18 and 24 then '18-24'
      when p.age between 25 and 34 then '25-34'
      when p.age between 35 and 44 then '35-44'
      when p.age between 45 and 54 then '45-54'
      when p.age between 55 and 64 then '55-64'
      when p.age >= 65 then '65+'
      else null
    end as bucket, count(*) as cnt
    from public.follows f join public.profiles p on p.id = f.follower_id
    where f.followee_id = v_uid and p.age is not null
    group by bucket
    having case
      when p.age between 13 and 17 then '13-17'
      when p.age between 18 and 24 then '18-24'
      when p.age between 25 and 34 then '25-34'
      when p.age between 35 and 44 then '35-44'
      when p.age between 45 and 54 then '45-54'
      when p.age between 55 and 64 then '55-64'
      when p.age >= 65 then '65+'
      else null
    end is not null
    order by bucket
  ) a;

  select coalesce(json_agg(row_to_json(c)), '[]'::json) into v_country
  from (
    select p.country, count(*) as cnt
    from public.follows f join public.profiles p on p.id = f.follower_id
    where f.followee_id = v_uid and p.country is not null
    group by p.country
    order by cnt desc
    limit 10
  ) c;

  return json_build_object('total_followers', v_total, 'gender', v_gender, 'age', v_age, 'countries', v_country);
end;
$$;
grant execute on function public.get_audience_demographics() to authenticated;

-- ── 6. get_active_times(p_days) — Audience tab ──────────────
-- Raw UTC timestamps of views on the caller's profile (capped at
-- 5000 most recent) so js/insights.js can bucket by day-of-week and
-- hour in the *viewer's own browser* timezone — same "Based on your
-- current time zone" framing as the reference screenshots. Bucketing
-- happens client-side rather than in SQL because Postgres has no way
-- to know the browser's timezone.
create or replace function public.get_active_times(p_days integer default 30)
returns table(viewed_at timestamptz)
language sql
stable
security definer
set search_path = public
as $$
  select created_at from public.profile_views
  where viewed_id = auth.uid() and created_at >= now() - (p_days || ' days')::interval
  order by created_at desc
  limit 5000;
$$;
grant execute on function public.get_active_times(integer) to authenticated;

-- ── 7. get_content_view_totals() — Overview tab ─────────────
-- Sums the view_count columns view_counts.sql already maintains on
-- posts/replies. A running total, not a time series — this project
-- doesn't log a timestamp per post/reply view, only an incrementing
-- counter, so there's nothing to bucket by day for this one.
create or replace function public.get_content_view_totals()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_posts integer;
  v_replies integer;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  select coalesce(sum(view_count), 0) into v_posts from public.posts where author_id = v_uid and is_deleted = false;
  select coalesce(sum(view_count), 0) into v_replies from public.replies where author_id = v_uid and is_deleted = false;

  return json_build_object('post_views', v_posts, 'reply_views', v_replies, 'total', v_posts + v_replies);
end;
$$;
grant execute on function public.get_content_view_totals() to authenticated;


-- ────────────────────────────────────────────────────────────
-- Part 2: viewer locations, engagement totals, top posts
-- ────────────────────────────────────────────────────────────

-- ANALYTICS — ENGAGEMENT & TOP POSTS (Insights page, part 2)
--
-- Extends supabase/analytics_setup.sql with three more RPCs the
-- expanded Insights page uses:
--   get_viewer_locations(p_days)  -> country breakdown of PROFILE
--                                    VIEWERS (not just followers),
--                                    from profile_views.country
--   get_engagement_totals(p_days) -> likes/reposts/saves/comments
--                                    received across your posts
--                                    (p_days null = lifetime)
--   get_top_posts(p_period)       -> your top 3 posts by engagement
--                                    in the last 7 days ('week') or
--                                    30 days ('month')
-- All owner-only via auth.uid(), same pattern as analytics_setup.sql.
--
-- ASSUMPTIONS FLAGGED (adjust if your schema differs — same spirit
-- as recommendation_engine.sql's flagged assumptions):
--   - public.likes has (post_id nullable, reply_id nullable, user_id,
--     created_at), per likes_full_fix.sql.
--   - public.reposts and public.bookmarks each have (post_id,
--     user_id, created_at) and only ever attach to posts, not
--     replies — true everywhere else in this schema (recommendation_
--     engine.sql joins both straight to posts).
--   - public.posts has body, author_id, is_deleted, view_count.
--   - "Comments received" counts public.replies rows on your posts
--     (is_deleted = false), regardless of who wrote them.
--
-- NOT INCLUDED — Shares: nothing in this schema logs a share event.
-- profileMenuShare() / the post share button only open the native
-- share sheet or copy a link client-side; there's no shares table to
-- count from, and most share-sheet APIs don't reliably report
-- "the user actually sent it" even if we started logging today. If
-- you want a real Shares number later, that needs a new event table
-- fed from js/common.js's share functions — flagging it here rather
-- than faking a number from something else.
--
-- NOTE — Post-level views can't be split into "this week" / "this
-- month": view_counts.sql only keeps a running total per post, not
-- a per-view timestamp, so get_top_posts()'s score below is built
-- from likes/reposts/comments/saves (all timestamped) and each
-- post's lifetime view_count is returned alongside for context only,
-- not used in the period ranking itself.
--
-- Run after analytics_setup.sql. Additive/idempotent — safe to re-run.
-- ============================================================

-- ── get_viewer_locations(p_days) — where your profile viewers are from ──
create or replace function public.get_viewer_locations(p_days integer default 30)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_result json;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  select coalesce(json_agg(row_to_json(c)), '[]'::json) into v_result
  from (
    select country, count(*) as cnt
    from public.profile_views
    where viewed_id = v_uid
      and created_at >= now() - (p_days || ' days')::interval
      and country is not null
    group by country
    order by cnt desc
    limit 10
  ) c;

  return v_result;
end;
$$;
grant execute on function public.get_viewer_locations(integer) to authenticated;

-- ── get_engagement_totals(p_days) — likes/reposts/saves/comments received ──
-- p_days null = all-time. Any positive integer = trailing window.
create or replace function public.get_engagement_totals(p_days integer default null)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_since timestamptz := case when p_days is null then '-infinity'::timestamptz
                               else now() - (p_days || ' days')::interval end;
  v_likes integer;
  v_reposts integer;
  v_saves integer;
  v_comments integer;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  select count(*) into v_likes
  from public.likes l
  where l.created_at >= v_since
    and (
      exists(select 1 from public.posts p where p.id = l.post_id and p.author_id = v_uid)
      or exists(select 1 from public.replies r where r.id = l.reply_id and r.author_id = v_uid)
    );

  select count(*) into v_reposts
  from public.reposts rp join public.posts p on p.id = rp.post_id
  where p.author_id = v_uid and rp.created_at >= v_since;

  select count(*) into v_saves
  from public.bookmarks b join public.posts p on p.id = b.post_id
  where p.author_id = v_uid and b.created_at >= v_since;

  select count(*) into v_comments
  from public.replies r join public.posts p on p.id = r.post_id
  where p.author_id = v_uid and r.is_deleted = false and r.created_at >= v_since;

  return json_build_object('likes', v_likes, 'reposts', v_reposts, 'saves', v_saves, 'comments', v_comments);
end;
$$;
grant execute on function public.get_engagement_totals(integer) to authenticated;

-- ── get_top_posts(p_period) — your top 3 posts this week / month ──
-- Score = likes*1 + reposts*3 + comments*4 + saves*2 (comments/
-- reposts/saves all imply more effort than a like, same weighting
-- spirit as recommendation_engine.sql's affinity scoring), counting
-- only engagement events that landed within the window — so a post
-- from months ago that's suddenly getting attention again shows up,
-- not just recently-published posts.
create or replace function public.get_top_posts(p_period text default 'week')
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_days integer := case when lower(coalesce(p_period, 'week')) = 'month' then 30 else 7 end;
  v_since timestamptz := now() - (v_days || ' days')::interval;
  v_result json;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  with scored as (
    select
      p.id,
      left(p.body, 140) as snippet,
      p.created_at,
      p.view_count,
      coalesce(lk.cnt, 0) as likes,
      coalesce(rp.cnt, 0) as reposts,
      coalesce(cm.cnt, 0) as comments,
      coalesce(sv.cnt, 0) as saves,
      (coalesce(lk.cnt, 0) * 1 + coalesce(rp.cnt, 0) * 3 + coalesce(cm.cnt, 0) * 4 + coalesce(sv.cnt, 0) * 2) as score
    from public.posts p
    left join (select post_id, count(*) cnt from public.likes where post_id is not null and created_at >= v_since group by post_id) lk on lk.post_id = p.id
    left join (select post_id, count(*) cnt from public.reposts where created_at >= v_since group by post_id) rp on rp.post_id = p.id
    left join (select post_id, count(*) cnt from public.replies where is_deleted = false and created_at >= v_since group by post_id) cm on cm.post_id = p.id
    left join (select post_id, count(*) cnt from public.bookmarks where created_at >= v_since group by post_id) sv on sv.post_id = p.id
    where p.author_id = v_uid and p.is_deleted = false
  )
  select coalesce(json_agg(row_to_json(s)), '[]'::json) into v_result
  from (select * from scored where score > 0 order by score desc, created_at desc limit 3) s;

  return v_result;
end;
$$;
grant execute on function public.get_top_posts(text) to authenticated;


-- ────────────────────────────────────────────────────────────
-- Part 3: video watch time, mentions, period comparisons
-- ────────────────────────────────────────────────────────────

-- ANALYTICS — VIDEO WATCH TIME, MENTIONS, PERIOD COMPARISON
-- (Insights page, part 3)
--
-- Adds three more owner-only RPCs on top of analytics_setup.sql and
-- analytics_engagement.sql:
--   get_video_watch_stats()     -> total/avg watch time + top videos
--   get_mentions_count(p_days)  -> @mentions received, lifetime + window
--   get_prior_period_totals(p_days) -> the SAME metrics
--       get_profile_view_stats/get_follower_growth/get_engagement_totals
--       already return, but for the equal-length window immediately
--       BEFORE the current one — so the client can show "▲18% vs
--       last period" next to each stat tile instead of a bare number.
--
-- ASSUMPTIONS FLAGGED:
--   - Video watch time comes entirely from public.post_watch_events.
--     Only posts a viewer actually played video on ever get a row
--     there, so "posts with any watch-time row" doubles as "your
--     video posts" — there's no separate is_video/media_type flag
--     to check.
--   - No video duration is stored anywhere (js/video-player.js reads
--     it live from the <video> element, never persists it), so this
--     can only report total/average watched time, not a completion
--     percentage. Flagging rather than estimating one.
--
-- Run after analytics_setup.sql and analytics_engagement.sql.
-- Additive/idempotent — safe to re-run.
-- ============================================================

-- ── post_watch_events + record_watch_time() ──
-- get_video_watch_stats() below reads this table, so it has to exist
-- even if recommendation_engine.sql was never run — this file's whole
-- point is that you shouldn't have to track down which other .sql
-- happens to define a dependency. Identical to the copy in
-- recommendation_engine.sql; if you've already run that file this is
-- a no-op (create table if not exists / create or replace function),
-- and if you run recommendation_engine.sql later it's a no-op there
-- too, so it's safe to have both.
create table if not exists public.post_watch_events (
  viewer_id  uuid not null references public.profiles(id) on delete cascade,
  post_id    uuid not null references public.posts(id) on delete cascade,
  watched_ms integer not null default 0,
  updated_at timestamptz not null default now(),
  primary key (viewer_id, post_id)
);

alter table public.post_watch_events enable row level security;

do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'post_watch_events'
  loop
    execute format('drop policy %I on public.post_watch_events', pol.policyname);
  end loop;
end $$;

create policy "watch events viewable by owner"
  on public.post_watch_events for select
  using (auth.uid() = viewer_id);

-- No insert/update policy — every write goes through
-- record_watch_time() (security definer) below.
create or replace function public.record_watch_time(p_post_id uuid, p_ms integer)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  clamped integer;
begin
  if auth.uid() is null then return; end if;
  clamped := greatest(0, least(coalesce(p_ms, 0), 30000));
  if clamped = 0 or p_post_id is null then return; end if;

  insert into public.post_watch_events (viewer_id, post_id, watched_ms, updated_at)
  values (auth.uid(), p_post_id, clamped, now())
  on conflict (viewer_id, post_id) do update
    set watched_ms = public.post_watch_events.watched_ms + excluded.watched_ms,
        updated_at = now();
end;
$$;
grant execute on function public.record_watch_time(uuid, integer) to authenticated;

-- ── get_video_watch_stats() — total/avg watch time + top 3 videos ──
create or replace function public.get_video_watch_stats()
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_total_ms bigint;
  v_viewers integer;
  v_top json;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  select coalesce(sum(w.watched_ms), 0), count(distinct w.viewer_id)
    into v_total_ms, v_viewers
  from public.post_watch_events w
  join public.posts p on p.id = w.post_id
  where p.author_id = v_uid and p.is_deleted = false;

  select coalesce(json_agg(row_to_json(t)), '[]'::json) into v_top
  from (
    select
      p.id,
      left(p.body, 140) as snippet,
      sum(w.watched_ms) as total_ms,
      count(distinct w.viewer_id) as viewers
    from public.post_watch_events w
    join public.posts p on p.id = w.post_id
    where p.author_id = v_uid and p.is_deleted = false
    group by p.id, p.body
    order by total_ms desc
    limit 3
  ) t;

  return json_build_object(
    'total_watch_ms', v_total_ms,
    'viewers', v_viewers,
    'avg_ms_per_viewer', case when v_viewers > 0 then round(v_total_ms::numeric / v_viewers) else 0 end,
    'top_videos', v_top
  );
end;
$$;
grant execute on function public.get_video_watch_stats() to authenticated;

-- ── get_mentions_count(p_days) — @mentions received ──
create or replace function public.get_mentions_count(p_days integer default 30)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_total integer;
  v_period integer;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  select count(*) into v_total
  from public.notifications
  where user_id = v_uid and type = 'mention';

  select count(*) into v_period
  from public.notifications
  where user_id = v_uid and type = 'mention' and created_at >= now() - (p_days || ' days')::interval;

  return json_build_object('total', v_total, 'period', v_period);
end;
$$;
grant execute on function public.get_mentions_count(integer) to authenticated;

-- ── get_prior_period_totals(p_days) — for period-over-period deltas ──
-- Same metrics as get_profile_view_stats/get_follower_growth/
-- get_engagement_totals, but for [now - 2*p_days, now - p_days) —
-- the window immediately before the one those RPCs already cover —
-- so the client can compute a % change without a second round trip
-- per metric.
create or replace function public.get_prior_period_totals(p_days integer default 30)
returns json
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_start timestamptz := now() - ((p_days * 2) || ' days')::interval;
  v_end timestamptz := now() - (p_days || ' days')::interval;
  v_views integer;
  v_followers integer;
  v_likes integer;
  v_reposts integer;
  v_comments integer;
  v_saves integer;
  v_mentions integer;
begin
  if v_uid is null then raise exception 'not authorized'; end if;

  select count(*) into v_views
  from public.profile_views
  where viewed_id = v_uid and created_at >= v_start and created_at < v_end;

  select count(*) into v_followers
  from public.follows
  where followee_id = v_uid and created_at >= v_start and created_at < v_end;

  select count(*) into v_likes
  from public.likes l
  where l.created_at >= v_start and l.created_at < v_end
    and (
      exists(select 1 from public.posts p where p.id = l.post_id and p.author_id = v_uid)
      or exists(select 1 from public.replies r where r.id = l.reply_id and r.author_id = v_uid)
    );

  select count(*) into v_reposts
  from public.reposts rp join public.posts p on p.id = rp.post_id
  where p.author_id = v_uid and rp.created_at >= v_start and rp.created_at < v_end;

  select count(*) into v_comments
  from public.replies r join public.posts p on p.id = r.post_id
  where p.author_id = v_uid and r.is_deleted = false and r.created_at >= v_start and r.created_at < v_end;

  select count(*) into v_saves
  from public.bookmarks b join public.posts p on p.id = b.post_id
  where p.author_id = v_uid and b.created_at >= v_start and b.created_at < v_end;

  select count(*) into v_mentions
  from public.notifications
  where user_id = v_uid and type = 'mention' and created_at >= v_start and created_at < v_end;

  return json_build_object(
    'views', v_views,
    'new_followers', v_followers,
    'likes', v_likes,
    'reposts', v_reposts,
    'comments', v_comments,
    'saves', v_saves,
    'mentions', v_mentions
  );
end;
$$;
grant execute on function public.get_prior_period_totals(integer) to authenticated;


notify pgrst, 'reload schema';
