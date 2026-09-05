-- ============================================================
-- PRIVATE ACCOUNTS — turns the display-only "Private account" flag
-- added in private_account.sql into an actual gate:
--
--   - A private account's posts/replies are hidden from everyone
--     except the account itself and its accepted followers (profile
--     header — avatar/bio/stats/lock icon — stays visible, same as
--     Instagram/X: you can tell whose profile it is, you just can't
--     see what they've posted).
--   - Following a private account no longer follows instantly —
--     it creates a pending follow_requests row instead. The target
--     gets a notification with Accept/Decline actions
--     (js/notifications.js, mirroring the group_invite pattern in
--     supabase/group_invites.sql); js/profile.js shows "Requested"
--     on the follow button in the meantime (tapping it again
--     cancels the request).
--   - Accepting inserts the real public.follows row and notifies the
--     requester; declining/canceling just deletes the request row.
--
-- Run AFTER supabase/private_account.sql. Safe to re-run — every
-- statement is idempotent.
-- ============================================================

-- ── 1. follow_requests table ──
-- One pending row per (requester, target) pair — accepting or
-- declining deletes it rather than tracking a status column, since
-- nothing needs to remember a resolved request (js/notifications.js
-- derives "accepted" vs "declined" for display by checking
-- public.follows for the row's absence, same idea as
-- inviteConvIds/statusByConv in js/notifications.js's
-- loadNotifications()).
create table if not exists public.follow_requests (
  requester_id uuid not null references public.profiles(id) on delete cascade,
  target_id    uuid not null references public.profiles(id) on delete cascade,
  created_at   timestamptz not null default now(),
  primary key (requester_id, target_id)
);
create index if not exists follow_requests_target_idx on public.follow_requests(target_id);

alter table public.follow_requests enable row level security;

-- Either side of a request can see it (requester needs this to show
-- "Requested" on the follow button; target needs it for the
-- notification's Accept/Decline state). No INSERT policy on
-- purpose — every request is created through request_follow() below
-- so the private-account check always happens server-side, never
-- trusted from the client.
drop policy if exists "follow_requests_select" on public.follow_requests;
create policy "follow_requests_select" on public.follow_requests
  for select to authenticated
  using (requester_id = auth.uid() or target_id = auth.uid());

-- Either side can remove it: the requester canceling, or the target
-- declining. Both are plain deletes from the client — no RPC needed,
-- same reasoning as conversation_members_delete_self covering
-- group-invite decline in supabase/group_invites.sql.
drop policy if exists "follow_requests_delete" on public.follow_requests;
create policy "follow_requests_delete" on public.follow_requests
  for delete to authenticated
  using (requester_id = auth.uid() or target_id = auth.uid());

-- ── 2. Notify the target when a request comes in ──
create or replace function public.notify_follow_request()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.notifications (user_id, actor_id, type, read, created_at)
  values (new.target_id, new.requester_id, 'follow_request', false, now());
  return new;
end;
$$;

drop trigger if exists trg_notify_follow_request on public.follow_requests;
create trigger trg_notify_follow_request
  after insert on public.follow_requests
  for each row execute function public.notify_follow_request();

-- ── 3. request_follow() — what the Follow button actually calls now ──
-- Replaces a plain `insert into follows` from the client for the
-- "not already following" case (js/common.js's followUser() is still
-- used for the direct-unfollow path, which never needs a privacy
-- check). Server-side because whether the target is private can't be
-- trusted from the client: it looks the target up itself and either
-- follows immediately (public account) or drops a pending request
-- (private account), returning which one happened so the button
-- knows whether to show "Following" or "Requested".
create or replace function public.request_follow(target_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  me      uuid := auth.uid();
  is_priv boolean;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if me = target_id then raise exception 'cannot follow yourself'; end if;

  if exists (
    select 1 from public.blocks
    where (blocker_id = me and blocked_id = target_id)
       or (blocker_id = target_id and blocked_id = me)
  ) then
    raise exception 'cannot follow this account';
  end if;

  select is_private into is_priv from public.profiles where id = target_id;
  if is_priv is null then raise exception 'account not found'; end if;

  if exists (select 1 from public.follows where follower_id = me and followee_id = target_id) then
    return 'followed';
  end if;

  if not is_priv then
    insert into public.follows (follower_id, followee_id) values (me, target_id)
      on conflict do nothing;
    return 'followed';
  end if;

  insert into public.follow_requests (requester_id, target_id) values (me, target_id)
    on conflict (requester_id, target_id) do nothing;
  return 'requested';
end;
$$;

revoke all on function public.request_follow(uuid) from public, anon;
grant execute on function public.request_follow(uuid) to authenticated;

-- ── 4. accept_follow_request() ──
-- Needs to be an RPC (unlike decline/cancel above): accepting has to
-- insert into follows with follower_id = the REQUESTER, not
-- auth.uid(), which no client-safe RLS policy on follows should ever
-- allow directly.
create or replace function public.accept_follow_request(p_requester_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  me uuid := auth.uid();
begin
  if me is null then raise exception 'not authenticated'; end if;
  if not exists (
    select 1 from public.follow_requests
    where requester_id = p_requester_id and target_id = me
  ) then
    raise exception 'no pending request from that account';
  end if;

  insert into public.follows (follower_id, followee_id) values (p_requester_id, me)
    on conflict do nothing;
  delete from public.follow_requests where requester_id = p_requester_id and target_id = me;

  insert into public.notifications (user_id, actor_id, type, read, created_at)
  values (p_requester_id, me, 'follow_request_accepted', false, now());
end;
$$;

revoke all on function public.accept_follow_request(uuid) from public, anon;
grant execute on function public.accept_follow_request(uuid) to authenticated;

-- ── 5. Going public clears out the waiting list ──
-- Flipping the Settings toggle off (js/settings.js's
-- saveAccountPrivacy()) means every pending requester was already
-- trying to follow — same as Instagram, they're waved through rather
-- than left stuck in limbo until re-requesting.
create or replace function public.handle_private_account_disabled()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.is_private and not new.is_private then
    insert into public.follows (follower_id, followee_id)
    select fr.requester_id, fr.target_id
    from public.follow_requests fr
    where fr.target_id = new.id
    on conflict do nothing;

    delete from public.follow_requests where target_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_private_account_disabled on public.profiles;
create trigger trg_private_account_disabled
  after update of is_private on public.profiles
  for each row execute function public.handle_private_account_disabled();

-- ── 6. Blocking cleans up pending requests too ──
-- Re-creates handle_block_insert() from supabase/profile_extras.sql
-- with the same @marpe guard and follows-cleanup it already had,
-- plus clearing out any follow_requests row either direction so a
-- block doesn't leave a stale pending request sitting behind it.
create or replace function public.handle_block_insert()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if exists (
    select 1 from public.profiles
    where id = new.blocked_id and lower(username) = 'marpe'
  ) then
    raise exception 'You can''t block @marpe.';
  end if;

  delete from public.follows
  where (follower_id = new.blocker_id and followee_id = new.blocked_id)
     or (follower_id = new.blocked_id and followee_id = new.blocker_id);

  delete from public.follow_requests
  where (requester_id = new.blocker_id and target_id = new.blocked_id)
     or (requester_id = new.blocked_id and target_id = new.blocker_id);

  return new;
end;
$$;

drop trigger if exists trg_block_insert on public.blocks;
create trigger trg_block_insert
  before insert on public.blocks
  for each row execute function public.handle_block_insert();

-- ── 7. The actual gate — posts/replies hidden from non-followers ──
-- RESTRICTIVE, not a normal (permissive) policy: permissive policies
-- OR together, so a new one can only ever widen access. This one
-- needs to narrow it instead, on top of whatever the existing
-- permissive SELECT policies on these tables already allow, so it's
-- declared `as restrictive` — it ANDs with everything else regardless
-- of how those existing policies read.
drop policy if exists "posts_select_private_gate" on public.posts;
create policy "posts_select_private_gate" on public.posts
  as restrictive
  for select
  using (
    author_id = auth.uid()
    or not exists (select 1 from public.profiles pa where pa.id = posts.author_id and pa.is_private)
    or exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.followee_id = posts.author_id)
  );

drop policy if exists "replies_select_private_gate" on public.replies;
create policy "replies_select_private_gate" on public.replies
  as restrictive
  for select
  using (
    author_id = auth.uid()
    or not exists (select 1 from public.profiles pa where pa.id = replies.author_id and pa.is_private)
    or exists (select 1 from public.follows f where f.follower_id = auth.uid() and f.followee_id = replies.author_id)
  );
-- Note: profiles.posts_count is a denormalized column and stays
-- visible on a private profile's header either way (matching the
-- reference apps — the count shows, the content doesn't). The one
-- knock-on effect: loadReplyCountIntoStat() in js/profile.js adds a
-- LIVE reply count on top of that column for whoever's viewing, so a
-- non-follower viewing a private profile will see just the post
-- count with no reply add-on, since this policy now hides those rows
-- from their query. Not a privacy bug, just a slightly lower number
-- than what an accepted follower sees.

-- ── 8. get_for_you_feed() — SECURITY DEFINER bypasses RLS entirely ──
-- Same reason this function already hand-filters public.blocks and
-- public.mutes below instead of relying on posts' own RLS: a
-- SECURITY DEFINER function runs as its owner, which bypasses RLS on
-- every table it touches, restrictive policies included. Re-created
-- in full (see supabase/for_you_feed.sql) with one more condition
-- added alongside the existing block/mute checks.
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
        public._for_you_has_interacted(viewer, p.author_id)
      ) as _score
    from public.posts p
    where p.is_deleted = false
      and (p.scheduled_at is null or p.scheduled_at <= now())
      and (viewer is null or not exists(select 1 from public.blocks b where b.blocker_id = viewer and b.blocked_id = p.author_id))
      and (viewer is null or not exists(select 1 from public.mutes m where m.muter_id = viewer and m.muted_id = p.author_id))
      and (
        p.author_id = viewer
        or not exists(select 1 from public.profiles pa where pa.id = p.author_id and pa.is_private)
        or exists(select 1 from public.follows f2 where f2.follower_id = viewer and f2.followee_id = p.author_id)
      )
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
