-- ============================================================
-- CHAT — group/channel editing, membership management, and
-- creator-only delete. Safe to re-run any time — every statement
-- is idempotent. Run this in the Supabase SQL editor AFTER
-- supabase/chat_full_setup.sql (it depends on the `conversations`
-- and `conversation_members` tables that script creates).
--
-- What this adds on top of chat_full_setup.sql:
--   1. Restates (unchanged) that owner/admin can rename, re-describe,
--      re-avatar, and flip public/private — chat_full_setup.sql's
--      "conversations_update_admin" policy already covers all of
--      that as one plain row-level UPDATE policy (it isn't
--      column-restricted), so the new "change public/private"
--      control in js/chat.js needs no new policy. Included here
--      again only so this file is a complete, standalone reference
--      for "everything about editing a group/channel."
--   2. Restates (unchanged) that owner/admin can add
--      ("conversation_members_insert_admin") and remove
--      ("conversation_members_delete_admin") other members —
--      already in chat_full_setup.sql, so the new "remove member"
--      button needs no new policy either.
--   3. TIGHTENS delete: replaces the old role-based
--      "conversations_delete_owner" policy (anyone with
--      role = 'owner') with "conversations_delete_creator", which
--      checks created_by = auth.uid() directly. created_by is set
--      once, server-side, at insert time
--      (conversations_force_creator trigger) and never changes —
--      so this is a hard guarantee that only the person who
--      created the group/channel can ever delete it, independent
--      of the role table.
--   4. HARDENS the role column: the existing
--      "conversation_members_update_own" policy lets a member
--      update their own row (originally just for last_read_at) but
--      never restricted which columns — as written, any member
--      could have UPDATEd their own row to set role = 'owner' and
--      granted themselves delete/manage rights. A trigger below
--      closes that hole by silently reverting any role change made
--      by someone who isn't already an owner/admin of that
--      conversation. This is what makes guarantee #3 actually mean
--      something (owner can no longer be self-granted).
-- ============================================================

-- ── 1. conversations UPDATE (rename / re-describe / re-avatar / public-private) ──
-- Unchanged from chat_full_setup.sql — restated for completeness.
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

-- ── 2. conversation_members INSERT/DELETE (add / remove members) ──
-- Unchanged from chat_full_setup.sql — restated for completeness.
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

-- ── 3. conversations DELETE — creator only ──
-- Replaces the role-based "conversations_delete_owner" policy from
-- chat_full_setup.sql with a direct created_by check.
drop policy if exists "conversations_delete_owner" on public.conversations;
drop policy if exists "conversations_delete_creator" on public.conversations;
create policy "conversations_delete_creator" on public.conversations
  for delete
  to authenticated
  using (created_by = auth.uid());

-- ── 4. Prevent self-granted role changes ──
-- conversation_members_update_own (chat_full_setup.sql) lets a
-- member update their own row for legitimate reasons (last_read_at).
-- This trigger makes sure that's ALL that policy can be used for:
-- if a row's role is being changed by someone who isn't currently an
-- owner/admin of that conversation, the change is silently reverted
-- back to the old role instead of erroring (keeps the same UPDATE
-- succeeding for the last_read_at part of the same statement, if
-- any). security definer so it can look up the actor's own
-- membership row even under RLS.
create or replace function public.conversation_members_protect_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role then
    if not exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = old.conversation_id and cm.user_id = auth.uid()
        and cm.role in ('owner', 'admin')
    ) then
      new.role := old.role;
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists conversation_members_protect_role_trg on public.conversation_members;
create trigger conversation_members_protect_role_trg
  before update on public.conversation_members
  for each row execute function public.conversation_members_protect_role();

-- ============================================================
-- 5. Name & description length limits
-- ============================================================
-- Enforces server-side what js/chat.js now also enforces client-side
-- (maxlength on the inputs + a JS check before insert/update):
--   name        <= 14 characters
--   description <= 50 characters (still optional — NULL is fine)
--
-- Existing rows are truncated BEFORE the constraints are added, so
-- this won't fail against any group/channel created before this
-- limit existed — it just clips anything already over the new limit
-- down to fit.

update public.conversations
  set name = left(name, 14)
  where char_length(name) > 14;

update public.conversations
  set description = left(description, 50)
  where description is not null and char_length(description) > 50;

alter table public.conversations drop constraint if exists conversations_name_len_chk;
alter table public.conversations add constraint conversations_name_len_chk
  check (char_length(name) <= 14);

alter table public.conversations drop constraint if exists conversations_desc_len_chk;
alter table public.conversations add constraint conversations_desc_len_chk
  check (description is null or char_length(description) <= 50);
