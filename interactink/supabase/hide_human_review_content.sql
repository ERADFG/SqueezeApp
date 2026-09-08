-- ============================================================
-- HIDE HUMAN_REVIEW CONTENT FROM PUBLIC VIEW
-- Run this any time after moderation_media_pipeline.sql. Idempotent
-- (drop-if-exists + create) — safe to re-run.
--
-- What this changes: previously, a post/reply whose moderation_status
-- landed on 'human_review' (a doxxing hit, borderline NSFW, coded
-- drug/weapon-sale language, a self-harm-adjacent flag, etc.) stayed
-- publicly visible to everyone while it waited for an admin to look
-- at it — only 'blocked' and unchecked 'pending' rows were actually
-- hidden. This tightens that: now only 'visible' rows are public.
-- 'human_review' rows are visible to their author and to admins only,
-- same as 'pending'/'blocked', until an admin clears them from the
-- Moderation tab in /admin.
--
-- Trade-off to know about: this means more content sits invisible-
-- to-others until reviewed, so a busier admin queue directly means
-- more legitimate posts waiting longer. Keep an eye on the admin
-- panel's Moderation tab after applying this so review doesn't lag
-- behind for long stretches.
-- ============================================================

drop policy if exists posts_moderation_gate on public.posts;
create policy posts_moderation_gate on public.posts
  as restrictive
  for select
  using (
    moderation_status = 'visible'
    or author_id = auth.uid()
    or public.is_admin()
  );

drop policy if exists replies_moderation_gate on public.replies;
create policy replies_moderation_gate on public.replies
  as restrictive
  for select
  using (
    moderation_status = 'visible'
    or author_id = auth.uid()
    or public.is_admin()
  );
