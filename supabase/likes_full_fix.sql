-- ============================================================
-- LIKES — FULL FIX (consolidated, replaces likes_support_replies.sql
-- and fix_likes_rls.sql — just run this one instead of those two)
-- Run this whole thing in the Supabase SQL editor, top to bottom.
-- ============================================================

-- ── 1. SCHEMA: let a like point at a post OR a reply ──
-- Originally `likes.post_id` was NOT NULL with a FK to posts(id), so
-- liking a reply (whose id isn't in `posts`) failed with
-- "violates foreign key constraint likes_post_id_fkey". This makes
-- post_id nullable, adds a nullable reply_id, and a check constraint
-- so exactly one of the two is always set.

alter table public.likes
  alter column post_id drop not null;

alter table public.likes
  add column if not exists reply_id uuid references public.replies(id) on delete cascade;

alter table public.likes
  drop constraint if exists likes_post_xor_reply;
alter table public.likes
  add constraint likes_post_xor_reply
  check (
    (post_id is not null and reply_id is null) or
    (post_id is null and reply_id is not null)
  );

alter table public.likes
  drop constraint if exists likes_post_id_user_id_key;

create unique index if not exists likes_unique_post_like
  on public.likes (post_id, user_id) where post_id is not null;

create unique index if not exists likes_unique_reply_like
  on public.likes (reply_id, user_id) where reply_id is not null;

-- ── 2. RLS: wipe every existing policy on `likes`, then rebuild ──
-- A like appearing to "go away on refresh" while the tap itself
-- worked is the signature of a blocked SELECT: the row really is
-- inserted, but the read that repopulates the page after refresh gets
-- silently filtered down to zero rows by Row Level Security, so the
-- heart renders unliked again — nothing was actually deleted.
-- Adding a same-named policy on top of the table's real (differently
-- named, still-blocking) policy wouldn't have fixed that, which is
-- most likely why the last script didn't help — so this drops
-- EVERY policy currently on the table first, whatever it's called,
-- then adds exactly the three needed.

alter table public.likes enable row level security;

do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'likes'
  loop
    execute format('drop policy %I on public.likes', pol.policyname);
  end loop;
end $$;

create policy "likes_select_own"
  on public.likes for select
  to authenticated
  using (user_id = auth.uid());

create policy "likes_insert_own"
  on public.likes for insert
  to authenticated
  with check (user_id = auth.uid());

create policy "likes_delete_own"
  on public.likes for delete
  to authenticated
  using (user_id = auth.uid());

-- ============================================================
-- 3. VERIFY — run these two after the above and check the results
-- ============================================================

-- Should list exactly 3 rows: likes_select_own / likes_insert_own /
-- likes_delete_own.
select policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname = 'public' and tablename = 'likes';

-- While logged in as yourself: like something in the app, refresh,
-- then run this. If the row IS here but the app still shows it
-- unliked, the bug is back in the client, not the database, and I
-- need to look at that instead — tell me and paste what this
-- returns. If the row is NOT here, something is deleting it
-- (a trigger, most likely) and I need to see that trigger's
-- definition to fix it — I have no way to find it without the DB.
select * from public.likes where user_id = auth.uid() order by created_at desc limit 10;
