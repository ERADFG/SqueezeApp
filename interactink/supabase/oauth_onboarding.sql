-- ═══════════════════════════════════════════════════════════════
-- OAUTH-ONLY SIGNUP — drops email/password entirely in favor of
-- Google / X / Discord sign-in (see js/auth.js, login.html,
-- signup.html, start.html). Since OAuth providers never hand this
-- app a ready-to-use unique @handle (and Twitter/Discord don't even
-- reliably hand over an age), every first-time sign-in now needs one
-- short "claim your username" step — this is what tracks whether
-- that's been done yet.
--
-- Safe to re-run — every statement is idempotent.
-- ═══════════════════════════════════════════════════════════════

-- New default is FALSE (so brand-new rows inserted by the
-- handle_new_user() trigger after this migration runs start out
-- needing onboarding) — then the UPDATE right below immediately flips
-- every *existing* account back to TRUE in the same breath, since
-- anyone who already has a real username from the old email/password
-- signup flow has nothing left to claim.
alter table public.profiles
  add column if not exists onboarded boolean not null default false;

update public.profiles
  set onboarded = true
  where onboarded = false
    and username is not null
    and username <> '';

-- NOTE ON THE handle_new_user() TRIGGER: that function isn't in this
-- project's SQL export (see the neighboring note in
-- supabase/add_age_gender.sql) — it already exists on your live
-- project and creates the profiles row the instant someone signs in
-- for the first time via any provider, Google/X/Discord included.
-- This migration doesn't need to touch it: the row it inserts simply
-- won't set `onboarded` (so it uses the new default of FALSE above),
-- and whatever it puts in `username` (nothing, an email prefix, a
-- provider display name — depends on how it was written) gets
-- overwritten for real the moment the person submits onboarding.html.
--
-- One thing worth checking on your project: if `username` has a
-- NOT NULL constraint and the trigger doesn't independently generate
-- one for OAuth sign-ins (it may never have needed to, if it was only
-- ever exercised by the old signUp({ options: { data: { username }}})
-- call), first-time Google/X/Discord sign-in could fail at the INSERT
-- before ever reaching onboarding.html. If new OAuth sign-ins error
-- out instead of landing on the username-claim screen, that's almost
-- certainly it — run this to see the trigger's actual body and adjust
-- it to fall back to something always-present (e.g. a random string)
-- when metadata has no username:
--
--   select pg_get_functiondef('public.handle_new_user'::regproc);
