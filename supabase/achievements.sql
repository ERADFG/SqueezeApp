-- ============================================================
-- ACHIEVEMENTS — levels, badges, and progress tracking
-- ============================================================
-- Run this whole file once in the Supabase SQL editor. Safe to
-- re-run any time — every statement is idempotent (create-if-not-
-- exists tables, drop-then-recreate policies/functions, and an
-- `on conflict do update` seed upsert), so re-running it after
-- adding/editing achievements below just refreshes the catalog
-- without touching anyone's already-unlocked rows.
--
-- WHAT THIS ADDS
--   1. public.achievements       — the read-only catalog (162 seed
--                                   rows across ~20 metrics + a
--                                   handful of one-off specials).
--   2. public.user_achievements  — which of those each person has
--                                   actually unlocked, and when.
--   3. public.ii_achv_metrics(uid)     — SECURITY DEFINER helper that
--                                   recomputes every raw metric
--                                   (posts, likes, followers, streak,
--                                   …) for one person straight from
--                                   the tables that already exist.
--   4. public.ii_sync_achievements(uid) — compares those metrics
--                                   against the catalog's thresholds
--                                   and inserts any newly-earned
--                                   rows into user_achievements.
--   5. public.get_my_achievements()     — the single RPC the client
--                                   calls. Syncs the caller's own
--                                   achievements, then returns one
--                                   jsonb payload with their level,
--                                   XP, and the full catalog each
--                                   marked locked/unlocked with live
--                                   progress. auth.uid()-scoped only
--                                   — there is no "view someone
--                                   else's achievements" path.
--
-- LEVEL CURVE
--   Level is derived entirely from the sum of XP on unlocked
--   achievements — it is not a separate counter that can drift out
--   of sync. cumulative XP needed to REACH level L is 10*L*(L+1),
--   i.e. the XP required to go from level L to L+1 is 20*(L+1) —
--   a steadily steeper climb the same way the reference screenshots
--   show ("Level 1  150/150XP" → "Level 3  55/450XP"). Levels are
--   clamped to 0–100; unlocking literally every achievement in this
--   seed set lands a bit past level 30, so 100 stays a long-term
--   ceiling with room for this catalog to grow rather than
--   something everyone maxes out immediately.
-- ============================================================

create extension if not exists pgcrypto;

-- ── CATALOG TABLE ──────────────────────────────────────────
create table if not exists public.achievements (
  id          text primary key,
  category    text not null,
  metric      text not null,
  threshold   numeric not null,
  tier        text not null,
  title       text not null,
  description text not null,
  icon        text not null,
  xp          integer not null,
  sort_order  integer not null default 0,
  created_at  timestamptz not null default now()
);
create index if not exists achievements_metric_idx on public.achievements(metric);
create index if not exists achievements_category_idx on public.achievements(category);

alter table public.achievements enable row level security;
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'achievements'
  loop
    execute format('drop policy %I on public.achievements', pol.policyname);
  end loop;
end $$;
-- The catalog itself (titles/icons/thresholds) is not sensitive —
-- everyone can read it, same as any other static reference data.
create policy "achievements_public_read" on public.achievements
  for select using (true);

-- ── PER-USER UNLOCK TABLE ──────────────────────────────────
create table if not exists public.user_achievements (
  user_id        uuid not null references public.profiles(id) on delete cascade,
  achievement_id text not null references public.achievements(id) on delete cascade,
  unlocked_at    timestamptz not null default now(),
  primary key (user_id, achievement_id)
);
create index if not exists user_achievements_user_idx on public.user_achievements(user_id);

alter table public.user_achievements enable row level security;
do $$
declare pol record;
begin
  for pol in
    select policyname from pg_policies
    where schemaname = 'public' and tablename = 'user_achievements'
  loop
    execute format('drop policy %I on public.user_achievements', pol.policyname);
  end loop;
end $$;
-- Read-only from the client's side, and only your own rows — every
-- INSERT happens inside ii_sync_achievements() below, which runs
-- SECURITY DEFINER (so it bypasses RLS entirely) and is only ever
-- called with auth.uid() as the target, never an arbitrary id. There
-- is deliberately no insert/update/delete policy here, so a direct
-- client-side `sb.from('user_achievements').insert(...)` is always
-- rejected — the only legitimate way to unlock one is through the
-- RPC actually recomputing your metrics.
create policy "user_achievements_read_own" on public.user_achievements
  for select using (auth.uid() = user_id);

