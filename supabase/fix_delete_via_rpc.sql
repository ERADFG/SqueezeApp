-- ============================================================
-- DELETE OWN POST / REPLY — via SECURITY DEFINER RPC.
--
-- RECONSTRUCTED FILE: this file is referenced by name (as
-- "fix_delete_via_rpc.sql") in js/common.js's confirmDeletePost(),
-- and by comments in edit_own_post.sql and
-- fix_delete_article_via_rpc.sql, but wasn't included in the project
-- export this was rebuilt from. If your live Supabase project
-- already has delete_own_post/delete_own_reply functions (it must,
-- for post/reply deletion to work at all), you don't need to run
-- this — check first with:
--
--   select routine_name from information_schema.routines
--   where routine_schema = 'public'
--     and routine_name in ('delete_own_post','delete_own_reply');
--
-- If that comes back empty, run this file — it's what
-- confirmDeletePost() has been calling via
-- sb.rpc('delete_own_post'|'delete_own_reply', ...) all along.
--
-- WHY AN RPC INSTEAD OF A CLIENT-SIDE UPDATE: posts/replies have no
-- client-facing UPDATE policy (same reasoning as edit_own_post.sql) —
-- a raw `.update({ is_deleted: true })` is gated by RLS's WITH CHECK
-- re-validation, which can fail on session/JWT edge cases outside the
-- app's control even when the row really is yours. Moving the write
-- into a SECURITY DEFINER function sidesteps that: the function
-- checks ownership itself and performs the write as its own
-- privileged role, bypassing table RLS entirely for this one write.
--
-- POSTS get one extra allowance common.js already relies on
-- (confirmDeletePost()'s client-side pre-check mirrors this): the
-- creator of the community a post was made in may also delete that
-- post, not just the post's own author. Replies have no such
-- exception — only the reply's author can delete it.
--
-- Safe to re-run.
-- ============================================================

create or replace function public.delete_own_post(post_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  row_owner   uuid;
  row_comm    uuid;
  comm_owner  uuid;
begin
  select author_id, community_id into row_owner, row_comm
  from public.posts where id = post_id;

  if row_owner is null then
    raise exception 'Post not found.';
  end if;

  if row_owner <> auth.uid() then
    if row_comm is not null then
      select created_by into comm_owner from public.communities where id = row_comm;
    end if;
    if comm_owner is null or comm_owner <> auth.uid() then
      raise exception 'You can only delete your own posts (or posts in a community you own).';
    end if;
  end if;

  update public.posts set is_deleted = true where id = post_id;
end;
$$;

create or replace function public.delete_own_reply(reply_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  select author_id into owner from public.replies where id = reply_id;

  if owner is null then
    raise exception 'Reply not found.';
  end if;

  if owner <> auth.uid() then
    raise exception 'You can only delete your own replies.';
  end if;

  update public.replies set is_deleted = true where id = reply_id;
end;
$$;

-- Let logged-in users call these; the functions themselves enforce
-- ownership, so this grant does not open up deleting other people's
-- posts/replies.
grant execute on function public.delete_own_post(uuid) to authenticated;
grant execute on function public.delete_own_reply(uuid) to authenticated;

-- Force PostgREST (Supabase's auto-generated API layer) to reload its
-- schema cache immediately. Without this, a newly created function can
-- return "Could not find the function ... in the schema cache" until
-- PostgREST's next automatic refresh.
notify pgrst, 'reload schema';
