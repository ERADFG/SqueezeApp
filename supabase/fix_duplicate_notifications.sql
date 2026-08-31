-- ============================================================
-- FIX: duplicate notifications
-- (screenshot: "marpe followed you" x2, "replied to your post"
-- x2, "SAYADI followed you" x2 — always the exact same actor,
-- type and timestamp)
--
-- This isn't a rendering bug — js/notifications.js replaces
-- innerHTML wholesale on every load, it never appends, so
-- duplicates on screen mean duplicate rows in the `notifications`
-- table itself. That happens when a table has the *same*
-- notification-inserting trigger registered on it twice (e.g. an
-- old migration's trigger never got dropped before a newer one
-- was added under a different name), so one follow/reply fires
-- two inserts.
--
-- This script:
--   1) Deletes the duplicate rows already sitting in the table.
--   2) Auto-detects and drops the extra duplicate trigger(s) so
--      it stops happening going forward.
-- Safe to re-run.
-- ============================================================

-- 1) Clean up existing duplicate rows.
-- "Duplicate" = same recipient, same actor, same type, same post
-- (or both null for follows), created within the same second —
-- i.e. clearly one action firing twice, not two separate
-- follows/replies made on different occasions.
with dupes as (
  select id,
         row_number() over (
           partition by user_id, actor_id, type,
                        coalesce(post_id, '00000000-0000-0000-0000-000000000000'),
                        date_trunc('second', created_at)
           order by id
         ) as rn
  from public.notifications
)
delete from public.notifications
where id in (select id from dupes where rn > 1);

-- 2) Find + remove duplicate triggers that insert notifications.
-- Checks every trigger on the tables that can generate a
-- notification; if a table has more than one trigger backed by a
-- function whose name mentions "notif" firing on the same
-- event, keeps the oldest one and drops the rest. Reports what it
-- found either way so you can see the result in the SQL editor's
-- "Notices" output.
do $$
declare
  r record;
  tbl text;
  rel regclass;
  any_dupe boolean := false;
begin
  foreach tbl in array array['follows','replies','posts','likes','reposts']
  loop
    rel := to_regclass('public.' || tbl);
    if rel is null then
      continue;
    end if;

    for r in
      select t.tgname,
             count(*) over (partition by t.tgtype) as cnt,
             row_number() over (partition by t.tgtype order by t.oid) as rn
      from pg_trigger t
      join pg_proc p on p.oid = t.tgfoid
      where t.tgrelid = rel
        and not t.tgisinternal
        and p.proname ilike '%notif%'
    loop
      if r.cnt > 1 then
        any_dupe := true;
        if r.rn > 1 then
          execute format('drop trigger if exists %I on public.%I', r.tgname, tbl);
          raise notice 'Dropped duplicate trigger "%" on table "%"', r.tgname, tbl;
        else
          raise notice 'Kept trigger "%" on table "%" (oldest of % duplicates)', r.tgname, tbl, r.cnt;
        end if;
      end if;
    end loop;
  end loop;

  if not any_dupe then
    raise notice 'No duplicate notification triggers found on follows/replies/posts/likes/reposts. If duplicates keep appearing, the two inserts are likely coming from two different functions with different names doing the same thing rather than the same trigger registered twice — run: select tgname, proname from pg_trigger t join pg_proc p on p.oid = t.tgfoid where p.proname ilike ''%%notif%%''; and share the output.';
  end if;
end $$;
