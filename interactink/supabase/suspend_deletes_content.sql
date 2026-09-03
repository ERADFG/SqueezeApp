-- ============================================================
-- SUSPEND -> AUTO-DELETE CONTENT
-- Run after admin_panel_advanced.sql. Additive/idempotent — safe to
-- re-run any time.
--
-- What this adds on top of admin_panel_advanced.sql's suspend/
-- unsuspend (which only flipped profiles.banned + metadata):
--   1. Every post and reply belonging to a user is automatically
--      soft-deleted (same is_deleted flag admin_delete_post/
--      admin_delete_reply already use) the moment they're suspended
--      — same as X, where a suspended account's posts disappear.
--   2. A new deleted_by_suspension flag on posts/replies marks which
--      ones were taken down *because of* the suspension, as opposed
--      to ones the author (or a mod) had already deleted themselves
--      beforehand. That distinction matters twice: unsuspending only
--      restores the former (a manually-deleted post doesn't come
--      back just because the account got unsuspended), and
--      quotedPostHtml() in js/common.js reads it to show "This post
--      is from a suspended account" instead of the generic "no
--      longer available" wording for quote-post embeds.
--   3. The username itself is never freed up — nothing here touches
--      the profiles row or its username, so the unique constraint on
--      profiles.username keeps anyone else from ever registering it,
--      exactly like a suspended handle on X.
-- ============================================================

alter table public.posts   add column if not exists deleted_by_suspension boolean not null default false;
alter table public.replies add column if not exists deleted_by_suspension boolean not null default false;

create or replace function public.admin_suspend_user(target_user_id uuid, reason text default null, until timestamptz default null)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  if target_user_id = auth.uid() then
    raise exception 'cannot suspend your own account';
  end if;
  update public.profiles
    set banned = true,
        suspend_reason = nullif(trim(coalesce(reason, '')), ''),
        suspended_until = until
    where id = target_user_id;

  -- Only touch rows that weren't already deleted, so a post the
  -- author (or a mod) removed beforehand doesn't get relabeled as
  -- "deleted by suspension" and wrongly come back on unsuspend.
  update public.posts
    set is_deleted = true, deleted_by_suspension = true
    where author_id = target_user_id and is_deleted = false;
  update public.replies
    set is_deleted = true, deleted_by_suspension = true
    where author_id = target_user_id and is_deleted = false;
end;
$$;

create or replace function public.admin_unsuspend_user(target_user_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  if not public.is_admin() then
    raise exception 'not authorized';
  end if;
  update public.profiles set banned = false, suspended_until = null, suspend_reason = null where id = target_user_id;

  -- Only restore what the suspension itself took down — leaves any
  -- of the user's own prior deletions alone.
  update public.posts
    set is_deleted = false, deleted_by_suspension = false
    where author_id = target_user_id and deleted_by_suspension = true;
  update public.replies
    set is_deleted = false, deleted_by_suspension = false
    where author_id = target_user_id and deleted_by_suspension = true;
end;
$$;

grant execute on function public.admin_suspend_user(uuid, text, timestamptz) to authenticated;
grant execute on function public.admin_unsuspend_user(uuid)                  to authenticated;
notify pgrst, 'reload schema';
