-- ============================================================
-- CHAT MEDIA MODERATION
-- Run after chat_media.sql, chat_encryption.sql, and
-- moderation_media_pipeline.sql (needs public.is_admin() and the
-- moderation_status/'visible'|'pending'|'blocked'|'human_review'
-- pattern that file establishes). Additive/idempotent.
--
-- What this closes: chat attachments (images/videos/voice notes,
-- all stored unencrypted in the same public "media" bucket
-- posts/replies use — see chat_media.sql's own comment on that) were
-- never run through nsfw-service's NSFW/category/CSAM checks at all.
-- api/moderate-media.js now accepts 'messages' as a gated table (see
-- its ALLOWED_TABLES) and js/chat.js inserts new attachments with
-- moderation_status: 'pending', then calls that endpoint the same
-- way a post does — this migration is what actually makes 'pending'/
-- 'blocked'/'human_review' mean something for a chat message: every
-- read path is a SECURITY DEFINER RPC (not raw table SELECT — chat
-- rows are ciphertext until one of these decrypts them), so the
-- enforcement has to live in the RPCs themselves, not a table RLS
-- policy nothing ever queries directly.
--
-- Message TEXT is not touched by this file — see js/chat.js's
-- checkTextModeration() call at send time, which can only refuse to
-- send outright (a hard 'block'); there's no "hide this text message
-- from the recipient" concept applied here, unlike media.
-- ============================================================

alter table public.messages add column if not exists moderation_status text not null default 'visible';
alter table public.messages add column if not exists moderation_flags jsonb;
alter table public.messages add column if not exists moderation_checked_at timestamptz;
do $$
begin
  alter table public.messages add constraint messages_moderation_status_check
    check (moderation_status in ('visible','pending','blocked','human_review'));
exception when duplicate_object then null;
end $$;

-- ── Redefine the decrypt-on-read RPCs to filter gated media ──
-- Same shape as before (see chat_encryption.sql), each with one
-- added condition: a message whose media hasn't cleared review
-- ('pending'/'blocked'/'human_review') is only returned to its own
-- sender or an admin — everyone else in the conversation doesn't see
-- it until it flips to 'visible'. Text-only messages (media_url is
-- null) are completely unaffected, matching how posts/replies work.

create or replace function public.get_dm_thread(other_user_id uuid, msg_limit int default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, vault
as $$
declare
  me uuid := auth.uid();
  result jsonb;
begin
  if me is null then raise exception 'not authenticated'; end if;
  select coalesce(jsonb_agg(row order by created_at asc), '[]'::jsonb) into result
  from (
    select
      m.created_at,
      to_jsonb(m) || jsonb_build_object('body', public._chat_decrypt(m.body, m.body_encrypted)) as row
    from public.messages m
    where m.conversation_id is null
      and ((m.sender_id = me and m.recipient_id = other_user_id)
        or (m.sender_id = other_user_id and m.recipient_id = me))
      and (m.media_url is null or m.moderation_status = 'visible' or m.sender_id = me or public.is_admin())
    order by m.created_at asc
    limit msg_limit
  ) t;
  return result;
end;
$$;

create or replace function public.get_dm_list(row_limit int default 300)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, vault
as $$
declare
  me uuid := auth.uid();
  result jsonb;
begin
  if me is null then raise exception 'not authenticated'; end if;
  select coalesce(jsonb_agg(row order by created_at desc), '[]'::jsonb) into result
  from (
    select
      m.created_at,
      to_jsonb(m) || jsonb_build_object(
        'body', public._chat_decrypt(m.body, m.body_encrypted),
        'sender', jsonb_build_object('id', sp.id, 'username', sp.username, 'display_name', sp.display_name, 'avatar_url', sp.avatar_url, 'verified', sp.verified, 'verification_type', sp.verification_type),
        'recipient', jsonb_build_object('id', rp.id, 'username', rp.username, 'display_name', rp.display_name, 'avatar_url', rp.avatar_url, 'verified', rp.verified, 'verification_type', rp.verification_type)
      ) as row
    from public.messages m
    join public.profiles sp on sp.id = m.sender_id
    left join public.profiles rp on rp.id = m.recipient_id
    where m.conversation_id is null and (m.sender_id = me or m.recipient_id = me)
      and (m.media_url is null or m.moderation_status = 'visible' or m.sender_id = me or public.is_admin())
    order by m.created_at desc
    limit row_limit
  ) t;
  return result;
end;
$$;

create or replace function public.get_group_thread(conv_id uuid, msg_limit int default 500)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, vault
as $$
declare
  me uuid := auth.uid();
  result jsonb;
begin
  if me is null then raise exception 'not authenticated'; end if;
  if not exists (select 1 from public.conversation_members cm where cm.conversation_id = conv_id and cm.user_id = me) then
    raise exception 'not a member of this conversation';
  end if;
  select coalesce(jsonb_agg(row order by created_at asc), '[]'::jsonb) into result
  from (
    select
      m.created_at,
      to_jsonb(m) || jsonb_build_object('body', public._chat_decrypt(m.body, m.body_encrypted)) as row
    from public.messages m
    where m.conversation_id = conv_id
      and (m.media_url is null or m.moderation_status = 'visible' or m.sender_id = me or public.is_admin())
    order by m.created_at asc
    limit msg_limit
  ) t;
  return result;
end;
$$;

create or replace function public.get_group_last_messages(conv_ids uuid[])
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, vault
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
        'body', public._chat_decrypt(m.body, m.body_encrypted),
        'sender', jsonb_build_object('username', sp.username, 'display_name', sp.display_name)
      ) as row
    from public.messages m
    join public.profiles sp on sp.id = m.sender_id
    where m.conversation_id = any(conv_ids)
      and exists (select 1 from public.conversation_members cm where cm.conversation_id = m.conversation_id and cm.user_id = me)
      and (m.media_url is null or m.moderation_status = 'visible' or m.sender_id = me or public.is_admin())
    order by m.conversation_id, m.created_at desc
  ) t;
  return result;
