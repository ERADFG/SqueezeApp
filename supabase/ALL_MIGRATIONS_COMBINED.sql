-- ================================================================
-- INTERACTINK — ALL MIGRATIONS, COMBINED (run this one file)
-- ================================================================
-- This is supabase/MASTER_MIGRATIONS_reconstructed.sql followed by
-- supabase/RUN_PENDING_MIGRATIONS.sql (== RUN_THIS_SQL_FIRST.sql),
-- pasted back to back in the order their own headers say they
-- depend on each other. Every statement in both files is written to
-- be idempotent (create-if-not-exists / drop-then-create), so this
-- whole file is safe to paste into Supabase SQL Editor → New query →
-- Run on a brand-new project OR one that already has some/all of
-- this applied.
--
-- ⚠️ WHAT THIS FILE DOES **NOT** INCLUDE, READ BEFORE RUNNING:
-- The base schema — the actual `create table` statements for
-- profiles, posts, replies, likes, follows, communities, lists,
-- messages, notifications, storage buckets, etc., plus their
-- original RLS policies — is NOT part of this export. Only the
-- later *patches* on top of that base schema were included in the
-- project you uploaded. I did not invent those CREATE TABLE/RLS
-- definitions to fill the gap: guessing at column types, constraints
-- and policies for tables that already exist in your live database
-- is exactly the kind of thing that's cheap to get subtly wrong
-- (wrong RLS policy, wrong constraint) and expensive to have gotten
-- wrong against real user data.
--
-- So: if you already have a working Supabase project for this app,
-- you almost certainly already have that base schema applied —
-- this file is only the layer of fixes/features on top of it, safe
-- to run again. If you are starting a BRAND NEW Supabase project
-- from zero, running only this file will fail (tables like `posts`
-- won't exist yet) — you need your original schema.sql /
-- MASTER_SCHEMA.sql first. Check Supabase Dashboard → Database →
-- Migrations, or your own git history/backups, for that file; if you
-- genuinely don't have it anywhere, say so and I can help
-- reconstruct it from the client code (js/*.js), with the same
-- honesty about what's inferred vs. verbatim.
-- ================================================================


-- ================================================================
-- INTERACTINK — MASTER MIGRATIONS (reconstructed)
-- ================================================================
-- What this is: every supabase/*.sql migration that was actually
-- present in this project export, concatenated in the order their
-- own header comments say they depend on each other, PLUS two files
-- that were referenced by name elsewhere (in js/common.js and in
-- other migrations' comments) but missing from the export — I
-- rebuilt those two from the exact client code that calls them:
--   • fix_delete_via_rpc.sql   (post/reply delete — common.js calls
--     sb.rpc('delete_own_post'/'delete_own_reply', ...) directly)
--   • likes_count_sync.sql     (new — see its own header; this is
--     the fix for the like/unlike "delay" you reported)
--
-- WHAT'S NOT IN HERE, AND WHY: your README's setup instructions
-- point at supabase/schema.sql, settings.sql, communities.sql,
-- community_creator_and_post_limit.sql, community_delete.sql,
-- lists.sql, list_followers.sql (present), mentions.sql,
-- quotes_and_reposts.sql, gifs_polls_scheduling.sql,
-- bookmark_count.sql, pin_follow_marpe.sql, and a consolidated
-- MASTER_SCHEMA.sql — NONE of those base/table-creating files were
-- in the export this was built from (only the smaller later patches
-- were). I did not fabricate them from scratch: guessing full
-- CREATE TABLE definitions, constraints, and RLS policies for a
-- database that's already live with real user data is exactly the
-- kind of thing that's safe to get right and genuinely harmful to
-- get wrong (silently-different constraints, RLS holes, etc.). Since
-- your app is live and working, those tables obviously already exist
-- in your actual Supabase project — you just don't have the local
-- .sql files for them anymore. If you still have them anywhere (git
-- history, an old backup, Supabase's own migration history under
-- Database → Migrations in the dashboard), that's a much safer
-- source of truth than anything I'd reconstruct blind. Happy to help
-- rebuild any specific one of them from your code if you confirm you
-- don't have it and want me to try.
--
-- HOW TO RUN: paste this whole file into Supabase SQL Editor → New
-- query → Run. Every migration below is written to be idempotent
-- (create-if-not-exists / drop-then-create), so this is safe to run
-- on a project that already has some or all of it applied.
-- ================================================================


-- ################################################################
-- FROM: supabase/likes_full_fix.sql
-- ################################################################
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


-- ################################################################
-- FROM: supabase/likes_count_sync.sql
-- ################################################################
-- ============================================================
-- LIKES — COUNT SYNC (fixes the like/unlike "delay" bug)
--
-- WHY THIS FILE EXISTS: js/common.js's toggleLike() is already fully
-- optimistic — it flips the heart and the count the instant you tap,
-- before the network call even resolves. If a tap still feels
-- delayed/laggy, the client isn't the problem; what's actually
-- happening is this:
--
--   1. toggleLike() inserts/deletes a row in `likes`.
--   2. Nothing in the database was updating posts.like_count (or
--      replies.like_count) to match — there was no trigger doing it.
--   3. So the optimistic +1/-1 you see on tap is only ever a LOCAL
--      guess. The moment the real count gets re-read from the DB —
--      a realtime UPDATE from something else touching that row, a
--      revisit to the feed, a reload, opening the thread again — it
--      snaps back to the old, un-incremented number. That
--      snap-back is what reads as "a delay": the heart looks right
--      for a moment, then a beat later the number reverts.
--
-- This file closes that gap with a trigger that updates the count
-- columns inside the same transaction as the like/unlike, so the
-- stored count is never out of sync with the `likes` table.
--
-- Also make sure supabase/likes_full_fix.sql has been run — if the
-- RLS policies on `likes` are missing/broken, inserts fail silently
-- and toggleLike()'s catch block rolls the optimistic UI back a
-- moment later, which looks identical to this bug from the outside.
--
-- Safe to re-run — replaces the function and re-creates the trigger.
-- ============================================================

create or replace function public.sync_like_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    if new.post_id is not null then
      update public.posts set like_count = coalesce(like_count, 0) + 1 where id = new.post_id;
    elsif new.reply_id is not null then
      update public.replies set like_count = coalesce(like_count, 0) + 1 where id = new.reply_id;
    end if;
    return new;
  elsif (tg_op = 'DELETE') then
    if old.post_id is not null then
      update public.posts set like_count = greatest(coalesce(like_count, 0) - 1, 0) where id = old.post_id;
    elsif old.reply_id is not null then
      update public.replies set like_count = greatest(coalesce(like_count, 0) - 1, 0) where id = old.reply_id;
    end if;
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_likes_sync_count on public.likes;
create trigger trg_likes_sync_count
  after insert or delete on public.likes
  for each row execute function public.sync_like_count();

-- ── ONE-TIME BACKFILL ──
-- Recomputes both count columns from the actual rows in `likes` right
-- now, so any counts that already drifted out of sync before this
-- trigger existed get corrected immediately instead of waiting for
-- their next like/unlike.
update public.posts p
   set like_count = coalesce((select count(*) from public.likes l where l.post_id = p.id), 0);

update public.replies r
   set like_count = coalesce((select count(*) from public.likes l where l.reply_id = r.id), 0);


-- ################################################################
-- FROM: supabase/fix_delete_via_rpc.sql
-- ################################################################
-- ============================================================
-- DELETE OWN POST / REPLY — via SECURITY DEFINER RPC.
--
-- RECONSTRUCTED FILE: this file is referenced by name (as
-- "fix_delete_via_rpc.sql") in js/common.js's confirmDeletePost(),
-- and by comments in edit_own_post.sql and
-- fix_delete_article_via_rpc.sql, but wasn't included in the project
-- export this was rebuilt from. If your live Supabase project
-- already has delete_own_post/delete_own_reply functions (it must,
-- for post/reply deletion to work at all), you don't need to run
-- this — check first with:
--
--   select routine_name from information_schema.routines
--   where routine_schema = 'public'
--     and routine_name in ('delete_own_post','delete_own_reply');
--
-- If that comes back empty, run this file — it's what
-- confirmDeletePost() has been calling via
-- sb.rpc('delete_own_post'|'delete_own_reply', ...) all along.
--
-- WHY AN RPC INSTEAD OF A CLIENT-SIDE UPDATE: posts/replies have no
-- client-facing UPDATE policy (same reasoning as edit_own_post.sql) —
-- a raw `.update({ is_deleted: true })` is gated by RLS's WITH CHECK
-- re-validation, which can fail on session/JWT edge cases outside the
-- app's control even when the row really is yours. Moving the write
-- into a SECURITY DEFINER function sidesteps that: the function
-- checks ownership itself and performs the write as its own
-- privileged role, bypassing table RLS entirely for this one write.
--
-- POSTS get one extra allowance common.js already relies on
-- (confirmDeletePost()'s client-side pre-check mirrors this): the
-- creator of the community a post was made in may also delete that
-- post, not just the post's own author. Replies have no such
-- exception — only the reply's author can delete it.
--
-- Safe to re-run.
-- ============================================================

create or replace function public.delete_own_post(post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  row_owner   uuid;
  row_comm    uuid;
  comm_owner  uuid;
begin
  select author_id, community_id into row_owner, row_comm
  from public.posts where id = post_id;

  if row_owner is null then
    raise exception 'Post not found.';
  end if;

  if row_owner <> auth.uid() then
    if row_comm is not null then
      select created_by into comm_owner from public.communities where id = row_comm;
    end if;
    if comm_owner is null or comm_owner <> auth.uid() then
      raise exception 'You can only delete your own posts (or posts in a community you own).';
    end if;
  end if;

  update public.posts set is_deleted = true where id = post_id;
end;
$$;

create or replace function public.delete_own_reply(reply_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  select author_id into owner from public.replies where id = reply_id;

  if owner is null then
    raise exception 'Reply not found.';
  end if;

  if owner <> auth.uid() then
    raise exception 'You can only delete your own replies.';
  end if;

  update public.replies set is_deleted = true where id = reply_id;
end;
$$;

-- Let logged-in users call these; the functions themselves enforce
-- ownership, so this grant does not open up deleting other people's
-- posts/replies.
grant execute on function public.delete_own_post(uuid) to authenticated;
grant execute on function public.delete_own_reply(uuid) to authenticated;

-- Force PostgREST (Supabase's auto-generated API layer) to reload its
-- schema cache immediately. Without this, a newly created function can
-- return "Could not find the function ... in the schema cache" until
-- PostgREST's next automatic refresh.
notify pgrst, 'reload schema';


-- ################################################################
-- FROM: supabase/edit_own_post.sql
-- ################################################################
-- ============================================================
-- EDIT OWN POST / REPLY — lets an author edit their own post or
-- comment within 15 minutes of posting it, and marks it "Edited"
-- afterwards (js/common.js's editedSuffix()/markEditedTag()).
--
-- Same SECURITY DEFINER RPC pattern as delete_own_post /
-- delete_own_reply / delete_own_article: the function checks
-- ownership (and, here, the 15-minute window) itself and performs
-- the write as its own privileged role. posts/replies have no
-- client-facing UPDATE policy — same as before this file, deletes
-- go through delete_own_post/delete_own_reply rather than a raw
-- `.update()` — so this RPC is the only way an edit can happen at
-- all, not just the preferred one.
--
-- WHY 15 MINUTES IS ALSO ENFORCED HERE (not just in js/common.js's
-- withinEditWindow()): this app's client talks directly to Supabase
-- with the public anon key (see post_cooldown.sql for the same
-- reasoning), so the client-side check only exists to show a fast,
-- friendly "the edit window has passed" message — this function is
-- what actually stops a late edit, since anyone could otherwise call
-- `supabase.rpc('edit_own_post', ...)` directly from a script.
--
-- "Edited" shows up in the UI whenever a row's updated_at differs
-- from its created_at. Both columns default to now() and a single
-- INSERT's now() is the same value for every column it touches, so
-- they land exactly equal until an edit changes updated_at — same
-- trick articles.sql already relies on for its own "· Edited" label.
--
-- TO APPLY: run this once in the Supabase SQL editor (or via the
-- CLI) for your project. Safe to re-run.
-- ============================================================

alter table public.posts   add column if not exists updated_at timestamptz not null default now();
alter table public.replies add column if not exists updated_at timestamptz not null default now();

-- Backfill: rows that existed before this column was added should
-- read as un-edited, not as edited the moment updated_at appears.
update public.posts   set updated_at = created_at where updated_at is distinct from created_at;
update public.replies set updated_at = created_at where updated_at is distinct from created_at;

create or replace function public.edit_own_post(post_id uuid, new_body text)
returns public.posts
language plpgsql
security definer
set search_path = public
as $$
declare
  row_owner   uuid;
  row_created timestamptz;
  row_deleted boolean;
  clean_body  text := trim(new_body);
  result      public.posts;
begin
  select author_id, created_at, is_deleted into row_owner, row_created, row_deleted
  from public.posts where id = post_id;

  if row_owner is null then
    raise exception 'Post not found.';
  end if;
  if row_owner <> auth.uid() then
    raise exception 'You can only edit your own posts.';
  end if;
  if row_deleted then
    raise exception 'This post has been deleted.';
  end if;
  if now() - row_created > interval '15 minutes' then
    raise exception 'The 15-minute edit window for this post has passed.';
  end if;
  if clean_body = '' then
    raise exception 'Post cannot be empty.';
  end if;
  if length(clean_body) > 500 then
    raise exception 'Post is too long (max 500 characters).';
  end if;

  update public.posts set body = clean_body, updated_at = now()
  where id = post_id
  returning * into result;

  return result;
end;
$$;

create or replace function public.edit_own_reply(reply_id uuid, new_body text)
returns public.replies
language plpgsql
security definer
set search_path = public
as $$
declare
  row_owner   uuid;
  row_created timestamptz;
  row_deleted boolean;
  clean_body  text := trim(new_body);
  result      public.replies;
begin
  select author_id, created_at, is_deleted into row_owner, row_created, row_deleted
  from public.replies where id = reply_id;

  if row_owner is null then
    raise exception 'Reply not found.';
  end if;
  if row_owner <> auth.uid() then
    raise exception 'You can only edit your own replies.';
  end if;
  if row_deleted then
    raise exception 'This reply has been deleted.';
  end if;
  if now() - row_created > interval '15 minutes' then
    raise exception 'The 15-minute edit window for this reply has passed.';
  end if;
  if clean_body = '' then
    raise exception 'Reply cannot be empty.';
  end if;
  if length(clean_body) > 500 then
    raise exception 'Reply is too long (max 500 characters).';
  end if;

  update public.replies set body = clean_body, updated_at = now()
  where id = reply_id
  returning * into result;

  return result;
end;
$$;

-- Let logged-in users call these; the functions themselves enforce
-- ownership and the time window, so this grant does not open up
-- editing other people's posts/replies or editing past 15 minutes.
grant execute on function public.edit_own_post(uuid, text) to authenticated;
grant execute on function public.edit_own_reply(uuid, text) to authenticated;

-- Force PostgREST (Supabase's auto-generated API layer) to reload its
-- schema cache immediately. Without this, a newly created function can
-- return "Could not find the function ... in the schema cache" until
-- PostgREST's next automatic refresh.
notify pgrst, 'reload schema';


-- ################################################################
-- FROM: supabase/post_cooldown.sql
-- ################################################################
-- ============================================================
-- POST COOLDOWN — server-side enforcement of the 30s "wait between
-- posts" spam brake.
--
-- WHY THIS FILE EXISTS: js/common.js already throttles posting on the
-- client (enforceCooldown() / markPosted(), gating submitPost() in
-- board.js, submitCommunityPost() in community.js, and submitReply()
-- in thread.js). That's good for UX (an instant "wait 12s" message,
-- a disabled button with a live countdown) but it is NOT real
-- security — this app's client talks directly to Supabase with the
-- public anon key, so anyone can skip the site's JS entirely and call
-- `supabase.from('posts').insert(...)` straight from a script. This
-- trigger is what actually stops that: it runs inside Postgres, so
-- there's no client to bypass.
--
-- HOW: a BEFORE INSERT trigger on both public.posts and
-- public.replies checks the author's most recent row (across BOTH
-- tables, since a reply-flood is just as much spam as a post-flood)
-- and rejects the insert if it's within 30 seconds of their last one.
--
-- TO APPLY: run this once in the Supabase SQL editor (or via the CLI)
-- for your project. Safe to re-run — it replaces the function and
-- re-creates the triggers.
-- ============================================================

create or replace function public.enforce_post_cooldown()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  last_at timestamptz;
  cooldown interval := interval '30 seconds';
begin
  select max(created_at) into last_at
  from (
    select created_at from public.posts   where author_id = new.author_id
    union all
    select created_at from public.replies where author_id = new.author_id
  ) recent;

  if last_at is not null and now() - last_at < cooldown then
    raise exception 'You are posting too fast — please wait a bit before posting again.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_posts_cooldown on public.posts;
create trigger trg_posts_cooldown
  before insert on public.posts
  for each row execute function public.enforce_post_cooldown();

drop trigger if exists trg_replies_cooldown on public.replies;
create trigger trg_replies_cooldown
  before insert on public.replies
  for each row execute function public.enforce_post_cooldown();

-- NOTE ON SCHEDULED POSTS: board.js lets a post carry a future
-- scheduled_at and only actually becomes visible then, but the ROW is
-- inserted right away — so scheduling several posts back-to-back
-- still counts against this same cooldown, same as normal posts. If
-- you'd rather exempt scheduled posts from the cooldown, add
-- `and new.scheduled_at is null` to the `if` condition above (only
-- posts has a scheduled_at column, so guard for that in the function
-- if you do this).


-- ################################################################
-- FROM: supabase/articles_full_setup.sql
-- ################################################################
-- ============================================================
-- ARTICLES — full setup (run this single file in the Supabase
-- SQL editor). Safe to re-run any time — every statement is
-- idempotent (create-if-not-exists / drop-then-create), so this
-- works whether you're starting fresh or already ran the earlier
-- articles.sql / articles_rich_and_promo.sql files.
--
-- Combines:
--   1. The base `articles` table (title/body/cover/author) +
--      public-read / author-only-write RLS.
--   2. content_html — the rich-text body written by the
--      editarticle.html editor (bold/italic/headings/quotes/
--      links/inline images). `body` stays a plain-text mirror
--      used only for search + row-card excerpts.
--   3. posts.article_id — lets a post "promote" an article,
--      rendered as an X-style article card in the feed.
--   4. A hardening fix for:
--         "new row violates row-level security policy for
--          table articles"
--      This happens whenever the row being inserted has an
--      author_id that doesn't exactly equal auth.uid() — most
--      often because the client sent the wrong value, sent none,
--      or the insert fired before the session was fully attached.
--      The fix: a BEFORE INSERT trigger that overwrites
--      author_id with auth.uid() unconditionally, so whatever
--      the client sends is ignored and the RLS check
--      (author_id = auth.uid()) can never fail for a logged-in
--      request. An insert from a logged-OUT request still
--      correctly fails, since auth.uid() is null there and
--      articles.author_id is `not null`.
-- ============================================================

-- gen_random_uuid() needs pgcrypto — on Supabase this is almost
-- always already enabled, but this makes the script self-contained.
create extension if not exists pgcrypto;

-- ── TABLE ──────────────────────────────────────────────────
create table if not exists public.articles (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references public.profiles(id) on delete cascade,
  title       text not null,
  body        text not null,
  content_html text,
  cover_url   text,
  is_deleted  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

-- In case this runs against a table created by the older
-- articles.sql, which didn't have content_html yet.
alter table public.articles add column if not exists content_html text;

create index if not exists articles_author_idx on public.articles(author_id);
create index if not exists articles_created_idx on public.articles(created_at desc);
create index if not exists articles_title_trgm_idx on public.articles using gin (title gin_trgm_ops);
create index if not exists articles_body_trgm_idx on public.articles using gin (body gin_trgm_ops);

-- ── RLS ────────────────────────────────────────────────────
alter table public.articles enable row level security;

-- Anyone (including logged-out visitors) can read any non-deleted article.
drop policy if exists "articles_select" on public.articles;
create policy "articles_select" on public.articles
  for select
  to public
  using (is_deleted = false);

-- Any logged-in account can write an article. The `with check` here
-- is really just a belt-and-suspenders backstop now — the trigger
-- below (articles_force_author_trg) is what actually guarantees
-- author_id = auth.uid() before this check even runs, which is the
-- fix for the "violates row-level security policy" insert error.
drop policy if exists "articles_insert_own" on public.articles;
create policy "articles_insert_own" on public.articles
  for insert
  to authenticated
  with check (author_id = auth.uid());

-- Only the author can edit their own article (or soft-delete it via
-- is_deleted, same pattern posts.sql uses instead of a hard delete).
drop policy if exists "articles_update_own" on public.articles;
create policy "articles_update_own" on public.articles
  for update
  to authenticated
  using (author_id = auth.uid())
  with check (author_id = auth.uid());

-- ── FIX: force author_id server-side ──────────────────────
-- Whatever the client sends as author_id on INSERT is discarded and
-- replaced with the actual signed-in user's id. This is what stops
-- "new row violates row-level security policy for table articles":
-- that error means the row about to be inserted had an author_id
-- that didn't match auth.uid(); after this trigger, it always will
-- (for any authenticated request — a logged-out request still gets
-- correctly rejected, since auth.uid() is null and the column is
-- `not null`).
create or replace function public.articles_force_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.author_id := auth.uid();
  return new;
end;
$$;

drop trigger if exists articles_force_author_trg on public.articles;
create trigger articles_force_author_trg
  before insert on public.articles
  for each row execute function public.articles_force_author();

-- Keeps updated_at honest on every edit.
create or replace function public.articles_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists articles_touch_updated_at_trg on public.articles;
create trigger articles_touch_updated_at_trg
  before update on public.articles
  for each row execute function public.articles_touch_updated_at();

-- ── POSTS -> ARTICLES promo link ──────────────────────────
-- Set when a post is "sharing" an article (either automatically at
-- publish time via the editarticle.html "Share as a post" checkbox,
-- or later via the Article page's Post button). on delete set null
-- (not cascade): deleting the article shouldn't delete someone's
-- post, just drop the dead embed.
alter table public.posts
  add column if not exists article_id uuid references public.articles(id) on delete set null;

create index if not exists posts_article_idx on public.posts(article_id) where article_id is not null;


-- ################################################################
-- FROM: supabase/fix_delete_article_via_rpc.sql
-- ################################################################
-- ============================================================
-- FIX: "new row violates row-level security policy for table
-- articles" when soft-deleting your own article.
--
-- Same root issue (and same fix) already applied to posts/replies
-- (see fix_delete_via_rpc.sql, used by confirmDeletePost() in
-- common.js): a raw client-side
--   UPDATE articles SET is_deleted = true WHERE id = ...
-- is gated by RLS's WITH CHECK re-validation, which can fail even
-- with author_id correctly pinned (session/JWT edge cases outside
-- app control — this is exactly what articles_fix_update_rls.sql
-- tried to patch, and it's still not reliable).
--
-- FIX: move the soft-delete into a SECURITY DEFINER RPC. The
-- function checks ownership itself (auth.uid() = author_id) and
-- then performs the write as its own privileged role, so it never
-- goes through the table's RLS UPDATE policy at all — same pattern
-- as delete_own_post / delete_own_reply.
--
-- Safe to re-run.
-- ============================================================

create or replace function public.delete_own_article(article_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  select author_id into owner from public.articles where id = article_id;

  if owner is null then
    raise exception 'Article not found.';
  end if;

  if owner <> auth.uid() then
    raise exception 'You can only delete your own articles.';
  end if;

  update public.articles set is_deleted = true, updated_at = now()
  where id = article_id;
end;
$$;

-- Let logged-in users call it; the function itself enforces ownership,
-- so this grant does not open up deleting other people's articles.
grant execute on function public.delete_own_article(uuid) to authenticated;

-- Force PostgREST (Supabase's auto-generated API layer) to reload its
-- schema cache immediately. Without this, a newly created function can
-- return "Could not find the function ... in the schema cache" until
-- PostgREST's next automatic refresh.
notify pgrst, 'reload schema';


-- ################################################################
-- FROM: supabase/fix_mention_notifications_case_insensitive.sql
-- ################################################################
-- Mentions weren't creating notifications when the @handle's casing
-- didn't exactly match the stored username (e.g. "@Marpe" typed
-- against a profile whose username is "marpe"). Every other username
-- lookup in this app is case-insensitive (profile.js, chat.js,
-- followlist.js, profilelists.js all use .ilike('username', uname)),
-- but the mention trigger was doing (or is assumed to be doing) an
-- exact-case match against profiles.username, so a differently-cased
-- @mention silently matched no one and no notification was inserted.
--
-- This replaces the mention-detection function with a version that:
--   - extracts @handles with the same pattern the client uses to
--     linkify them (js/common.js linkifyText(): @[a-zA-Z0-9_]{3,20})
--   - looks each one up case-insensitively (ilike, exact match — no
--     wildcards, so "marpe" matches "@Marpe"/"@MARPE"/"@marpe" alike)
--   - dedupes repeated mentions of the same person in one post
--   - skips mentioning yourself
--
-- ADJUST BEFORE RUNNING: this assumes a `notifications` table with
-- columns (user_id, actor_id, type, post_id, read, created_at) — the
-- columns js/notifications.js selects from. If your actual table
-- differs (extra NOT NULL columns, different column names), or if you
-- already have a same-named trigger/function doing more than mention
-- detection (e.g. combined with likes/replies), rename this function
-- before running so it doesn't overwrite something else — or paste me
-- your existing one and I'll patch it directly instead.

create or replace function public.notify_post_mentions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  handle text;
  mentioned record;
begin
  for handle in
    select distinct lower(m[1])
    from regexp_matches(coalesce(new.body, ''), '(?:^|[^\w&])@([a-zA-Z0-9_]{3,20})', 'g') as m
  loop
    select id into mentioned from public.profiles where username ilike handle limit 1;
    if mentioned.id is not null and mentioned.id <> new.author_id then
      insert into public.notifications (user_id, actor_id, type, post_id, read, created_at)
      values (mentioned.id, new.author_id, 'mention', new.id, false, now());
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_notify_post_mentions on public.posts;
create trigger trg_notify_post_mentions
  after insert on public.posts
  for each row execute function public.notify_post_mentions();

-- Same thing for replies — a mention inside a reply notifies the
-- mentioned user too, linking back to the parent post (notifications
-- only join `post:posts(...)`, same as every other notification type
-- generated from a reply, e.g. "X replied to your post").
create or replace function public.notify_reply_mentions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  handle text;
  mentioned record;
begin
  for handle in
    select distinct lower(m[1])
    from regexp_matches(coalesce(new.body, ''), '(?:^|[^\w&])@([a-zA-Z0-9_]{3,20})', 'g') as m
  loop
    select id into mentioned from public.profiles where username ilike handle limit 1;
    if mentioned.id is not null and mentioned.id <> new.author_id then
      insert into public.notifications (user_id, actor_id, type, post_id, read, created_at)
      values (mentioned.id, new.author_id, 'mention', new.post_id, false, now());
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_notify_reply_mentions on public.replies;
create trigger trg_notify_reply_mentions
  after insert on public.replies
  for each row execute function public.notify_reply_mentions();

-- Not covered: editing a post/reply to add a new @mention after the
-- fact won't fire these (they're AFTER INSERT only). Say the word if
-- you want that covered too — it'd need an AFTER UPDATE trigger that
-- diffs old vs new body so editing doesn't re-notify mentions that
-- were already there.


-- ################################################################
-- FROM: supabase/for_you_feed.sql
-- ################################################################
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


-- ################################################################
-- FROM: supabase/list_followers.sql
-- ################################################################
-- ============================================================
-- LIST FOLLOWERS — lets any account "follow" a public List the way
-- Twitter's own Lists work, separate from `list_members` (who's
-- curated ONTO a List's timeline — owner-only, no consent needed).
-- Following a List just pins it into the follower's own /lists
-- "Your Lists" section; it never adds them as a content source.
--
-- Run in the Supabase SQL Editor after schema.sql AND lists.sql.
-- Additive/idempotent like the other migrations — safe to re-run.
-- ============================================================

-- Denormalized count, same pattern as lists.member_count.
alter table public.lists add column if not exists follower_count integer not null default 0;

create table if not exists public.list_followers (
  list_id     uuid not null references public.lists(id) on delete cascade,
  follower_id uuid not null references public.profiles(id) on delete cascade,
  followed_at timestamptz not null default now(),
  primary key (list_id, follower_id)
);

create index if not exists list_followers_follower_idx on public.list_followers(follower_id);
create index if not exists list_followers_list_idx on public.list_followers(list_id);

alter table public.list_followers enable row level security;

-- Anyone can see who follows a public List; a private List's follower
-- rows (there won't normally be any, since you can only follow a
-- public List — see the insert policy below) stay visible to its
-- owner only, same visibility rule as the List itself.
drop policy if exists "list_followers_select" on public.list_followers;
create policy "list_followers_select" on public.list_followers
  for select using (
    exists (
      select 1 from public.lists l
      where l.id = list_followers.list_id
        and (l.is_private = false or l.owner_id = auth.uid())
    )
  );

-- You can only ever insert your own follow row, and only for a List
-- that's public — private Lists aren't followable, matching how
-- they're invisible to anyone but the owner in the first place.
drop policy if exists "list_followers_insert_own" on public.list_followers;
create policy "list_followers_insert_own" on public.list_followers
  for insert with check (
    follower_id = auth.uid()
    and exists (select 1 from public.lists l where l.id = list_followers.list_id and l.is_private = false)
  );

-- You can only ever remove your own follow row (unfollow).
drop policy if exists "list_followers_delete_own" on public.list_followers;
create policy "list_followers_delete_own" on public.list_followers
  for delete using (follower_id = auth.uid());

-- Keeps lists.follower_count in sync, same trigger shape lists.sql
-- already uses for member_count.
create or replace function public.list_followers_count_sync() returns trigger
language plpgsql security definer set search_path = public as $$
begin
  if tg_op = 'INSERT' then
    update public.lists set follower_count = follower_count + 1 where id = new.list_id;
  elsif tg_op = 'DELETE' then
    update public.lists set follower_count = greatest(0, follower_count - 1) where id = old.list_id;
  end if;
  return null;
end;
$$;

drop trigger if exists list_followers_count_sync_trg on public.list_followers;
create trigger list_followers_count_sync_trg
  after insert or delete on public.list_followers
  for each row execute function public.list_followers_count_sync();


-- ################################################################
-- FROM: supabase/chat_e2e_encryption.sql
-- ################################################################
-- ─────────────────────────────────────────────────────────────
-- CHAT E2E ENCRYPTION — run this once in the Supabase SQL editor.
--
-- Adds the columns the new js/chat-crypto.js needs:
--   profiles.pubkey   — each user's ECDH (P-256) public key, stored
--                        as a JSON-stringified JWK. Public by design
--                        (that's the point of a public key) — no RLS
--                        change needed, it rides on the existing
--                        "anyone can read profiles" policy, and the
--                        existing "user can update own profile" policy
--                        already lets a user set their own pubkey.
--   messages.iv        — base64 AES-GCM IV for that row. NULL means
--                        the row is legacy/unencrypted plaintext
--                        (old messages sent before this migration, or
--                        messages sent while the recipient had no
--                        pubkey yet) — the client falls back to
--                        rendering `body` as-is when `iv` is NULL.
--   messages.body       — unchanged column, just now holds base64
--                        AES-GCM ciphertext instead of plaintext once
--                        both sides have a pubkey. Supabase/Postgres
--                        (and anyone with DB access) only ever sees
--                        ciphertext for encrypted rows — the AES key
--                        is derived client-side via ECDH and never
--                        leaves the browser.
-- ─────────────────────────────────────────────────────────────

alter table public.profiles add column if not exists pubkey text;
alter table public.messages add column if not exists iv text;

comment on column public.profiles.pubkey is 'ECDH P-256 public key (JWK, JSON-encoded) used to derive per-conversation AES-GCM keys client-side. Public by design.';
comment on column public.messages.iv is 'Base64 AES-GCM IV for this message. NULL = legacy/unencrypted plaintext body.';


-- ################################################################
-- FROM: supabase/admin_panel_advanced.sql
-- ################################################################
-- ============================================================
-- ADMIN PANEL — ADVANCED MODERATION
-- Run this in the Supabase SQL Editor after everything else
-- (schema.sql, articles.sql, etc.). Additive/idempotent like the
-- other migrations here — safe to re-run any time.
--
-- What this adds on top of the original admin panel (which only
-- had verify / ban / delete-post):
--   1. A real `is_admin` flag on profiles instead of a hardcoded
--      username, so you can promote more admins later with one
--      UPDATE statement (see bottom of this file).
--   2. Twitter-style SUSPEND — same "signed out, can't post" effect
--      the old `banned` flag had, but now with a reason and an
--      optional expiry (1 day / 3 days / 7 days / 30 days /
--      permanent). UNSUSPEND reverses it. `banned` is kept as the
--      actual enforcement column (nothing else in the app has to
--      change), suspended_until/suspend_reason are metadata on top.
--   3. Delete for replies (comments) and articles, not just posts.
--   4. A real Reports queue the admin panel can read — reports.sql
--      made that table write-only from the browser on purpose (see
--      README's Moderation section), so these are SECURITY DEFINER
--      functions that let an admin read/resolve reports without a
--      service_role key ever touching the browser.
--
-- Every function below re-checks is_admin() itself server-side, the
-- same "even if someone bypassed the UI, the database still refuses
-- them" guarantee the original admin panel had.
-- ============================================================

-- ── 1. Columns ──────────────────────────────────────────────

alter table public.profiles add column if not exists is_admin        boolean not null default false;
alter table public.profiles add column if not exists banned          boolean not null default false;
alter table public.profiles add column if not exists suspended_until timestamptz;
alter table public.profiles add column if not exists suspend_reason  text;

alter table public.reports add column if not exists status      text not null default 'open';
alter table public.reports add column if not exists reviewed_at timestamptz;
alter table public.reports add column if not exists reviewed_by uuid references public.profiles(id);
do $$
begin
  alter table public.reports add constraint reports_status_check check (status in ('open','actioned','dismissed'));
exception when duplicate_object then null;
end $$;

-- ── 2. is_admin() — the real gate every RPC below checks ──────
-- Checks the new is_admin flag, OR falls back to the original
-- @marpe-only rule so nothing breaks before you've flipped the
-- flag on any row. See the UPDATE near the bottom of this file.

create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select p.is_admin or lower(p.username) = 'marpe' from public.profiles p where p.id = auth.uid()),
    false
  );
$$;

grant execute on function public.is_admin() to anon, authenticated;

-- ── 3. Users: verify, suspend (with reason + optional expiry), unsuspend ──

create or replace function public.admin_verify_user(target_user_id uuid, make_verified boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.profiles set verified = make_verified where id = target_user_id;
end;
$$;

-- until = null means an indefinite/permanent suspension (lifted only
-- by an explicit unsuspend). A non-null timestamp auto-lifts itself —
-- see clear_expired_suspension() below and the best-effort pg_cron
-- job at the bottom of this file.
create or replace function public.admin_suspend_user(target_user_id uuid, reason text default null, until timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'cannot suspend your own account';
  end if;
  update public.profiles
    set banned = true,
        suspend_reason = nullif(trim(coalesce(reason, '')), ''),
        suspended_until = until
    where id = target_user_id;
end;
$$;

-- Kept as a thin wrapper so anything still calling the old
-- admin_ban_user (permanent ban) keeps working.
create or replace function public.admin_ban_user(target_user_id uuid, make_banned boolean)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if make_banned then
    perform public.admin_suspend_user(target_user_id, null, null);
  else
    update public.profiles set banned = false, suspended_until = null, suspend_reason = null where id = target_user_id;
  end if;
end;
$$;

create or replace function public.admin_unsuspend_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.profiles set banned = false, suspended_until = null, suspend_reason = null where id = target_user_id;
end;
$$;

grant execute on function public.admin_suspend_user(uuid, text, timestamptz) to authenticated;
grant execute on function public.admin_ban_user(uuid, boolean)               to authenticated;
grant execute on function public.admin_unsuspend_user(uuid)                  to authenticated;

-- Called by js/auth.js for the currently-logged-in user right after
-- their profile loads: if their suspension has an expiry that's
-- already passed, lift it immediately instead of making them wait
-- for the cron sweep. SECURITY DEFINER but scoped to auth.uid() only
-- — a user can only ever clear their own expired suspension, never
-- anyone else's.
create or replace function public.clear_expired_suspension()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  affected int;
begin
  update public.profiles
    set banned = false, suspended_until = null, suspend_reason = null
    where id = auth.uid()
      and banned = true
      and suspended_until is not null
      and suspended_until <= now();
  get diagnostics affected = row_count;
  return affected > 0;
end;
$$;

grant execute on function public.clear_expired_suspension() to authenticated;

-- ── 4. Delete: posts (kept for compatibility), replies, articles ──

create or replace function public.admin_delete_post(post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.posts set is_deleted = true where id = post_id;
end;
$$;

create or replace function public.admin_delete_reply(reply_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.replies set is_deleted = true where id = reply_id;
end;
$$;

create or replace function public.admin_delete_article(article_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.articles set is_deleted = true where id = article_id;
end;
$$;

grant execute on function public.admin_delete_post(uuid)    to authenticated;
grant execute on function public.admin_delete_reply(uuid)   to authenticated;
grant execute on function public.admin_delete_article(uuid) to authenticated;

-- ── 5. Reports queue ──────────────────────────────────────────
-- reports.sql made this table write-only (insert your own report,
-- read nothing) on purpose. These two functions are the sanctioned
-- way to read/resolve it without ever putting a service_role key in
-- the browser — they run as SECURITY DEFINER and re-check is_admin()
-- themselves, same as every other function on this page.

-- Defensive drop: a live project may already have a
-- report_community.sql-shaped admin_list_reports() (extra
-- community_id/name/slug OUT columns) from a prior run — CREATE OR
-- REPLACE can't change a function's return row shape, only DROP +
-- CREATE can, so this always drops first regardless of which shape
-- (if any) currently exists. The report_community.sql section later
-- in this file recreates the wider version on top of this one.
drop function if exists public.admin_list_reports(text);

create or replace function public.admin_list_reports(status_filter text default 'open')
returns table (
  id                     uuid,
  created_at             timestamptz,
  reason                 text,
  details                text,
  status                 text,
  reporter_id            uuid,
  reporter_username      text,
  post_id                uuid,
  post_body              text,
  post_author_id         uuid,
  post_author_username   text,
  reply_id               uuid,
  reply_body             text,
  reply_author_id        uuid,
  reply_author_username  text,
  reported_user_id       uuid,
  reported_username      text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  return query
  select
    r.id, r.created_at, r.reason, r.details, r.status,
    r.reporter_id, rp.username,
    r.post_id, p.body, p.author_id, pa.username,
    r.reply_id, rl.body, rl.author_id, ra.username,
    r.reported_user_id, ru.username
  from public.reports r
  left join public.profiles rp on rp.id = r.reporter_id
  left join public.posts    p  on p.id  = r.post_id
  left join public.profiles pa on pa.id = p.author_id
  left join public.replies  rl on rl.id = r.reply_id
  left join public.profiles ra on ra.id = rl.author_id
  left join public.profiles ru on ru.id = r.reported_user_id
  where status_filter = 'all' or r.status = status_filter
  order by r.created_at desc
  limit 100;
end;
$$;

create or replace function public.admin_set_report_status(report_id uuid, new_status text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if new_status not in ('open','actioned','dismissed') then
    raise exception 'invalid status';
  end if;
  update public.reports
    set status = new_status, reviewed_at = now(), reviewed_by = auth.uid()
    where id = report_id;
end;
$$;

grant execute on function public.admin_list_reports(text)       to authenticated;
grant execute on function public.admin_set_report_status(uuid, text) to authenticated;

-- ── 6. Dashboard counters (open reports badge, quick totals) ──

create or replace function public.admin_stats()
returns table (open_reports bigint, total_users bigint, banned_users bigint, total_posts bigint, total_articles bigint)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  return query select
    (select count(*) from public.reports where status = 'open'),
    (select count(*) from public.profiles),
    (select count(*) from public.profiles where banned = true),
    (select count(*) from public.posts where is_deleted = false),
    (select count(*) from public.articles where is_deleted = false);
end;
$$;

grant execute on function public.admin_stats() to authenticated;

-- ── 7. Best-effort auto-unsuspend sweep ────────────────────────
-- Belt-and-suspenders on top of clear_expired_suspension(): if a
-- timed-out suspended user never comes back to trigger their own
-- clear, this sweeps expired suspensions every 5 minutes so the
-- admin panel's "Suspended" list doesn't quietly go stale. Skipped
-- silently if pg_cron isn't enabled on your project (Database →
-- Extensions → pg_cron) — nothing else here depends on it.
do $$
begin
  begin
    create extension if not exists pg_cron;
  exception when others then null;
  end;
  begin
    perform cron.unschedule('interactink_auto_unsuspend');
  exception when others then null;
  end;
  begin
    perform cron.schedule(
      'interactink_auto_unsuspend',
      '*/5 * * * *',
      $cron$
        update public.profiles
          set banned = false, suspended_until = null, suspend_reason = null
          where banned = true and suspended_until is not null and suspended_until <= now();
      $cron$
    );
  exception when others then
    raise notice 'pg_cron unavailable — skipping the auto-unsuspend sweep. Expired suspensions still lift the moment that user next loads the site (see clear_expired_suspension in js/auth.js).';
  end;
end $$;

-- ── 8. Make @marpe an admin under the new flag ─────────────────
-- The is_admin() function above already falls back to the @marpe
-- username rule, so this isn't strictly required — but setting the
-- real flag means you can add a second admin later just by running:
--   update public.profiles set is_admin = true where lower(username) = 'someoneelse';
-- and you're never stuck hardcoding usernames again.
update public.profiles set is_admin = true where lower(username) = 'marpe';


-- ################################################################
-- FROM: supabase/admin_panel_restore.sql
-- ################################################################
-- ============================================================
-- ADMIN PANEL — RESTORE (UNDELETE)
-- Run this after admin_panel_advanced.sql. Additive/idempotent
-- like the other migrations here — safe to re-run any time.
--
-- admin_panel_advanced.sql added delete for posts/replies/articles
-- (soft-delete via is_deleted = true) but no way back. This adds
-- the other half: restore each of those, so a misclick — or a
-- report that turns out to be bogus — isn't permanent. The admin
-- panel's Posts/Replies/Articles tabs use these to power a
-- "Show deleted" toggle with a Restore button.
--
-- Same guarantee as every other admin_* function: re-checks
-- is_admin() itself server-side, so this is safe even if someone
-- bypassed the UI and called the RPC directly.
-- ============================================================

create or replace function public.admin_restore_post(post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.posts set is_deleted = false where id = post_id;
end;
$$;

create or replace function public.admin_restore_reply(reply_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.replies set is_deleted = false where id = reply_id;
end;
$$;

create or replace function public.admin_restore_article(article_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.articles set is_deleted = false where id = article_id;
end;
$$;

grant execute on function public.admin_restore_post(uuid)    to authenticated;
grant execute on function public.admin_restore_reply(uuid)   to authenticated;
grant execute on function public.admin_restore_article(uuid) to authenticated;


-- ################################################################
-- FROM: supabase/admin_lock_to_marpe.sql
-- ################################################################
-- ============================================================
-- ADMIN — LOCK ACCESS TO @marpe ONLY
-- Run this after admin_panel_advanced.sql. Safe to re-run any time.
--
-- is_admin() already grants access to whoever has is_admin = true
-- OR whose username is 'marpe' (see admin_panel_advanced.sql). That
-- second clause means access is already restricted to @marpe as
-- long as no other row's is_admin flag ever gets set to true. This
-- migration makes that a hard guarantee instead of an assumption:
-- it strips the flag from every account except @marpe, and sets it
-- on @marpe so the panel keeps working even if the username ever
-- changes later.
-- ============================================================

update public.profiles set is_admin = false where lower(username) <> 'marpe' and is_admin = true;
update public.profiles set is_admin = true  where lower(username) = 'marpe';


-- ################################################################
-- FROM: supabase/add_age_gender.sql
-- ################################################################
-- ─────────────────────────────────────────────────────────────
-- ADD AGE + GENDER TO SIGNUP
--
-- Adds two nullable columns to public.profiles. Nullable (not
-- NOT NULL) on purpose: this runs against a project that may
-- already have real accounts created before this migration
-- existed, and a NOT NULL column would fail on those existing
-- rows. New signups always populate both — auth.js's doSignUp()
-- validates both are present client-side before submitting, and
-- the CHECK constraints below enforce it server-side too.
--
-- age  — plain integer, checked to sit in [13, 120]. 120 is the
--        product's stated max; 13 is a floor to reject 0/negative
--        or accidental-typo values, ordinary practice for
--        anything social-network-shaped.
-- gender — a fixed set of 4 values, matching the signup form's
--        four options exactly.
--
-- Nothing here touches the handle_new_user() trigger that creates
-- the profiles row on signup — that function isn't included in
-- this project's SQL export, and blindly redefining it without
-- seeing its current body risks breaking the auto-follow-@marpe /
-- username-claim logic it already does. Instead, auth.js writes
-- age/gender via a normal UPDATE right after signUp() returns a
-- session, which is covered by the existing "users can update
-- their own profile" RLS policy — no new policy needed.
-- ─────────────────────────────────────────────────────────────

alter table public.profiles add column if not exists age integer;
alter table public.profiles add column if not exists gender text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_age_range'
  ) then
    alter table public.profiles
      add constraint profiles_age_range check (age is null or (age >= 13 and age <= 120));
  end if;

  if not exists (
    select 1 from pg_constraint where conname = 'profiles_gender_valid'
  ) then
    alter table public.profiles
      add constraint profiles_gender_valid check (gender is null or gender in ('male', 'female', 'other', 'not_specified'));
  end if;
end $$;

comment on column public.profiles.age is 'Self-reported age at signup, 13-120. Collected once at signup, not editable via the app UI.';
comment on column public.profiles.gender is 'One of: male, female, other, not_specified. Collected once at signup, not editable via the app UI.';

-- ─────────────────────────────────────────────────────────────
-- VERIFICATION TYPES — blue / gold / purple checkmarks
--
-- Previously "verified" was a single boolean rendered as one
-- purple badge. This adds a second column, verification_type,
-- so the admin panel can pick which mark a verified user gets:
--   'purple' — the original badge (default when verified with
--              no type set, e.g. rows verified before this
--              migration ran)
--   'blue'   — standard individual verification
--   'gold'   — organization/business verification; the frontend
--              (see avSqClass() in js/common.js) also renders
--              that user's avatar as a rounded square instead
--              of a circle, matching X/Twitter's convention.
--
-- `verified` boolean is kept in sync (true whenever
-- verification_type is not null) so any code that only checks
-- `profile.verified` — without knowing about types — keeps
-- working exactly as before.
-- ─────────────────────────────────────────────────────────────

alter table public.profiles add column if not exists verification_type text;

do $$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'profiles_verification_type_valid'
  ) then
    alter table public.profiles
      add constraint profiles_verification_type_valid
      check (verification_type is null or verification_type in ('blue', 'gold', 'purple'));
  end if;
end $$;

comment on column public.profiles.verification_type is 'One of: blue, gold, purple, or null. Null with verified=true (legacy rows) renders as purple. Set/cleared together with verified by admin_verify_user().';

-- Backfill: anyone already verified before this migration gets the
-- original purple badge so nothing visually changes for them.
update public.profiles set verification_type = 'purple' where verified = true and verification_type is null;

-- Replace admin_verify_user() to take a type instead of a plain
-- boolean. make_verified=false always clears both columns
-- regardless of what verification_type is passed. Passing
-- make_verified=true with a null/omitted type defaults to 'purple'
-- so existing callers (or a stray RPC call without the new arg)
-- keep the old behavior instead of silently failing the check
-- constraint.
--
-- The old (uuid, boolean) two-arg version is dropped first —
-- adding a parameter makes this a different signature, so
-- "create or replace" alone would leave both overloads in place
-- and PostgREST would then see an ambiguous call whenever a
-- request only supplies target_user_id + make_verified.
-- Drop every existing overload of admin_verify_user, whatever its
-- signature or parameter names — create or replace cannot rename
-- params or resolve overload ambiguity, so a plain "drop if exists"
-- with one guessed signature isn't reliable enough here.
do $$
declare
  r record;
begin
  for r in
    select oid::regprocedure as sig
    from pg_proc
    where proname = 'admin_verify_user'
      and pronamespace = 'public'::regnamespace
  loop
    execute format('drop function %s', r.sig);
  end loop;
end $$;

-- The third parameter is named p_verification_type (not just
-- verification_type) on purpose — plpgsql can't tell a bare
-- parameter name apart from a same-named column inside the
-- UPDATE below, and silently picks one, which is exactly the
-- "column reference verification_type is ambiguous" error this
-- avoids.
create or replace function public.admin_verify_user(target_user_id uuid, make_verified boolean, p_verification_type text default 'purple')
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if make_verified and p_verification_type not in ('blue', 'gold', 'purple') then
    raise exception 'invalid verification_type: %', p_verification_type;
  end if;
  update public.profiles
    set verified = make_verified,
        verification_type = case when make_verified then p_verification_type else null end
    where id = target_user_id;
end;
$$;

grant execute on function public.admin_verify_user(uuid, boolean, text) to authenticated;
notify pgrst, 'reload schema';

-- ################################################################
-- ### BELOW: supabase/RUN_PENDING_MIGRATIONS.sql (chat/DMs, groups,
-- ### channels, group/channel avatars, voice-note fix — not yet in
-- ### the master file above)
-- ################################################################

-- ═══════════════════════════════════════════════════════════════
-- INTERACTINK — PENDING MIGRATIONS (run this once)
--
-- Everything in MASTER_MIGRATIONS_reconstructed.sql should already
-- be applied to your project. These six files are NOT in that
-- master yet — they're what's needed for chat/DMs, groups &
-- channels, group/channel avatars, and today's voice-note upload
-- fix. Every statement here is written to be safe to re-run
-- (if not exists / drop-if-exists-then-create), so it's fine to
-- run this whole file even if some pieces already partially
-- exist on your project.
--
-- Run this in the Supabase SQL editor, top to bottom, in one go.
-- ═══════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────
-- FROM: supabase/fix_messages_body_check.sql
-- ───────────────────────────────────────────────────────────────
-- Drops a stale pre-existing `messages_body_check` constraint (not
-- created by any file in this repo — left over from the table's
-- original creation) that rejects the empty-string body the app
-- sends for a caption-less photo/video/voice-note attachment. See
-- that file for the full explanation. Run this early, before the
-- PART 1 media-attachment block below, so uploading media never hits
-- it even mid-migration.
alter table public.messages alter column body drop not null;
alter table public.messages drop constraint if exists messages_body_check;

-- ───────────────────────────────────────────────────────────────
-- FROM: supabase/chat_full_setup.sql
-- ───────────────────────────────────────────────────────────────
-- ============================================================
-- CHAT — full setup for media attachments, sharing posts into a
-- chat, and group/channel messaging. Safe to re-run any time —
-- every statement is idempotent. Run this whole file once in the
-- Supabase SQL editor.
--
-- Covers three things:
--   PART 1 — media attachments on messages (images/video/voice
--            notes). Same as supabase/chat_media.sql — included
--            here again so this file is a complete, standalone
--            setup script; re-running it is harmless.
--   PART 2 — sharing a post into a chat (a message that embeds a
--            post, like retweeting into a DM).
--   PART 3 — group chats and channels: new `conversations` /
--            `conversation_members` tables, and extending
--            `messages` so a row can belong to either a 1:1 DM
--            (sender_id/recipient_id, as today) or a group/channel
--            (conversation_id) — never both.
--
-- SCHEMA NOTE assumed from the existing app: `public.messages`
-- already exists with (at least) id, sender_id, recipient_id, body,
-- iv, read, created_at, and `public.posts`/`public.profiles` already
-- exist. This file only adds to them — it never drops or rewrites
-- your existing DM policies, since this script can't see their
-- exact names. New RLS policies below are additive (Postgres OR's
-- multiple permissive policies together), so existing 1:1 DM access
-- keeps working exactly as it does today.
--
-- ENCRYPTION NOTE: message text stays end-to-end encrypted for 1:1
-- DMs only (per-pair ECDH, see js/chat-crypto.js — unchanged by this
-- file). Group/channel messages are plain text server-side, and
-- media attachments (in any context) are plain public URLs, same
-- trust model as a post's image — see the PART 1 comment below for
-- why.
-- ============================================================

create extension if not exists pgcrypto;

-- ────────────────────────────────────────────────────────────
-- PART 1 — MEDIA ATTACHMENTS (images / video / voice notes)
-- ────────────────────────────────────────────────────────────
-- Media is uploaded to the same public "media" storage bucket posts
-- and replies already use (see MEDIA_BUCKET / uploadMedia() in
-- js/common.js) — no new bucket or storage policy needed, since that
-- bucket's insert/select policies are already scoped to "any
-- authenticated user can upload, anyone can read the public URL".
--
-- Attached media is NOT end-to-end encrypted — it's a plain public
-- URL. A message's body/iv (caption) still goes through the normal
-- 1:1 E2E path independently, so a photo can have an encrypted
-- caption, an unencrypted one, or no caption at all (body = '').

alter table public.messages add column if not exists media_url text;
alter table public.messages add column if not exists media_type text
  check (media_type in ('image', 'video', 'audio'));

comment on column public.messages.media_url is
  'Public URL of an attached image/video/voice-note in the shared "media" storage bucket. NULL = no attachment.';
comment on column public.messages.media_type is
  'image | video | audio (voice note). NULL when media_url is NULL.';

-- ────────────────────────────────────────────────────────────
-- PART 2 — SHARING A POST INTO A CHAT
-- ────────────────────────────────────────────────────────────
-- A message can embed a post (like "Send via Chat" already partially
-- supports at the UI-prefill level — see list.js's listMenuSendChat()
-- — this is the DB-level version: an actual structured reference
-- instead of just prefilled text). on delete set null (not cascade):
-- deleting the original post shouldn't delete someone's message, it
-- should just leave the embed pointing at nothing (render as
-- "this post was deleted" client-side).

alter table public.messages add column if not exists shared_post_id uuid
  references public.posts(id) on delete set null;

create index if not exists messages_shared_post_idx
  on public.messages(shared_post_id) where shared_post_id is not null;

comment on column public.messages.shared_post_id is
  'Set when this message is sharing a post into the chat, X-style. NULL for ordinary messages.';

-- A message must contain *something* — text, media, or a shared
-- post. Replaces the narrower version of this constraint from
-- chat_media.sql (which didn't know about shared_post_id yet).
--
-- Written to also allow a tombstoned "delete for everyone" row
-- through (deleted_for_everyone = true, body/media/shared_post_id
-- all cleared) — see chat_delete_messages_and_contacts.sql later in
-- this file. That column doesn't exist yet on a brand-new project,
-- so it's added here (harmless no-op if it already exists — e.g. on
-- a project that already has real tombstoned messages from prior
-- use of the delete feature) so this ADD CONSTRAINT doesn't reject
-- rows that are legitimately empty because they were deleted, not
-- because they're broken.
alter table public.messages add column if not exists deleted_for_everyone boolean not null default false;

-- Defensive backfill: mark any row that's already contentless (no
-- body, no media, no shared post) as tombstoned, whatever the reason
-- it ended up that way (an old bug, a manual edit, anything). This
-- doesn't discard any real data — a row already has nothing to show
-- — it just makes the ADD CONSTRAINT below succeed no matter what's
-- currently in the table, instead of failing on rows this script has
-- no way to know about in advance.
update public.messages
  set deleted_for_everyone = true
  where not deleted_for_everyone
    and coalesce(body, '') = ''
    and media_url is null
    and shared_post_id is null;

alter table public.messages drop constraint if exists messages_body_or_media_chk;
alter table public.messages drop constraint if exists messages_has_content_chk;
alter table public.messages add constraint messages_has_content_chk
  check (deleted_for_everyone or coalesce(body, '') <> '' or media_url is not null or shared_post_id is not null);

-- ────────────────────────────────────────────────────────────
-- PART 3 — GROUP CHATS & CHANNELS
-- ────────────────────────────────────────────────────────────
-- `conversations` is the group/channel itself; `conversation_members`
-- is who's in it and their role. `kind` distinguishes the two:
--   'group'   — any member can post (like a Telegram group).
--   'channel' — only owner/admin can post; everyone else just reads
--               (like a Telegram channel / broadcast list).
-- `is_public` lets a channel (or group) be discovered and joined by
-- anyone without an invite — private ones only show up for members.

create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('group', 'channel')),
  name        text not null,
  description text,
  avatar_url  text,
  is_public   boolean not null default false,
  created_by  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  role            text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at       timestamptz not null default now(),
  last_read_at    timestamptz,
  primary key (conversation_id, user_id)
);

