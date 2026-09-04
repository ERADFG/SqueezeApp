-- ============================================================
-- ACCOUNT PRIVACY — "Private account" toggle + a "Nobody" option
-- for "Who can message you". Run once in the Supabase SQL editor.
-- Safe to re-run.
--
-- Adds two things the Settings page now exposes:
--
--   1. profiles.is_private — same idea, and same column name, as
--      the existing "Private community" toggle (see
--      supabase/community_privacy.sql). When on, only the owner and
--      their followers can see the account's posts/replies. Everyone
--      can still find the profile itself (name, bio, follower
--      counts) and send a follow request — this mirrors how a
--      private *community* here already works (membership gates the
--      content, not the listing), and keeps this a content-visibility
--      switch rather than a full follow-request/approval system,
--      which this app doesn't have for accounts.
--
--   2. user_settings.dm_privacy gets a third value, 'nobody', on top
--      of the existing 'everyone' / 'following'. This file also adds
--      the enforcement that was missing for ALL THREE values —
--      js/settings.js has been reading and writing dm_privacy since
--      it shipped, but nothing server-side ever actually acted on it
--      (chat.js never checked it either), so until now every account
--      behaved like 'everyone' regardless of what the dropdown said.
--
-- Both are enforced with RESTRICTIVE policies, same technique as
-- supabase/chat_block_enforcement.sql: a restrictive policy only
-- ever takes permission away, so it layers on top of whatever
-- permissive SELECT/INSERT policy already exists on posts/replies/
-- messages in your project without needing to know that policy's
-- name or replace it.
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- PART 1 — "Private account" toggle
-- ────────────────────────────────────────────────────────────
alter table public.profiles add column if not exists is_private boolean not null default false;

-- Wipe and re-create just the restrictive privacy policy on posts/
-- replies by name (not every policy — unlike blocks/community_privacy,
-- this table already has permissive policies this file must not
-- touch), so re-running this file can't leave two copies stacked up.
drop policy if exists "posts_private_account_gate" on public.posts;
create policy "posts_private_account_gate" on public.posts
  as restrictive
  for select
  to authenticated, anon
  using (
    not exists (select 1 from public.profiles pr where pr.id = posts.author_id and pr.is_private)
    or auth.uid() = posts.author_id
    or exists (
      select 1 from public.follows f
      where f.follower_id = auth.uid() and f.followee_id = posts.author_id
    )
  );

drop policy if exists "replies_private_account_gate" on public.replies;
create policy "replies_private_account_gate" on public.replies
  as restrictive
  for select
  to authenticated, anon
  using (
    not exists (select 1 from public.profiles pr where pr.id = replies.author_id and pr.is_private)
    or auth.uid() = replies.author_id
    or exists (
      select 1 from public.follows f
      where f.follower_id = auth.uid() and f.followee_id = replies.author_id
    )
  );

-- ────────────────────────────────────────────────────────────
-- PART 2 — "Who can message you": add 'nobody', enforce all 3
-- ────────────────────────────────────────────────────────────
-- Defensive: drop any pre-existing check constraint on dm_privacy
-- (under whatever name it was originally created with) before adding
-- ours back with 'nobody' included, so this is safe whether or not a
-- constraint already exists and whatever it happens to be called.
do $$
declare con record;
begin
  for con in
    select conname from pg_constraint
    where conrelid = 'public.user_settings'::regclass
      and pg_get_constraintdef(oid) ilike '%dm_privacy%'
  loop
    execute format('alter table public.user_settings drop constraint %I', con.conname);
  end loop;
end $$;

alter table public.user_settings
  add constraint user_settings_dm_privacy_check
  check (dm_privacy in ('everyone', 'following', 'nobody'));

drop policy if exists "messages_dm_privacy_check" on public.messages;
create policy "messages_dm_privacy_check" on public.messages
  as restrictive
  for insert
  to authenticated
  with check (
    -- Only constrains new 1:1 DMs, matching the "Applies to new
    -- conversations only" note already shown under the setting.
    -- Group/channel rows (conversation_id set) are untouched.
    conversation_id is not null
    or recipient_id is null
    or messages.sender_id = messages.recipient_id
    or exists (
      -- Already talking? This setting never closes an existing
      -- conversation, only gates opening a new one.
      select 1 from public.messages m
      where m.conversation_id is null
        and ((m.sender_id = messages.sender_id and m.recipient_id = messages.recipient_id)
          or (m.sender_id = messages.recipient_id and m.recipient_id = messages.sender_id))
    )
    or coalesce(
      (select us.dm_privacy from public.user_settings us where us.user_id = messages.recipient_id),
      'everyone'
    ) = 'everyone'
    or (
      (select us.dm_privacy from public.user_settings us where us.user_id = messages.recipient_id) = 'following'
      and exists (
        select 1 from public.follows f
        where f.follower_id = messages.recipient_id and f.followee_id = messages.sender_id
      )
    )
    -- 'nobody' falls through to false: no exception applies, so the
    -- insert is rejected.
  );
