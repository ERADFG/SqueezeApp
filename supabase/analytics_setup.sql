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

notify pgrst, 'reload schema';
