-- ============================================================
-- FOR YOU FEED — replaces the old plain reverse-chronological
-- get_for_you_feed() with real ranking:
--
--   score = recency decay + engagement (likes/replies/reposts,
--           replies/reposts weighted above likes, views weighted
--           lowest) + affinity (a flat boost for accounts the
--           viewer follows, a smaller one for accounts the viewer
--           has recently liked/replied to/reposted even if not
--           followed)
--
-- ...then a same-author de-clumping pass so no more than 2 posts
-- in a row share an author, without ever dropping a post to do it
-- (see the greedy loop below).
--
-- PAGING: this file switches the RPC from offset-based paging to
-- cursor-based. Offset paging breaks here specifically *because*
-- ranking is now score-based instead of static chronological order:
-- once likes/replies/reposts land on posts between page loads,
-- everyone's score shifts, so "page 2 = rows 21-40" silently skips
-- or repeats rows depending on which way the shifted rows moved.
-- The cursor is just the id of the last post a client has already
-- seen (`after_id`) — this function re-derives that post's own
-- score server-side (from its own stored counts, not from anything
-- the client sends) and only returns posts ranked strictly below
-- it. That's stable no matter how much the ranking underneath has
-- moved, and it has no built-in ceiling — a client can keep passing
-- the new `after_id` forward and keep paging indefinitely.
--
-- `recent_author_1` / `recent_author_2` let a client carry the
-- same-author de-clump state across a page boundary (the last two
-- authors it rendered, most recent first) so a run of the same
-- author can't span two pages of infinite scroll.
--
-- ASSUMPTION FLAGGED: the interaction-affinity helper below assumes
-- `public.likes` has a `created_at` column, matching every other
-- event/junction table in this schema (reposts, replies, follows,
-- list_followers, notifications all do). If your `likes` table
-- doesn't have one, drop the `created_at` predicate in
-- `_for_you_has_interacted()` below (it'll just widen the lookback
-- to "ever liked" instead of "liked in the last 30 days").
--
-- Run in the Supabase SQL Editor after schema.sql and
-- quotes_and_reposts.sql (scoring reads repost_count). Additive/
-- idempotent like the other migrations — safe to re-run.
-- ============================================================

-- Old signature(s) this replaces — drop first since we're changing
-- the offset_n param to after_id (a different function shape as far
-- as Postgres/PostgREST are concerned, not just a body swap).
drop function if exists public.get_for_you_feed(uuid, integer, integer);
drop function if exists public.get_for_you_feed(uuid, integer, uuid, uuid, uuid);

-- ── Scoring: recency decay + engagement + affinity ──
-- Recency uses a half-life-style decay (~18h) instead of a hard
-- cutoff, so a strong older post can still outrank a brand-new,
-- unengaged one rather than every feed being pure "what's newest".
create or replace function public._for_you_score(
  p_created_at   timestamptz,
  p_like_count   integer,
  p_reply_count  integer,
  p_repost_count integer,
  p_view_count   integer,
  p_is_followed  boolean,
  p_has_interacted boolean
) returns double precision
language sql stable as $$
  select
    (100.0 / (1.0 + (extract(epoch from (now() - p_created_at)) / 3600.0) / 18.0))
    + (ln(1 + greatest(coalesce(p_like_count, 0), 0))   * 2.0)
    + (ln(1 + greatest(coalesce(p_reply_count, 0), 0))  * 3.0)
    + (ln(1 + greatest(coalesce(p_repost_count, 0), 0)) * 3.5)
    + (ln(1 + greatest(coalesce(p_view_count, 0), 0))   * 0.4)
    + (case when p_is_followed then 18.0 else 0.0 end)
    + (case when p_has_interacted then 6.0 else 0.0 end)
$$;

-- Has the viewer liked/replied-to/reposted something from this
-- author in the last 30 days? Used for the smaller "not followed,
-- but you keep engaging with them" affinity boost.
create or replace function public._for_you_has_interacted(
  p_viewer uuid,
  p_author uuid
) returns boolean
language sql stable as $$
  select case when p_viewer is null then false else exists(
    select 1 from public.likes l
      join public.posts p on p.id = l.post_id
     where l.user_id = p_viewer and p.author_id = p_author
       and l.created_at > now() - interval '30 days'
    union all
    select 1 from public.replies r
      join public.posts p on p.id = r.post_id
     where r.author_id = p_viewer and p.author_id = p_author
       and r.created_at > now() - interval '30 days'
    union all
    select 1 from public.reposts rp
      join public.posts p on p.id = rp.post_id
     where rp.user_id = p_viewer and p.author_id = p_author
       and rp.created_at > now() - interval '30 days'
  ) end
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
             public._for_you_has_interacted(viewer, p.author_id)
           )
      into anchor_score
      from public.posts p
     where p.id = after_id;

    -- Anchor post no longer exists/visible (deleted since the client
    -- last saw it) — nothing to page relative to, so return nothing
    -- rather than silently restarting the feed from the top.
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
  -- `where true` is not decorative — some Postgres setups (including
  -- this Supabase project) run with a safe-update guard that rejects
  -- any UPDATE/DELETE with no WHERE clause at all, even against a
  -- per-transaction temp table like this one. An unqualified
  -- `delete from _fy_candidates;` throws "DELETE requires a WHERE
  -- clause" every time this function runs, which is what was
  -- surfacing as "Failed to load posts" on every feed load.
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
        public._for_you_has_interacted(viewer, p.author_id)
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

  -- Greedy de-clump pass: walk the score-ordered candidates and emit
  -- the best-scored one remaining, except when that would make a
  -- 3rd consecutive post from the same author — in that case skip to
  -- the next-best candidate from a different author. Never drops a
  -- post; if every remaining candidate would violate the rule (e.g.
  -- only one author has anything left), the rule yields rather than
  -- the page coming up short.
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
