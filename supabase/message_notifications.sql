-- ============================================================
-- Notify on incoming chat message
--
-- Until now `messages` never touched `notifications` — an incoming
-- DM only bumped the chat tab's unread badge (loadUnreadChatCount()
-- in js/auth.js), so it never showed up in the bell/notifications
-- page. This adds that.
--
-- Scoped to 1:1 DMs only (recipient_id set). Group/channel messages
-- (conversation_id set, recipient_id null) are deliberately left
-- out — they already have their own unread indicator per
-- conversation, and a notification-list row per group message would
-- flood the page for anyone in an active group chat.
--
-- No message body/snippet is stored on the notification row: body
-- is encrypted at rest by messages_encrypt_body_trg (see
-- supabase/chat_server_side_encryption.sql), so there's nothing
-- plaintext to safely copy over anyway — js/notifications.js just
-- shows "<name> sent you a message" and links to the thread.
--
-- Blocked senders never make it this far: the messages_block_check
-- restrictive policy (chat_block_enforcement.sql) already rejects
-- the insert before this trigger would fire.
--
-- Safe to re-run.
-- ============================================================

create or replace function public.notify_new_message()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.recipient_id is not null then
    insert into public.notifications (user_id, actor_id, type, post_id, read, created_at)
    values (new.recipient_id, new.sender_id, 'message', null, false, new.created_at);
  end if;
  return new;
end;
$$;

drop trigger if exists trg_notify_new_message on public.messages;
create trigger trg_notify_new_message
  after insert on public.messages
  for each row execute function public.notify_new_message();
