-- ═════════════════════════════════════════════════════════════════
-- FIX: "Wrong key or corrupt data" blanking the whole chat list/thread
-- Run this once, AFTER chat_server_side_encryption.sql.
--
-- ROOT CAUSE
-- get_dm_list / get_dm_thread / get_group_thread /
-- get_group_last_messages / get_message all call pgp_sym_decrypt()
-- directly inside a CASE expression. pgp_sym_decrypt() RAISES an
-- exception (Postgres's literal error text is "Wrong key or corrupt
-- data") if a ciphertext can't be decrypted with the current
-- _chat_secret() — and because these functions build their result
-- with jsonb_agg() over every row in one query, ONE bad/corrupt row
-- aborts the entire function call. The frontend (js/chat.js) just
-- prints error.message straight into the page, which is exactly the
-- banner in the bug report — the whole chat list disappears because
-- of a single undecryptable message.
--
-- FIX
-- Route every pgp_sym_decrypt() call through this new
-- public._chat_decrypt() helper, which catches the decrypt failure
-- per-row and returns NULL instead of raising. js/chat.js already
-- treats a null body as "undecryptable" and renders the existing
-- lock-icon placeholder bubble (see msgBubbleHtml in js/chat.js) —
-- so this is a pure SQL fix, no frontend change needed. Every other
-- exception (auth, permissions, etc.) still raises normally.
-- ═════════════════════════════════════════════════════════════════

create or replace function public._chat_decrypt(enc_body text, is_encrypted boolean)
returns text
language plpgsql
stable
security definer
set search_path = public, vault
as $$
begin
  if not is_encrypted then
    return enc_body;
  end if;
  if enc_body is null then
    return null;
  end if;
  return convert_from(pgp_sym_decrypt(decode(enc_body, 'base64'), public._chat_secret()), 'UTF8');
exception
  when others then
    -- Covers "Wrong key or corrupt data" plus any other decrypt
    -- failure (bad base64, truncated ciphertext, rotated key, etc.)
    -- so one bad row degrades to an undecryptable placeholder instead
    -- of taking the whole list/thread down.
    return null;
end;
$$;

revoke all on function public._chat_decrypt(text, boolean) from public, anon, authenticated;

-- ── get_dm_thread ──
create or replace function public.get_dm_thread(other_user_id uuid, msg_limit int default 500)
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
  select coalesce(jsonb_agg(row order by created_at asc), '[]'::jsonb) into result
  from (
    select
      m.created_at,
      to_jsonb(m) || jsonb_build_object(
        'body', public._chat_decrypt(m.body, m.body_encrypted)
      ) as row
    from public.messages m
    where m.conversation_id is null
      and ((m.sender_id = me and m.recipient_id = other_user_id)
        or (m.sender_id = other_user_id and m.recipient_id = me))
    order by m.created_at asc
    limit msg_limit
  ) t;
  return result;
end;
$$;

revoke all on function public.get_dm_thread(uuid, int) from public, anon;
grant execute on function public.get_dm_thread(uuid, int) to authenticated;

-- ── get_dm_list ──
create or replace function public.get_dm_list(row_limit int default 300)
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
    order by m.created_at desc
    limit row_limit
  ) t;
  return result;
end;
$$;

revoke all on function public.get_dm_list(int) from public, anon;
grant execute on function public.get_dm_list(int) to authenticated;

-- ── get_group_thread ──
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
  if not exists (select 1 from public.conversation_members cm where cm.conversation_id = conv_id and cm.user_id = me) then
    raise exception 'not a member of this conversation';
  end if;
  select coalesce(jsonb_agg(row order by created_at asc), '[]'::jsonb) into result
  from (
    select
      m.created_at,
      to_jsonb(m) || jsonb_build_object(
        'body', public._chat_decrypt(m.body, m.body_encrypted)
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

-- ── get_group_last_messages ──
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
        'body', public._chat_decrypt(m.body, m.body_encrypted),
        'sender', jsonb_build_object('username', sp.username, 'display_name', sp.display_name)
      ) as row
    from public.messages m
    join public.profiles sp on sp.id = m.sender_id
    where m.conversation_id = any(conv_ids)
      and exists (select 1 from public.conversation_members cm where cm.conversation_id = m.conversation_id and cm.user_id = me)
    order by m.conversation_id, m.created_at desc
  ) t;
  return result;
end;
$$;

revoke all on function public.get_group_last_messages(uuid[]) from public, anon;
grant execute on function public.get_group_last_messages(uuid[]) to authenticated;

-- ── get_message ──
create or replace function public.get_message(msg_id uuid)
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
  select to_jsonb(m) || jsonb_build_object(
    'body', public._chat_decrypt(m.body, m.body_encrypted)
  ) into result
  from public.messages m
  where m.id = msg_id
    and (
      (m.conversation_id is null and (m.sender_id = me or m.recipient_id = me))
      or (m.conversation_id is not null and exists (
            select 1 from public.conversation_members cm
            where cm.conversation_id = m.conversation_id and cm.user_id = me))
    );
  if result is null then raise exception 'not found or not authorized'; end if;
  return result;
end;
$$;

revoke all on function public.get_message(uuid) from public, anon;
grant execute on function public.get_message(uuid) to authenticated;

notify pgrst, 'reload schema';
