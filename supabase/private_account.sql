-- Adds the "Private account" toggle to Settings → Privacy
-- (see the "private-account" toggle row in js/settings.js).
-- Defaults to false so every existing account stays exactly as
-- visible as it already is.
alter table profiles
  add column if not exists is_private boolean not null default false;

comment on column profiles.is_private is 'When true, the account is private: posts/replies are hidden from everyone except accepted followers (RLS gate in supabase/private_account_follow_requests.sql), and new followers require an accepted follow_requests row first.';