create index if not exists conversation_members_user_idx on public.conversation_members(user_id);
create index if not exists conversations_public_idx on public.conversations(is_public) where is_public = true;

-- `messages.conversation_id` — a group/channel message. A row now
-- belongs to *either* a 1:1 DM (sender_id/recipient_id, as today) or
-- a group/channel (conversation_id), never both — hence recipient_id
-- becoming nullable and the new check constraint.
alter table public.messages add column if not exists conversation_id uuid
  references public.conversations(id) on delete cascade;

alter table public.messages alter column recipient_id drop not null;

alter table public.messages drop constraint if exists messages_target_chk;
alter table public.messages add constraint messages_target_chk
  check (
    (conversation_id is not null and recipient_id is null)
    or (conversation_id is null and recipient_id is not null)
  );

create index if not exists messages_conversation_idx
  on public.messages(conversation_id, created_at) where conversation_id is not null;

comment on column public.messages.conversation_id is
  'Set for a group/channel message. Mutually exclusive with recipient_id (1:1 DM).';

-- ── force created_by server-side (same pattern as articles_full_setup.sql) ──
create or replace function public.conversations_force_creator()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.created_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists conversations_force_creator_trg on public.conversations;
create trigger conversations_force_creator_trg
  before insert on public.conversations
  for each row execute function public.conversations_force_creator();

