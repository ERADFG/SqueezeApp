-- ============================================================
-- OPT-IN: "Show my community on my profile" toggle
-- ============================================================
-- Owning a community (see community_owner_limit.sql) used to be
-- enough on its own to show a "Community" card at the top of that
-- account's profile — whether the owner wanted it there or not. This
-- adds a plain per-profile flag so it's off by default and only
-- appears once the owner turns it on from Edit Profile (see the
-- "Show my community on my profile" checkbox in js/editprofile.js;
-- js/profile.js's loadProfileCommunity() reads this before it will
-- even query the communities table).
--
-- Run this once in the Supabase SQL editor. Safe to re-run.
-- ============================================================

alter table public.profiles
  add column if not exists show_community boolean not null default false;
