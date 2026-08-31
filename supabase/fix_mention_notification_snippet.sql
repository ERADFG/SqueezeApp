-- ============================================================
-- Mention notifications from a reply were previewing the wrong
-- text: notify_reply_mentions() (see MASTER_MIGRATIONS_reconstructed.sql)
-- sets notifications.post_id to the *parent post* (needed so the
-- notification links to the right thread, same as every other
-- type), which meant js/notifications.js's snippet showed the
-- parent post's body instead of the reply that actually mentioned
-- you — unlike a mention in a top-level post, where post_id is the
-- mentioning post itself and the snippet is correct. This is what
-- made mention notifications look/behave inconsistently with the
-- rest of the list.
--
-- Fix: add a nullable reply_id column just for this, and have
-- notify_reply_mentions() fill it in alongside post_id. post_id
-- keeps pointing at the parent (still used for the link), reply_id
-- points at the actual reply (used only for the snippet preview —
-- see js/notifications.js's NOTIF_SELECT + notifItemHtml). Nothing
-- else reads this column, and every other notification type leaves
-- it null.
--
-- Safe to re-run.
-- ============================================================

alter table public.notifications
  add column if not exists reply_id uuid references public.replies(id) on delete cascade;

create or replace function public.notify_reply_mentions()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  handle text;
  mentioned record;
begin
  for handle in
    select distinct lower(m[1])
    from regexp_matches(coalesce(new.body, ''), '(?:^|[^\w&])@([a-zA-Z0-9_]{3,20})', 'g') as m
  loop
    select id into mentioned from public.profiles where username ilike handle limit 1;
    if mentioned.id is not null and mentioned.id <> new.author_id then
      insert into public.notifications (user_id, actor_id, type, post_id, reply_id, read, created_at)
      values (mentioned.id, new.author_id, 'mention', new.post_id, new.id, false, now());
    end if;
  end loop;
  return new;
end;
$$;
-- Trigger itself is unchanged (still AFTER INSERT on public.replies,
-- still trg_notify_reply_mentions) — only the function body changed,
-- and CREATE OR REPLACE FUNCTION picks that up without re-creating it.
