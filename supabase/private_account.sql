-- Adds the "Private account" toggle to Settings → Privacy
-- (see the "private-account" toggle row in js/settings.js).
-- Defaults to false so every existing account stays exactly as
-- visible as it already is.
alter table profiles
  add column if not exists is_private boolean not null default false;

comment on column profiles.is_private is 'When true, the account is marked private. Purely a display flag for now — it does not yet gate access to posts, profile, or follows via RLS.';
