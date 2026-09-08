-- ============================================================
-- MODERATION SAFETY UPGRADE — audit trail + IP-level bans +
-- anti-abuse rate limiting for the reporting system.
--
-- Three independent things, all additive/idempotent — safe to re-run,
-- same as every other file in this folder:
--
--   1. ADMIN AUDIT LOG (public.admin_actions) — every admin action
--      that changes something (suspend/unsuspend, verify, delete
--      post/reply/article/community, resolve a report, ban/unban an
--      IP) now writes a row: who did it, to what, when, with what
--      reason if one was given. None of this existed before — there
--      was no way to answer "who suspended this account and why" or
--      to notice a compromised or rogue admin session acting on the
--      panel. Wired in by re-defining the existing admin_* RPCs
--      (create or replace — same layering pattern admin_panel_
--      advanced.sql / suspend_deletes_content.sql / ip_ban.sql
--      already used on top of each other) to log at the end of each
--      one, rather than changing any call site.
--
--   2. DIRECT IP BANS (admin_ban_ip / admin_unban_ip) — ip_ban.sql's
--      admin_suspend_user() already bans every IP on file for an
--      account it suspends, but that only works once an account
--      exists to suspend. This adds the ability to ban an IP on its
--      own — e.g. a network you've already traced through a deleted
--      community/account and want blocked from signing up again
--      before a new account ever gets created there. Lives in a new
--      public.ip_blocklist table (banned_ips' own composite PK + FK
--      to profiles can't hold a row with no account — see the
--      comment above that table below), and is_ip_banned() / the
--      inline check inside record_user_ip() — both api/ip.js and
--      js/auth.js already call these under those exact names — are
--      re-defined to check both tables.
--
--   3. REPORT RATE LIMIT — a trigger on public.reports so the
--      reporting system added in report_community.sql can't itself
--      become an abuse vector ("report-bombing" someone or a
--      community to harass them or bury real reports in noise).
--      Caps a single account at 20 report submissions per rolling
--      hour and hard-enforces reporter_id = auth.uid() at the
--      database level, not just as an app convention.
--
-- Run after admin_panel_advanced.sql, suspend_deletes_content.sql,
-- ip_ban.sql, report_community.sql, and admin_delete_community.sql.
-- ============================================================

-- ── 1a. Audit log table ──
create table if not exists public.admin_actions (
  id           bigserial primary key,
  admin_id     uuid references public.profiles(id) on delete set null,
  action       text not null,        -- e.g. 'suspend_user','delete_post','ban_ip'
  target_type  text,                 -- 'user' | 'post' | 'reply' | 'article' | 'community' | 'report' | 'ip'
  target_id    text,                 -- the affected row's id, cast to text (or the IP string for ban_ip)
  reason       text,
  details      jsonb not null default '{}'::jsonb,
  created_at   timestamptz not null default now()
);
create index if not exists admin_actions_created_idx on public.admin_actions(created_at desc);
create index if not exists admin_actions_admin_idx   on public.admin_actions(admin_id, created_at desc);

alter table public.admin_actions enable row level security;
-- No direct client policies — written only by the SECURITY DEFINER
-- functions below, read only via admin_list_audit_log() further
-- down, same no-RLS-policy pattern as moderation_events/user_ips.

create or replace function public._log_admin_action(p_action text, p_target_type text, p_target_id text, p_reason text default null, p_details jsonb default '{}'::jsonb)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.admin_actions (admin_id, action, target_type, target_id, reason, details)
    values (auth.uid(), p_action, p_target_type, p_target_id, p_reason, coalesce(p_details, '{}'::jsonb));
end;
$$;
-- Intentionally NOT granted to authenticated — this is an internal
-- helper the admin_* functions below call from inside their own
-- SECURITY DEFINER context, not something the client ever calls
-- directly (which would let anyone forge log entries).

-- ── 1b. Re-defined admin RPCs, now logging ──

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

  insert into public.banned_ips (ip, user_id, reason)
    select u.ip, target_user_id, nullif(trim(coalesce(reason, '')), '')
    from public.user_ips u
    where u.user_id = target_user_id
  on conflict (ip, user_id) do update
    set reason = excluded.reason, banned_at = now();

  perform public._log_admin_action('suspend_user', 'user', target_user_id::text, reason, jsonb_build_object('until', until));
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

  delete from public.banned_ips where user_id = target_user_id;

  perform public._log_admin_action('unsuspend_user', 'user', target_user_id::text);
end;
$$;

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

  perform public._log_admin_action(case when make_verified then 'verify_user' else 'unverify_user' end, 'user', target_user_id::text, null, jsonb_build_object('type', p_verification_type));
end;
$$;

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
  perform public._log_admin_action('delete_post', 'post', post_id::text);
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
  perform public._log_admin_action('delete_reply', 'reply', reply_id::text);
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
  perform public._log_admin_action('delete_article', 'article', article_id::text);
end;
$$;

