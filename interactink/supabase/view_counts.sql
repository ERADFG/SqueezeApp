-- ============================================================
-- VIEW COUNTS — increment_post_view / increment_reply_views
-- ============================================================
-- js/common.js (bumpPostView / bumpReplyViews, called from thread.js
-- when a thread opens and from the feed's scroll-based view tracker)
-- calls these two RPCs by name:
--   sb.rpc('increment_post_view',   { p_id:  postId   })
--   sb.rpc('increment_reply_views', { p_ids: replyIds })
-- Neither function existed anywhere in the SQL export — every other
-- RPC the client calls (delete_own_post, edit_own_post, admin_*,
-- get_for_you_feed, etc.) has a matching definition in this project's
-- other migrations; these two didn't. That means every post/reply
-- view counter has been silently failing (caught by the .catch/
-- console.warn in bumpPostView/bumpReplyViews — it doesn't break the
-- page, the numbers just never move).
--
-- This assumes `posts.view_count` and `replies.view_count` already
-- exist as integer columns (the client already reads and displays
-- p.view_count / owner.view_count in thread.js, board.js, and
-- common.js, so those columns must already be present in your live
-- schema) — it only adds the two functions that increment them.
-- Safe to re-run.
-- ============================================================

create or replace function public.increment_post_view(p_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.posts set view_count = coalesce(view_count, 0) + 1 where id = p_id;
end;
$$;

create or replace function public.increment_reply_views(p_ids uuid[])
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  update public.replies set view_count = coalesce(view_count, 0) + 1 where id = any(p_ids);
end;
$$;

-- Anyone (including logged-out visitors) can bump a view count, same
-- as every other read-facing counter on the site.
grant execute on function public.increment_post_view(uuid)   to anon, authenticated;
grant execute on function public.increment_reply_views(uuid[]) to anon, authenticated;

notify pgrst, 'reload schema';
