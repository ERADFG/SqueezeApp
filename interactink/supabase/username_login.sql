-- ================================================================
-- USERNAME LOGIN — lets people sign in with their username instead
-- of their email, from the *same* password field/flow.
-- ================================================================
-- Supabase Auth's signInWithPassword() only ever accepts an email
-- (there's no native "sign in by username"). js/auth.js's login form
-- now takes either an email or a username in one field; when what
-- was typed isn't an email (no "@"), it calls this RPC first to look
-- up the email that goes with that username, then signs in with that
-- email + the password the person typed — the password itself is
-- still checked by Supabase Auth exactly as before, this function
-- never sees or touches it.
--
-- WHY SECURITY DEFINER: public.profiles deliberately does not store
-- email (see add_age_gender.sql's neighboring comments) — the email
-- only lives in auth.users, which the anon/authenticated client role
-- has no read access to. This function runs with the privileges of
-- the user that defined it (should be the project owner/postgres),
-- so it can join profiles -> auth.users to find the email, but it
-- only ever returns that one email string for an exact username
-- match — nothing else about the account.
--
-- Case-insensitive lookup (ilike), matching how every other username
-- lookup in this project already works (mentions, follow, admin
-- promotion — see MASTER_MIGRATIONS_reconstructed.sql).
--
-- NOTE ON PRIVACY: like any "log in with username" feature, this
-- necessarily confirms an account's email address to whoever knows
-- (or guesses) its username — that's an inherent tradeoff of the
-- feature, not a bug. It reveals nothing else (no password, no
-- profile data) and only responds to an exact username, so it isn't
-- a general email-harvesting endpoint.
-- ================================================================

create or replace function public.email_for_login(p_username text)
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text;
begin
  if p_username is null or trim(p_username) = '' then
    return null;
  end if;

  select u.email into v_email
  from public.profiles p
  join auth.users u on u.id = p.id
  where p.username ilike trim(p_username)
  limit 1;

  return v_email;
end;
$$;

grant execute on function public.email_for_login(text) to anon, authenticated;

notify pgrst, 'reload schema';
