-- ============================================================
-- FIX: "new row violates row-level security policy for table
-- articles" when soft-deleting your own article.
--
-- Same root issue (and same fix) already applied to posts/replies
-- (see fix_delete_via_rpc.sql, used by confirmDeletePost() in
-- common.js): a raw client-side
--   UPDATE articles SET is_deleted = true WHERE id = ...
-- is gated by RLS's WITH CHECK re-validation, which can fail even
-- with author_id correctly pinned (session/JWT edge cases outside
-- app control — this is exactly what articles_fix_update_rls.sql
-- tried to patch, and it's still not reliable).
--
-- FIX: move the soft-delete into a SECURITY DEFINER RPC. The
-- function checks ownership itself (auth.uid() = author_id) and
-- then performs the write as its own privileged role, so it never
-- goes through the table's RLS UPDATE policy at all — same pattern
-- as delete_own_post / delete_own_reply.
--
-- Safe to re-run.
-- ============================================================

create or replace function public.delete_own_article(article_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  owner uuid;
begin
  select author_id into owner from public.articles where id = article_id;

  if owner is null then
    raise exception 'Article not found.';
  end if;

  if owner <> auth.uid() then
    raise exception 'You can only delete your own articles.';
  end if;

  update public.articles set is_deleted = true, updated_at = now()
  where id = article_id;
end;
$$;

-- Let logged-in users call it; the function itself enforces ownership,
-- so this grant does not open up deleting other people's articles.
grant execute on function public.delete_own_article(uuid) to authenticated;

-- Force PostgREST (Supabase's auto-generated API layer) to reload its
-- schema cache immediately. Without this, a newly created function can
-- return "Could not find the function ... in the schema cache" until
-- PostgREST's next automatic refresh.
notify pgrst, 'reload schema';
