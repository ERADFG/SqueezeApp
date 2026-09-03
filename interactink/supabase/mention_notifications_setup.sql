-- ============================================================
-- MENTION NOTIFICATIONS — full setup (run this if @mentions
-- aren't creating a notification at all)
--
-- This combines fix_mention_notifications_case_insensitive.sql and
-- fix_mention_notification_snippet.sql into one script, in their
-- final, already-correct order — safe to run even if you already
-- ran one or both of those before (CREATE OR REPLACE / IF NOT
-- EXISTS everywhere).
--
-- If you're seeing NO notification at all when someone @mentions
-- you (not a wrong-looking one, not a missing snippet — nothing
-- shows up in Notifications), the most likely explanation is that
-- these trigger functions were never actually created in your live
-- database. Several pieces of this project (this being one of them)
-- exist as ready SQL files that need to be run once in the Supabase
-- SQL Editor — they don't apply themselves.
-- ============================================================

alter table public.notifications
  add column if not exists reply_id uuid references public.replies(id) on delete cascade;

-- Mentions inside a top-level post.
create or replace function public.notify_post_mentions()
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
      insert into public.notifications (user_id, actor_id, type, post_id, read, created_at)
      values (mentioned.id, new.author_id, 'mention', new.id, false, now());
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_notify_post_mentions on public.posts;
create trigger trg_notify_post_mentions
  after insert on public.posts
  for each row execute function public.notify_post_mentions();

-- Mentions inside a reply — links back to the parent post (post_id)
-- for navigation, and separately to the actual reply (reply_id) so
-- the notification's preview text shows what really mentioned you,
-- not the parent post's unrelated text.
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

drop trigger if exists trg_notify_reply_mentions on public.replies;
create trigger trg_notify_reply_mentions
  after insert on public.replies
  for each row execute function public.notify_reply_mentions();

-- Quick sanity check you can run after this: mention yourself's a
-- no-op (skipped deliberately), so open two accounts, post
-- "hi @otheraccount" as account A, then as account B run:
--   select * from public.notifications where type = 'mention' order by created_at desc limit 5;
-- A fresh row should show up immediately.