-- ── SEED CATALOG (162 achievements) ─────────────────────────
-- Auto-generated seed data — 162 achievements.
insert into public.achievements (id, category, metric, threshold, tier, title, description, icon, xp, sort_order) values
  ('account_age_days_1', 'Getting Started', 'account_age_days', 1, 'Bronze', 'Day One', 'Been on InteractInk for a day.', '🌱', 10, 0),
  ('account_age_days_2', 'Getting Started', 'account_age_days', 7, 'Silver', 'First Week', 'Stuck around for a full week.', '🌱', 15, 1),
  ('account_age_days_3', 'Getting Started', 'account_age_days', 30, 'Gold', 'One Month In', 'A month on InteractInk.', '🌱', 25, 2),
  ('account_age_days_4', 'Getting Started', 'account_age_days', 90, 'Platinum', 'Quarter Year', 'Three months on InteractInk.', '🌱', 35, 3),
  ('account_age_days_5', 'Getting Started', 'account_age_days', 180, 'Diamond', 'Half a Year', 'Six months on InteractInk.', '🌱', 60, 4),
  ('account_age_days_6', 'Getting Started', 'account_age_days', 365, 'Master', 'First Anniversary', 'One full year on InteractInk.', '🌱', 90, 5),
  ('account_age_days_7', 'Getting Started', 'account_age_days', 730, 'Grandmaster', 'Two Year Veteran', 'Two years on InteractInk.', '🌱', 140, 6),
  ('account_age_days_8', 'Getting Started', 'account_age_days', 1095, 'Legendary', 'Old Timer', 'Three years on InteractInk.', '🌱', 215, 7),
  ('posts_count_1', 'Posting', 'posts_count', 1, 'Bronze', 'First Post', 'Published your first post.', '✍️', 10, 8),
  ('posts_count_2', 'Posting', 'posts_count', 5, 'Silver', 'Getting Started', 'Published 5 posts.', '✍️', 15, 9),
  ('posts_count_3', 'Posting', 'posts_count', 10, 'Gold', 'Warming Up', 'Published 10 posts.', '✍️', 25, 10),
  ('posts_count_4', 'Posting', 'posts_count', 25, 'Platinum', 'Regular Poster', 'Published 25 posts.', '✍️', 35, 11),
  ('posts_count_5', 'Posting', 'posts_count', 50, 'Diamond', 'Steady Stream', 'Published 50 posts.', '✍️', 60, 12),
  ('posts_count_6', 'Posting', 'posts_count', 100, 'Master', 'Century Club', 'Published 100 posts.', '✍️', 90, 13),
  ('posts_count_7', 'Posting', 'posts_count', 250, 'Grandmaster', 'Prolific Poster', 'Published 250 posts.', '✍️', 140, 14),
  ('posts_count_8', 'Posting', 'posts_count', 500, 'Legendary', 'Content Machine', 'Published 500 posts.', '✍️', 215, 15),
  ('posts_count_9', 'Posting', 'posts_count', 1000, 'Mythic', 'Post Legend', 'Published 1,000 posts.', '✍️', 335, 16),
  ('posts_count_10', 'Posting', 'posts_count', 2500, 'Eternal', 'Unstoppable', 'Published 2,500 posts.', '✍️', 515, 17),
  ('likes_given_1', 'Likes', 'likes_given', 1, 'Bronze', 'First Like', 'Liked your first post.', '❤️', 10, 18),
  ('likes_given_2', 'Likes', 'likes_given', 10, 'Silver', 'Supportive', 'Liked 10 posts.', '❤️', 15, 19),
  ('likes_given_3', 'Likes', 'likes_given', 50, 'Gold', 'Generous', 'Liked 50 posts.', '❤️', 25, 20),
  ('likes_given_4', 'Likes', 'likes_given', 100, 'Platinum', 'Big Fan', 'Liked 100 posts.', '❤️', 35, 21),
  ('likes_given_5', 'Likes', 'likes_given', 250, 'Diamond', 'Cheerleader', 'Liked 250 posts.', '❤️', 60, 22),
  ('likes_given_6', 'Likes', 'likes_given', 500, 'Master', 'Serial Liker', 'Liked 500 posts.', '❤️', 90, 23),
  ('likes_given_7', 'Likes', 'likes_given', 1000, 'Grandmaster', 'Heart of Gold', 'Liked 1,000 posts.', '❤️', 140, 24),
  ('likes_given_8', 'Likes', 'likes_given', 2500, 'Legendary', 'Like Machine', 'Liked 2,500 posts.', '❤️', 215, 25),
  ('likes_given_9', 'Likes', 'likes_given', 5000, 'Mythic', 'Endless Support', 'Liked 5,000 posts.', '❤️', 335, 26),
  ('likes_received_1', 'Likes', 'likes_received', 1, 'Bronze', 'First Fan', 'Got your first like.', '💖', 10, 27),
  ('likes_received_2', 'Likes', 'likes_received', 10, 'Silver', 'Liked', 'Earned 10 likes.', '💖', 15, 28),
  ('likes_received_3', 'Likes', 'likes_received', 50, 'Gold', 'Crowd Pleaser', 'Earned 50 likes.', '💖', 25, 29),
  ('likes_received_4', 'Likes', 'likes_received', 100, 'Platinum', 'Well Liked', 'Earned 100 likes.', '💖', 35, 30),
  ('likes_received_5', 'Likes', 'likes_received', 250, 'Diamond', 'Popular', 'Earned 250 likes.', '💖', 60, 31),
  ('likes_received_6', 'Likes', 'likes_received', 500, 'Master', 'Fan Favorite', 'Earned 500 likes.', '💖', 90, 32),
  ('likes_received_7', 'Likes', 'likes_received', 1000, 'Grandmaster', 'Adored', 'Earned 1,000 likes.', '💖', 140, 33),
  ('likes_received_8', 'Likes', 'likes_received', 2500, 'Legendary', 'Beloved', 'Earned 2,500 likes.', '💖', 215, 34),
  ('likes_received_9', 'Likes', 'likes_received', 5000, 'Mythic', 'Icon', 'Earned 5,000 likes.', '💖', 335, 35),
  ('likes_received_10', 'Likes', 'likes_received', 10000, 'Eternal', 'Legend Status', 'Earned 10,000 likes.', '💖', 515, 36),
  ('replies_given_1', 'Comments', 'replies_given', 1, 'Bronze', 'First Comment', 'Left your first reply.', '💬', 10, 37),
  ('replies_given_2', 'Comments', 'replies_given', 5, 'Silver', 'Chatty', 'Left 5 replies.', '💬', 15, 38),
  ('replies_given_3', 'Comments', 'replies_given', 25, 'Gold', 'Conversationalist', 'Left 25 replies.', '💬', 25, 39),
  ('replies_given_4', 'Comments', 'replies_given', 50, 'Platinum', 'Engaged', 'Left 50 replies.', '💬', 35, 40),
  ('replies_given_5', 'Comments', 'replies_given', 100, 'Diamond', 'Discussion Pro', 'Left 100 replies.', '💬', 60, 41),
  ('replies_given_6', 'Comments', 'replies_given', 250, 'Master', 'Reply Guy', 'Left 250 replies.', '💬', 90, 42),
  ('replies_given_7', 'Comments', 'replies_given', 500, 'Grandmaster', 'Thread Runner', 'Left 500 replies.', '💬', 140, 43),
  ('replies_given_8', 'Comments', 'replies_given', 1000, 'Legendary', 'Comment Legend', 'Left 1,000 replies.', '💬', 215, 44),
  ('replies_received_1', 'Comments', 'replies_received', 1, 'Bronze', 'Sparked a Reply', 'Got your first reply.', '🗨️', 10, 45),
  ('replies_received_2', 'Comments', 'replies_received', 5, 'Silver', 'Talk of the Town', 'Got 5 replies.', '🗨️', 15, 46),
  ('replies_received_3', 'Comments', 'replies_received', 25, 'Gold', 'Conversation Starter', 'Got 25 replies.', '🗨️', 25, 47),
  ('replies_received_4', 'Comments', 'replies_received', 50, 'Platinum', 'Hot Topic', 'Got 50 replies.', '🗨️', 35, 48),
  ('replies_received_5', 'Comments', 'replies_received', 100, 'Diamond', 'Discussion Magnet', 'Got 100 replies.', '🗨️', 60, 49),
  ('replies_received_6', 'Comments', 'replies_received', 250, 'Master', 'Buzzing', 'Got 250 replies.', '🗨️', 90, 50),
  ('replies_received_7', 'Comments', 'replies_received', 500, 'Grandmaster', 'Always Talked About', 'Got 500 replies.', '🗨️', 140, 51),
  ('reposts_given_1', 'Sharing', 'reposts_given', 1, 'Bronze', 'First Repost', 'Reposted something for the first time.', '🔁', 10, 52),
  ('reposts_given_2', 'Sharing', 'reposts_given', 5, 'Silver', 'Sharing is Caring', 'Reposted 5 posts.', '🔁', 15, 53),
  ('reposts_given_3', 'Sharing', 'reposts_given', 10, 'Gold', 'Word Spreader', 'Shared a post with 10 people.', '🔁', 25, 54),
  ('reposts_given_4', 'Sharing', 'reposts_given', 25, 'Platinum', 'Signal Booster', 'Reposted 25 posts.', '🔁', 35, 55),
  ('reposts_given_5', 'Sharing', 'reposts_given', 50, 'Diamond', 'Amplifier', 'Reposted 50 posts.', '🔁', 60, 56),
  ('reposts_given_6', 'Sharing', 'reposts_given', 100, 'Master', 'Megaphone', 'Shared posts with 100 people.', '🔁', 90, 57),
  ('reposts_given_7', 'Sharing', 'reposts_given', 250, 'Grandmaster', 'Broadcast Tower', 'Reposted 250 posts.', '🔁', 140, 58),
  ('reposts_given_8', 'Sharing', 'reposts_given', 500, 'Legendary', 'Reach Machine', 'Reposted 500 posts.', '🔁', 215, 59),
  ('reposts_given_9', 'Sharing', 'reposts_given', 1000, 'Mythic', 'Viral Curator', 'Reposted 1,000 posts.', '🔁', 335, 60),
  ('reposts_received_1', 'Sharing', 'reposts_received', 1, 'Bronze', 'Worth Sharing', 'One of your posts got reposted.', '📢', 10, 61),
  ('reposts_received_2', 'Sharing', 'reposts_received', 5, 'Silver', 'Catching On', 'Your posts were reposted 5 times.', '📢', 15, 62),
  ('reposts_received_3', 'Sharing', 'reposts_received', 10, 'Gold', 'Reaching 10', 'Your posts reached 10 people through reposts.', '📢', 25, 63),
  ('reposts_received_4', 'Sharing', 'reposts_received', 25, 'Platinum', 'Spreading Fast', 'Your posts were reposted 25 times.', '📢', 35, 64),
  ('reposts_received_5', 'Sharing', 'reposts_received', 50, 'Diamond', 'Making Waves', 'Your posts were reposted 50 times.', '📢', 60, 65),
  ('reposts_received_6', 'Sharing', 'reposts_received', 100, 'Master', 'Reaching 100', 'Your posts reached 100 people through reposts.', '📢', 90, 66),
  ('reposts_received_7', 'Sharing', 'reposts_received', 250, 'Grandmaster', 'Trending', 'Your posts were reposted 250 times.', '📢', 140, 67),
  ('reposts_received_8', 'Sharing', 'reposts_received', 500, 'Legendary', 'Everywhere', 'Your posts were reposted 500 times.', '📢', 215, 68),
  ('reposts_received_9', 'Sharing', 'reposts_received', 1000, 'Mythic', 'Going Viral', 'Your posts were reposted 1,000 times.', '📢', 335, 69),
  ('quotes_given_1', 'Sharing', 'quotes_given', 1, 'Bronze', 'First Quote', 'Quoted a post for the first time.', '💭', 10, 70),
  ('quotes_given_2', 'Sharing', 'quotes_given', 5, 'Silver', 'Adding Commentary', 'Quoted 5 posts.', '💭', 15, 71),
  ('quotes_given_3', 'Sharing', 'quotes_given', 10, 'Gold', 'Quote Tweeter', 'Quoted 10 posts.', '💭', 25, 72),
  ('quotes_given_4', 'Sharing', 'quotes_given', 25, 'Platinum', 'Running Commentary', 'Quoted 25 posts.', '💭', 35, 73),
  ('quotes_given_5', 'Sharing', 'quotes_given', 50, 'Diamond', 'Hot Takes', 'Quoted 50 posts.', '💭', 60, 74),
  ('quotes_given_6', 'Sharing', 'quotes_given', 100, 'Master', 'Quote Master', 'Quoted 100 posts.', '💭', 90, 75),
  ('followers_count_1', 'Community', 'followers_count', 1, 'Bronze', 'First Follower', 'Someone followed you.', '👥', 10, 76),
  ('followers_count_2', 'Community', 'followers_count', 10, 'Silver', 'Building an Audience', 'Reached 10 followers.', '👥', 15, 77),
  ('followers_count_3', 'Community', 'followers_count', 25, 'Gold', 'Small Crowd', 'Reached 25 followers.', '👥', 25, 78),
  ('followers_count_4', 'Community', 'followers_count', 50, 'Platinum', 'Growing Fast', 'Reached 50 followers.', '👥', 35, 79),
  ('followers_count_5', 'Community', 'followers_count', 100, 'Diamond', 'Triple Digits', 'Reached 100 followers.', '👥', 60, 80),
  ('followers_count_6', 'Community', 'followers_count', 250, 'Master', 'Rising Star', 'Reached 250 followers.', '👥', 90, 81),
  ('followers_count_7', 'Community', 'followers_count', 500, 'Grandmaster', 'Local Celebrity', 'Reached 500 followers.', '👥', 140, 82),
  ('followers_count_8', 'Community', 'followers_count', 1000, 'Legendary', 'Four Digits', 'Reached 1,000 followers.', '👥', 215, 83),
  ('followers_count_9', 'Community', 'followers_count', 2500, 'Mythic', 'Influencer', 'Reached 2,500 followers.', '👥', 335, 84),
  ('followers_count_10', 'Community', 'followers_count', 5000, 'Eternal', 'Household Name', 'Reached 5,000 followers.', '👥', 515, 85),
  ('followers_count_11', 'Community', 'followers_count', 10000, 'Ascendant', 'InteractInk Famous', 'Reached 10,000 followers.', '👥', 800, 86),
  ('following_count_1', 'Community', 'following_count', 10, 'Bronze', 'Curious', 'Following 10 people.', '🤝', 10, 87),
  ('following_count_2', 'Community', 'following_count', 25, 'Silver', 'Building Your Feed', 'Following 25 people.', '🤝', 15, 88),
  ('following_count_3', 'Community', 'following_count', 50, 'Gold', 'Well Connected', 'Following 50 people.', '🤝', 25, 89),
  ('following_count_4', 'Community', 'following_count', 100, 'Platinum', 'Networker', 'Following 100 people.', '🤝', 35, 90),
  ('following_count_5', 'Community', 'following_count', 250, 'Diamond', 'Super Connector', 'Following 250 people.', '🤝', 60, 91),
  ('following_count_6', 'Community', 'following_count', 500, 'Master', 'Follows Everyone', 'Following 500 people.', '🤝', 90, 92),
  ('communities_joined_1', 'Communities', 'communities_joined', 1, 'Bronze', 'Joined the Club', 'Joined your first community.', '🏘️', 10, 93),
  ('communities_joined_2', 'Communities', 'communities_joined', 3, 'Silver', 'Community Hopper', 'Joined 3 communities.', '🏘️', 15, 94),
  ('communities_joined_3', 'Communities', 'communities_joined', 5, 'Gold', 'Well Rounded', 'Joined 5 communities.', '🏘️', 25, 95),
  ('communities_joined_4', 'Communities', 'communities_joined', 10, 'Platinum', 'Community Explorer', 'Joined 10 communities.', '🏘️', 35, 96),
  ('communities_joined_5', 'Communities', 'communities_joined', 25, 'Diamond', 'Everywhere at Once', 'Joined 25 communities.', '🏘️', 60, 97),
  ('communities_created_1', 'Communities', 'communities_created', 1, 'Bronze', 'Founder', 'Created your first community.', '🏗️', 10, 98),
  ('communities_created_2', 'Communities', 'communities_created', 3, 'Silver', 'Serial Founder', 'Created 3 communities.', '🏗️', 15, 99),
  ('communities_created_3', 'Communities', 'communities_created', 5, 'Gold', 'Community Architect', 'Created 5 communities.', '🏗️', 25, 100),
  ('communities_created_4', 'Communities', 'communities_created', 10, 'Platinum', 'Empire Builder', 'Created 10 communities.', '🏗️', 35, 101),
  ('messages_sent_1', 'Chat', 'messages_sent', 1, 'Bronze', 'First Message', 'Sent your first chat message.', '💌', 10, 102),
  ('messages_sent_2', 'Chat', 'messages_sent', 10, 'Silver', 'Texter', 'Sent 10 messages.', '💌', 15, 103),
  ('messages_sent_3', 'Chat', 'messages_sent', 50, 'Gold', 'Chatterbox', 'Sent 50 messages.', '💌', 25, 104),
  ('messages_sent_4', 'Chat', 'messages_sent', 100, 'Platinum', 'Always Online', 'Sent 100 messages.', '💌', 35, 105),
  ('messages_sent_5', 'Chat', 'messages_sent', 500, 'Diamond', 'DM Regular', 'Sent 500 messages.', '💌', 60, 106),
  ('messages_sent_6', 'Chat', 'messages_sent', 1000, 'Master', 'Chat Champion', 'Sent 1,000 messages.', '💌', 90, 107),
  ('messages_sent_7', 'Chat', 'messages_sent', 5000, 'Grandmaster', 'Never Offline', 'Sent 5,000 messages.', '💌', 140, 108),
  ('dm_partners_count_1', 'Chat', 'dm_partners_count', 1, 'Bronze', 'Broke the Ice', 'Started your first conversation.', '📇', 10, 109),
  ('dm_partners_count_2', 'Chat', 'dm_partners_count', 5, 'Silver', 'Social Butterfly', 'Chatted with 5 different people.', '📇', 15, 110),
  ('dm_partners_count_3', 'Chat', 'dm_partners_count', 10, 'Gold', 'Well Connected', 'Chatted with 10 different people.', '📇', 25, 111),
  ('dm_partners_count_4', 'Chat', 'dm_partners_count', 25, 'Platinum', 'Networker', 'Chatted with 25 different people.', '📇', 35, 112),
  ('dm_partners_count_5', 'Chat', 'dm_partners_count', 50, 'Diamond', 'Knows Everyone', 'Chatted with 50 different people.', '📇', 60, 113),
  ('bookmarks_count_1', 'Saving', 'bookmarks_count', 1, 'Bronze', 'First Save', 'Bookmarked your first post.', '🔖', 10, 114),
  ('bookmarks_count_2', 'Saving', 'bookmarks_count', 10, 'Silver', 'Collector', 'Bookmarked 10 posts.', '🔖', 15, 115),
  ('bookmarks_count_3', 'Saving', 'bookmarks_count', 50, 'Gold', 'Curator', 'Bookmarked 50 posts.', '🔖', 25, 116),
  ('bookmarks_count_4', 'Saving', 'bookmarks_count', 100, 'Platinum', 'Archivist', 'Bookmarked 100 posts.', '🔖', 35, 117),
  ('bookmarks_count_5', 'Saving', 'bookmarks_count', 250, 'Diamond', 'Digital Hoarder', 'Bookmarked 250 posts.', '🔖', 60, 118),
  ('lists_created_1', 'Lists', 'lists_created', 1, 'Bronze', 'List Maker', 'Created your first list.', '📋', 10, 119),
  ('lists_created_2', 'Lists', 'lists_created', 3, 'Silver', 'Organizer', 'Created 3 lists.', '📋', 15, 120),
  ('lists_created_3', 'Lists', 'lists_created', 5, 'Gold', 'List Fanatic', 'Created 5 lists.', '📋', 25, 121),
  ('lists_created_4', 'Lists', 'lists_created', 10, 'Platinum', 'Master Curator', 'Created 10 lists.', '📋', 35, 122),
  ('articles_written_1', 'Articles', 'articles_written', 1, 'Bronze', 'First Byline', 'Published your first article.', '📰', 10, 123),
  ('articles_written_2', 'Articles', 'articles_written', 3, 'Silver', 'Columnist', 'Published 3 articles.', '📰', 15, 124),
  ('articles_written_3', 'Articles', 'articles_written', 5, 'Gold', 'Contributor', 'Published 5 articles.', '📰', 25, 125),
  ('articles_written_4', 'Articles', 'articles_written', 10, 'Platinum', 'Staff Writer', 'Published 10 articles.', '📰', 35, 126),
  ('articles_written_5', 'Articles', 'articles_written', 25, 'Diamond', 'Prolific Author', 'Published 25 articles.', '📰', 60, 127),
  ('streak_days_1', 'Streaks', 'streak_days', 3, 'Bronze', '3 Day Streak', 'Active 3 days in a row.', '🔥', 10, 128),
  ('streak_days_2', 'Streaks', 'streak_days', 7, 'Silver', 'Week Streak', 'Active 7 days in a row.', '🔥', 15, 129),
  ('streak_days_3', 'Streaks', 'streak_days', 14, 'Gold', 'Two Week Streak', 'Active 14 days in a row.', '🔥', 25, 130),
  ('streak_days_4', 'Streaks', 'streak_days', 30, 'Platinum', 'Month Streak', 'Active 30 days in a row.', '🔥', 35, 131),
  ('streak_days_5', 'Streaks', 'streak_days', 60, 'Diamond', 'Unstoppable', 'Active 60 days in a row.', '🔥', 60, 132),
  ('streak_days_6', 'Streaks', 'streak_days', 100, 'Master', 'Century Streak', 'Active 100 days in a row.', '🔥', 90, 133),
  ('streak_days_7', 'Streaks', 'streak_days', 180, 'Grandmaster', 'Half Year Streak', 'Active 180 days in a row.', '🔥', 140, 134),
  ('streak_days_8', 'Streaks', 'streak_days', 365, 'Legendary', 'Full Year Streak', 'Active 365 days in a row.', '🔥', 215, 135),
  ('polls_created_1', 'Polls', 'polls_created', 1, 'Bronze', 'First Poll', 'Created your first poll.', '📊', 10, 136),
  ('polls_created_2', 'Polls', 'polls_created', 5, 'Silver', 'Pollster', 'Created 5 polls.', '📊', 15, 137),
  ('polls_created_3', 'Polls', 'polls_created', 10, 'Gold', 'Data Collector', 'Created 10 polls.', '📊', 25, 138),
  ('polls_created_4', 'Polls', 'polls_created', 25, 'Platinum', 'Poll Machine', 'Created 25 polls.', '📊', 35, 139),
  ('polls_voted_1', 'Polls', 'polls_voted', 1, 'Bronze', 'First Vote', 'Voted in your first poll.', '🗳️', 10, 140),
  ('polls_voted_2', 'Polls', 'polls_voted', 10, 'Silver', 'Engaged Voter', 'Voted in 10 polls.', '🗳️', 15, 141),
  ('polls_voted_3', 'Polls', 'polls_voted', 50, 'Gold', 'Civic Duty', 'Voted in 50 polls.', '🗳️', 25, 142),
  ('polls_voted_4', 'Polls', 'polls_voted', 100, 'Platinum', 'Poll Addict', 'Voted in 100 polls.', '🗳️', 35, 143),
  ('joined', 'Getting Started', 'joined', 1, 'Special', 'Welcome Aboard', 'Joined InteractInk.', '🎉', 10, 144),
  ('profile_complete', 'Getting Started', 'profile_complete', 1, 'Special', 'Profile Complete', 'Set a display name, avatar, and bio.', '🧩', 25, 145),
  ('verified_account', 'Getting Started', 'verified_account', 1, 'Special', 'Verified', 'Got the verified badge.', '✅', 100, 146),
  ('community_moderator', 'Communities', 'community_moderator', 1, 'Special', 'Moderator', 'Became a moderator of a community.', '🛡️', 60, 147),
  ('night_owl_post', 'Special', 'night_owl_post', 1, 'Special', 'Night Owl', 'Posted between midnight and 5am.', '🦉', 20, 148),
  ('early_bird_post', 'Special', 'early_bird_post', 1, 'Special', 'Early Bird', 'Posted between 5am and 7am.', '🐦', 20, 149),
  ('weekend_both_days', 'Special', 'weekend_both_days', 1, 'Special', 'Weekend Warrior', 'Posted on both a Saturday and a Sunday.', '📅', 20, 150),
  ('first_mutual_follow', 'Community', 'first_mutual_follow', 1, 'Special', 'Mutual', 'Formed your first mutual follow.', '🔗', 20, 151),
  ('posted_long_form', 'Special', 'posted_long_form', 1, 'Special', 'Wall of Text', 'Wrote a post near the character limit.', '📜', 15, 152),
  ('posted_media', 'Special', 'posted_media', 1, 'Special', 'Show and Tell', 'Posted with a photo attached.', '🖼️', 10, 153),
  ('posted_video', 'Special', 'posted_video', 1, 'Special', 'Director''s Cut', 'Posted with a video attached.', '🎬', 15, 154),
  ('posted_gif', 'Special', 'posted_gif', 1, 'Special', 'GIF Enjoyer', 'Posted with a GIF attached.', '🎞️', 10, 155),
  ('list_with_5_members', 'Lists', 'list_with_5_members', 1, 'Special', 'List Builder', 'Added 5 people to a list.', '🗂️', 20, 156),
  ('reply_got_liked', 'Comments', 'reply_got_liked', 1, 'Special', 'Good Take', 'One of your replies got liked.', '✨', 15, 157),
  ('nested_reply', 'Comments', 'nested_reply', 1, 'Special', 'Thread Diver', 'Replied inside a reply thread.', '🧵', 15, 158),
  ('got_quoted', 'Sharing', 'got_quoted', 1, 'Special', 'Quotable', 'One of your posts got quoted.', '🗣️', 25, 159),
  ('chat_key_backup', 'Chat', 'chat_key_backup', 1, 'Special', 'Secured', 'Backed up your chat encryption key.', '🔐', 20, 160),
  ('bio_written', 'Getting Started', 'bio_written', 1, 'Special', 'Tell Us About You', 'Wrote a bio for your profile.', '📝', 10, 161)
