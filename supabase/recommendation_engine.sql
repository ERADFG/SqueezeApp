-- ============================================================
-- RECOMMENDATION ENGINE — personalized "For You" ranking +
-- real "Who to follow" suggestions, both driven by one idea: how
-- much affinity a viewer has built up with a given author from
-- likes, comments, reposts, bookmarks (saves), and video watch
-- time — not just a flat "did you interact in the last 30 days,
-- yes/no" the old for_you_feed.sql used.
--
-- Ships three pieces:
--
--   1. post_watch_events + record_watch_time() — nothing tracked
--      per-user watch time before this. view_count (view_counts.sql)
--      is just a +1-per-view counter with no duration attached, so
--      "watches a lot" had no signal to read from. The client
--      reports accumulated playback time in small increments (see
--      js/video-player.js) and this table sums it per viewer+post.
--
--   2. _viewer_author_affinity(viewer, author) — one function that
--      turns every signal a viewer has sent toward one author into
--      a single number. Each signal type is weighted by how much
--      effort/intent it implies (like < repost < comment < save),
--      and every individual event is recency-decayed on a 14-day
--      half-life — something you engaged with yesterday counts for
--      a lot more than the same thing from two months ago, so the
--      score tracks *current* taste rather than a lifetime tally.
--
--   3. get_for_you_feed() now blends this continuous affinity into
--      ranking instead of the old flat +6 "interacted, yes/no"
--      bonus. get_suggested_accounts() is new — it recommends
--      accounts two ways and blends both:
--        - direct: accounts you already engage with a lot (comment
--          on, save, watch) but haven't actually followed yet
--        - collaborative: accounts followed by *other* viewers whose
--          taste overlaps with yours (people who engage with the
--          same authors you do) — this is the part that surfaces
--          genuinely new accounts you've never touched, the same
--          "people who liked this also follow…" idea behind most
--          real feed recommenders
--      Cold-start viewers (no signals yet — brand new accounts) get
--      nothing from either branch; js/common.js's renderWhoToFollow()
--      falls back to the old recently-active-accounts query in that
--      case, so the box is never just empty.
--
-- ASSUMPTIONS FLAGGED (same spirit as for_you_feed.sql's own flagged
-- assumption about likes.created_at):
--   - public.bookmarks is assumed to have a `created_at` column, same
--     as every other event/junction table in this schema (likes,
--     replies, reposts, follows all do). If yours doesn't, drop the
--     `power(0.5, ...)` decay term on the bookmarks branch below and
--     just use the flat 8.0 weight.
--   - public.reposts is assumed to have (user_id, post_id,
--     created_at) — already relied on by for_you_feed.sql itself.
--
-- Run in the Supabase SQL Editor after for_you_feed.sql and
-- view_counts.sql. Additive/idempotent — safe to re-run.
-- ============================================================

-- ── 1. WATCH-TIME TRACKING ──

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