-- ── auto-add the creator as owner ──
-- Runs as security definer so it isn't blocked by conversation_members'
-- own RLS (the creator's membership row is what most of those
-- policies rely on existing in the first place).
create or replace function public.conversations_add_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.conversation_members (conversation_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict (conversation_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists conversations_add_owner_trg on public.conversations;
create trigger conversations_add_owner_trg
  after insert on public.conversations
  for each row execute function public.conversations_add_owner();

-- ── force sender_id server-side on group/channel messages ──
-- Only touches rows that are actually group/channel messages
-- (conversation_id is not null); 1:1 DM inserts are untouched, so
-- whatever your existing messages insert trigger/policy does for
-- those keeps doing it.
create or replace function public.messages_force_sender_for_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.conversation_id is not null then
    new.sender_id := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists messages_force_sender_conversation_trg on public.messages;
create trigger messages_force_sender_conversation_trg
  before insert on public.messages
  for each row execute function public.messages_force_sender_for_conversation();

-- ── RLS: conversations ──
alter table public.conversations enable row level security;

drop policy if exists "conversations_select" on public.conversations;
create policy "conversations_select" on public.conversations
  for select
  to authenticated
  using (
    is_public = true
    or exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversations.id and cm.user_id = auth.uid()
    )
  );

drop policy if exists "conversations_insert" on public.conversations;
create policy "conversations_insert" on public.conversations
  for insert
  to authenticated
  with check (created_by = auth.uid());

-- Only owner/admin can rename, re-describe, re-avatar, or flip
-- public/private.
drop policy if exists "conversations_update_admin" on public.conversations;
create policy "conversations_update_admin" on public.conversations
  for update
  to authenticated
  using (
    exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversations.id and cm.user_id = auth.uid()
        and cm.role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversations.id and cm.user_id = auth.uid()
        and cm.role in ('owner', 'admin')
    )
  );

