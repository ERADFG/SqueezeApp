-- ============================================================
-- CHAT — full setup for media attachments, sharing posts into a
-- chat, and group/channel messaging. Safe to re-run any time —
-- every statement is idempotent. Run this whole file once in the
-- Supabase SQL editor.
--
-- Covers three things:
--   PART 1 — media attachments on messages (images/video/voice
--            notes). Same as supabase/chat_media.sql — included
--            here again so this file is a complete, standalone
--            setup script; re-running it is harmless.
--   PART 2 — sharing a post into a chat (a message that embeds a
--            post, like retweeting into a DM).
--   PART 3 — group chats and channels: new `conversations` /
--            `conversation_members` tables, and extending
--            `messages` so a row can belong to either a 1:1 DM
--            (sender_id/recipient_id, as today) or a group/channel
--            (conversation_id) — never both.
--
-- SCHEMA NOTE assumed from the existing app: `public.messages`
-- already exists with (at least) id, sender_id, recipient_id, body,
-- iv, read, created_at, and `public.posts`/`public.profiles` already
-- exist. This file only adds to them — it never drops or rewrites
-- your existing DM policies, since this script can't see their
-- exact names. New RLS policies below are additive (Postgres OR's
-- multiple permissive policies together), so existing 1:1 DM access
-- keeps working exactly as it does today.
--
-- ENCRYPTION NOTE: see supabase/chat_server_side_encryption.sql,
-- which must be run AFTER this file (it depends on the columns/
-- tables created here). That migration encrypts message bodies at
-- rest server-side for 1:1 DMs, groups, and channels alike — it
-- superseded the per-pair-ECDH client-side scheme this comment used
-- to describe.
-- ============================================================

create extension if not exists pgcrypto;

-- ────────────────────────────────────────────────────────────
-- PART 1 — MEDIA ATTACHMENTS (images / video / voice notes)
-- ────────────────────────────────────────────────────────────
-- Media is uploaded to the same public "media" storage bucket posts
-- and replies already use (see MEDIA_BUCKET / uploadMedia() in
-- js/common.js) — no new bucket or storage policy needed, since that
-- bucket's insert/select policies are already scoped to "any
-- authenticated user can upload, anyone can read the public URL".
--
-- Attached media is NOT end-to-end encrypted — it's a plain public
-- URL. A message's body/iv (caption) still goes through the normal
-- 1:1 E2E path independently, so a photo can have an encrypted
-- caption, an unencrypted one, or no caption at all (body = '').

alter table public.messages add column if not exists media_url text;
alter table public.messages add column if not exists media_type text
  check (media_type in ('image', 'video', 'audio'));

comment on column public.messages.media_url is
  'Public URL of an attached image/video/voice-note in the shared "media" storage bucket. NULL = no attachment.';
comment on column public.messages.media_type is
  'image | video | audio (voice note). NULL when media_url is NULL.';

-- ────────────────────────────────────────────────────────────
-- PART 2 — SHARING A POST INTO A CHAT
-- ────────────────────────────────────────────────────────────
-- A message can embed a post (like "Send via Chat" already partially
-- supports at the UI-prefill level — see list.js's listMenuSendChat()
-- — this is the DB-level version: an actual structured reference
-- instead of just prefilled text). on delete set null (not cascade):
-- deleting the original post shouldn't delete someone's message, it
-- should just leave the embed pointing at nothing (render as
-- "this post was deleted" client-side).

alter table public.messages add column if not exists shared_post_id uuid
  references public.posts(id) on delete set null;

create index if not exists messages_shared_post_idx
  on public.messages(shared_post_id) where shared_post_id is not null;

comment on column public.messages.shared_post_id is
  'Set when this message is sharing a post into the chat, X-style. NULL for ordinary messages.';

