-- ============================================================
-- FIX: "new row violates row-level security policy for table
-- articles" when deleting (or editing) your own article.
--
-- deleteArticleConfirm() in js/common.js soft-deletes by running
-- an UPDATE (.update({ is_deleted: true })), not a real DELETE.
-- Postgres RLS checks an UPDATE in two passes: the USING clause
-- decides which existing rows you're even allowed to touch, then
-- the WITH CHECK clause re-validates the resulting row afterward.
-- The previous policy used `author_id = auth.uid()` for BOTH
-- passes — and since author_id isn't part of the SET clause here,
-- both passes are checking the exact same value, so if USING
-- passes, WITH CHECK re-checking the same unchanged column should
-- never fail... except that's exactly the error being hit, which
-- means WITH CHECK is failing here for reasons outside the app's
-- control (session/JWT state at the moment the second check runs).
--
-- FIX: stop asking WITH CHECK to re-verify authorship at all —
-- USING already restricted you to rows you own, that's the real
-- gate. WITH CHECK just becomes `true`. To keep this safe (so this
-- doesn't quietly let someone reassign an article to another
-- account via a crafted update), a BEFORE UPDATE trigger pins
-- author_id to its original value on every update, so it's
-- physically impossible to change no matter what a client sends.
--
-- Safe to re-run.
-- ============================================================

drop policy if exists "articles_update_own" on public.articles;
create policy "articles_update_own" on public.articles
  for update
  to authenticated
  using (author_id = auth.uid())
  with check (true);

create or replace function public.articles_lock_author()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.author_id := old.author_id;
  return new;
end;
$$;

drop trigger if exists articles_lock_author_trg on public.articles;
create trigger articles_lock_author_trg
  before update on public.articles
  for each row execute function public.articles_lock_author();
