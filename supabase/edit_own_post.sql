-- ============================================================
-- EDIT OWN POST / REPLY — lets an author edit their own post or
-- comment within 15 minutes of posting it, and marks it "Edited"
-- afterwards (js/common.js's editedSuffix()/markEditedTag()).
--
-- Same SECURITY DEFINER RPC pattern as delete_own_post /
-- delete_own_reply / delete_own_article: the function checks
-- ownership (and, here, the 15-minute window) itself and performs
-- the write as its own privileged role. posts/replies have no
-- client-facing UPDATE policy — same as before this file, deletes
-- go through delete_own_post/delete_own_reply rather than a raw
-- `.update()` — so this RPC is the only way an edit can happen at
-- all, not just the preferred one.
--
-- WHY 15 MINUTES IS ALSO ENFORCED HERE (not just in js/common.js's
-- withinEditWindow()): this app's client talks directly to Supabase
-- with the public anon key (see post_cooldown.sql for the same
-- reasoning), so the client-side check only exists to show a fast,
-- friendly "the edit window has passed" message — this function is
-- what actually stops a late edit, since anyone could otherwise call
-- `supabase.rpc('edit_own_post', ...)` directly from a script.
--
-- "Edited" shows up in the UI whenever a row's updated_at differs
-- from its created_at. Both columns default to now() and a single
-- INSERT's now() is the same value for every column it touches, so
-- they land exactly equal until an edit changes updated_at — same
-- trick articles.sql already relies on for its own "· Edited" label.
--
-- TO APPLY: run this once in the Supabase SQL editor (or via the
-- CLI) for your project. Safe to re-run.
-- ============================================================

alter table public.posts   add column if not exists updated_at timestamptz not null default now();
alter table public.replies add column if not exists updated_at timestamptz not null default now();

-- Backfill: rows that existed before this column was added should
-- read as un-edited, not as edited the moment updated_at appears.
update public.posts   set updated_at = created_at where updated_at is distinct from created_at;
update public.replies set updated_at = created_at where updated_at is distinct from created_at;

create or replace function public.edit_own_post(post_id uuid, new_body text)
returns public.posts
language plpgsql
security definer
set search_path = public
as $$
declare
  row_owner   uuid;
  row_created timestamptz;
  row_deleted boolean;
  clean_body  text := trim(new_body);
  result      public.posts;
begin
  select author_id, created_at, is_deleted into row_owner, row_created, row_deleted
  from public.posts where id = post_id;

  if row_owner is null then
    raise exception 'Post not found.';
  end if;
  if row_owner <> auth.uid() then
    raise exception 'You can only edit your own posts.';
  end if;
  if row_deleted then
    raise exception 'This post has been deleted.';
  end if;
  if now() - row_created > interval '15 minutes' then
    raise exception 'The 15-minute edit window for this post has passed.';
  end if;
  if clean_body = '' then
    raise exception 'Post cannot be empty.';
  end if;
  if length(clean_body) > 500 then
    raise exception 'Post is too long (max 500 characters).';
  end if;

  update public.posts set body = clean_body, updated_at = now()
  where id = post_id
  returning * into result;

  return result;
end;
$$;

create or replace function public.edit_own_reply(reply_id uuid, new_body text)
returns public.replies
language plpgsql
security definer
set search_path = public
as $$
declare
  row_owner   uuid;
  row_created timestamptz;
  row_deleted boolean;
  clean_body  text := trim(new_body);
  result      public.replies;
begin
  select author_id, created_at, is_deleted into row_owner, row_created, row_deleted
  from public.replies where id = reply_id;

  if row_owner is null then
    raise exception 'Reply not found.';
  end if;
  if row_owner <> auth.uid() then
    raise exception 'You can only edit your own replies.';
  end if;
  if row_deleted then
    raise exception 'This reply has been deleted.';
  end if;
  if now() - row_created > interval '15 minutes' then
    raise exception 'The 15-minute edit window for this reply has passed.';
  end if;
  if clean_body = '' then
    raise exception 'Reply cannot be empty.';
  end if;
  if length(clean_body) > 500 then
    raise exception 'Reply is too long (max 500 characters).';
  end if;

  update public.replies set body = clean_body, updated_at = now()
  where id = reply_id
  returning * into result;

  return result;
end;
$$;

-- Let logged-in users call these; the functions themselves enforce
-- ownership and the time window, so this grant does not open up
-- editing other people's posts/replies or editing past 15 minutes.
grant execute on function public.edit_own_post(uuid, text) to authenticated;
grant execute on function public.edit_own_reply(uuid, text) to authenticated;

-- Force PostgREST (Supabase's auto-generated API layer) to reload its
-- schema cache immediately. Without this, a newly created function can
-- return "Could not find the function ... in the schema cache" until
-- PostgREST's next automatic refresh.
notify pgrst, 'reload schema';
