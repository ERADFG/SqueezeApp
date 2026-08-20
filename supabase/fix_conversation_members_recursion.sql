-- ────────────────────────────────────────────────────────────
-- FIX: infinite recursion in policy for relation
-- "conversation_members"
-- ────────────────────────────────────────────────────────────
-- Cause: several conversation_members policies check membership
-- with `exists (select 1 from conversation_members cm where ...)`
-- — a subquery against the SAME table the policy protects.
-- Postgres has to re-run that table's own RLS policies to
-- evaluate the subquery, which re-triggers the same policy,
-- which re-runs the subquery, forever. (The comment in the
-- original migration calling this "non-recursive" was wrong —
-- self-referencing EXISTS checks on the same RLS-protected
-- table are exactly what causes this error.)
--
-- Fix: move the membership/role checks into small SECURITY
-- DEFINER functions. Those run with the function owner's
-- privileges, so they read conversation_members WITHOUT
-- triggering its RLS policies at all — no recursion possible.
--
-- Safe to run regardless of which earlier chat migration
-- (chat_full_setup.sql / RUN_PENDING_MIGRATIONS.sql /
-- chat_group_manage.sql / chat_group_avatar_and_names.sql)
-- last ran on your database — it only drops/recreates the
-- specific policies involved.
-- ────────────────────────────────────────────────────────────

-- ── Helper functions (bypass RLS on conversation_members) ──
-- Dropped first: CREATE OR REPLACE can't change an existing
-- function's parameter names, and a same-named/same-signature
-- function may already exist (e.g. from a prior attempt) with
-- different parameter names.

drop function if exists public.is_conversation_member(uuid, uuid) cascade;
drop function if exists public.is_conversation_admin(uuid, uuid) cascade;

create or replace function public.is_conversation_member(_conversation_id uuid, _user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = _conversation_id
      and cm.user_id = _user_id
  );
$$;

create or replace function public.is_conversation_admin(_conversation_id uuid, _user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.conversation_members cm
    where cm.conversation_id = _conversation_id
      and cm.user_id = _user_id
      and cm.role in ('owner', 'admin')
  );
$$;

revoke all on function public.is_conversation_member(uuid, uuid) from public;
revoke all on function public.is_conversation_admin(uuid, uuid) from public;
grant execute on function public.is_conversation_member(uuid, uuid) to authenticated;
grant execute on function public.is_conversation_admin(uuid, uuid) to authenticated;

-- ── conversation_members policies, rewritten to use the helpers ──

drop policy if exists "conversation_members_select" on public.conversation_members;
create policy "conversation_members_select" on public.conversation_members
  for select
  to authenticated
  using (
    public.is_conversation_member(conversation_id, auth.uid())
  );

drop policy if exists "conversation_members_insert_admin" on public.conversation_members;
create policy "conversation_members_insert_admin" on public.conversation_members
  for insert
  to authenticated
  with check (
    public.is_conversation_admin(conversation_id, auth.uid())
  );

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

drop policy if exists "conversation_members_update_own" on public.conversation_members;
create policy "conversation_members_update_own" on public.conversation_members
  for update
  to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

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
    public.is_conversation_admin(conversation_id, auth.uid())
  );

-- ── conversations policies that reference conversation_members ──
-- These aren't recursive on their own (conversations is a
-- different table), but they were written as raw EXISTS
-- subqueries too. Routing them through the same SECURITY
-- DEFINER helpers keeps behavior identical and avoids ever
-- re-triggering conversation_members RLS while checking
-- conversations access.

drop policy if exists "conversations_select" on public.conversations;
create policy "conversations_select" on public.conversations
  for select
  to authenticated
  using (
    is_public = true
    or public.is_conversation_member(id, auth.uid())
  );

drop policy if exists "conversations_select_member" on public.conversations;
create policy "conversations_select_member" on public.conversations
  for select
  to authenticated
  using (
    is_public = true
    or public.is_conversation_member(id, auth.uid())
  );

drop policy if exists "conversations_update_admin" on public.conversations;
create policy "conversations_update_admin" on public.conversations
  for update
  to authenticated
  using (
    public.is_conversation_admin(id, auth.uid())
  )
  with check (
    public.is_conversation_admin(id, auth.uid())
  );

drop policy if exists "conversations_delete_owner" on public.conversations;
drop policy if exists "conversations_delete_creator" on public.conversations;
create policy "conversations_delete_creator" on public.conversations
  for delete
  to authenticated
  using (created_by = auth.uid());

-- ── messages policies that reference conversation_members ──

drop policy if exists "messages_select_conversation" on public.messages;
create policy "messages_select_conversation" on public.messages
  for select
  to authenticated
  using (
    conversation_id is not null
    and public.is_conversation_member(conversation_id, auth.uid())
  );

drop policy if exists "messages_insert_conversation" on public.messages;
create policy "messages_insert_conversation" on public.messages
  for insert
  to authenticated
  with check (
    conversation_id is not null
    and public.is_conversation_member(conversation_id, auth.uid())
    and (
      -- channels: only owner/admin can post; groups: any member can post
      exists (
        select 1 from public.conversations c
        where c.id = conversation_id and c.kind = 'group'
      )
      or public.is_conversation_admin(conversation_id, auth.uid())
    )
  );

drop policy if exists "messages_delete_own_conversation" on public.messages;
create policy "messages_delete_own_conversation" on public.messages
  for delete
  to authenticated
  using (
    conversation_id is not null
    and sender_id = auth.uid()
  );

-- ── conversation_members_protect_role trigger fn (chat_group_manage.sql) ──
-- Also did a raw self-referencing EXISTS; not part of a SELECT-time
-- RLS check so it isn't the cause of this error, but it's the same
-- footgun pattern, so it's routed through the helper too for safety.
create or replace function public.conversation_members_protect_role()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role is distinct from old.role then
    if not public.is_conversation_admin(old.conversation_id, auth.uid()) then
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
