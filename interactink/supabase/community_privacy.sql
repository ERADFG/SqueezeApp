-- Adds the "Private community" toggle to the new single-screen create-
-- community modal (see openCreateCommunityModal() in js/common.js).
-- Defaults to false so every existing community stays exactly as
-- visible as it already is.
alter table communities
  add column if not exists is_private boolean not null default false;
