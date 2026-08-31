-- ============================================================
-- ADMIN — LOCK ACCESS TO @marpe ONLY
-- Run this after admin_panel_advanced.sql. Safe to re-run any time.
--
-- is_admin() already grants access to whoever has is_admin = true
-- OR whose username is 'marpe' (see admin_panel_advanced.sql). That
-- second clause means access is already restricted to @marpe as
-- long as no other row's is_admin flag ever gets set to true. This
-- migration makes that a hard guarantee instead of an assumption:
-- it strips the flag from every account except @marpe, and sets it
-- on @marpe so the panel keeps working even if the username ever
-- changes later.
-- ============================================================

update public.profiles set is_admin = false where lower(username) <> 'marpe' and is_admin = true;
update public.profiles set is_admin = true  where lower(username) = 'marpe';
