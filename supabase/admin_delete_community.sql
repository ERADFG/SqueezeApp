-- ============================================================
-- ADMIN: DELETE COMMUNITIES + SUSPEND THEIR CREATOR FROM A REPORT
--
-- Two gaps this closes in the moderation tools:
--   1. A community could be reported (report_community.sql) but an
--      admin had no way to act on that report beyond dismissing it
--      or suspending a random user — there was no "remove this
--      community" button anywhere. This adds admin_delete_community(),
--      wired to a new "Delete community" button on community rows in
--      the Reports tab (js/admin.js).
--   2. The Reports tab's Suspend button only ever targeted a post/
--      reply author or a directly-reported user — a community report
--      had nobody to suspend, since a community has no single
--      "author" column the way a post does. This extends
--      admin_list_reports() to also return the community's creator
--      (created_by), so the existing Suspend button can target them
--      too, e.g. for a community that exists to promote terrorism or
--      other content severe enough that the person behind it, not
--      just the community itself, needs to be dealt with.
--
-- DELETE BEHAVIOR: matches the existing owner-side "Delete community"
-- flow in js/community.js (confirmDeleteCommunity() does a real
-- `sb.from('communities').delete()`, relying on the FK cascades
-- already configured on the live table for posts/members/rules/etc.)
-- — this is the same hard delete, just callable by an admin on
-- someone else's community via a SECURITY DEFINER RPC instead of the
-- owner-only RLS delete policy. Any of that community's still-open
-- reports are marked 'actioned' automatically so they don't sit in
-- the queue pointing at something that no longer exists.
--
-- Run this in the Supabase SQL Editor after report_community.sql
-- (needs its reports.community_id column and admin_list_reports()
-- signature) and admin_panel_advanced.sql (needs is_admin()).
-- Additive/idempotent — safe to re-run.
-- ============================================================

-- ── 1. admin_delete_community() ──
create or replace function public.admin_delete_community(p_community_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  -- Close out any reports pointing at this community first — once the
  -- delete below runs there's nothing left for an admin to click
  -- through to from the Reports tab, so leaving them 'open' would
  -- just be a dead end in the queue.
  update public.reports
    set status = 'actioned'
    where community_id = p_community_id and status <> 'actioned';

  delete from public.communities where id = p_community_id;
end;
$$;
grant execute on function public.admin_delete_community(uuid) to authenticated;

-- ── 2. admin_list_reports() — same as report_community.sql's version,
--      plus community_creator_id/community_creator_username so the
--      Reports tab can offer a Suspend button on a community report
--      too, not just a delete-community one. Same drop-first dance as
--      report_community.sql: adding OUT columns changes the row type,
--      which CREATE OR REPLACE won't allow. ──
drop function if exists public.admin_list_reports(text);

create function public.admin_list_reports(status_filter text default 'open')
returns table (
  id                        uuid,
  created_at                timestamptz,
  reason                    text,
  details                   text,
  status                    text,
  reporter_id               uuid,
  reporter_username         text,
  post_id                   uuid,
  post_body                 text,
  post_author_id            uuid,
  post_author_username      text,
  reply_id                  uuid,
  reply_body                text,
  reply_author_id           uuid,
  reply_author_username     text,
  reported_user_id          uuid,
  reported_username         text,
  community_id              uuid,
  community_name            text,
  community_slug            text,
  community_creator_id      uuid,
  community_creator_username text
)
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;

  return query
  select
    r.id, r.created_at, r.reason, r.details, r.status,
    r.reporter_id, rp.username,
    r.post_id, p.body, p.author_id, pa.username,
    r.reply_id, rl.body, rl.author_id, ra.username,
    r.reported_user_id, ru.username,
    r.community_id, c.name, c.slug,
    c.created_by, cc.username
  from public.reports r
  left join public.profiles rp on rp.id = r.reporter_id
  left join public.posts    p  on p.id  = r.post_id
  left join public.profiles pa on pa.id = p.author_id
  left join public.replies  rl on rl.id = r.reply_id
  left join public.profiles ra on ra.id = rl.author_id
  left join public.profiles ru on ru.id = r.reported_user_id
  left join public.communities c on c.id = r.community_id
  left join public.profiles cc on cc.id = c.created_by
  where status_filter = 'all' or r.status = status_filter
  order by r.created_at desc
  limit 100;
end;
$$;

grant execute on function public.admin_list_reports(text) to authenticated;

notify pgrst, 'reload schema';
