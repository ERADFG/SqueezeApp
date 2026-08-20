-- ═══════════════════════════════════════════════════════════════
-- INTERACTINK — PENDING MIGRATIONS (run this once)
--
-- Everything in MASTER_MIGRATIONS_reconstructed.sql should already
-- be applied to your project. These six files are NOT in that
-- master yet — they're what's needed for chat/DMs, groups &
-- channels, group/channel avatars, and today's voice-note upload
-- fix. Every statement here is written to be safe to re-run
-- (if not exists / drop-if-exists-then-create), so it's fine to
-- run this whole file even if some pieces already partially
-- exist on your project.
--
-- Run this in the Supabase SQL editor, top to bottom, in one go.
-- ═══════════════════════════════════════════════════════════════

-- ───────────────────────────────────────────────────────────────
-- FROM: supabase/chat_full_setup.sql
-- ───────────────────────────────────────────────────────────────
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
-- ENCRYPTION NOTE: message text stays end-to-end encrypted for 1:1
-- DMs only (per-pair ECDH, see js/chat-crypto.js — unchanged by this
-- file). Group/channel messages are plain text server-side, and
-- media attachments (in any context) are plain public URLs, same
-- trust model as a post's image — see the PART 1 comment below for
-- why.
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


-- ───────────────────────────────────────────────────────────────
-- FROM: supabase/chat_media.sql
-- ───────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────
-- CHAT MEDIA — lets DM messages carry an image, video, or voice
-- note, with or without a text caption.
--
-- Media is uploaded to the same public "media" storage bucket posts
-- and replies already use (see MEDIA_BUCKET / uploadMedia() in
-- js/common.js) — no new bucket or storage policy needed, since that
-- bucket's insert/select policies are already scoped to "any
-- authenticated user can upload, anyone can read the public URL".
--
-- NOTE ON ENCRYPTION: unlike message text (see chat_e2e_encryption.sql
-- / js/chat-crypto.js), attached media is NOT end-to-end encrypted.
-- It's a plain public URL, same trust model as post/reply media. A
-- message's `body`/`iv` (caption) still go through the normal E2E
-- path independently — a photo can have an encrypted caption, an
-- unencrypted one, or no caption at all (body = '').
-- ─────────────────────────────────────────────────────────────

alter table public.messages add column if not exists media_url text;
alter table public.messages add column if not exists media_type text
  check (media_type in ('image', 'video', 'audio'));

comment on column public.messages.media_url is
  'Public URL of an attached image/video/voice-note in the shared "media" storage bucket. NULL = text-only message.';
comment on column public.messages.media_type is
  'image | video | audio (voice note). NULL when media_url is NULL.';

-- A message must either say something or attach something.
alter table public.messages drop constraint if exists messages_body_or_media_chk;
alter table public.messages add constraint messages_body_or_media_chk
  check (coalesce(body, '') <> '' or media_url is not null);


-- ───────────────────────────────────────────────────────────────
-- FROM: supabase/chat_group_avatar_and_names.sql
-- ───────────────────────────────────────────────────────────────
-- ============================================================
-- CHAT — group/channel avatars + names/descriptions.
-- Safe to re-run any time — every statement is idempotent.
--
-- This is a standalone confirmation/completion script for the
-- avatar-upload + rename feature added to the "New group"/"New
-- channel" modal and the group-info panel. Most of this already
-- exists if supabase/chat_full_setup.sql has been run — this file
-- just makes sure every piece it depends on is actually in place,
-- and is safe to run on its own even if chat_full_setup.sql never
-- was.
-- ============================================================

-- ── conversations table + columns ──
-- (No-op if supabase/chat_full_setup.sql already created this.)
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
alter table public.conversations add column if not exists avatar_url text;
alter table public.conversations add column if not exists description text;

create table if not exists public.conversation_members (
  conversation_id uuid not null references public.conversations(id) on delete cascade,
  user_id         uuid not null references public.profiles(id) on delete cascade,
  role            text not null default 'member' check (role in ('owner', 'admin', 'member')),
  joined_at       timestamptz not null default now(),
  last_read_at    timestamptz,
  primary key (conversation_id, user_id)
);

comment on column public.conversations.avatar_url is
  'Public URL of the group/channel picture, in the shared "avatars" storage bucket (same bucket/policy as profile pictures — see uploadAvatar() in js/auth.js). NULL = no picture set, client falls back to an initial-letter avatar.';

