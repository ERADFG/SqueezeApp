-- ═══════════════════════════════════════════════════════════════
-- CHAT — enforce unique names for PUBLIC groups/channels, the same
-- way usernames are unique for accounts. Public groups/channels are
-- discoverable and joinable by name, so two of them sharing a name is
-- exactly the "username already taken" problem — private groups
-- aren't discoverable by name at all (invite-only), so they're left
-- alone and can share names freely.
--
-- Run this once in the Supabase SQL editor. Safe to re-run.
-- ═══════════════════════════════════════════════════════════════

-- If two public groups/channels already share a name (case-insensitive),
-- the unique index below will fail to create. Uncomment and run this
-- first to see any collisions, then rename one of each pair by hand:
--
-- select lower(name) as dup_name, array_agg(id) as conversation_ids
-- from public.conversations
-- where is_public = true
-- group by lower(name)
-- having count(*) > 1;

drop index if exists conversations_public_name_uniq;
create unique index conversations_public_name_uniq
  on public.conversations (lower(name))
  where is_public = true;
