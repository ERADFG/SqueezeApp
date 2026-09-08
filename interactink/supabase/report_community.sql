-- ============================================================
-- REPORT COMMUNITY — supports the new "Report community" item in
-- the community page's "•••" menu (js/community.js
-- communityMenuReport() → common.js openReportCommunity()).
--
-- Run this in the Supabase SQL Editor after schema.sql and
-- admin_panel_advanced.sql (it only adds a column and replaces the
-- admin_list_reports() function those set up) — safe to re-run any
-- time, same as the other migrations in this folder.
--
-- What this adds:
--   1. reports.community_id — nullable, so every existing report
--      row (post/reply/user reports) is untouched. A community
--      report is inserted with only community_id set and
--      post_id/reply_id/reported_user_id left null, exactly the
--      same shape submitReport() in common.js already uses for the
--      other three report kinds.
--   2. admin_list_reports() now also returns community_id,
--      community_name and community_slug, so the admin panel
--      (js/admin.js adminReportRowHtml()) can show and link to the
--      reported community instead of the row baffling an admin
--      with "Reported: @null".
-- ============================================================

-- ── 1. Column ───────────────────────────────────────────────
alter table public.reports
  add column if not exists community_id uuid references public.communities(id) on delete cascade;

-- Same "one report is about exactly one thing" shape the table
-- already implies for post_id/reply_id/reported_user_id — makes it
-- a database-level guarantee instead of just an app convention.
-- Existing rows (all pre-dating this column) have community_id null
-- and at least one of the other three set, so they already satisfy
-- this without any backfill.
do $$
begin
  alter table public.reports add constraint reports_exactly_one_target check (
    (case when post_id is not null then 1 else 0 end) +
    (case when reply_id is not null then 1 else 0 end) +
    (case when reported_user_id is not null then 1 else 0 end) +
    (case when community_id is not null then 1 else 0 end) = 1
  );
exception when duplicate_object then null;
end $$;

-- ── 2. admin_list_reports() — same function/signature as
--      admin_panel_advanced.sql, replaced to add the three
--      community_* columns via a left join on communities.
--
--      Postgres won't let CREATE OR REPLACE change a function's
--      return row shape (new OUT columns = a different row type,
--      even with the same name/args) — it errors with 42P13 and
--      tells you to DROP FUNCTION first. That's expected here since
--      this replaces the 16-column version from admin_panel_advanced.sql
--      with a 19-column one, so drop it before recreating. ──
drop function if exists public.admin_list_reports(text);

create function public.admin_list_reports(status_filter text default 'open')
returns table (
  id                     uuid,
  created_at             timestamptz,
  reason                 text,
  details                text,
  status                 text,
  reporter_id            uuid,
  reporter_username      text,
  post_id                uuid,
  post_body              text,
  post_author_id         uuid,
  post_author_username   text,
  reply_id               uuid,
  reply_body             text,
  reply_author_id        uuid,
  reply_author_username  text,
  reported_user_id       uuid,
  reported_username      text,
  community_id           uuid,
  community_name         text,
  community_slug         text
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
    r.community_id, c.name, c.slug
  from public.reports r
  left join public.profiles rp on rp.id = r.reporter_id
  left join public.posts    p  on p.id  = r.post_id
  left join public.profiles pa on pa.id = p.author_id
  left join public.replies  rl on rl.id = r.reply_id
  left join public.profiles ra on ra.id = rl.author_id
  left join public.profiles ru on ru.id = r.reported_user_id
  left join public.communities c on c.id = r.community_id
  where status_filter = 'all' or r.status = status_filter
  order by r.created_at desc
  limit 100;
end;
$$;

grant execute on function public.admin_list_reports(text) to authenticated;