-- ── RLS ──
alter table public.conversations enable row level security;
alter table public.conversation_members enable row level security;

-- Only a current owner/admin may rename, re-describe, re-avatar, or
-- flip public/private on an existing group/channel. (Anyone can
-- still INSERT a new one — see "conversations_insert" in
-- chat_full_setup.sql, unaffected by this file.)
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

-- Every current member can read the group/channel row (name,
-- avatar_url, description, is_public, etc.) — needed for the info
-- panel and conversation-list rows to render at all.
drop policy if exists "conversations_select_member" on public.conversations;
create policy "conversations_select_member" on public.conversations
  for select
  to authenticated
  using (
    is_public = true
    or exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = conversations.id and cm.user_id = auth.uid()
    )
  );

-- ── STORAGE — group/channel avatars reuse the existing "avatars"
-- bucket (same one profile pictures use), uploaded to the acting
-- user's own <uid> folder — see uploadAvatar() in js/auth.js. That
-- bucket's policies already allow any authenticated user to write
-- inside their own folder and let anyone read the public URL, so no
-- new bucket or storage policy is needed here. This block only
-- creates the bucket if this project genuinely doesn't have it yet
-- (fresh Supabase project) — it's a no-op everywhere else.
insert into storage.buckets (id, name, public)
select 'avatars', 'avatars', true
where not exists (select 1 from storage.buckets where id = 'avatars');

drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read" on storage.objects
  for select
  to public
  using (bucket_id = 'avatars');

drop policy if exists "avatars_own_folder_write" on storage.objects;
create policy "avatars_own_folder_write" on storage.objects
  for insert
  to authenticated
  with check (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars_own_folder_update" on storage.objects;
create policy "avatars_own_folder_update" on storage.objects
  for update
  to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);


-- ───────────────────────────────────────────────────────────────
-- FROM: supabase/fix_media_bucket_audio_mime.sql
-- ───────────────────────────────────────────────────────────────
-- ─────────────────────────────────────────────────────────────
-- FIX: voice notes fail to upload with "mime type audio/webm is
-- not supported" (and similarly for audio/mp4, audio/ogg).
--
-- Root cause: the shared "media" storage bucket (see MEDIA_BUCKET /
-- uploadMedia() in js/common.js — created outside these migrations,
-- directly in the Supabase dashboard, back when it only had to hold
-- post/reply images and videos) has an allowed_mime_types allow-list
-- that was never updated when voice notes were added in
-- chat_media.sql. Supabase Storage rejects the upload at the bucket
-- level before it ever reaches app code, which is what surfaces as
-- that raw "mime type ... is not supported" error in the UI.
--
-- This sets the bucket to accept the actual set of types every
-- uploader in this app can produce:
--  - images: compressImageFile()/compressGifFile() output + originals
--  - video:  uploaded as-is (see the note in uploadMedia())
--  - audio:  startVoiceRecording()'s MediaRecorder, whichever of
--            audio/webm, audio/mp4, audio/ogg the browser picked
--
-- Safe to run repeatedly — it's a plain update, not an insert.
-- ─────────────────────────────────────────────────────────────

update storage.buckets
set allowed_mime_types = array[
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav'
],
    file_size_limit = coalesce(file_size_limit, 52428800) -- 50MB, only if not already set
where id = 'media';

-- If this project genuinely never had the bucket at all, create it
-- now with the right allow-list already in place (no-op everywhere
-- the bucket already exists, per the `where not exists` guard).
insert into storage.buckets (id, name, public, allowed_mime_types, file_size_limit)
select 'media', 'media', true, array[
  'image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif',
  'video/mp4', 'video/webm', 'video/quicktime',
  'audio/webm', 'audio/mp4', 'audio/ogg', 'audio/mpeg', 'audio/wav'
], 52428800
where not exists (select 1 from storage.buckets where id = 'media');


