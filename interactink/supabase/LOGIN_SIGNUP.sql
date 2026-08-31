-- ================================================================
-- INTERACTINK — SQL specifically used by login.html / signup.html
-- ================================================================
-- Everything js/auth.js's doSignUp()/doLogIn()/renderAuthArea()
-- actually touches in the database, pulled out from the rest of the
-- project so it's just the login/signup layer:
--
--   1. THE PROFILE ROW ITSELF (handle_new_user trigger) — NOT
--      included below. The instant signUp() succeeds, a `profiles`
--      row with that user's id/username already exists — that's a
--      database trigger on auth.users, and it isn't in this
--      project's SQL export (only later patches on top of the base
--      schema were exported — see this repo's other SQL files for
--      the full explanation). Since your site already has real
--      accounts and login already works, that trigger already
--      exists on your live project — nothing to run for it. Only
--      mentioning it here so it's clear why it's not below rather
--      than looking like an oversight.
--
--   2. Age + gender columns on signup — supabase/add_age_gender.sql,
--      included in full below.
--
--   3. IP ban check (isClientIpBanned(), called from both doSignUp
--      and doLogIn, and again on every page load in renderAuthArea)
--      — supabase/ip_ban.sql, included in full below. This one has a
--      real dependency: it calls public.is_admin() and assumes
--      profiles.banned/suspended_until already exist, both of which
--      come from supabase/admin_panel_advanced.sql. If you haven't
--      already run that file (it's part of ALL_MIGRATIONS_COMBINED.sql),
--      run that FIRST or this file's second half will fail.
--
--   4. clear_expired_suspension(), called from renderAuthArea() right
--      after login — NOT included below on its own. It's defined
--      inside admin_panel_advanced.sql alongside is_admin() and every
--      other admin_* function it depends on; pulling just this one
--      function out risks shipping it without something it needs.
--      Run the full supabase/admin_panel_advanced.sql (already part
--      of ALL_MIGRATIONS_COMBINED.sql) for this piece.
--
-- Bottom line: if your project already has admin_panel_advanced.sql
-- applied (it's foundational to a lot more than just login), the
-- only genuinely new thing below is add_age_gender.sql + ip_ban.sql.
-- If you're not sure, it's simplest to just run
-- ALL_MIGRATIONS_COMBINED.sql — every statement in it is safe to
-- re-run even where it's already applied.
-- ================================================================


-- ################################################################
-- ### FROM: supabase/add_age_gender.sql
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

-- ################################################################
-- ### FROM: supabase/ip_ban.sql  (depends on admin_panel_advanced.sql
-- ### already being applied — see header above)
-- ################################################################

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
