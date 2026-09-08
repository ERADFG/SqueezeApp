-- ============================================================
-- FIX: view counts should be one per account, not one per browser
-- session
--
-- The original increment_post_view / increment_reply_views (see
-- view_counts.sql) bump view_count unconditionally on every call —
-- the only "dedup" was client-side (js/common.js's seenThisSession(),
-- sessionStorage-based), which resets on every new tab/session. So
-- the same logged-in account could rack up more than one view on a
-- post just by opening a new tab, using incognito, or coming back
-- later — sessionStorage was never actually tied to the account.
--
-- This adds two small tracking tables (one row per account+post /
-- account+reply, ever) and rewrites both RPCs to only increment the
-- counter the first time a given account is recorded against a given
-- post/reply — every call after that is a no-op. Logged-out visitors
-- have no account to dedupe against, so their views still count
-- every time, same as before (this only changes behavior for signed-
-- in accounts).
--
-- Safe to re-run.
-- ============================================================

create table if not exists public.post_views (
  post_id uuid not null references public.posts(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id)
);

create table if not exists public.reply_views (
  reply_id uuid not null references public.replies(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (reply_id, user_id)
);

alter table public.post_views enable row level security;
alter table public.reply_views enable row level security;

-- No direct client access — only the security-definer RPCs below
-- touch these tables. (Matches the pattern already used for
-- `reports` elsewhere in this project: write-only via RPC, nothing
-- for anon/authenticated to select/insert directly.)
drop policy if exists post_views_no_direct_access on public.post_views;
create policy post_views_no_direct_access on public.post_views
  for all using (false) with check (false);

drop policy if exists reply_views_no_direct_access on public.reply_views;
create policy reply_views_no_direct_access on public.reply_views
  for all using (false) with check (false);

create or replace function public.increment_post_view(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
begin
  if v_uid is null then
    -- Logged-out visitor — no account to dedupe against, count it
    -- every time (same as the old behavior).
    update public.posts set view_count = coalesce(view_count, 0) + 1 where id = p_id;
    return;
  end if;

  insert into public.post_views (post_id, user_id) values (p_id, v_uid)
  on conflict (post_id, user_id) do nothing;

  if found then
    update public.posts set view_count = coalesce(view_count, 0) + 1 where id = p_id;
  end if;
end;
$$;

create or replace function public.increment_reply_views(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_id uuid;
begin
  if v_uid is null then
    update public.replies set view_count = coalesce(view_count, 0) + 1 where id = any(p_ids);
    return;
  end if;

  foreach v_id in array p_ids loop
    insert into public.reply_views (reply_id, user_id) values (v_id, v_uid)
    on conflict (reply_id, user_id) do nothing;
    if found then
      update public.replies set view_count = coalesce(view_count, 0) + 1 where id = v_id;
    end if;
  end loop;
end;
$$;

grant execute on function public.increment_post_view(uuid)     to anon, authenticated;
grant execute on function public.increment_reply_views(uuid[]) to anon, authenticated;

notify pgrst, 'reload schema';
