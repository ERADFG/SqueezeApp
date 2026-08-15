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