on conflict (id) do update set
  category = excluded.category, metric = excluded.metric, threshold = excluded.threshold,
  tier = excluded.tier, title = excluded.title, description = excluded.description,
  icon = excluded.icon, xp = excluded.xp, sort_order = excluded.sort_order;

-- ── METRICS — recomputes every raw counter for one person from the
-- tables that already power the rest of the app (no new counters to
-- keep in sync; this always reflects the current live state). ────
create or replace function public.ii_achv_metrics(p_uid uuid)
returns table(metric text, value numeric)
language sql
security definer
set search_path = public
as $$
  with streak as (
    select coalesce(max(len), 0) as v
    from (
      select g, count(*) as len, max(d) as last_day
      from (
        select d, d - (row_number() over (order by d))::int as g
        from (
          select distinct (created_at at time zone 'utc')::date as d from public.posts where author_id = p_uid and is_deleted = false
          union
          select distinct (created_at at time zone 'utc')::date from public.replies where author_id = p_uid and is_deleted = false
          union
          select distinct (created_at at time zone 'utc')::date from public.likes where user_id = p_uid
          union
          select distinct (created_at at time zone 'utc')::date from public.reposts where user_id = p_uid
        ) acts
      ) grp
      group by g
    ) streaks
    where last_day >= (current_date - 1)
  )
  select 'account_age_days'::text, greatest(0, extract(epoch from (now() - p.created_at)) / 86400.0) from public.profiles p where p.id = p_uid
  union all select 'joined', 1
  union all select 'profile_complete', (case when coalesce(length(trim(p.display_name)),0) > 0 and p.avatar_url is not null and coalesce(length(trim(p.bio)),0) > 0 then 1 else 0 end) from public.profiles p where p.id = p_uid
  union all select 'bio_written', (case when coalesce(length(trim(p.bio)),0) > 0 then 1 else 0 end) from public.profiles p where p.id = p_uid
  union all select 'verified_account', (case when p.verified then 1 else 0 end) from public.profiles p where p.id = p_uid
  union all select 'chat_key_backup', (case when p.key_backup is not null then 1 else 0 end) from public.profiles p where p.id = p_uid
  union all select 'posts_count', count(*) from public.posts where author_id = p_uid and is_deleted = false
  union all select 'quotes_given', count(*) from public.posts where author_id = p_uid and is_deleted = false and quote_of is not null
  union all select 'polls_created', count(*) from public.posts where author_id = p_uid and is_deleted = false and poll_options is not null
  union all select 'posted_long_form', (case when exists(select 1 from public.posts where author_id = p_uid and is_deleted = false and length(body) >= 480) then 1 else 0 end)
  union all select 'posted_media', (case when exists(select 1 from public.posts where author_id = p_uid and is_deleted = false and media_type = 'image') then 1 else 0 end)
  union all select 'posted_video', (case when exists(select 1 from public.posts where author_id = p_uid and is_deleted = false and media_type = 'video') then 1 else 0 end)
  union all select 'posted_gif', (case when exists(select 1 from public.posts where author_id = p_uid and is_deleted = false and media_type = 'gif') then 1 else 0 end)
  union all select 'night_owl_post', (case when exists(select 1 from public.posts where author_id = p_uid and is_deleted = false and extract(hour from created_at at time zone 'utc') < 5) then 1 else 0 end)
  union all select 'early_bird_post', (case when exists(select 1 from public.posts where author_id = p_uid and is_deleted = false and extract(hour from created_at at time zone 'utc') between 5 and 6) then 1 else 0 end)
  union all select 'weekend_both_days', (case when exists(select 1 from public.posts where author_id = p_uid and is_deleted = false and extract(dow from created_at at time zone 'utc') = 6)
                                            and exists(select 1 from public.posts where author_id = p_uid and is_deleted = false and extract(dow from created_at at time zone 'utc') = 0) then 1 else 0 end)
  union all select 'likes_given', count(*) from public.likes where user_id = p_uid
  union all select 'likes_received', (select count(*) from public.likes l join public.posts pp on pp.id = l.post_id where pp.author_id = p_uid)
                                    + (select count(*) from public.likes l join public.replies r on r.id = l.reply_id where r.author_id = p_uid)
  union all select 'reply_got_liked', (case when exists(select 1 from public.likes l join public.replies r on r.id = l.reply_id where r.author_id = p_uid) then 1 else 0 end)
  union all select 'replies_given', count(*) from public.replies where author_id = p_uid and is_deleted = false
  union all select 'nested_reply', (case when exists(select 1 from public.replies where author_id = p_uid and is_deleted = false and parent_reply_id is not null) then 1 else 0 end)
  union all select 'replies_received', count(*) from public.replies r join public.posts pp on pp.id = r.post_id where pp.author_id = p_uid and r.is_deleted = false
  union all select 'reposts_given', count(*) from public.reposts where user_id = p_uid
  union all select 'reposts_received', count(*) from public.reposts rp join public.posts pp on pp.id = rp.post_id where pp.author_id = p_uid
  union all select 'got_quoted', (case when exists(select 1 from public.posts q join public.posts pp on pp.id = q.quote_of where pp.author_id = p_uid) then 1 else 0 end)
  union all select 'followers_count', count(*) from public.follows where followee_id = p_uid
  union all select 'following_count', count(*) from public.follows where follower_id = p_uid
  union all select 'first_mutual_follow', (case when exists(
      select 1 from public.follows f1 join public.follows f2
        on f2.follower_id = f1.followee_id and f2.followee_id = f1.follower_id
      where f1.follower_id = p_uid
    ) then 1 else 0 end)
  union all select 'communities_joined', count(*) from public.community_members where user_id = p_uid
  union all select 'communities_created', count(*) from public.communities where created_by = p_uid
  union all select 'community_moderator', (case when exists(select 1 from public.community_moderators where user_id = p_uid) then 1 else 0 end)
  union all select 'messages_sent', count(*) from public.messages where sender_id = p_uid
  union all select 'dm_partners_count', count(distinct coalesce(recipient_id::text, conversation_id::text)) from public.messages where sender_id = p_uid
  union all select 'bookmarks_count', count(*) from public.bookmarks where user_id = p_uid
  union all select 'lists_created', count(*) from public.lists where owner_id = p_uid
  union all select 'list_with_5_members', (case when exists(
      select 1 from public.list_members lm join public.lists l on l.id = lm.list_id
      where l.owner_id = p_uid group by lm.list_id having count(*) >= 5
    ) then 1 else 0 end)
  union all select 'articles_written', count(*) from public.articles where author_id = p_uid
  union all select 'polls_voted', count(distinct post_id) from public.poll_votes where user_id = p_uid
  union all select 'streak_days', (select v from streak);
