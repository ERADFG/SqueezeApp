-- ============================================================
-- PROFILE EXTRAS — block ⇄ follow sync + @marpe block guard
-- ============================================================
-- This is the file js/common.js already refers to (see the comment
-- above isBlocked()/blockUser()/unblockUser() — "the DB trigger in
-- profile_extras.sql drops any existing follow either direction the
-- moment a block row is inserted"). That trigger was never actually
-- shipped, which is why blocking someone hasn't been unfollowing
-- them. This is that file, plus two things the client-side comment
-- didn't cover:
--
--   1. BLOCK → unfollow both ways. Same as Twitter: the moment you
--      block someone, any follow relationship between the two of
--      you — either direction — is deleted.
--   2. UNBLOCK does NOT re-follow. Lifting a block just lifts the
--      block — it does not make you follow that person again. An
--      earlier version of this file shipped a trigger that did
--      re-follow on unblock; that was wrong (confusing — "why am I
--      suddenly following this person again?") and has been removed.
--      See fix_unblock_no_refollow.sql for the migration that drops
--      it on a database that already has it.
--   3. Nobody can block @marpe. Same idea as the existing
--      unfollow-lock on @marpe (see PROTECTED_FOLLOW_USERNAME in
--      common.js / the "users can unfollow" RLS policy in
--      pin_follow_marpe.sql) — @marpe is InteractInk's pinned
--      account, and a block row targeting it is rejected outright,
--      both server-side (here) and client-side (js/profile.js /
--      js/list.js hide the Block option on @marpe's own profile).
--
-- Safe to re-run — every statement below is idempotent.
-- ============================================================

-- Defensive only: js/common.js and for_you_feed.sql already read
-- from/write to public.blocks, so this table already exists on your
-- live project. `if not exists` just means this file doesn't blow up
-- if it's ever run against a fresh database that doesn't have it yet
-- — it does NOT redefine or touch the table if it's already there.
create table if not exists public.blocks (
  blocker_id uuid not null references public.profiles(id) on delete cascade,
  blocked_id uuid not null references public.profiles(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (blocker_id, blocked_id)
);

alter table public.blocks enable row level security;

-- Wipe and rebuild policies on `blocks`, same reasoning as
-- likes_full_fix.sql: dropping every existing policy by name (rather
-- than assuming what it's called) means this can't silently leave a
-- stale, differently-named policy blocking reads/writes underneath
-- the ones added here.
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'blocks'
  loop
    execute format('drop policy %I on public.blocks', pol.policyname);
  end loop;
end $$;

-- You can only see/manage blocks you created — the person on the
-- other end never gets to query this table to find out you blocked
-- them (same as Twitter: they just experience the effects of it).
create policy "blocks_select_own" on public.blocks
  for select using (auth.uid() = blocker_id);
create policy "blocks_insert_own" on public.blocks
  for insert with check (auth.uid() = blocker_id and blocker_id <> blocked_id);
create policy "blocks_delete_own" on public.blocks
  for delete using (auth.uid() = blocker_id);

-- ── 1 & 3: on block, reject @marpe and drop any existing follow
-- either direction ──
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

  return new;
end;
$$;

drop trigger if exists trg_block_insert on public.blocks;
create trigger trg_block_insert
  before insert on public.blocks
  for each row execute function public.handle_block_insert();

-- ── 2: on unblock, nothing follow-related happens — see the note at
-- the top of this file. (No trigger here on purpose.) ──
drop trigger if exists trg_block_delete on public.blocks;
drop function if exists public.handle_block_delete();

-- Retroactive cleanup: if any block row already exists against
-- @marpe from before this guard existed, remove it now rather than
-- leaving it in place until someone happens to unblock/reblock.
delete from public.blocks
where blocked_id in (select id from public.profiles where lower(username) = 'marpe');