-- ───────────────────────────────────────────────────────────────
-- FROM: supabase/ip_ban.sql
-- ───────────────────────────────────────────────────────────────
-- ============================================================
-- IP BAN — suspending someone now bans their known IP address(es)
-- too, not just the account. Run after admin_panel_advanced.sql and
-- suspend_deletes_content.sql. Additive/idempotent — safe to re-run.
--
-- WHY: banning only the account (profiles.banned) is trivial to
-- evade — sign up again with a new email and you're back. This adds
-- a second, IP-based layer:
--   1. public.user_ips logs every IP each account has connected
--      from (recorded via api/ip.js, a Vercel function that reads
--      the *real* client IP from Vercel's own x-forwarded-for header
--      — not something the browser can just lie about the way it
--      could if the client sent its own IP value straight to
--      Postgres).
--   2. public.banned_ips is the deny-list. Suspending a user copies
--      every IP on file for them into it; unsuspending removes only
--      the rows that suspension added (a shared IP another still-
--      suspended account also used stays banned).
--   3. is_ip_banned() is a public RPC (works for signed-out visitors
--      too) that api/ip.js calls before letting someone sign up, and
--      that js/auth.js also checks once a session exists — so a
--      banned IP can neither create a new account nor keep an
--      existing session alive.
-- ============================================================

-- ── 1. Tables ───────────────────────────────────────────────

create table if not exists public.user_ips (
  user_id    uuid not null references public.profiles(id) on delete cascade,
  ip         text not null,
  first_seen timestamptz not null default now(),
  last_seen  timestamptz not null default now(),
  primary key (user_id, ip)
);
create index if not exists user_ips_ip_idx on public.user_ips(ip);

create table if not exists public.banned_ips (
  ip        text not null,
  user_id   uuid not null references public.profiles(id) on delete cascade,
  banned_at timestamptz not null default now(),
  reason    text,
  primary key (ip, user_id)
);
create index if not exists banned_ips_ip_idx on public.banned_ips(ip);

alter table public.user_ips   enable row level security;
alter table public.banned_ips enable row level security;
-- No direct client policies on either table on purpose — every read/
-- write goes through the SECURITY DEFINER functions below, same
-- pattern the rest of the admin panel uses to avoid a service_role
-- key ever touching the browser.

-- ── 2. record_user_ip() — called by api/ip.js on every signup/login/
-- page load for a signed-in user, with the IP api/ip.js itself read
-- from the request headers (never trusted from the client body).
-- Upserts the IP against the caller's own account and returns
-- whether that IP is currently banned, so api/ip.js can act on it in
-- the same round trip. ──

create or replace function public.record_user_ip(p_ip text)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null or p_ip is null or trim(p_ip) = '' then
    return false;
  end if;
  insert into public.user_ips (user_id, ip, first_seen, last_seen)
    values (auth.uid(), p_ip, now(), now())
  on conflict (user_id, ip) do update set last_seen = now();

  return exists(select 1 from public.banned_ips b where b.ip = p_ip);
end;
$$;

-- ── 3. is_ip_banned() — public (anon-callable) so api/ip.js can
-- refuse a signup from a banned IP before an account even exists. ──