$$;

-- ── SYNC — inserts any newly-earned rows into user_achievements.
-- Idempotent per call (only inserts what isn't already there) and
-- cheap enough to call on every achievements-page load; nothing
-- elsewhere in the app needs to change to "award" anything. ──────
create or replace function public.ii_sync_achievements(p_uid uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.user_achievements (user_id, achievement_id)
  select p_uid, a.id
  from public.achievements a
  join public.ii_achv_metrics(p_uid) m on m.metric = a.metric
  where m.value >= a.threshold
    and not exists (
      select 1 from public.user_achievements ua
      where ua.user_id = p_uid and ua.achievement_id = a.id
    )
  on conflict (user_id, achievement_id) do nothing;
end;
$$;

-- ── PUBLIC RPC — the only entry point the client calls. Always
-- operates on auth.uid(); there is no parameter to pass someone
-- else's id, so this can only ever sync/return your own progress. ──
create or replace function public.get_my_achievements()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_uid uuid := auth.uid();
  v_total_xp numeric;
  v_level int;
  v_cum_this int;
  v_cum_next int;
  v_result jsonb;
begin
  if v_uid is null then
    return null;
  end if;

  perform public.ii_sync_achievements(v_uid);

  select coalesce(sum(a.xp), 0) into v_total_xp
  from public.user_achievements ua
  join public.achievements a on a.id = ua.achievement_id
  where ua.user_id = v_uid;

  -- level = largest L with 10*L*(L+1) <= total_xp, clamped 0..100
  v_level := greatest(0, least(100, floor((-1 + sqrt(1 + 0.4 * v_total_xp)) / 2)::int));
  v_cum_this := 10 * v_level * (v_level + 1);
  v_cum_next := 10 * (v_level + 1) * (v_level + 2);

  select jsonb_build_object(
    'level', v_level,
    'total_xp', v_total_xp,
    'xp_in_level', v_total_xp - v_cum_this,
    'xp_for_next_level', v_cum_next - v_cum_this,
    'unlocked_count', (select count(*) from public.user_achievements where user_id = v_uid),
    'total_count', (select count(*) from public.achievements),
    'achievements', coalesce(jsonb_agg(
      jsonb_build_object(
        'id', a.id,
        'category', a.category,
        'metric', a.metric,
        'threshold', a.threshold,
        'tier', a.tier,
        'title', a.title,
        'description', a.description,
        'icon', a.icon,
        'xp', a.xp,
        'unlocked', (ua.user_id is not null),
        'unlocked_at', ua.unlocked_at,
        'current_value', coalesce(m.value, 0)
      ) order by a.sort_order
    ), '[]'::jsonb)
  ) into v_result
  from public.achievements a
  left join public.user_achievements ua on ua.achievement_id = a.id and ua.user_id = v_uid
  left join public.ii_achv_metrics(v_uid) m on m.metric = a.metric;

  return v_result;
end;
$$;

grant execute on function public.get_my_achievements() to authenticated;
revoke execute on function public.ii_achv_metrics(uuid) from public, anon, authenticated;
revoke execute on function public.ii_sync_achievements(uuid) from public, anon, authenticated;

-- ============================================================
-- Done. Test with (as a logged-in user, in the Supabase SQL editor
-- you'll need to impersonate a user or just call it from the app):
--   select public.get_my_achievements();
-- ============================================================