-- Only the owner can delete the whole group/channel.
drop policy if exists "conversations_delete_owner" on public.conversations;
create policy "conversations_delete_owner" on public.conversations
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversations.id and cm.user_id = auth.uid()
        and cm.role = 'owner'
    )
  );

-- ── RLS: conversation_members ──
alter table public.conversation_members enable row level security;

-- Any current member can see the member list of a conversation
-- they're in (self-referencing EXISTS — a standard, non-recursive
-- pattern for "am I in this group" checks).
drop policy if exists "conversation_members_select" on public.conversation_members;
create policy "conversation_members_select" on public.conversation_members
  for select
  to authenticated
  using (
    exists (
      select 1 from public.conversation_members cm2
      where cm2.conversation_id = conversation_members.conversation_id and cm2.user_id = auth.uid()
    )
  );

-- Owner/admin can add anyone to a group/channel.
drop policy if exists "conversation_members_insert_admin" on public.conversation_members;
create policy "conversation_members_insert_admin" on public.conversation_members
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversation_members.conversation_id and cm.user_id = auth.uid()
        and cm.role in ('owner', 'admin')
    )
  );

-- Anyone can join a public group/channel themselves (self-serve
-- subscribe, like following a Telegram channel).
drop policy if exists "conversation_members_insert_self_public" on public.conversation_members;
create policy "conversation_members_insert_self_public" on public.conversation_members
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_members.conversation_id and c.is_public = true
    )
  );