create or replace function public.is_ip_banned(p_ip text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists(select 1 from public.banned_ips where ip = p_ip);
$$;

grant execute on function public.record_user_ip(text) to authenticated;
grant execute on function public.is_ip_banned(text)   to anon, authenticated;

-- ── 4. admin_get_user_ips() — lets the admin panel show which IPs
-- are on file for an account before/while suspending it. ──

create or replace function public.admin_get_user_ips(target_user_id uuid)
returns table(ip text, first_seen timestamptz, last_seen timestamptz)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  return query
    select u.ip, u.first_seen, u.last_seen
    from public.user_ips u
    where u.user_id = target_user_id
    order by u.last_seen desc;
end;
$$;
grant execute on function public.admin_get_user_ips(uuid) to authenticated;

-- ── 5. Extend admin_suspend_user / admin_unsuspend_user (re-defined
-- from suspend_deletes_content.sql, plus the IP step) ──

create or replace function public.admin_suspend_user(target_user_id uuid, reason text default null, until timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'cannot suspend your own account';
  end if;
  update public.profiles
    set banned = true,
        suspend_reason = nullif(trim(coalesce(reason, '')), ''),
        suspended_until = until
    where id = target_user_id;

  update public.posts
    set is_deleted = true, deleted_by_suspension = true
    where author_id = target_user_id and is_deleted = false;
  update public.replies
    set is_deleted = true, deleted_by_suspension = true
    where author_id = target_user_id and is_deleted = false;

  -- Ban every IP this account has ever connected from, so a fresh
  -- account made from the same device/network is blocked at signup
  -- (see is_ip_banned() in api/ip.js's pre-signup check) instead of
  -- only the old account being locked out.
  insert into public.banned_ips (ip, user_id, reason)
    select u.ip, target_user_id, nullif(trim(coalesce(reason, '')), '')
    from public.user_ips u
    where u.user_id = target_user_id
  on conflict (ip, user_id) do update
    set reason = excluded.reason, banned_at = now();
end;
$$;

create or replace function public.admin_unsuspend_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.profiles set banned = false, suspended_until = null, suspend_reason = null where id = target_user_id;

  update public.posts
    set is_deleted = false, deleted_by_suspension = false
    where author_id = target_user_id and deleted_by_suspension = true;
  update public.replies
    set is_deleted = false, deleted_by_suspension = false
    where author_id = target_user_id and deleted_by_suspension = true;

  -- Only lift the IP bans THIS suspension added. If another still-
  -- suspended account shares one of these IPs, its own row (a
  -- different user_id on the same ip) stays behind and the IP stays
  -- banned — exactly the point of keying banned_ips by (ip, user_id).
  delete from public.banned_ips where user_id = target_user_id;
end;
$$;

grant execute on function public.admin_suspend_user(uuid, text, timestamptz) to authenticated;
grant execute on function public.admin_unsuspend_user(uuid)                  to authenticated;

notify pgrst, 'reload schema';


-- ───────────────────────────────────────────────────────────────
-- FROM: supabase/suspend_deletes_content.sql
-- ───────────────────────────────────────────────────────────────
-- ============================================================
-- SUSPEND -> AUTO-DELETE CONTENT
-- Run after admin_panel_advanced.sql. Additive/idempotent — safe to
-- re-run any time.
--
-- What this adds on top of admin_panel_advanced.sql's suspend/
-- unsuspend (which only flipped profiles.banned + metadata):
--   1. Every post and reply belonging to a user is automatically
--      soft-deleted (same is_deleted flag admin_delete_post/
--      admin_delete_reply already use) the moment they're suspended
--      — same as X, where a suspended account's posts disappear.
--   2. A new deleted_by_suspension flag on posts/replies marks which
--      ones were taken down *because of* the suspension, as opposed
--      to ones the author (or a mod) had already deleted themselves
--      beforehand. That distinction matters twice: unsuspending only
--      restores the former (a manually-deleted post doesn't come
--      back just because the account got unsuspended), and
--      quotedPostHtml() in js/common.js reads it to show "This post
--      is from a suspended account" instead of the generic "no
--      longer available" wording for quote-post embeds.
--   3. The username itself is never freed up — nothing here touches
--      the profiles row or its username, so the unique constraint on
--      profiles.username keeps anyone else from ever registering it,
--      exactly like a suspended handle on X.
-- ============================================================

alter table public.posts   add column if not exists deleted_by_suspension boolean not null default false;
alter table public.replies add column if not exists deleted_by_suspension boolean not null default false;

create or replace function public.admin_suspend_user(target_user_id uuid, reason text default null, until timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'cannot suspend your own account';
  end if;
  update public.profiles
    set banned = true,
        suspend_reason = nullif(trim(coalesce(reason, '')), ''),
        suspended_until = until
    where id = target_user_id;

  -- Only touch rows that weren't already deleted, so a post the
  -- author (or a mod) removed beforehand doesn't get relabeled as
  -- "deleted by suspension" and wrongly come back on unsuspend.
  update public.posts
    set is_deleted = true, deleted_by_suspension = true
    where author_id = target_user_id and is_deleted = false;
  update public.replies
    set is_deleted = true, deleted_by_suspension = true
    where author_id = target_user_id and is_deleted = false;
end;
$$;

create or replace function public.admin_unsuspend_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.profiles set banned = false, suspended_until = null, suspend_reason = null where id = target_user_id;

  -- Only restore what the suspension itself took down — leaves any
  -- of the user's own prior deletions alone.
  update public.posts
    set is_deleted = false, deleted_by_suspension = false
    where author_id = target_user_id and deleted_by_suspension = true;
  update public.replies
    set is_deleted = false, deleted_by_suspension = false
    where author_id = target_user_id and deleted_by_suspension = true;
end;
$$;

grant execute on function public.admin_suspend_user(uuid, text, timestamptz) to authenticated;
grant execute on function public.admin_unsuspend_user(uuid)                  to authenticated;
notify pgrst, 'reload schema';


