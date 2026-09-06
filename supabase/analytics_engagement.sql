-- ============================================================
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

notify pgrst, 'reload schema';