-- A member can update their own row (e.g. last_read_at for unread
-- counts). Role changes by admins are a v2 concern — kept out of
-- scope here to avoid a self-escalation hole.
drop policy if exists "conversation_members_update_own" on public.conversation_members;
create policy "conversation_members_update_own" on public.conversation_members
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Leave a conversation yourself, or be removed by an owner/admin.
drop policy if exists "conversation_members_delete_self" on public.conversation_members;
create policy "conversation_members_delete_self" on public.conversation_members
  for delete
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "conversation_members_delete_admin" on public.conversation_members;
create policy "conversation_members_delete_admin" on public.conversation_members
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversation_members.conversation_id and cm.user_id = auth.uid()
        and cm.role in ('owner', 'admin')
    )
  );

-- ── RLS: messages, additive policies for the conversation_id case ──
-- These are new, separate policies scoped to `conversation_id is not
-- null` — they don't touch or replace whatever policies already
-- govern the 1:1 DM case (sender_id/recipient_id), since Postgres
-- combines multiple permissive policies for the same command with
-- OR.
drop policy if exists "messages_select_conversation" on public.messages;
create policy "messages_select_conversation" on public.messages
  for select
  to authenticated
  using (
    conversation_id is not null
    and exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = messages.conversation_id and cm.user_id = auth.uid()
    )
  );

