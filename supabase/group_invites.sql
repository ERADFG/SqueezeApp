-- ============================================================
-- GROUP/CHANNEL INVITES — being added to a group or channel by
-- someone else now creates a pending invite instead of dropping you
-- straight in. You get a notification with Accept/Decline actions
-- (js/notifications.js) and, if you open the thread link before
-- responding, a landing screen instead of the live chat
-- (loadGroupThread() in js/chat.js). Safe to re-run — every
-- statement is idempotent. Run AFTER supabase/chat_full_setup.sql
-- and supabase/chat_group_manage.sql.
--
-- What still joins instantly, with no invite step:
--   - The creator of a group/channel (conversations_add_owner_trg).
--   - Anyone self-joining a PUBLIC group/channel (like subscribing
--     to a Telegram channel) — conversation_members_insert_self_public.
-- What now requires accept/decline:
--   - Being added by an owner/admin to a PRIVATE group/channel, or
--     picked as a member while one is being created.
-- ============================================================

-- ── 1. New columns on conversation_members ──
-- status: 'pending' until the invitee accepts, 'accepted' once
-- they're actually in. Existing rows all default to 'accepted' so
-- nothing that already worked breaks.
alter table public.conversation_members add column if not exists status text not null default 'accepted';
alter table public.conversation_members drop constraint if exists conversation_members_status_chk;
alter table public.conversation_members add constraint conversation_members_status_chk
  check (status in ('pending', 'accepted'));

-- Who sent the invite (null for self-joins/the creator's own row).
alter table public.conversation_members add column if not exists invited_by uuid references public.profiles(id) on delete set null;

create index if not exists conversation_members_status_idx on public.conversation_members(user_id, status);

-- ── 2. Force status/invited_by server-side ──
-- Whether a new membership row is pending or immediately accepted is
-- never trusted from the client: it's derived purely from who's
-- doing the inserting.
--   - Inserting your OWN row (auth.uid() = new.user_id) — the
--     creator's auto-owner row, or a self-join on a public group/
--     channel — is accepted immediately.
--   - Anyone else inserting your row for you (an owner/admin adding
--     a member) becomes a pending invite, credited to whoever ran it.
create or replace function public.conversation_members_force_invite_status()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is not null and new.user_id = auth.uid() then
    new.status := 'accepted';
    new.invited_by := null;
  else
    new.status := 'pending';
    new.invited_by := auth.uid();
  end if;
  return new;
end;
$$;

drop trigger if exists conversation_members_force_invite_status_trg on public.conversation_members;
create trigger conversation_members_force_invite_status_trg
  before insert on public.conversation_members
  for each row execute function public.conversation_members_force_invite_status();

-- ── 3. Notify the invitee ──
-- notifications.conversation_id links a 'group_invite' notification
-- back to the group/channel (mirrors post_id/reply_id for the other
-- notification types) — see js/notifications.js's NOTIF_SELECT.
alter table public.notifications add column if not exists conversation_id uuid references public.conversations(id) on delete cascade;

create or replace function public.notify_group_invite()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.status = 'pending' and new.invited_by is not null then
    insert into public.notifications (user_id, actor_id, type, conversation_id, read, created_at)
    values (new.user_id, new.invited_by, 'group_invite', new.conversation_id, false, now());
  end if;
  return new;
end;
$$;

drop trigger if exists trg_notify_group_invite on public.conversation_members;
create trigger trg_notify_group_invite
  after insert on public.conversation_members
  for each row execute function public.notify_group_invite();

-- ── 4. Gate real membership on status = 'accepted' ──
-- A pending row still lets you see the group/channel's name/avatar
-- (conversations_select is unchanged — that's what lets the invite
-- notification and the accept/decline landing screen show what
-- you're being invited to) but NOT the member list, the message
-- history, or the ability to post, until you accept.

-- conversation_members: an accepted member can see the full member
-- list of their conversations (pending rows included, so admins can
-- see who they've invited); anyone can always see their own row
-- (needed to render/accept/decline their own pending invite).
drop policy if exists "conversation_members_select" on public.conversation_members;
create policy "conversation_members_select" on public.conversation_members
  for select
  to authenticated
  using (
    user_id = auth.uid()
    or exists (
      select 1 from public.conversation_members cm2
      where cm2.conversation_id = conversation_members.conversation_id
        and cm2.user_id = auth.uid() and cm2.status = 'accepted'
    )
  );

-- messages: reading and posting both require an ACCEPTED membership row.
drop policy if exists "messages_select_conversation" on public.messages;
create policy "messages_select_conversation" on public.messages
  for select
  to authenticated
  using (
    conversation_id is not null
    and exists (
      select 1 from public.conversation_members cm
      where cm.conversation_id = messages.conversation_id and cm.user_id = auth.uid()
        and cm.status = 'accepted'
    )
  );

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
        and cm.status = 'accepted'
        and (c.kind = 'group' or cm.role in ('owner', 'admin'))
    )
  );

-- get_group_thread / get_group_last_messages (chat_server_side_encryption.sql)
-- — same "accepted only" gate, re-created here with the extra check.
create or replace function public.get_group_thread(conv_id uuid, msg_limit int default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, vault
as $$
declare
  me uuid := auth.uid();
  result jsonb;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.conversation_members cm where cm.conversation_id = conv_id and cm.user_id = me and cm.status = 'accepted') then
    raise exception 'not a member of this conversation';
  end if;
  select coalesce(jsonb_agg(row order by created_at asc), '[]'::jsonb) into result
  from (
    select
      m.created_at,
      to_jsonb(m) || jsonb_build_object(
        'body', case when m.body_encrypted
                      then convert_from(pgp_sym_decrypt(decode(m.body, 'base64'), public._chat_secret()), 'UTF8')
                      else m.body end
      ) as row
    from public.messages m
    where m.conversation_id = conv_id
    order by m.created_at asc
    limit msg_limit
  ) t;
  return result;
end;
$$;

revoke all on function public.get_group_thread(uuid, int) from public, anon;
grant execute on function public.get_group_thread(uuid, int) to authenticated;

create or replace function public.get_group_last_messages(conv_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, vault
as $$
declare
  me uuid := auth.uid();
  result jsonb;
begin
  if me is null then raise exception 'not authenticated'; end if;
  select coalesce(jsonb_agg(row), '[]'::jsonb) into result
  from (
    select distinct on (m.conversation_id)
      to_jsonb(m) || jsonb_build_object(
        'body', case when m.body_encrypted
                      then convert_from(pgp_sym_decrypt(decode(m.body, 'base64'), public._chat_secret()), 'UTF8')
                      else m.body end,
        'sender', jsonb_build_object('username', sp.username, 'display_name', sp.display_name)
      ) as row
    from public.messages m
    join public.profiles sp on sp.id = m.sender_id
    where m.conversation_id = any(conv_ids)
      and exists (select 1 from public.conversation_members cm where cm.conversation_id = m.conversation_id and cm.user_id = me and cm.status = 'accepted')
    order by m.conversation_id, m.created_at desc
  ) t;
  return result;
end;
$$;

revoke all on function public.get_group_last_messages(uuid[]) from public, anon;
grant execute on function public.get_group_last_messages(uuid[]) to authenticated;

-- ── 5. Accept / decline ──
-- No new RPC needed for either:
--   - Accept is a plain UPDATE of your own row's status, already
--     covered by conversation_members_update_own.
--   - Decline is a plain DELETE of your own row, already covered by
--     conversation_members_delete_self.
-- js/chat.js and js/notifications.js call those directly.
