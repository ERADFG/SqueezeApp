-- ============================================================
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
--   - Video watch time comes entirely from public.post_watch_events
--     (recommendation_engine.sql). Only posts a viewer actually
--     played video on ever get a row there, so "posts with any
--     watch-time row" doubles as "your video posts" — there's no
--     separate is_video/media_type flag to check.
--   - No video duration is stored anywhere (js/video-player.js reads
--     it live from the <video> element, never persists it), so this
--     can only report total/average watched time, not a completion
--     percentage. Flagging rather than estimating one.
--
-- Run after analytics_setup.sql and analytics_engagement.sql.
-- Additive/idempotent — safe to re-run.
-- ============================================================

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
