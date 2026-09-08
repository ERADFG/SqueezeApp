-- ============================================================
-- POST COOLDOWN — server-side enforcement of the 100s "wait between
-- posts" spam brake.
--
-- WHY THIS FILE EXISTS: js/common.js already throttles posting on the
-- client (enforceCooldown() / markPosted(), gating submitPost() in
-- board.js, submitCommunityPost() in community.js, and submitReply()
-- in thread.js). That's good for UX (an instant "wait 12s" message,
-- a disabled button with a live countdown) but it is NOT real
-- security — this app's client talks directly to Supabase with the
-- public anon key, so anyone can skip the site's JS entirely and call
-- `supabase.from('posts').insert(...)` straight from a script. This
-- trigger is what actually stops that: it runs inside Postgres, so
-- there's no client to bypass.
--
-- HOW: a BEFORE INSERT trigger on both public.posts and
-- public.replies checks the author's most recent row (across BOTH
-- tables, since a reply-flood is just as much spam as a post-flood)
-- and rejects the insert if it's within 100 seconds of their last one.
--
-- TO APPLY: run this once in the Supabase SQL editor (or via the CLI)
-- for your project. Safe to re-run — it replaces the function and
-- re-creates the triggers.
-- ============================================================

create or replace function public.enforce_post_cooldown()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  last_at timestamptz;
  cooldown interval := interval '100 seconds';
begin
  select max(created_at) into last_at
  from (
    select created_at from public.posts   where author_id = new.author_id
    union all
    select created_at from public.replies where author_id = new.author_id
  ) recent;

  if last_at is not null and now() - last_at < cooldown then
    raise exception 'You are posting too fast — please wait a bit before posting again.'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

drop trigger if exists trg_posts_cooldown on public.posts;
create trigger trg_posts_cooldown
  before insert on public.posts
  for each row execute function public.enforce_post_cooldown();

drop trigger if exists trg_replies_cooldown on public.replies;
create trigger trg_replies_cooldown
  before insert on public.replies
  for each row execute function public.enforce_post_cooldown();

-- NOTE ON SCHEDULED POSTS: board.js lets a post carry a future
-- scheduled_at and only actually becomes visible then, but the ROW is
-- inserted right away — so scheduling several posts back-to-back
-- still counts against this same cooldown, same as normal posts. If
-- you'd rather exempt scheduled posts from the cooldown, add
-- `and new.scheduled_at is null` to the `if` condition above (only
-- posts has a scheduled_at column, so guard for that in the function
-- if you do this).
