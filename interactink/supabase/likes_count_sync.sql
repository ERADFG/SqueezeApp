-- ============================================================
-- LIKES — COUNT SYNC (fixes the like/unlike "delay" bug)
--
-- WHY THIS FILE EXISTS: js/common.js's toggleLike() is already fully
-- optimistic — it flips the heart and the count the instant you tap,
-- before the network call even resolves. If a tap still feels
-- delayed/laggy, the client isn't the problem; what's actually
-- happening is this:
--
--   1. toggleLike() inserts/deletes a row in `likes`.
--   2. Nothing in the database was updating posts.like_count (or
--      replies.like_count) to match — there was no trigger doing it.
--   3. So the optimistic +1/-1 you see on tap is only ever a LOCAL
--      guess. The moment the real count gets re-read from the DB —
--      a realtime UPDATE from something else touching that row, a
--      revisit to the feed, a reload, opening the thread again — it
--      snaps back to the old, un-incremented number. That
--      snap-back is what reads as "a delay": the heart looks right
--      for a moment, then a beat later the number reverts.
--
-- This file closes that gap with a trigger that updates the count
-- columns inside the same transaction as the like/unlike, so the
-- stored count is never out of sync with the `likes` table.
--
-- Also make sure supabase/likes_full_fix.sql has been run — if the
-- RLS policies on `likes` are missing/broken, inserts fail silently
-- and toggleLike()'s catch block rolls the optimistic UI back a
-- moment later, which looks identical to this bug from the outside.
--
-- Safe to re-run — replaces the function and re-creates the trigger.
-- ============================================================

create or replace function public.sync_like_count()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if (tg_op = 'INSERT') then
    if new.post_id is not null then
      update public.posts set like_count = coalesce(like_count, 0) + 1 where id = new.post_id;
    elsif new.reply_id is not null then
      update public.replies set like_count = coalesce(like_count, 0) + 1 where id = new.reply_id;
    end if;
    return new;
  elsif (tg_op = 'DELETE') then
    if old.post_id is not null then
      update public.posts set like_count = greatest(coalesce(like_count, 0) - 1, 0) where id = old.post_id;
    elsif old.reply_id is not null then
      update public.replies set like_count = greatest(coalesce(like_count, 0) - 1, 0) where id = old.reply_id;
    end if;
    return old;
  end if;
  return null;
end;
$$;

drop trigger if exists trg_likes_sync_count on public.likes;
create trigger trg_likes_sync_count
  after insert or delete on public.likes
  for each row execute function public.sync_like_count();

-- ── ONE-TIME BACKFILL ──
-- Recomputes both count columns from the actual rows in `likes` right
-- now, so any counts that already drifted out of sync before this
-- trigger existed get corrected immediately instead of waiting for
-- their next like/unlike.
update public.posts p
   set like_count = coalesce((select count(*) from public.likes l where l.post_id = p.id), 0);

update public.replies r
   set like_count = coalesce((select count(*) from public.likes l where l.reply_id = r.id), 0);