-- A message must contain *something* — text, media, or a shared
-- post. Replaces the narrower version of this constraint from
-- chat_media.sql (which didn't know about shared_post_id yet).
alter table public.messages drop constraint if exists messages_body_or_media_chk;
alter table public.messages drop constraint if exists messages_has_content_chk;
alter table public.messages add constraint messages_has_content_chk
  check (coalesce(body, '') <> '' or media_url is not null or shared_post_id is not null);

-- ────────────────────────────────────────────────────────────
-- PART 3 — GROUP CHATS & CHANNELS
-- ────────────────────────────────────────────────────────────
-- `conversations` is the group/channel itself; `conversation_members`
-- is who's in it and their role. `kind` distinguishes the two:
--   'group'   — any member can post (like a Telegram group).
--   'channel' — only owner/admin can post; everyone else just reads
--               (like a Telegram channel / broadcast list).
-- `is_public` lets a channel (or group) be discovered and joined by
-- anyone without an invite — private ones only show up for members.

create table if not exists public.conversations (
  id          uuid primary key default gen_random_uuid(),
  kind        text not null check (kind in ('group', 'channel')),
  name        text not null,
  description text,
  avatar_url  text,
  is_public   boolean not null default false,
  created_by  uuid not null references public.profiles(id) on delete cascade,
  created_at  timestamptz not null default now()
);

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  role            text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at       timestamptz not null default now(),
  last_read_at    timestamptz,
  primary key (conversation_id, user_id)
);

create index if not exists conversation_members_user_idx on public.conversation_members(user_id);
create index if not exists conversations_public_idx on public.conversations(is_public) where is_public = true;

-- `messages.conversation_id` — a group/channel message. A row now
-- belongs to *either* a 1:1 DM (sender_id/recipient_id, as today) or
-- a group/channel (conversation_id), never both — hence recipient_id
-- becoming nullable and the new check constraint.
alter table public.messages add column if not exists conversation_id uuid
  references public.conversations(id) on delete cascade;

alter table public.messages alter column recipient_id drop not null;

alter table public.messages drop constraint if exists messages_target_chk;
alter table public.messages add constraint messages_target_chk
  check (
    (conversation_id is not null and recipient_id is null)
    or (conversation_id is null and recipient_id is not null)
  );

create index if not exists messages_conversation_idx
  on public.messages(conversation_id, created_at) where conversation_id is not null;

comment on column public.messages.conversation_id is
  'Set for a group/channel message. Mutually exclusive with recipient_id (1:1 DM).';

-- ── force created_by server-side (same pattern as articles_full_setup.sql) ──
create or replace function public.conversations_force_creator()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.created_by := auth.uid();
  return new;
end;
$$;

drop trigger if exists conversations_force_creator_trg on public.conversations;
create trigger conversations_force_creator_trg
  before insert on public.conversations
  for each row execute function public.conversations_force_creator();

-- ── auto-add the creator as owner ──
-- Runs as security definer so it isn't blocked by conversation_members'
-- own RLS (the creator's membership row is what most of those
-- policies rely on existing in the first place).
create or replace function public.conversations_add_owner()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.conversation_members (conversation_id, user_id, role)
  values (new.id, new.created_by, 'owner')
  on conflict (conversation_id, user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists conversations_add_owner_trg on public.conversations;
create trigger conversations_add_owner_trg
  after insert on public.conversations
  for each row execute function public.conversations_add_owner();

-- ── force sender_id server-side on group/channel messages ──
-- Only touches rows that are actually group/channel messages
-- (conversation_id is not null); 1:1 DM inserts are untouched, so
-- whatever your existing messages insert trigger/policy does for
-- those keeps doing it.
create or replace function public.messages_force_sender_for_conversation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.conversation_id is not null then
    new.sender_id := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists messages_force_sender_conversation_trg on public.messages;
create trigger messages_force_sender_conversation_trg
  before insert on public.messages
  for each row execute function public.messages_force_sender_for_conversation();

-- ── RLS: conversations ──
alter table public.conversations enable row level security;

drop policy if exists "conversations_select" on public.conversations;
create policy "conversations_select" on public.conversations
  for select
  to authenticated
  using (
    is_public = true
    or exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversations.id and cm.user_id = auth.uid()
    )
  );

drop policy if exists "conversations_insert" on public.conversations;
create policy "conversations_insert" on public.conversations
  for insert
  to authenticated
  with check (created_by = auth.uid());

-- Only owner/admin can rename, re-describe, re-avatar, or flip
-- public/private.
drop policy if exists "conversations_update_admin" on public.conversations;
create policy "conversations_update_admin" on public.conversations
  for update
  to authenticated
  using (
    exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversations.id and cm.user_id = auth.uid()
        and cm.role in ('owner', 'admin')
    )
  )
  with check (
    exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversations.id and cm.user_id = auth.uid()
        and cm.role in ('owner', 'admin')
    )
  );

-- Only the owner can delete the whole group/channel.
drop policy if exists "conversations_delete_owner" on public.conversations;
create policy "conversations_delete_owner" on public.conversations
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversations.id and cm.user_id = auth.uid()
        and cm.role = 'owner'
    )
  );

