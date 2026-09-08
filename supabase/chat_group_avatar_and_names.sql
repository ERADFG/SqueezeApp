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