end;
$$;

create or replace function public.get_message(msg_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public, extensions, vault
as $$
declare
  me uuid := auth.uid();
  result jsonb;
begin
  if me is null then raise exception 'not authenticated'; end if;
  select to_jsonb(m) || jsonb_build_object('body', public._chat_decrypt(m.body, m.body_encrypted)) into result
  from public.messages m
  where m.id = msg_id
    and (
      (m.conversation_id is null and (m.sender_id = me or m.recipient_id = me))
      or (m.conversation_id is not null and exists (
            select 1 from public.conversation_members cm
            where cm.conversation_id = m.conversation_id and cm.user_id = me))
    )
    and (m.media_url is null or m.moderation_status = 'visible' or m.sender_id = me or public.is_admin());
  if result is null then raise exception 'not found or not authorized'; end if;
  return result;
end;
$$;

-- Grants were already set by chat_encryption.sql and survive
-- create-or-replace, but re-asserting them here costs nothing and
-- keeps this file runnable standalone against a fresh database too.
revoke all on function public.get_dm_thread(uuid, int) from public, anon;
grant execute on function public.get_dm_thread(uuid, int) to authenticated;
revoke all on function public.get_dm_list(int) from public, anon;
grant execute on function public.get_dm_list(int) to authenticated;
revoke all on function public.get_group_thread(uuid, int) from public, anon;
grant execute on function public.get_group_thread(uuid, int) to authenticated;
revoke all on function public.get_group_last_messages(uuid[]) from public, anon;
grant execute on function public.get_group_last_messages(uuid[]) to authenticated;
revoke all on function public.get_message(uuid) from public, anon;
grant execute on function public.get_message(uuid) to authenticated;

notify pgrst, 'reload schema';
