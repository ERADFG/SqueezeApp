-- ============================================================
-- ARTICLES — long-form posts any account can write, replacing
-- Lists as the app's second primary nav item ("Lists" moved into
-- the "···" More menu — see js/common.js's renderSideNav()).
--
-- Twitter/X has no real equivalent here; this is closer to a
-- lightweight Medium/Substack post: a title + body owned by one
-- author, publicly readable, editable/deletable only by its
-- author. No members, no privacy toggle, no following — anyone
-- with an account can write one.
--
-- Run in the Supabase SQL Editor after schema.sql (needs
-- public.profiles to exist for the author_id foreign key).
-- Additive/idempotent like the other migrations — safe to re-run.
-- ============================================================

create table if not exists public.articles (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references public.profiles(id) on delete cascade,
  title       text not null,
  body        text not null,
  cover_url   text,
  is_deleted  boolean not null default false,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create index if not exists articles_author_idx on public.articles(author_id);
create index if not exists articles_created_idx on public.articles(created_at desc);
-- Backs the search box on /articles (title/body ILIKE), same
-- approach as posts.body in schema.sql.
create index if not exists articles_title_trgm_idx on public.articles using gin (title gin_trgm_ops);
create index if not exists articles_body_trgm_idx on public.articles using gin (body gin_trgm_ops);

alter table public.articles enable row level security;

-- Anyone (including logged-out visitors) can read any non-deleted
-- article — same "public read" rule posts.sql uses.
drop policy if exists "articles_select" on public.articles;
create policy "articles_select" on public.articles
  for select using (is_deleted = false);

-- Any logged-in account can write an article, as long as it's
-- attributed to themselves.
drop policy if exists "articles_insert_own" on public.articles;
create policy "articles_insert_own" on public.articles
  for insert with check (author_id = auth.uid());

-- Only the author can edit their own article (title/body/cover,
-- or soft-deleting it — same is_deleted pattern posts.sql uses
-- instead of a hard delete, so it doesn't need a separate delete
-- policy at all).
drop policy if exists "articles_update_own" on public.articles;
create policy "articles_update_own" on public.articles
  for update using (author_id = auth.uid()) with check (author_id = auth.uid());

-- Keeps updated_at honest on every edit.
create or replace function public.articles_touch_updated_at() returns trigger
language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists articles_touch_updated_at_trg on public.articles;
create trigger articles_touch_updated_at_trg
  before update on public.articles
  for each row execute function public.articles_touch_updated_at();
