-- ============================================================
-- CHAT — delete message (for me / for everyone) + delete conversation
-- (removes a contact's messages from your inbox). Run once in the
-- Supabase SQL editor. Safe to re-run — every statement is
-- idempotent.
--
-- Only covers 1:1 DMs (sender_id/recipient_id rows), not group/
-- channel messages (conversation_id rows) — those already have their
-- own "delete your own message" RLS policy from chat_full_setup.sql
-- (messages_delete_own_conversation), which hard-deletes the row
-- outright, so there's nothing to add there.
--
-- THREE NEW THINGS:
--   1. "Delete for me"       — hides one message from your own view
--      only. The other person keeps seeing it normally. Stored as a
--      per-side flag (deleted_for_sender / deleted_for_recipient)
--      rather than actually removing the row, since the row still
--      needs to exist for the OTHER side.
--   2. "Delete for everyone" — sender-only. Wipes the message content
--      (body/iv/media/shared post) and tombstones the row so both
--      sides render "This message was deleted" instead of the real
--      content. The row itself stays (keeps timestamps/ordering
--      sane) but nothing readable is left in it.
--   3. "Delete conversation"  — deleting a contact from your message
--      list. There's no separate contacts table for DMs — the
--      conversation list is just derived from the messages table
--      (see loadConversationList() in js/chat.js) — so "delete this
--      person" = delete-for-me every message you've exchanged with
--      them. Once every message between the two of you is hidden on
--      your side, the conversation naturally disappears from your
--      inbox. The other person's inbox is untouched — same one-sided
--      behavior as deleting a single message for yourself, and the
--      same convention WhatsApp/Instagram/X use for "delete chat".
--
-- All three go through SECURITY DEFINER RPCs (same pattern as
-- delete_own_post/delete_own_reply in fix_delete_via_rpc.sql) rather
-- than raw client-side UPDATEs, so ownership is checked server-side
-- regardless of whatever the existing messages RLS policies allow —
-- this migration doesn't need to know their exact definitions to be
-- safe.
--
-- NOTE ON SELECT RLS: filtering out deleted-for-me rows currently
-- happens client-side (js/chat.js drops any row where the flag is
-- set for the current viewer, for both the conversation list and an
-- open thread). That's enough for the UI to behave correctly, but
-- it's not defense-in-depth — a network tab could still see the
-- flagged-hidden row's ciphertext. If you want the SELECT policy
-- itself to exclude these rows, share its current definition and it
-- can be tightened in a follow-up migration.
-- ============================================================

alter table public.messages add column if not exists deleted_for_sender boolean not null default false;
alter table public.messages add column if not exists deleted_for_recipient boolean not null default false;
alter table public.messages add column if not exists deleted_for_everyone boolean not null default false;

comment on column public.messages.deleted_for_sender is 'true = the sender chose "Delete for me" on this message; hidden from their view only.';
comment on column public.messages.deleted_for_recipient is 'true = the recipient chose "Delete for me" on this message; hidden from their view only.';
comment on column public.messages.deleted_for_everyone is 'true = "Delete for everyone" (sender-only). body/iv/media/shared_post_id are wiped once this is set; both sides render a tombstone instead.';

-- The old "must contain something" constraint (chat_full_setup.sql)
-- would reject the wipe a delete-for-everyone update performs, since
-- that update intentionally empties body/media/shared_post_id. Widen
-- it to also allow a tombstoned row through.
alter table public.messages drop constraint if exists messages_has_content_chk;
alter table public.messages add constraint messages_has_content_chk
  check (deleted_for_everyone or coalesce(body, '') <> '' or media_url is not null or shared_post_id is not null);

-- ── delete_message_for_me ──
-- Hides a single 1:1 DM message from the caller's own view. Works
-- for either side of the conversation — whichever one you are is
-- detected from the row itself, not passed in by the client.
create or replace function public.delete_message_for_me(message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
begin
  select sender_id, recipient_id, conversation_id into m
    from public.messages where id = message_id;

  if not found then
    raise exception 'Message not found.';
  end if;
  if m.conversation_id is not null then
    raise exception 'This message belongs to a group/channel — use the group delete instead.';
  end if;

  if auth.uid() = m.sender_id then
    update public.messages set deleted_for_sender = true where id = message_id;
  elsif auth.uid() = m.recipient_id then
    update public.messages set deleted_for_recipient = true where id = message_id;
  else
    raise exception 'This is not your message.';
  end if;
end;
$$;

grant execute on function public.delete_message_for_me(uuid) to authenticated;

-- ── delete_message_for_everyone ──
-- Sender-only. Wipes the message content and tombstones the row so
-- it renders as "This message was deleted" for both sides. Attached
-- media's storage object is intentionally left alone here (the row
-- just stops pointing at it) — if you also want the file itself
-- removed from the "media" bucket, that needs a follow-up storage
-- delete call from the client, since SQL alone can't reach into
-- Storage.
create or replace function public.delete_message_for_everyone(message_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  m record;
begin
  select sender_id, conversation_id into m
    from public.messages where id = message_id;

  if not found then
    raise exception 'Message not found.';
  end if;
  if m.conversation_id is not null then
    raise exception 'This message belongs to a group/channel — use the group delete instead.';
  end if;
  if auth.uid() <> m.sender_id then
    raise exception 'Only the sender can delete this for everyone.';
  end if;

  update public.messages
    set body = '',
        iv = null,
        media_url = null,
        media_type = null,
        media_duration_ms = null,
        shared_post_id = null,
        deleted_for_everyone = true
    where id = message_id;
end;
$$;

grant execute on function public.delete_message_for_everyone(uuid) to authenticated;

-- ── delete_conversation_with_user ──
-- "Delete this contact" from your message list — delete-for-me on
-- every 1:1 message you've ever exchanged with them. Does not touch
-- messages_for_everyone/anything on the other person's side.
create or replace function public.delete_conversation_with_user(other_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.messages set deleted_for_sender = true
    where sender_id = auth.uid() and recipient_id = other_user_id;
  update public.messages set deleted_for_recipient = true
    where recipient_id = auth.uid() and sender_id = other_user_id;
end;
$$;

grant execute on function public.delete_conversation_with_user(uuid) to authenticated;
