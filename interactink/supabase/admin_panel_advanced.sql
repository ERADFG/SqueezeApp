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
--
-- verification_type: which badge a verified user gets — 'blue',
-- 'gold', or 'purple' (see supabase/MASTER_MIGRATIONS_reconstructed.sql
-- for the column/constraint this depends on, and js/common.js's
-- vBadge()/avSqClass() for how the app renders each type).
-- make_verified=false always clears both columns. The old two-arg
-- signature is dropped first so it can't linger as an ambiguous
-- overload alongside this one.

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

grant execute on function public.admin_verify_user(uuid, boolean, text)      to authenticated;
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
-- exists. Re-run report_community.sql after this file if you need
-- those columns back.
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
