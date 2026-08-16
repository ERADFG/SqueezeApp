-- ============================================================
-- LIKES — FIX DOUBLE COUNT (+2 on like / -2 on unlike)
--
-- WHY: toggleLike() in js/common.js only ever inserts/deletes ONE
-- row in `likes` per tap, and the realtime handlers that patch the
-- on-screen number (board.js's patchPostCounters, thread.js's
-- op-post handler) overwrite the count with the DB's real value —
-- they never add to it. So a symmetric +2/-2 per tap means the
-- DATABASE is moving like_count by 2 on a single insert/delete,
-- which happens when there are TWO triggers on `likes` both
-- incrementing/decrementing it (most likely: an older trigger from
-- before trg_likes_sync_count existed — e.g. created directly in
-- the Supabase dashboard — that never got dropped).
--
-- STEP 1 — run this first and look at the results.
-- ============================================================

select tgname as trigger_name, tgenabled, pg_get_triggerdef(oid) as definition
from pg_trigger
where tgrelid = 'public.likes'::regclass
  and not tgisinternal;

-- You should see exactly ONE row here: trg_likes_sync_count.
-- If you see a second row (any other name), that's the duplicate —
-- paste me its "definition" column if you want it double-checked,
-- or just run STEP 2 below to drop everything except the canonical
-- one and recreate that one cleanly.

-- ============================================================
-- STEP 2 — drop every trigger on `likes` except the canonical one,
-- then recreate trg_likes_sync_count fresh.
-- ============================================================

do $$
declare trg record;
begin
  for trg in
    select tgname from pg_trigger
    where tgrelid = 'public.likes'::regclass
      and not tgisinternal
      and tgname <> 'trg_likes_sync_count'
  loop
    execute format('drop trigger %I on public.likes', trg.tgname);
    raise notice 'Dropped duplicate trigger: %', trg.tgname;
  end loop;
end $$;

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

-- ============================================================
-- STEP 3 — re-derive every count from the actual rows in `likes`,
-- so any post/reply whose count already drifted from the doubling
-- (e.g. an unlike that went to -2 and got floored at 0, undercounting
-- real likes) snaps back to the true number right now.
-- ============================================================

update public.posts p
   set like_count = coalesce((select count(*) from public.likes l where l.post_id = p.id), 0);

update public.replies r
   set like_count = coalesce((select count(*) from public.likes l where l.reply_id = r.id), 0);

-- ── VERIFY ── should now show exactly one row again.
select tgname from pg_trigger where tgrelid = 'public.likes'::regclass and not tgisinternal;
