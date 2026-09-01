-- ============================================================
-- FIX: duplicate notifications (v2 — permanent guard)
--
-- If duplicates are still showing up after running
-- fix_duplicate_notifications.sql, that script's trigger-hunting
-- only catches ONE specific cause (the same trigger literally
-- registered twice under different names, with "notif" in the
-- function name). The actual cause can also be:
--   - two DIFFERENT functions (different names entirely) both
--     inserting a notification for the same event
--   - a function that calls another function which ALSO inserts,
--     double-inserting from a single trigger fire
--   - the client app itself firing the insert an extra time
--
-- Rather than keep chasing the exact cause, this adds a permanent
-- guard directly on the notifications table: right before any row
-- is inserted, it checks whether an identical notification
-- (same recipient, same actor, same type, same post/reply) was
-- already created in the last 10 seconds — if so, the new insert
-- is silently dropped. This works no matter which trigger,
-- function, or client code is responsible, and never blocks a
-- legitimate second follow/mention from the same person later on
-- (10 seconds is long enough to catch a double-fire, short enough
-- to never affect real, separate actions).
--
-- Safe to re-run. Run this alongside (or instead of) chasing down
-- fix_duplicate_notifications.sql's trigger-name heuristic.
-- ============================================================

-- 0) Make sure reply_id exists before the guard below references it
-- (added by fix_mention_notification_snippet.sql — harmless no-op
-- if it's already there).
alter table public.notifications
  add column if not exists reply_id uuid references public.replies(id) on delete cascade;

-- 1) Clean up existing duplicate rows (same rule as v1 — same
-- recipient/actor/type/post, created within the same second).
with dupes as (
  select id,
         row_number() over (
           partition by user_id, actor_id, type,
                        coalesce(post_id, '00000000-0000-0000-0000-000000000000'),
                        coalesce(reply_id, '00000000-0000-0000-0000-000000000000'),
                        date_trunc('second', created_at)
           order by id
         ) as rn
  from public.notifications
)
delete from public.notifications
where id in (select id from dupes where rn > 1);

-- 2) Permanent guard: drop any insert that exactly matches a
-- notification already created for the same recipient in the
-- last 10 seconds.
create or replace function public.prevent_duplicate_notifications()
returns trigger
language plpgsql
as $$
begin
  if exists (
    select 1 from public.notifications
    where user_id = new.user_id
      and actor_id is not distinct from new.actor_id
      and type = new.type
      and coalesce(post_id, '00000000-0000-0000-0000-000000000000')
        = coalesce(new.post_id, '00000000-0000-0000-0000-000000000000')
      and coalesce(reply_id, '00000000-0000-0000-0000-000000000000')
        = coalesce(new.reply_id, '00000000-0000-0000-0000-000000000000')
      and created_at > now() - interval '10 seconds'
  ) then
    -- Returning null from a BEFORE INSERT trigger silently cancels
    -- just this one row's insert — nothing else in the transaction
    -- is affected.
    return null;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_prevent_duplicate_notifications on public.notifications;
create trigger trg_prevent_duplicate_notifications
before insert on public.notifications
for each row execute function public.prevent_duplicate_notifications();
