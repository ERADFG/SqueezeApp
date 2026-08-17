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