-- Any member can post in a 'group'; only owner/admin can post in a
-- 'channel'. sender_id is re-forced server-side above regardless of
-- what the client sends.
drop policy if exists "messages_insert_conversation" on public.messages;
create policy "messages_insert_conversation" on public.messages
  for insert
  to authenticated
  with check (
    conversation_id is not null
    and exists (
      select 1
      from public.conversation_members cm
      join public.conversations c on c.id = cm.conversation_id
      where cm.conversation_id = messages.conversation_id and cm.user_id = auth.uid()
        and (c.kind = 'group' or cm.role in ('owner', 'admin'))
    )
  );

-- A member can delete their own group/channel message (soft- or
-- hard-delete, matching whatever convention posts.sql already uses
-- for is_deleted — adjust to `update ... set is_deleted = true` client
-- side if this app soft-deletes rather than hard-deletes messages).
drop policy if exists "messages_delete_own_conversation" on public.messages;
create policy "messages_delete_own_conversation" on public.messages
  for delete
  to authenticated
  using (conversation_id is not null and sender_id = auth.uid());

-- ── REALTIME ──
-- `messages` is already in the realtime publication (that's how 1:1
-- DM delivery works today) — conversation_id rides on the same table
-- so nothing extra is needed there. The two new tables aren't,
-- though, so group/channel membership changes and metadata edits
-- won't push over realtime until they're added. Guarded with a DO
-- block since `alter publication ... add table` errors (rather than
-- no-ops) if the table's already a member.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversations'
  ) then
    alter publication supabase_realtime add table public.conversations;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversation_members'
  ) then
    alter publication supabase_realtime add table public.conversation_members;
  end if;
end $$;


-- ───────────────────────────────────────────────────────────────
-- FROM: supabase/chat_media.sql
-- ───────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────
-- CHAT MEDIA — lets DM messages carry an image, video, or voice
-- note, with or without a text caption.
--
-- Media is uploaded to the same public "media" storage bucket posts
-- and replies already use (see MEDIA_BUCKET / uploadMedia() in
-- js/common.js) — no new bucket or storage policy needed, since that
-- bucket's insert/select policies are already scoped to "any
-- authenticated user can upload, anyone can read the public URL".
--
-- NOTE ON ENCRYPTION: unlike message text (see chat_e2e_encryption.sql
-- / js/chat-crypto.js), attached media is NOT end-to-end encrypted.
-- It's a plain public URL, same trust model as post/reply media. A
-- message's `body`/`iv` (caption) still go through the normal E2E
-- path independently — a photo can have an encrypted caption, an
-- unencrypted one, or no caption at all (body = '').
-- ─────────────────────────────────────────────────────────────

alter table public.messages add column if not exists media_url text;
alter table public.messages add column if not exists media_type text
  check (media_type in ('image', 'video', 'audio'));

comment on column public.messages.media_url is
  'Public URL of an attached image/video/voice-note in the shared "media" storage bucket. NULL = text-only message.';
comment on column public.messages.media_type is
  'image | video | audio (voice note). NULL when media_url is NULL.';

-- A message must either say something or attach something. NOTE:
-- this constraint (from the older, standalone chat_media.sql) is
-- superseded by messages_has_content_chk, added earlier in this file
-- from chat_full_setup.sql — that version already covers everything
-- this one does, plus shared_post_id and deleted_for_everyone
-- tombstones. Adding this narrower one on top would just reject
-- those same tombstoned rows all over again, so it's dropped here
-- and not re-created.
alter table public.messages drop constraint if exists messages_body_or_media_chk;


-- ───────────────────────────────────────────────────────────────
-- FROM: supabase/chat_group_avatar_and_names.sql
-- ───────────────────────────────────────────────────────────────
-- ============================================================
-- CHAT — group/channel avatars + names/descriptions.
-- Safe to re-run any time — every statement is idempotent.
--
-- This is a standalone confirmation/completion script for the
-- avatar-upload + rename feature added to the "New group"/"New
-- channel" modal and the group-info panel. Most of this already
-- exists if supabase/chat_full_setup.sql has been run — this file
-- just makes sure every piece it depends on is actually in place,
-- and is safe to run on its own even if chat_full_setup.sql never
-- was.
-- ============================================================

-- ── conversations table + columns ──
-- (No-op if supabase/chat_full_setup.sql already created this.)
create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('group', 'channel')),
  name        text not null,
  description text,
  avatar_url  text,
  is_public   boolean not null default false,
  created_by  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now()
);
alter table public.conversations add column if not exists avatar_url text;
alter table public.conversations add column if not exists description text;

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  role            text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at       timestamptz not null default now(),
  last_read_at    timestamptz,
  primary key (conversation_id, user_id)
);

comment on column public.conversations.avatar_url is
  'Public URL of the group/channel picture, in the shared "avatars" storage bucket (same bucket/policy as profile pictures — see uploadAvatar() in js/auth.js). NULL = no picture set, client falls back to an initial-letter avatar.';

-- ── RLS ──
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;

-- Only a current owner/admin may rename, re-describe, re-avatar, or
-- flip public/private on an existing group/channel. (Anyone can
-- still INSERT a new one — see "conversations_insert" in
-- chat_full_setup.sql, unaffected by this file.)
drop policy if exists "conversations_update_admin" on public.conversations;
create policy "conversations_update_admin" on public.conversations
  for update
  to authenticated
  using (
    exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversations.id and cm.user_id = auth.uid()
        and cm.role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversations.id and cm.user_id = auth.uid()
        and cm.role in ('owner', 'admin')
    )
  );

-- Every current member can read the group/channel row (name,
-- avatar_url, description, is_public, etc.) — needed for the info
-- panel and conversation-list rows to render at all.
drop policy if exists "conversations_select_member" on public.conversations;
create policy "conversations_select_member" on public.conversations
  for select
  to authenticated
  using (
    is_public = true
    or exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversations.id and cm.user_id = auth.uid()
    )
  );

-- ── STORAGE — group/channel avatars reuse the existing "avatars"
-- bucket (same one profile pictures use), uploaded to the acting
-- user's own <uid> folder — see uploadAvatar() in js/auth.js. That
-- bucket's policies already allow any authenticated user to write
-- inside their own folder and let anyone read the public URL, so no
-- new bucket or storage policy is needed here. This block only
-- creates the bucket if this project genuinely doesn't have it yet
-- (fresh Supabase project) — it's a no-op everywhere else.
insert into storage.buckets (id, name, public)
select 'avatars', 'avatars', true
where not exists (select 1 from storage.buckets where id = 'avatars');

drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read" on storage.objects
  for select
  to public
  using (bucket_id = 'avatars');

drop policy if exists "avatars_own_folder_write" on storage.objects;
create policy "avatars_own_folder_write" on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars_own_folder_update" on storage.objects;
create policy "avatars_own_folder_update" on storage.objects
  for update
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);


-- ───────────────────────────────────────────────────────────────
-- FROM: supabase/fix_media_bucket_audio_mime.sql
-- ───────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────
-- FIX: voice notes fail to upload with "mime type audio/webm is
-- not supported" (and similarly for audio/mp4, audio/ogg).
--
-- Root cause: the shared "media" storage bucket (see MEDIA_BUCKET /
-- uploadMedia() in js/common.js — created outside these migrations,
-- directly in the Supabase dashboard, back when it only had to hold
-- post/reply images and videos) has an allowed_mime_types allow-list
-- that was never updated when voice notes were added in
-- chat_media.sql. Supabase Storage rejects the upload at the bucket
-- level before it ever reaches app code, which is what surfaces as
-- that raw "mime type ... is not supported" error in the UI.
--
-- This sets the bucket to accept the actual set of types every
-- uploader in this app can produce:
--  - images: compressImageFile()/compressGifFile() output + originals
--  - video:  uploaded as-is (see the note in uploadMedia())
--  - audio:  startVoiceRecording()'s MediaRecorder, whichever of
--            audio/webm, audio/mp4, audio/ogg the browser picked
--
-- Safe to run repeatedly — it's a plain update, not an insert.
-- ─────────────────────────────────────────────────────────────

