-- ============================================================
-- CHAT — actually stop a blocked person from messaging you.
-- Run once in the Supabase SQL editor. Safe to re-run.
--
-- WHY THIS FILE EXISTS:
-- js/common.js's blockUser()/unblockUser() (and the "···" menu added
-- to the chat thread in js/chat.js) already write to the `blocks`
-- table, and that table already hides posts/feeds and drops follows
-- (see profile_extras.sql). But nothing in the SQL so far actually
-- stops a blocked person from *sending a DM* — the existing
-- messages_insert_conversation policy (chat_full_setup.sql) only
-- covers group/channel rows (conversation_id is not null), and
-- whatever the original 1:1 DM insert policy is isn't reproduced in
-- this repo's SQL snapshot, so this migration doesn't try to replace
-- it. Instead it adds a RESTRICTIVE policy, which Postgres always
-- ANDs together with whatever permissive policy already allows the
-- insert — so this can only take permission away, never grant it,
-- and it works regardless of what the original DM policy says.
--
-- Blocks both directions: neither side can start (or continue) a DM
-- with the other while a block exists either way, matching the "They
-- won't be able to follow or message you" text already shown in the
-- block confirmation dialog (profileMenuBlock() in profile.js).
-- ============================================================

drop policy if exists "messages_block_check" on public.messages;
create policy "messages_block_check" on public.messages
  as restrictive
  for insert
  to authenticated
  with check (
    -- Only constrains 1:1 DMs. Group/channel rows (conversation_id
    -- set) are untouched — membership already governs who can post
    -- there, and "blocking" someone doesn't remove them from a group.
    conversation_id is not null
    or recipient_id is null
    or not exists (
      select 1 from public.blocks b
      where (b.blocker_id = messages.sender_id and b.blocked_id = messages.recipient_id)
         or (b.blocker_id = messages.recipient_id and b.blocked_id = messages.sender_id)
    )
  );
