-- ─────────────────────────────────────────────────────────────
-- FIX: profiles.username rows with one or more stray leading '@'
-- characters (e.g. "@interactink" or "@@@@@@@@@@interactink"
-- instead of "interactink").
--
-- HOW THIS HAPPENS: every *Url() builder in js/common.js (and the
-- matching vercel.json rewrites / api/prerender.js) already does
-- `/@${username}` — exactly one '@', added on top of whatever is in
-- profiles.username. If a row's username value already had a
-- leading '@' baked into it (from before the
-- `^[a-zA-Z0-9_]{3,20}$` validation in js/auth.js/js/settings.js
-- existed, or from a signup path that bypasses it — e.g. the
-- handle_new_user() trigger for OAuth signups, which lives here in
-- the Supabase dashboard and isn't shipped in this repo), every
-- profile link built from it comes out as "/@@username" and so on,
-- and the client-side route parser (currentProfileUsername() in
-- js/common.js) then can't match it back to a real username either
-- — the profile page 404s.
--
-- This migration (1) cleans up any existing bad data, and (2) adds
-- a CHECK constraint so a leading '@' can never be saved into this
-- column again, from any code path, present or future.
--
-- SAFE TO RE-RUN: the UPDATE only touches rows that currently start
-- with '@', and the constraint is dropped-and-recreated so running
-- this twice is a no-op the second time.
-- ─────────────────────────────────────────────────────────────

-- 1. Strip every leading '@' off any existing dirty username.
--    (No collision handling needed: usernames are unique, and a
--    '@'-prefixed value could never have collided with the clean
--    version of itself since the unique index treats them as
--    different strings — if this UPDATE ever hits a real duplicate,
--    it means two different accounts would resolve to the same
--    clean handle, which needs a human to pick which one keeps it,
--    so it'll fail loudly on the unique constraint rather than
--    silently overwriting anyone's username.)
update public.profiles
set username = regexp_replace(username, '^@+', '')
where username ~ '^@';

-- 2. Stop it from happening again, regardless of which code path
--    (client-side signup, settings, an OAuth trigger, the admin
--    panel, or a direct SQL edit) tries to write it.
alter table public.profiles
  drop constraint if exists profiles_username_no_leading_at;

alter table public.profiles
  add constraint profiles_username_no_leading_at
  check (username !~ '^@');
