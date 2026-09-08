-- Mentions weren't creating notifications when the @handle's casing
-- didn't exactly match the stored username (e.g. "@Marpe" typed
-- against a profile whose username is "marpe"). Every other username
-- lookup in this app is case-insensitive (profile.js, chat.js,
-- followlist.js, profilelists.js all use .ilike('username', uname)),
-- but the mention trigger was doing (or is assumed to be doing) an
-- exact-case match against profiles.username, so a differently-cased
-- @mention silently matched no one and no notification was inserted.
--
-- This replaces the mention-detection function with a version that:
--   - extracts @handles with the same pattern the client uses to
--     linkify them (js/common.js linkifyText(): @[a-zA-Z0-9_]{3,20})
--   - looks each one up case-insensitively (ilike, exact match — no
--     wildcards, so "marpe" matches "@Marpe"/"@MARPE"/"@marpe" alike)
--   - dedupes repeated mentions of the same person in one post
--   - skips mentioning yourself
--
-- ADJUST BEFORE RUNNING: this assumes a `notifications` table with
-- columns (user_id, actor_id, type, post_id, read, created_at) — the
-- columns js/notifications.js selects from. If your actual table
-- differs (extra NOT NULL columns, different column names), or if you
-- already have a same-named trigger/function doing more than mention
-- detection (e.g. combined with likes/replies), rename this function
-- before running so it doesn't overwrite something else — or paste me
-- your existing one and I'll patch it directly instead.

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

-- Same thing for replies — a mention inside a reply notifies the
-- mentioned user too, linking back to the parent post (notifications
-- only join `post:posts(...)`, same as every other notification type
-- generated from a reply, e.g. "X replied to your post").
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
      insert into public.notifications (user_id, actor_id, type, post_id, read, created_at)
      values (mentioned.id, new.author_id, 'mention', new.post_id, false, now());
    end if;
  end loop;
  return new;
end;
$$;

drop trigger if exists trg_notify_reply_mentions on public.replies;
create trigger trg_notify_reply_mentions
  after insert on public.replies
  for each row execute function public.notify_reply_mentions();

-- Not covered: editing a post/reply to add a new @mention after the
-- fact won't fire these (they're AFTER INSERT only). Say the word if
-- you want that covered too — it'd need an AFTER UPDATE trigger that
-- diffs old vs new body so editing doesn't re-notify mentions that
-- were already there.