update storage.buckets
set allowed_mime_types = array[
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav'
],
    file_size_limit = coalesce(file_size_limit, 52428800) -- 50MB, only if not already set
where id = 'media';

-- If this project genuinely never had the bucket at all, create it
-- now with the right allow-list already in place (no-op everywhere
-- the bucket already exists, per the `where not exists` guard).
insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
select 'media', 'media', true, array[
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav'
], 52428800
where not exists (select 1 from storage.buckets where id = 'media');


-- ───────────────────────────────────────────────────────────────
-- FROM: supabase/ip_ban.sql
-- ───────────────────────────────────────────────────────────────
-- ============================================================
-- IP BAN — suspending someone now bans their known IP address(es)
-- too, not just the account. Run after admin_panel_advanced.sql and
-- suspend_deletes_content.sql. Additive/idempotent — safe to re-run.
--
-- WHY: banning only the account (profiles.banned) is trivial to
-- evade — sign up again with a new email and you're back. This adds
-- a second, IP-based layer:
--   1. public.user_ips logs every IP each account has connected
--      from (recorded via api/ip.js, a Vercel function that reads
--      the *real* client IP from Vercel's own x-forwarded-for header
--      — not something the browser can just lie about the way it
--      could if the client sent its own IP value straight to
--      Postgres).
--   2. public.banned_ips is the deny-list. Suspending a user copies
--      every IP on file for them into it; unsuspending removes only
--      the rows that suspension added (a shared IP another still-
--      suspended account also used stays banned).
--   3. is_ip_banned() is a public RPC (works for signed-out visitors
--      too) that api/ip.js calls before letting someone sign up, and
--      that js/auth.js also checks once a session exists — so a
--      banned IP can neither create a new account nor keep an
--      existing session alive.
-- ============================================================

-- ── 1. Tables ───────────────────────────────────────────────

create table if not exists public.user_ips (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  ip         text not null,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  primary key (user_id, ip)
);
create index if not exists user_ips_ip_idx on public.user_ips(ip);

create table if not exists public.banned_ips (
  ip        text not null,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  banned_at timestamptz not null default now(),
  reason    text,
  primary key (ip, user_id)
);
create index if not exists banned_ips_ip_idx on public.banned_ips(ip);

alter table public.user_ips   enable row level security;
alter table public.banned_ips enable row level security;
-- No direct client policies on either table on purpose — every read/
-- write goes through the SECURITY DEFINER functions below, same
-- pattern the rest of the admin panel uses to avoid a service_role
-- key ever touching the browser.

-- ── 2. record_user_ip() — called by api/ip.js on every signup/login/
-- page load for a signed-in user, with the IP api/ip.js itself read
-- from the request headers (never trusted from the client body).
-- Upserts the IP against the caller's own account and returns
-- whether that IP is currently banned, so api/ip.js can act on it in
-- the same round trip. ──

