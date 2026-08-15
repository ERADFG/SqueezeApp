-- ============================================================
-- ADMIN PANEL — RESTORE (UNDELETE)
-- Run this after admin_panel_advanced.sql. Additive/idempotent
-- like the other migrations here — safe to re-run any time.
--
-- admin_panel_advanced.sql added delete for posts/replies/articles
-- (soft-delete via is_deleted = true) but no way back. This adds
-- the other half: restore each of those, so a misclick — or a
-- report that turns out to be bogus — isn't permanent. The admin
-- panel's Posts/Replies/Articles tabs use these to power a
-- "Show deleted" toggle with a Restore button.
--
-- Same guarantee as every other admin_* function: re-checks
-- is_admin() itself server-side, so this is safe even if someone
-- bypassed the UI and called the RPC directly.
-- ============================================================

create or replace function public.admin_restore_post(post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.posts set is_deleted = false where id = post_id;
end;
$$;

create or replace function public.admin_restore_reply(reply_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.replies set is_deleted = false where id = reply_id;
end;
$$;

create or replace function public.admin_restore_article(article_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.articles set is_deleted = false where id = article_id;
end;
$$;

grant execute on function public.admin_restore_post(uuid)    to authenticated;
grant execute on function public.admin_restore_reply(uuid)   to authenticated;
grant execute on function public.admin_restore_article(uuid) to authenticated;