-- ── RLS: conversation_members ──
alter table public.conversation_members enable row level security;

-- Any current member can see the member list of a conversation
-- they're in (self-referencing EXISTS — a standard, non-recursive
-- pattern for "am I in this group" checks).
drop policy if exists "conversation_members_select" on public.conversation_members;
create policy "conversation_members_select" on public.conversation_members
  for select
  to authenticated
  using (
    exists (
      select 1 from public.conversation_members cm2
      where cm2.conversation_id = conversation_members.conversation_id and cm2.user_id = auth.uid()
    )
  );

-- Owner/admin can add anyone to a group/channel.
drop policy if exists "conversation_members_insert_admin" on public.conversation_members;
create policy "conversation_members_insert_admin" on public.conversation_members
  for insert
  to authenticated
  with check (
    exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversation_members.conversation_id and cm.user_id = auth.uid()
        and cm.role in ('owner', 'admin')
    )
  );

-- Anyone can join a public group/channel themselves (self-serve
-- subscribe, like following a Telegram channel).
drop policy if exists "conversation_members_insert_self_public" on public.conversation_members;
create policy "conversation_members_insert_self_public" on public.conversation_members
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and exists (
      select 1 from public.conversations c
      where c.id = conversation_members.conversation_id and c.is_public = true
    )
  );

-- A member can update their own row (e.g. last_read_at for unread
-- counts). Role changes by admins are a v2 concern — kept out of
-- scope here to avoid a self-escalation hole.
drop policy if exists "conversation_members_update_own" on public.conversation_members;
create policy "conversation_members_update_own" on public.conversation_members
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- Leave a conversation yourself, or be removed by an owner/admin.
drop policy if exists "conversation_members_delete_self" on public.conversation_members;
create policy "conversation_members_delete_self" on public.conversation_members
  for delete
  to authenticated
  using (user_id = auth.uid());

drop policy if exists "conversation_members_delete_admin" on public.conversation_members;
create policy "conversation_members_delete_admin" on public.conversation_members
  for delete
  to authenticated
  using (
    exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversation_members.conversation_id and cm.user_id = auth.uid()
        and cm.role in ('owner', 'admin')
    )
  );

-- ── RLS: messages, additive policies for the conversation_id case ──
-- These are new, separate policies scoped to `conversation_id is not
-- null` — they don't touch or replace whatever policies already
-- govern the 1:1 DM case (sender_id/recipient_id), since Postgres
-- combines multiple permissive policies for the same command with
-- OR.
drop policy if exists "messages_select_conversation" on public.messages;
create policy "messages_select_conversation" on public.messages
  for select
  to authenticated
  using (
    conversation_id is not null
    and exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = messages.conversation_id and cm.user_id = auth.uid()
    )
  );

-- Any member can post in a 'group'; only owner/admin can post in a
-- 'channel'. sender_id is re-forced server-side above regardless of
-- what the client sends.
drop policy if exists "messages_insert_conversation" on public.messages;
create policy "messages_insert_conversation" on public.messages
  for insert
  to authenticated
  with check (
    conversation_id is not null
    and exists (
      select 1
      from public.conversation_members cm
      join public.conversations c on c.id = cm.conversation_id
      where cm.conversation_id = messages.conversation_id and cm.user_id = auth.uid()
        and (c.kind = 'group' or cm.role in ('owner', 'admin'))
    )
  );

-- A member can delete their own group/channel message (soft- or
-- hard-delete, matching whatever convention posts.sql already uses
-- for is_deleted — adjust to `update ... set is_deleted = true` client
-- side if this app soft-deletes rather than hard-deletes messages).
drop policy if exists "messages_delete_own_conversation" on public.messages;
create policy "messages_delete_own_conversation" on public.messages
  for delete
  to authenticated
  using (conversation_id is not null and sender_id = auth.uid());

-- ── REALTIME ──
-- `messages` is already in the realtime publication (that's how 1:1
-- DM delivery works today) — conversation_id rides on the same table
-- so nothing extra is needed there. The two new tables aren't,
-- though, so group/channel membership changes and metadata edits
-- won't push over realtime until they're added. Guarded with a DO
-- block since `alter publication ... add table` errors (rather than
-- no-ops) if the table's already a member.
do $$
begin
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversations'
  ) then
    alter publication supabase_realtime add table public.conversations;
  end if;
  if not exists (
    select 1 from pg_publication_tables
    where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'conversation_members'
  ) then
    alter publication supabase_realtime add table public.conversation_members;
  end if;
end $$;