create or replace function public.record_user_ip(p_ip text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or p_ip is null or trim(p_ip) = '' then
    return false;
  end if;
  insert into public.user_ips (user_id, ip, first_seen, last_seen)
    values (auth.uid(), p_ip, now(), now())
  on conflict (user_id, ip) do update set last_seen = now();

  return exists(select 1 from public.banned_ips b where b.ip = p_ip);
end;
$$;

-- ── 3. is_ip_banned() — public (anon-callable) so api/ip.js can
-- refuse a signup from a banned IP before an account even exists. ──

create or replace function public.is_ip_banned(p_ip text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(select 1 from public.banned_ips where ip = p_ip);
$$;

grant execute on function public.record_user_ip(text) to authenticated;
grant execute on function public.is_ip_banned(text)   to anon, authenticated;

-- ── 4. admin_get_user_ips() — lets the admin panel show which IPs
-- are on file for an account before/while suspending it. ──

create or replace function public.admin_get_user_ips(target_user_id uuid)
returns table(ip text, first_seen timestamptz, last_seen timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  return query
    select u.ip, u.first_seen, u.last_seen
    from public.user_ips u
    where u.user_id = target_user_id
    order by u.last_seen desc;
end;
$$;
grant execute on function public.admin_get_user_ips(uuid) to authenticated;

-- ── 5. Extend admin_suspend_user / admin_unsuspend_user (re-defined
-- from suspend_deletes_content.sql, plus the IP step) ──

create or replace function public.admin_suspend_user(target_user_id uuid, reason text default null, until timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'cannot suspend your own account';
  end if;
  update public.profiles
    set banned = true,
        suspend_reason = nullif(trim(coalesce(reason, '')), ''),
        suspended_until = until
    where id = target_user_id;

  update public.posts
    set is_deleted = true, deleted_by_suspension = true
    where author_id = target_user_id and is_deleted = false;
  update public.replies
    set is_deleted = true, deleted_by_suspension = true
    where author_id = target_user_id and is_deleted = false;

  -- Ban every IP this account has ever connected from, so a fresh
  -- account made from the same device/network is blocked at signup
  -- (see is_ip_banned() in api/ip.js's pre-signup check) instead of
  -- only the old account being locked out.
  insert into public.banned_ips (ip, user_id, reason)
    select u.ip, target_user_id, nullif(trim(coalesce(reason, '')), '')
    from public.user_ips u
    where u.user_id = target_user_id
  on conflict (ip, user_id) do update
    set reason = excluded.reason, banned_at = now();
end;
$$;

create or replace function public.admin_unsuspend_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.profiles set banned = false, suspended_until = null, suspend_reason = null where id = target_user_id;

  update public.posts
    set is_deleted = false, deleted_by_suspension = false
    where author_id = target_user_id and deleted_by_suspension = true;
  update public.replies
    set is_deleted = false, deleted_by_suspension = false
    where author_id = target_user_id and deleted_by_suspension = true;

  -- Only lift the IP bans THIS suspension added. If another still-
  -- suspended account shares one of these IPs, its own row (a
  -- different user_id on the same ip) stays behind and the IP stays
  -- banned — exactly the point of keying banned_ips by (ip, user_id).
  delete from public.banned_ips where user_id = target_user_id;
end;
$$;

grant execute on function public.admin_suspend_user(uuid, text, timestamptz) to authenticated;
grant execute on function public.admin_unsuspend_user(uuid)                  to authenticated;

notify pgrst, 'reload schema';


-- ───────────────────────────────────────────────────────────────
-- FROM: supabase/suspend_deletes_content.sql
-- ───────────────────────────────────────────────────────────────
-- ============================================================
-- SUSPEND -> AUTO-DELETE CONTENT
-- Run after admin_panel_advanced.sql. Additive/idempotent — safe to
-- re-run any time.
--
-- What this adds on top of admin_panel_advanced.sql's suspend/
-- unsuspend (which only flipped profiles.banned + metadata):
--   1. Every post and reply belonging to a user is automatically
--      soft-deleted (same is_deleted flag admin_delete_post/
--      admin_delete_reply already use) the moment they're suspended
--      — same as X, where a suspended account's posts disappear.
--   2. A new deleted_by_suspension flag on posts/replies marks which
--      ones were taken down *because of* the suspension, as opposed
--      to ones the author (or a mod) had already deleted themselves
--      beforehand. That distinction matters twice: unsuspending only
--      restores the former (a manually-deleted post doesn't come
--      back just because the account got unsuspended), and
--      quotedPostHtml() in js/common.js reads it to show "This post
--      is from a suspended account" instead of the generic "no
--      longer available" wording for quote-post embeds.
--   3. The username itself is never freed up — nothing here touches
--      the profiles row or its username, so the unique constraint on
--      profiles.username keeps anyone else from ever registering it,
--      exactly like a suspended handle on X.
-- ============================================================

alter table public.posts   add column if not exists deleted_by_suspension boolean not null default false;
alter table public.replies add column if not exists deleted_by_suspension boolean not null default false;

create or replace function public.admin_suspend_user(target_user_id uuid, reason text default null, until timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'cannot suspend your own account';
  end if;
  update public.profiles
    set banned = true,
        suspend_reason = nullif(trim(coalesce(reason, '')), ''),
        suspended_until = until
    where id = target_user_id;

  -- Only touch rows that weren't already deleted, so a post the
  -- author (or a mod) removed beforehand doesn't get relabeled as
  -- "deleted by suspension" and wrongly come back on unsuspend.
  update public.posts
    set is_deleted = true, deleted_by_suspension = true
    where author_id = target_user_id and is_deleted = false;
  update public.replies
    set is_deleted = true, deleted_by_suspension = true
    where author_id = target_user_id and is_deleted = false;
end;
$$;

create or replace function public.admin_unsuspend_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.profiles set banned = false, suspended_until = null, suspend_reason = null where id = target_user_id;

  -- Only restore what the suspension itself took down — leaves any
  -- of the user's own prior deletions alone.
  update public.posts
    set is_deleted = false, deleted_by_suspension = false
    where author_id = target_user_id and deleted_by_suspension = true;
  update public.replies
    set is_deleted = false, deleted_by_suspension = false
    where author_id = target_user_id and deleted_by_suspension = true;
end;
$$;

grant execute on function public.admin_suspend_user(uuid, text, timestamptz) to authenticated;
grant execute on function public.admin_unsuspend_user(uuid)                  to authenticated;
notify pgrst, 'reload schema';




-- ################################################################
-- ### BELOW: supabase/view_counts.sql (NEW — found missing during
-- ### an audit of every sb.rpc() call in js/*.js against the SQL
-- ### files present in this export; see that file's own header)
-- ################################################################

-- ============================================================
-- VIEW COUNTS — increment_post_view / increment_reply_views
-- ============================================================
-- js/common.js (bumpPostView / bumpReplyViews, called from thread.js
-- when a thread opens and from the feed's scroll-based view tracker)
-- calls these two RPCs by name:
--   sb.rpc('increment_post_view',   { p_id:  postId   })
--   sb.rpc('increment_reply_views', { p_ids: replyIds })
-- Neither function existed anywhere in the SQL export — every other
-- RPC the client calls (delete_own_post, edit_own_post, admin_*,
-- get_for_you_feed, etc.) has a matching definition in this project's
-- other migrations; these two didn't. That means every post/reply
-- view counter has been silently failing (caught by the .catch/
-- console.warn in bumpPostView/bumpReplyViews — it doesn't break the
-- page, the numbers just never move).
--
-- This assumes `posts.view_count` and `replies.view_count` already
-- exist as integer columns (the client already reads and displays
-- p.view_count / owner.view_count in thread.js, board.js, and
-- common.js, so those columns must already be present in your live
-- schema) — it only adds the two functions that increment them.
-- Safe to re-run.
-- ============================================================

create or replace function public.increment_post_view(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.posts set view_count = coalesce(view_count, 0) + 1 where id = p_id;
end;
$$;

create or replace function public.increment_reply_views(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.replies set view_count = coalesce(view_count, 0) + 1 where id = any(p_ids);
end;
$$;

-- Anyone (including logged-out visitors) can bump a view count, same
-- as every other read-facing counter on the site.
grant execute on function public.increment_post_view(uuid)   to anon, authenticated;
grant execute on function public.increment_reply_views(uuid[]) to anon, authenticated;

notify pgrst, 'reload schema';


-- ################################################################
-- ### BELOW: supabase/report_community.sql (was missing from this
-- ### combined file — it replaces admin_list_reports() with a
-- ### version that adds community_id/name/slug columns, and MUST
-- ### drop the function first since CREATE OR REPLACE can't change
-- ### a function's return columns. Run last, after the
-- ### admin_panel_advanced.sql section above.)
-- ################################################################

-- ============================================================
-- REPORT COMMUNITY — supports the new "Report community" item in
-- the community page's "•••" menu (js/community.js
-- communityMenuReport() → common.js openReportCommunity()).
--
-- Run this in the Supabase SQL Editor after schema.sql and
-- admin_panel_advanced.sql (it only adds a column and replaces the
-- admin_list_reports() function those set up) — safe to re-run any
-- time, same as the other migrations in this folder.
--
-- What this adds:
--   1. reports.community_id — nullable, so every existing report
--      row (post/reply/user reports) is untouched. A community
--      report is inserted with only community_id set and
--      post_id/reply_id/reported_user_id left null, exactly the
--      same shape submitReport() in common.js already uses for the
--      other three report kinds.
--   2. admin_list_reports() now also returns community_id,
--      community_name and community_slug, so the admin panel
--      (js/admin.js adminReportRowHtml()) can show and link to the
--      reported community instead of the row baffling an admin
--      with "Reported: @null".
-- ============================================================

-- ── 1. Column ───────────────────────────────────────────────
alter table public.reports
  add column if not exists community_id uuid references public.communities(id) on delete cascade;

-- Same "one report is about exactly one thing" shape the table
-- already implies for post_id/reply_id/reported_user_id — makes it
-- a database-level guarantee instead of just an app convention.
-- Existing rows (all pre-dating this column) have community_id null
-- and at least one of the other three set, so they already satisfy
-- this without any backfill.
do $$
begin
  alter table public.reports add constraint reports_exactly_one_target check (
    (case when post_id is not null then 1 else 0 end) +
    (case when reply_id is not null then 1 else 0 end) +
    (case when reported_user_id is not null then 1 else 0 end) +
    (case when community_id is not null then 1 else 0 end) = 1
  );
exception when duplicate_object then null;
end $$;

-- ── 2. admin_list_reports() — same function/signature as
--      admin_panel_advanced.sql, replaced to add the three
--      community_* columns via a left join on communities.
--
--      Postgres won't let CREATE OR REPLACE change a function's
--      return row shape (new OUT columns = a different row type,
--      even with the same name/args) — it errors with 42P13 and
--      tells you to DROP FUNCTION first. That's expected here since
--      this replaces the 16-column version from admin_panel_advanced.sql
--      with a 19-column one, so drop it before recreating. ──
drop function if exists public.admin_list_reports(text);

create function public.admin_list_reports(status_filter text default 'open')
returns table (
  id                     uuid,
  created_at             timestamptz,
  reason                 text,
  details                text,
  status                 text,
  reporter_id            uuid,
  reporter_username      text,
  post_id                uuid,
  post_body              text,
  post_author_id         uuid,
  post_author_username   text,
  reply_id               uuid,
  reply_body             text,
  reply_author_id        uuid,
  reply_author_username  text,
  reported_user_id       uuid,
  reported_username      text,
  community_id           uuid,
  community_name         text,
  community_slug         text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  return query
  select
    r.id, r.created_at, r.reason, r.details, r.status,
    r.reporter_id, rp.username,
    r.post_id, p.body, p.author_id, pa.username,
    r.reply_id, rl.body, rl.author_id, ra.username,
    r.reported_user_id, ru.username,
    r.community_id, c.name, c.slug
  from public.reports r
  left join public.profiles rp on rp.id = r.reporter_id
  left join public.posts    p  on p.id  = r.post_id
  left join public.profiles pa on pa.id = p.author_id
  left join public.replies  rl on rl.id = r.reply_id
  left join public.profiles ra on ra.id = rl.author_id
  left join public.profiles ru on ru.id = r.reported_user_id
  left join public.communities c on c.id = r.community_id
  where status_filter = 'all' or r.status = status_filter
  order by r.created_at desc
  limit 100;
end;
$$;

grant execute on function public.admin_list_reports(text) to authenticated;


-- ################################################################
-- ### BELOW: supabase/chat_delete_messages_and_contacts.sql (was
-- ### missing from this combined file entirely — js/chat.js calls
-- ### delete_message_for_me / delete_message_for_everyone /
-- ### delete_conversation_with_user, and this also WIDENS
-- ### messages_has_content_chk to allow already-tombstoned
-- ### "deleted for everyone" rows through. Without this section,
-- ### the narrower chat_full_setup.sql version of that same
-- ### constraint (applied earlier in this file) rejects any message
-- ### your app has already tombstoned — which is the
-- ### "messages_has_content_chk is violated by some row" error.
-- ### Must run after chat_full_setup.sql, which it does here.
-- ################################################################

-- ============================================================
-- CHAT — delete message (for me / for everyone) + delete conversation
-- (removes a contact's messages from your inbox). Run once in the
-- Supabase SQL editor. Safe to re-run — every statement is
-- idempotent.
--
-- Only covers 1:1 DMs (sender_id/recipient_id rows), not group/
-- channel messages (conversation_id rows) — those already have their
-- own "delete your own message" RLS policy from chat_full_setup.sql
-- (messages_delete_own_conversation), which hard-deletes the row
-- outright, so there's nothing to add there.
--
-- THREE NEW THINGS:
--   1. "Delete for me"       — hides one message from your own view
--      only. The other person keeps seeing it normally. Stored as a
--      per-side flag (deleted_for_sender / deleted_for_recipient)
--      rather than actually removing the row, since the row still
--      needs to exist for the OTHER side.
--   2. "Delete for everyone" — sender-only. Wipes the message content
--      (body/iv/media/shared post) and tombstones the row so both
--      sides render "This message was deleted" instead of the real
--      content. The row itself stays (keeps timestamps/ordering
--      sane) but nothing readable is left in it.
--   3. "Delete conversation"  — deleting a contact from your message
--      list. There's no separate contacts table for DMs — the
--      conversation list is just derived from the messages table
--      (see loadConversationList() in js/chat.js) — so "delete this
--      person" = delete-for-me every message you've exchanged with
--      them. Once every message between the two of you is hidden on
--      your side, the conversation naturally disappears from your
--      inbox. The other person's inbox is untouched — same one-sided
--      behavior as deleting a single message for yourself, and the
--      same convention WhatsApp/Instagram/X use for "delete chat".
--
-- All three go through SECURITY DEFINER RPCs (same pattern as
-- delete_own_post/delete_own_reply in fix_delete_via_rpc.sql) rather
-- than raw client-side UPDATEs, so ownership is checked server-side
-- regardless of whatever the existing messages RLS policies allow —
-- this migration doesn't need to know their exact definitions to be
-- safe.
--
-- NOTE ON SELECT RLS: filtering out deleted-for-me rows currently
-- happens client-side (js/chat.js drops any row where the flag is
-- set for the current viewer, for both the conversation list and an
-- open thread). That's enough for the UI to behave correctly, but
-- it's not defense-in-depth — a network tab could still see the
-- flagged-hidden row's ciphertext. If you want the SELECT policy
-- itself to exclude these rows, share its current definition and it
-- can be tightened in a follow-up migration.
-- ============================================================

alter table public.messages add column if not exists deleted_for_sender boolean not null default false;
alter table public.messages add column if not exists deleted_for_recipient boolean not null default false;
alter table public.messages add column if not exists deleted_for_everyone boolean not null default false;

comment on column public.messages.deleted_for_sender is 'true = the sender chose "Delete for me" on this message; hidden from their view only.';
comment on column public.messages.deleted_for_recipient is 'true = the recipient chose "Delete for me" on this message; hidden from their view only.';
comment on column public.messages.deleted_for_everyone is 'true = "Delete for everyone" (sender-only). body/iv/media/shared_post_id are wiped once this is set; both sides render a tombstone instead.';

-- The old "must contain something" constraint (chat_full_setup.sql)
-- would reject the wipe a delete-for-everyone update performs, since
-- that update intentionally empties body/media/shared_post_id. Widen
-- it to also allow a tombstoned row through.
alter table public.messages drop constraint if exists messages_has_content_chk;
alter table public.messages add constraint messages_has_content_chk
  check (deleted_for_everyone or coalesce(body, '') <> '' or media_url is not null or shared_post_id is not null);

-- ── delete_message_for_me ──
-- Hides a single 1:1 DM message from the caller's own view. Works
-- for either side of the conversation — whichever one you are is
-- detected from the row itself, not passed in by the client.
create or replace function public.delete_message_for_me(message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
begin
  select sender_id, recipient_id, conversation_id into m
    from public.messages where id = message_id;

  if not found then
    raise exception 'Message not found.';
  end if;
  if m.conversation_id is not null then
    raise exception 'This message belongs to a group/channel — use the group delete instead.';
  end if;

  if auth.uid() = m.sender_id then
    update public.messages set deleted_for_sender = true where id = message_id;
  elsif auth.uid() = m.recipient_id then
    update public.messages set deleted_for_recipient = true where id = message_id;
  else
    raise exception 'This is not your message.';
  end if;
end;
$$;

grant execute on function public.delete_message_for_me(uuid) to authenticated;

-- ── delete_message_for_everyone ──
-- Sender-only. Wipes the message content and tombstones the row so
-- it renders as "This message was deleted" for both sides. Attached
-- media's storage object is intentionally left alone here (the row
-- just stops pointing at it) — if you also want the file itself
-- removed from the "media" bucket, that needs a follow-up storage
-- delete call from the client, since SQL alone can't reach into
-- Storage.
create or replace function public.delete_message_for_everyone(message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
begin
  select sender_id, conversation_id into m
    from public.messages where id = message_id;

  if not found then
    raise exception 'Message not found.';
  end if;
  if m.conversation_id is not null then
    raise exception 'This message belongs to a group/channel — use the group delete instead.';
  end if;
  if auth.uid() <> m.sender_id then
    raise exception 'Only the sender can delete this for everyone.';
  end if;

  update public.messages
    set body = '',
        iv = null,
        media_url = null,
        media_type = null,
        media_duration_ms = null,
        shared_post_id = null,
        deleted_for_everyone = true
    where id = message_id;
end;
$$;

grant execute on function public.delete_message_for_everyone(uuid) to authenticated;

-- ── delete_conversation_with_user ──
-- "Delete this contact" from your message list — delete-for-me on
-- every 1:1 message you've ever exchanged with them. Does not touch
-- messages_for_everyone/anything on the other person's side.
create or replace function public.delete_conversation_with_user(other_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.messages set deleted_for_sender = true
    where sender_id = auth.uid() and recipient_id = other_user_id;
  update public.messages set deleted_for_recipient = true
    where recipient_id = auth.uid() and sender_id = other_user_id;
end;
$$;

grant execute on function public.delete_conversation_with_user(uuid) to authenticated;


-- ################################################################
-- FROM: supabase/username_login.sql
-- ################################################################

-- ================================================================
-- USERNAME LOGIN — lets people sign in with their username instead
-- of their email, from the *same* password field/flow.
-- ================================================================
-- Supabase Auth's signInWithPassword() only ever accepts an email
-- (there's no native "sign in by username"). js/auth.js's login form
-- now takes either an email or a username in one field; when what
-- was typed isn't an email (no "@"), it calls this RPC first to look
-- up the email that goes with that username, then signs in with that
-- email + the password the person typed — the password itself is
-- still checked by Supabase Auth exactly as before, this function
-- never sees or touches it.
--
-- WHY SECURITY DEFINER: public.profiles deliberately does not store
-- email (see add_age_gender.sql's neighboring comments) — the email
-- only lives in auth.users, which the anon/authenticated client role
-- has no read access to. This function runs with the privileges of
-- the user that defined it (should be the project owner/postgres),
-- so it can join profiles -> auth.users to find the email, but it
-- only ever returns that one email string for an exact username
-- match — nothing else about the account.
--
-- Case-insensitive lookup (ilike), matching how every other username
-- lookup in this project already works (mentions, follow, admin
-- promotion — see MASTER_MIGRATIONS_reconstructed.sql).
--
-- NOTE ON PRIVACY: like any "log in with username" feature, this
-- necessarily confirms an account's email address to whoever knows
-- (or guesses) its username — that's an inherent tradeoff of the
-- feature, not a bug. It reveals nothing else (no password, no
-- profile data) and only responds to an exact username, so it isn't
-- a general email-harvesting endpoint.
-- ================================================================

create or replace function public.email_for_login(p_username text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if p_username is null or trim(p_username) = '' then
    return null;
  end if;

  select u.email into v_email
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.username ilike trim(p_username)
  limit 1;

  return v_email;
end;
$$;

grant execute on function public.email_for_login(text) to anon, authenticated;

notify pgrst, 'reload schema';
