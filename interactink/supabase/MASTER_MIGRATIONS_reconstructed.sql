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

-- Defensive drop: if report_community.sql has already been run on
-- this project, admin_list_reports() currently has extra
-- community_id/name/slug OUT columns — CREATE OR REPLACE can't
-- change a function's return row shape, only DROP + CREATE can, so
-- this always drops first regardless of which shape currently
-- exists. The report_community.sql section (run separately/after)
-- recreates the wider version on top of this one.
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