create or replace function public.admin_delete_community(p_community_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  select name into v_name from public.communities where id = p_community_id;

  update public.reports
    set status = 'actioned'
    where community_id = p_community_id and status <> 'actioned';

  delete from public.communities where id = p_community_id;

  perform public._log_admin_action('delete_community', 'community', p_community_id::text, null, jsonb_build_object('name', v_name));
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

  perform public._log_admin_action('resolve_report', 'report', report_id::text, null, jsonb_build_object('status', new_status));
end;
$$;

grant execute on function public.admin_suspend_user(uuid, text, timestamptz) to authenticated;
grant execute on function public.admin_unsuspend_user(uuid)                  to authenticated;
grant execute on function public.admin_verify_user(uuid, boolean, text)      to authenticated;
grant execute on function public.admin_delete_post(uuid)                    to authenticated;
grant execute on function public.admin_delete_reply(uuid)                   to authenticated;
grant execute on function public.admin_delete_article(uuid)                 to authenticated;
grant execute on function public.admin_delete_community(uuid)               to authenticated;
grant execute on function public.admin_set_report_status(uuid, text)        to authenticated;

-- ── 1c. admin_list_audit_log() — read side for the new Audit Log tab ──
create or replace function public.admin_list_audit_log(p_limit integer default 100)
returns table (
  id            bigint,
  created_at    timestamptz,
  admin_id      uuid,
  admin_username text,
  action        text,
  target_type   text,
  target_id     text,
  reason        text,
  details       jsonb
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
  select a.id, a.created_at, a.admin_id, p.username, a.action, a.target_type, a.target_id, a.reason, a.details
  from public.admin_actions a
  left join public.profiles p on p.id = a.admin_id
  order by a.created_at desc
  limit least(coalesce(p_limit, 100), 500);
end;
$$;
grant execute on function public.admin_list_audit_log(integer) to authenticated;

-- ── 2. Direct IP bans ──

-- banned_ips.user_id is NOT NULL, part of a composite primary key,
-- AND has a foreign key to profiles(id) — so a ban with no specific
-- account behind it can't just be a row in that table with a null or
-- fake user_id (Postgres refuses NULLs in a primary key column, and
-- a made-up uuid would fail the foreign key). Simplest correct fix:
-- a separate table for these, and is_ip_banned() (re-defined below)
-- checks both.
create table if not exists public.ip_blocklist (
  ip         text primary key,
  reason     text,
  banned_by  uuid references public.profiles(id) on delete set null,
  banned_at  timestamptz not null default now()
);
alter table public.ip_blocklist enable row level security;
-- No client policies — read/write only through the SECURITY DEFINER
-- functions below, same pattern as banned_ips itself.

create or replace function public.admin_ban_ip(p_ip text, p_reason text default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if p_ip is null or trim(p_ip) = '' then
    raise exception 'an ip is required';
  end if;
  insert into public.ip_blocklist (ip, reason, banned_by)
    values (trim(p_ip), nullif(trim(coalesce(p_reason, '')), ''), auth.uid())
  on conflict (ip) do update
    set reason = excluded.reason, banned_by = excluded.banned_by, banned_at = now();

  perform public._log_admin_action('ban_ip', 'ip', trim(p_ip), p_reason);
end;
$$;

create or replace function public.admin_unban_ip(p_ip text)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  delete from public.ip_blocklist where ip = trim(p_ip);
  perform public._log_admin_action('unban_ip', 'ip', trim(p_ip));
end;
$$;

create or replace function public.admin_list_banned_ips()
returns table (ip text, user_id uuid, username text, reason text, banned_at timestamptz, account_tied boolean)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  return query
  select b.ip, b.user_id, p.username, b.reason, b.banned_at, true as account_tied
  from public.banned_ips b
  left join public.profiles p on p.id = b.user_id
  union all
  select k.ip, null::uuid, null::text, k.reason, k.banned_at, false as account_tied
  from public.ip_blocklist k
  order by banned_at desc
  limit 300;
end;
$$;

-- Re-defined so a signed-out visitor blocked via admin_ban_ip (no
-- account, so nothing in banned_ips to match) is actually refused —
-- same signature/callers (api/ip.js, js/auth.js) as ip_ban.sql, just
-- checking one more table now.
create or replace function public.is_ip_banned(p_ip text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(select 1 from public.banned_ips where ip = p_ip)
      or exists(select 1 from public.ip_blocklist where ip = p_ip);
$$;

-- Same fix applied to record_user_ip()'s own inline check (js/auth.js
-- also calls this directly on every page load for a signed-in user
-- and signs them out if it comes back true) — was only checking
-- banned_ips before.
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

  return public.is_ip_banned(p_ip);
end;
$$;

grant execute on function public.admin_ban_ip(text, text)   to authenticated;
grant execute on function public.admin_unban_ip(text)       to authenticated;
grant execute on function public.admin_list_banned_ips()    to authenticated;
grant execute on function public.is_ip_banned(text)         to anon, authenticated;
grant execute on function public.record_user_ip(text)       to authenticated;

-- ── 3. Report rate limit + integrity trigger ──
-- Enforces reporter_id = auth.uid() at the database level (not just
-- an app convention) and caps a single account at 20 report
-- submissions per rolling hour, so the reporting system itself can't
-- be weaponized to bury a moderation queue or harass a target with
-- report spam.
create or replace function public.enforce_report_rate_limit()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_recent integer;
begin
  if new.reporter_id is null or new.reporter_id <> auth.uid() then
    raise exception 'reporter_id must match the authenticated user';
  end if;

  select count(*) into v_recent
  from public.reports
  where reporter_id = new.reporter_id
    and created_at >= now() - interval '1 hour';

  if v_recent >= 20 then
    raise exception 'You are submitting reports too quickly. Please try again later.';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_report_rate_limit on public.reports;
create trigger trg_report_rate_limit
  before insert on public.reports
  for each row execute function public.enforce_report_rate_limit();

notify pgrst, 'reload schema';
