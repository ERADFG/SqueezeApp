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