-- Read-only for the owner (nobody needs to read anyone else's watch
-- history directly — the affinity/suggestion functions below read it
-- via security definer instead, bypassing RLS on purpose the same
-- way get_for_you_feed already reads every author's posts).
create policy "watch events viewable by owner"
  on public.post_watch_events for select
  using (auth.uid() = viewer_id);

-- No insert/update policy at all — every write goes through
-- record_watch_time() (security definer) below, so a client can
-- never report time against someone else's account or forge an
-- arbitrarily large duration in a single call.

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
  -- The player flushes every few seconds of real playback (see
  -- js/video-player.js's ttv-watch tracker), so no legitimate call
  -- should ever report more than ~30s in one shot. Clamping here
  -- means even a hand-crafted request can't inflate one post's
  -- watch time arbitrarily.
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

-- ── 2. PER-AUTHOR AFFINITY ──

create or replace function public._viewer_author_affinity(
  p_viewer uuid,
  p_author uuid
) returns double precision
language sql stable as $$
  select coalesce(sum(weight), 0) from (
    -- Likes — lightest-effort signal, lowest weight.
    select 3.0 * power(0.5, extract(epoch from (now() - l.created_at)) / 86400.0 / 14.0) as weight
      from public.likes l join public.posts p on p.id = l.post_id
     where l.user_id = p_viewer and p.author_id = p_author and p.is_deleted = false
    union all
    -- Comments (replies) — took actual effort to write.
    select 6.0 * power(0.5, extract(epoch from (now() - r.created_at)) / 86400.0 / 14.0)
      from public.replies r join public.posts p on p.id = r.post_id
     where r.author_id = p_viewer and p.author_id = p_author and p.is_deleted = false
    union all
    -- Reposts — sharing to your own followers, stronger than a like.
    select 5.0 * power(0.5, extract(epoch from (now() - rp.created_at)) / 86400.0 / 14.0)
      from public.reposts rp join public.posts p on p.id = rp.post_id
     where rp.user_id = p_viewer and p.author_id = p_author and p.is_deleted = false
    union all
    -- Bookmarks (saves) — "I want to come back to this", the
    -- clearest explicit signal short of following outright.
    select 8.0 * power(0.5, extract(epoch from (now() - b.created_at)) / 86400.0 / 14.0)
      from public.bookmarks b join public.posts p on p.id = b.post_id
     where b.user_id = p_viewer and p.author_id = p_author and p.is_deleted = false
    union all
    -- Watch time — continuous, not flat: ln(1 + seconds) so the
    -- first minute matters far more than the fifth, capped at 5
    -- minutes per post so one binge-watched video can't outweigh
    -- every other signal here.
    select ln(1 + least(w.watched_ms, 300000) / 1000.0) * 2.0
         * power(0.5, extract(epoch from (now() - w.updated_at)) / 86400.0 / 14.0)
      from public.post_watch_events w join public.posts p on p.id = w.post_id
     where w.viewer_id = p_viewer and p.author_id = p_author and p.is_deleted = false
  ) s
$$;

-- ── 3a. FOR YOU FEED — same signature as for_you_feed.sql, ranking
-- body updated to blend in continuous affinity instead of the old
-- flat has-interacted boolean. ──

create or replace function public._for_you_score(
  p_created_at   timestamptz,
  p_like_count   integer,
  p_reply_count  integer,
  p_repost_count integer,
  p_view_count   integer,
  p_is_followed  boolean,
  p_affinity     double precision default 0
) returns double precision
language sql stable as $$
  select
    (100.0 / (1.0 + (extract(epoch from (now() - p_created_at)) / 3600.0) / 18.0))
    + (ln(1 + greatest(coalesce(p_like_count, 0), 0))   * 2.0)
    + (ln(1 + greatest(coalesce(p_reply_count, 0), 0))  * 3.0)
    + (ln(1 + greatest(coalesce(p_repost_count, 0), 0)) * 3.5)
    + (ln(1 + greatest(coalesce(p_view_count, 0), 0))   * 0.4)
    + (case when p_is_followed then 18.0 else 0.0 end)
    -- Capped at 25 so one author you've gone all-in on can't crowd
    -- out everything else in the feed, but noticeably more than the
    -- old flat +6 "interacted at all" bonus for someone you
    -- genuinely like/reply-to/save/watch a lot.
    + least(greatest(coalesce(p_affinity, 0), 0), 25.0)
$$;

create or replace function public.get_for_you_feed(
  viewer uuid,
  limit_n integer default 20,
  after_id uuid default null,
  recent_author_1 uuid default null,
  recent_author_2 uuid default null
) returns setof public.posts
language plpgsql security definer set search_path = public as $$
declare
  anchor_score   double precision;
  page_size      integer;
  candidate_n    integer;
  last_author1   uuid := recent_author_1;
  last_author2   uuid := recent_author_2;
  rec            record;
  emitted        integer := 0;
begin
  page_size   := greatest(1, least(coalesce(limit_n, 20), 50));
  candidate_n := least(page_size * 8, 400);

  if after_id is not null then
    select public._for_you_score(
             p.created_at, p.like_count, p.reply_count, p.repost_count, p.view_count,
             exists(select 1 from public.follows f where f.follower_id = viewer and f.followee_id = p.author_id),
             public._viewer_author_affinity(viewer, p.author_id)
           )
      into anchor_score
      from public.posts p
     where p.id = after_id;

    if anchor_score is null then
      return;
    end if;
  end if;

  create temporary table if not exists _fy_candidates (
    ord       integer primary key,
    post_row  public.posts,
    author_id uuid,
    used      boolean not null default false
  ) on commit drop;
  delete from _fy_candidates where true;

  insert into _fy_candidates (ord, post_row, author_id)
  select row_number() over (order by c._score desc, c.id desc), c.post_row, c.author_id
  from (
    select
      p as post_row,
      p.id,
      p.author_id,
      public._for_you_score(
        p.created_at, p.like_count, p.reply_count, p.repost_count, p.view_count,
        exists(select 1 from public.follows f where f.follower_id = viewer and f.followee_id = p.author_id),
        public._viewer_author_affinity(viewer, p.author_id)
      ) as _score
    from public.posts p
    where p.is_deleted = false
      and (p.scheduled_at is null or p.scheduled_at <= now())
      and (viewer is null or not exists(select 1 from public.blocks b where b.blocker_id = viewer and b.blocked_id = p.author_id))
      and (viewer is null or not exists(select 1 from public.mutes m where m.muter_id = viewer and m.muted_id = p.author_id))
  ) c
  where after_id is null
     or c._score < anchor_score
     or (c._score = anchor_score and c.id < after_id)
  order by c._score desc, c.id desc
  limit candidate_n;

  loop
    exit when emitted >= page_size;

    select c.ord, c.post_row, c.author_id into rec
      from _fy_candidates c
     where not c.used
       and not (last_author1 is not null and last_author1 = last_author2 and c.author_id = last_author1)
     order by c.ord
     limit 1;

    if not found then
      select c.ord, c.post_row, c.author_id into rec
        from _fy_candidates c
       where not c.used
       order by c.ord
       limit 1;
    end if;

    exit when not found;

    update _fy_candidates set used = true where ord = rec.ord;
    return next rec.post_row;
    emitted := emitted + 1;
    last_author2 := last_author1;
    last_author1 := rec.author_id;
  end loop;

  return;
end;
$$;

-- ── 3b. SUGGESTED ACCOUNTS — "Who to follow", backed by the same
-- affinity math instead of "whoever signed up most recently" (the
-- old js/common.js renderWhoToFollow() client-side query). ──

create or replace function public.get_suggested_accounts(
  viewer uuid,
  limit_n integer default 5
) returns table (
  id uuid,
  username text,
  display_name text,
  avatar_url text,
  verified boolean,
  verification_type text,
  reason text
)
language plpgsql security definer set search_path = public as $$
declare
  n integer;
begin
  n := greatest(1, least(coalesce(limit_n, 5), 20));
  if viewer is null then return; end if;

  return query
  with my_signals as (
    select p.author_id,
           3.0 * power(0.5, extract(epoch from (now() - l.created_at)) / 86400.0 / 14.0) as weight
      from public.likes l join public.posts p on p.id = l.post_id
     where l.user_id = viewer and p.is_deleted = false
    union all
    select p.author_id,
           6.0 * power(0.5, extract(epoch from (now() - r.created_at)) / 86400.0 / 14.0)
      from public.replies r join public.posts p on p.id = r.post_id
     where r.author_id = viewer and p.is_deleted = false
    union all
    select p.author_id,
           5.0 * power(0.5, extract(epoch from (now() - rp.created_at)) / 86400.0 / 14.0)
      from public.reposts rp join public.posts p on p.id = rp.post_id
     where rp.user_id = viewer and p.is_deleted = false
    union all
    select p.author_id,
           8.0 * power(0.5, extract(epoch from (now() - b.created_at)) / 86400.0 / 14.0)
      from public.bookmarks b join public.posts p on p.id = b.post_id
     where b.user_id = viewer and p.is_deleted = false
    union all
    select p.author_id,
           ln(1 + least(w.watched_ms, 300000) / 1000.0) * 2.0
             * power(0.5, extract(epoch from (now() - w.updated_at)) / 86400.0 / 14.0)
      from public.post_watch_events w join public.posts p on p.id = w.post_id
     where w.viewer_id = viewer and p.is_deleted = false
  ),
  -- Your top ~50 authors by affinity — "your taste", in short.
  my_affinities as (
    select author_id, sum(weight) as score
      from my_signals
     group by author_id
    having sum(weight) > 0
     order by sum(weight) desc
     limit 50
  ),
  excluded as (
    select viewer as acct_id
    union select followee_id from public.follows where follower_id = viewer
    union select blocked_id from public.blocks where blocker_id = viewer
    union select blocker_id from public.blocks where blocked_id = viewer
    union select muted_id from public.mutes where muter_id = viewer
  ),
  -- Direct: people you already engage with a lot but haven't
  -- actually followed.
  direct as (
    select ma.author_id as acct, ma.score as score, 'You interact with them a lot' as reason
      from my_affinities ma
     where ma.author_id not in (select acct_id from excluded)
  ),
  -- Collaborative: other viewers who engage with the same authors you
  -- do ("neighbors" in taste), weighted by how much overlap they
  -- have with you — then surface accounts *they* follow that you
  -- don't. This is the branch that can recommend someone you've
  -- never touched at all.
  neighbor_overlap as (
    select os.eng_user_id as neighbor_id,
           sum(least(os.weight, ma.score)) as similarity
      from my_affinities ma
      join lateral (
        select l.user_id as eng_user_id, 3.0 as weight
          from public.likes l join public.posts p on p.id = l.post_id
         where p.author_id = ma.author_id and l.user_id <> viewer
        union all
        select r.author_id, 6.0
          from public.replies r join public.posts p on p.id = r.post_id
         where p.author_id = ma.author_id and r.author_id <> viewer
        union all
        select rp.user_id, 5.0
          from public.reposts rp join public.posts p on p.id = rp.post_id
         where p.author_id = ma.author_id and rp.user_id <> viewer
        union all
        select b.user_id, 8.0
          from public.bookmarks b join public.posts p on p.id = b.post_id
         where p.author_id = ma.author_id and b.user_id <> viewer
      ) os on true
     group by os.eng_user_id
     order by sum(least(os.weight, ma.score)) desc
     limit 40
  ),
  collaborative as (
    select f.followee_id as acct,
           sum(no.similarity) * 0.5 as score, -- damped relative to a direct signal
           'People with similar taste follow them' as reason
      from neighbor_overlap no
      join public.follows f on f.follower_id = no.neighbor_id
     where f.followee_id not in (select acct_id from excluded)
     group by f.followee_id
  ),
  combined as (
    select acct, score, reason from direct
    union all
    select acct, score, reason from collaborative
  ),
  ranked as (
    select acct,
           sum(score) as total_score,
           (array_agg(reason order by score desc))[1] as top_reason
      from combined
     group by acct
     order by sum(score) desc
     limit n
  )
  select pr.id, pr.username, pr.display_name, pr.avatar_url, pr.verified, pr.verification_type,
         ranked.top_reason
    from ranked
    join public.profiles pr on pr.id = ranked.acct
   order by ranked.total_score desc;
end;
$$;

grant execute on function public.get_suggested_accounts(uuid, integer) to authenticated;

notify pgrst, 'reload schema';
