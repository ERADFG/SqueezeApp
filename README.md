# InteractInk — Setup

A static, no-backend social imageboard with real accounts. All data
(profiles, posts, replies, likes, media/avatar files) lives in
Supabase; the HTML/CSS/JS here just talks to it directly from the
browser. Posting requires signing up with an email, username, and
password — there is no anonymous posting.

## 1. Create a Supabase project
1. Go to https://supabase.com → New project.
2. Wait for it to finish provisioning.

## 2. Run the schema
Run **one file**: `supabase/MASTER_SCHEMA.sql`.
1. In your project: **SQL Editor → New query**.
2. Paste in the *entire* contents of `supabase/MASTER_SCHEMA.sql` and hit Run.

That one file is every other `supabase/*.sql` file in this project,
already concatenated in the order their dependencies require — tables,
RLS policies, triggers, storage buckets, everything. It's safe to
re-run any time, on a brand new project or one that already has some
of these applied. It creates (among other things):
   - `profiles` (username, display_name, avatar_url, banner_url, bio) —
     one row per user, auto-created by a trigger the moment someone
     signs up (this is what makes account creation not require any
     extra app-side "create the account" step — it happens in the DB
     the instant `auth.users` gets a new row)
   - `posts`, `replies`, `likes`, `reposts`, `reports`, `follows`,
     `lists`, `communities`, `messages`, `notifications` — all tied to
     a `profiles.id`
   - `user_settings` — notification toggles and a "who can message
     you" privacy setting, enforced by RLS
   - RLS policies on every table (public read, write only when logged
     in and only to your own rows)
   - the realtime publication for live post/reply/notification/message
     updates
   - two storage buckets: `media` (post/reply images & video, 100MB
     limit) and `avatars` (profile pictures, 100MB limit)

The individual `supabase/*.sql` files (`schema.sql`, `settings.sql`,
`communities.sql`, etc.) still exist for reference/history, but you
don't need to run them one by one — `MASTER_SCHEMA.sql` supersedes
all of them.

## 3. Configure email auth
Project Settings → Authentication → Providers → Email is on by
default, which is all this app needs — but there's one toggle to
flip:

**Turn OFF "Confirm email"** (Authentication → Providers → Email →
uncheck "Confirm email"). With it off, `signUp()` creates the account
and returns a real, logged-in session in the same call — no
verification step, no email sent, nothing to click or type. Sign up
is: username/email/password → submit → you're in.

This is intentional, not a shortcut taken to dodge a bug: Supabase's
built-in mailer (what handles auth emails before you set up your own
SMTP provider) is capped at only a handful of emails per hour — fine
for occasional testing, but it collapses immediately under real
traffic (a burst of signups, e.g. 100 people in an hour, will start
failing outright). Removing the email step removes that ceiling
completely — there's no external service in the loop at all, so there
is no rate limit to hit, no matter how many people sign up. Email is
still collected (used as the login identifier and for password reset)
but never verified.

If you want confirmed-real emails later at some point, the trade-off
is real infrastructure to support it: custom SMTP (Resend/SendGrid/
Postmark all have workable free tiers) plus raised rate limits in
Authentication → Rate Limits, and ideally CAPTCHA (Supabase supports
hCaptcha/Turnstile on signup) to keep bots from farming accounts once
there's no email step gatekeeping them. None of that is set up here —
worth doing before a real public launch, but out of scope for what
was asked.

## 4. Get your API keys
Project Settings → API:
- **Project URL**
- **anon public key**

Open `js/supabase-config.js` and paste them in:
```js
const SUPABASE_URL = 'https://xxxxxxxx.supabase.co';
const SUPABASE_ANON_KEY = 'eyJ...';
```
The anon key is meant to be public — it's safe in frontend code because
every table has Row Level Security turned on (see schema.sql: anyone
can read public data, but writes require a logged-in session and only
succeed against your own `author_id` / `user_id` / `id`).

## 5. Run it
This is a plain static site — no build step, no Node server required.
- Locally: open `index.html` directly, or run `npx serve .`
- Hosted: drag the folder into Netlify/Vercel, or push to GitHub Pages.

## Pages
- `/home` (`index.html`) — board feed, new-thread form (accounts only), trending sidebar, realtime new-post updates
- `/<username>/status/<uuid>` (`thread.html`) — single thread with all replies, realtime new-reply updates. Also reachable as `/i/status/<uuid>` before the author is known (e.g. a raw copy-pasted id) — the address bar upgrades to the canonical `/<username>/status/<uuid>` automatically once the post loads, same as x.com.
- `/login`, `/signup` (`login.html` / `signup.html`) — create an account / sign in (instant — no email verification step)
- `/<username>` (`profile.html`) — a user's public profile (banner, avatar, bio, their posts). Your own profile shows an "Edit Profile" button that goes to `editprofile.html`; visiting your own profile no longer auto-opens an edit form.
- `editprofile.html` — its own page (Twitter's "Edit profile" screen) for banner, avatar, display name, and bio; logged-in users only, always edits your own account
- `/<username>/followers`, `/<username>/following` (`followlist.html`) — its own page (Twitter's followers/following screen) with tabs, a Follow/Following button per row, live counts
- `/articles` (`articles.html`) — "All Articles" / "Your Articles" tabs, search box, "+ Write" button. Replaces Lists as the sidebar's second primary nav item — see "Articles" below.
- `/i/articles/<uuid>` (`article.html`) — a single Article: cover image (optional), title, author byline, full body, Edit/Delete for the author only
- `/editarticle.html` or `/editarticle.html?id=<uuid>` (`editarticle.html`) — write a new Article or edit one you own; logged-in users only
- `/lists` (`lists.html`) — "Your Lists" / "Lists you're on" tabs, "+ Create" button. No longer a primary sidebar item — reachable from the "···" **More** menu instead (see `js/common.js`'s `renderSideNav()`)
- `/i/lists/<uuid>` (`list.html`) — a single List: header (Edit/Delete for the owner), a Posts tab (merged timeline of every member) and a Members tab (Remove button for the owner)
- `/<username>/lists` (`profilelists.html`) — Lists a given profile is a (visible) member of; reached from that profile's "···" menu → "View Lists"
- `/search?q=<term>` (`search.html`) — search posts (body) or people (username/display name), tabbed
- `/bookmarks` (`bookmarks.html`) — posts you've bookmarked (private to you)
- `/notifications` (`notifications.html`) — likes, replies, and new followers; marks itself read on view, live badge count in the sidebar
- `/messages`, `/messages/<username>` (`chat.html`) — direct messages: conversation list, or a one-on-one thread with realtime delivery
- `/settings` (`settings.html`) — Notifications (toggle likes/replies/follows), Privacy (who can message you), Account (email/password), link to `editprofile.html`, log out
- `/rules` (`rules.html`) — rules, FAQ, DMCA contact info

All the pretty paths above are handled by the `rewrites` block in
`vercel.json` — Vercel serves the real `.html` file behind the scenes
while the address bar keeps the clean URL. Every internal link in the
app is built through one of the helpers at the top of `js/common.js`
(`profileUrl()`, `postUrl()`, `followListUrl()`, `messagesUrl()`), and
those now build the pretty path directly (e.g. `profileUrl('marc')`
-> `/marc`), so the whole scheme lives in one place if it ever needs
to change. That means pretty URLs need the `vercel.json` rewrites to
actually be active — a real Vercel deploy, a Vercel Preview URL, or
`vercel dev` locally — or every link 404s. Old-style links
(`profile.html?u=marc`, `thread.html?id=<uuid>` — see the `legacy*()`
helpers in `js/common.js`) are still *read* correctly by every page
as a fallback (old bookmarks, shared links, hosts without the
rewrites), but are no longer what the app itself links to. To test
URLs locally, use `vercel dev` instead, or just deploy — Vercel
Preview URLs get the rewrites too.

The left sidebar nav (`#side-nav`, filled in by `renderSideNav()` in
`js/common.js`) is shared across every page instead of being copy-pasted
HTML, so adding/reordering nav items only needs to happen in one place.

## SEO / indexing — every profile and post is now a real, discoverable page
This app is a client-rendered SPA: `profile.html`/`thread.html` are empty
shells until `js/profile.js`/`js/thread.js` fetch the real content from
Supabase in the browser. That's invisible to a human, but it meant two
things were broken for search engines and link-unfurl bots:

1. **Nothing to crawl.** There's no static list of `/<username>` and
   `/<username>/status/<id>` URLs anywhere, so a crawler could only ever
   find a profile/post by already having a link to it. Most users' pages
   would simply never be discovered.
2. **Nothing to read even if they found it.** Bots that don't execute
   JS (Bing's crawler is limited here; link-unfurlers like Slack,
   Discord, WhatsApp, iMessage, and X never run JS at all) would only
   ever see the generic placeholder `<title>`/`<meta>` baked into the
   HTML — every shared profile/post link unfurled as generic "Profile —
   InteractInk" text.

Three pieces fix this, all serverless (no build step added, still a
static site otherwise):

- **`/sitemap.xml`** (`api/sitemap.js`) — built live from `profiles`,
  `posts`, `communities`, and public `lists`, so every one of them has a
  discoverable URL. Linked from `/robots.txt`. Capped at ~5,000 rows per
  table for now — see the comment in that file for how to scale past it.
- **`/robots.txt`** (`api/robots.js`) — allows everything except the
  personal/utility pages (settings, DMs, bookmarks, notifications,
  login/signup, search results), which also carry a `noindex` meta tag
  as the primary signal.
- **Bot-only server-rendered HTML** (`api/prerender.js`) — requests to
  `/`, `/home`, `/<username>`, or `/<username>/status/<id>` whose
  User-Agent matches a known crawler/unfurl-bot pattern (see the `has`
  conditions in `vercel.json`) get real, already-rendered HTML —
  the latest posts on `/` and `/home`, the actual name/bio/post text
  on profile and thread pages — instead of the empty SPA shell (the
  home feed's `id="feed-posts"><span class="spinner">Loading
  posts…</span>` placeholder, in particular). A human hitting the same
  URL still gets the normal app, unchanged. This is what's usually
  called "dynamic rendering," not cloaking: both versions show the
  same content, just rendered by different means.

On top of that, every content page (`profile.js`, `thread.js`,
`community.js`, `list.js`, `followlist.js`, `profilelists.js`) now sets
a real `<link rel="canonical">`, `og:url`, `og:image`, and a JSON-LD
block (`Person`/`SocialMediaPosting`/etc.) once its data loads, via
`setCanonical()` / `setPageImage()` / `setJsonLd()` in `js/common.js` —
previously only `document.title` and the description were being
updated, so shared links had no real preview image and search engines
had no structured signal of what the page was about, and no canonical
URL tying together `/<username>`, the legacy `profile.html?u=<username>`
form, and `/i/status/<id>` vs. `/<username>/status/<id>`.

**One thing you need to do after deploying:** the sitemap/robots
functions build absolute URLs from the request's own host, so they work
on any domain automatically — nothing to configure there. But do
resubmit `https://yourdomain/sitemap.xml` in Google Search Console
(and Bing Webmaster Tools) once it's live, so it actually gets crawled
instead of waiting to be discovered organically.

## How accounts work
- `js/auth.js` handles sign up, log in, log out, session state, and
  renders the header's login/signup links vs. avatar-and-username menu.
- Sign up calls `supabase.auth.signUp()` with the username tucked into
  `options.data`; a Postgres trigger (`handle_new_user`) reads that and
  creates the matching `profiles` row automatically — so there's no
  race condition between "user exists" and "profile exists."
- Every post/reply insert sets `author_id` to `auth.uid()`; RLS enforces
  that you can only ever insert/edit rows under your own id.
- Elements marked `data-requires-auth` / `data-requires-anon` in the
  HTML are shown/hidden automatically based on session state (see
  `refreshPostGates()` in `js/auth.js`) — that's how the post form vs.
  "log in to post" gate is toggled.

## Moderation — read this before going public
Every post/reply is now tied to a real account, which helps, but you
are still legally the operator of a place where a stranger could try
to post something illegal (most importantly CSAM). A few things this
build already sets up for you, and what's still on you:

**Already in place:**
- Posting requires an account — no drive-by anonymous uploads.
- A "Report" link on every post/reply that writes to a `reports` table
  only your service_role key can read (moderation queue), tagged with
  the reporting user's id.
- File type + size limits enforced at the Supabase Storage level (not
  just in JS, so it can't be bypassed by hitting the API directly).
- RLS means the anon/authenticated key can never edit or delete other
  people's posts, profiles, or files, and reports are write-only.

**Still on you before running this for real users:**
- Check reports regularly (Table Editor → `reports`, or build yourself
  a small admin page using your service_role key on a server you
  control — never ship the service_role key to the browser).
- Know your legal reporting obligations for CSAM in your jurisdiction
  (in the US this means reporting to NCMEC) and have a takedown process.
- Add basic abuse protection Supabase doesn't give you for free by
  default: something like Cloudflare Turnstile on the sign-up form,
  and/or a Supabase Edge Function that rate-limits posts/signups per
  IP before they hit the database.
- Consider scanning uploads (e.g. via an Edge Function calling a hash-
  matching service like PhotoDNA/CSAI Match) before files go public,
  especially at any real scale.
- Decide on a real username-squatting / impersonation policy — the
  suspend/ban flow below covers enforcement once you've decided.

## Admin panel
Run `supabase/admin_panel_advanced.sql`, then `supabase/suspend_deletes_content.sql`,
in the SQL Editor (both additive/idempotent like the others) to enable
`/admin` — a real moderation console, not just the original
verify/ban/delete-post page:
- **Users** — verify/unverify, and Twitter-style **Suspend**: pick a
  reason and a duration (1/3/7/30 days, or Permanent) and the account
  is signed out immediately, blocked from posting, replying, or
  writing Articles until it's unsuspended, and every post/reply of
  theirs is auto-removed (see `suspend_deletes_content.sql`) — a
  suspended profile shows an "Account suspended" notice instead of
  their timeline to every visitor, other posts that quote one of
  theirs now show "This post is from a suspended account" instead of
  the content, and their username is never freed up for anyone else
  to register. A timed suspension lifts
  itself automatically — `clear_expired_suspension()` runs the moment
  that account next loads the site (see `js/auth.js`), backed up by a
  best-effort `pg_cron` sweep every 5 minutes so the admin panel's
  suspended list doesn't go stale even if they never come back.
  **Unsuspend** reverses it immediately either way, restoring exactly
  the posts/replies the suspension itself took down (anything the
  user or a mod had already deleted beforehand stays deleted).
- **Posts / Replies / Articles** — each has its own tab: recent feed
  by default, search by body/title text or `@username`, and a Delete
  button (soft delete, same `is_deleted` mechanism the site already
  uses everywhere else).
- **Reports** — the `reports` table `reports.sql` deliberately made
  write-only from the browser (see above) is now readable *only*
  through admin-gated, `SECURITY DEFINER` RPCs — no service_role key
  ever goes near the browser. Filter by Open/Actioned/Dismissed/All,
  jump straight to Suspend on the reported account (or the post/reply
  author, if the report was against content rather than a person
  directly), and mark a report Actioned or Dismissed once you've
  handled it.
- A stats bar (users, suspended count, posts, articles, open reports)
  sits above the tabs for an at-a-glance read on the site.
- Any account can be made an admin from the DB side — no more
  hardcoding a single username:
  ```sql
  update public.profiles set is_admin = true where lower(username) = 'someusername';
  ```
  `is_admin()` still falls back to the original @marpe-only rule too,
  so nothing breaks if you run this before flipping that flag on
  anyone.

## Quotes & reposts
Run `supabase/quotes_and_reposts.sql` in the SQL Editor after `schema.sql`
(and `settings.sql`, if you're using it) — it's additive/idempotent like
the others, so it's safe to run again later too. It adds:
- **Quote posts** — a quote is just a normal `posts` row with `quote_of`
  set to the post being quoted, so it rides along in every existing
  feed/profile/search query for free.
- **Reposts** — a separate `reposts` table (one row per user/post,
  toggleable) rather than a new `posts` row, so it doesn't clutter reply
  counts. Liking, unliking (tap the heart again), and reposting/undoing
  a repost all work the same way: insert or delete your own row, RLS
  enforces it can only ever be your own.
- **View cascading** — a view on a quote post counts as a view of the
  post it's quoting too (and on up the chain if that post is itself a
  quote), the same way a quote-retweet's impressions roll up to the
  original tweet on Twitter. Likes/replies/reposts never cascade this
  way — only views.
- **"[Name] reposted" banners** — a repost shows up in the reposting
  user's own profile timeline (sorted by repost time, not the original
  post's time) and in the timeline of anyone who follows them, each
  tagged with a small banner above the card: "You reposted" on your own
  profile, "[Display name] reposted" everywhere else. See
  `repostBannerHtml()` in `js/common.js`.

## Mentions, hashtags & links
Post and reply bodies are rendered Twitter-style — no schema change
needed for the text itself, since `renderBody()`/`linkifyText()` in
`js/common.js` turn plain text into rich text on the fly, after
escaping (so a post can never inject HTML this way):
- **`@username`** becomes a link to that user's profile.
- **`#hashtag`** becomes a link to `search.html?q=%23hashtag`, which
  runs through the existing posts search (an `ILIKE` on `body`), so
  it needs no separate hashtags table.
- **`https://…` / `http://…`** becomes a clickable link that opens in
  a new tab.

Run `supabase/mentions.sql` in the SQL Editor after `schema.sql` and
`settings.sql` (additive/idempotent like the others) to wire up the
notification side: tagging someone with `@their_username` in a post
or reply drops a "mentioned you" row in their Notifications page,
same mechanism as likes/replies/follows — a security-definer trigger
on insert, gated by a `notify_mentions` toggle in `settings.html`
(on by default), never something the client inserts directly.

## Articles
Run `supabase/articles.sql` in the SQL Editor after `schema.sql`
(additive/idempotent like the others) to enable long-form Articles —
now the sidebar's second primary nav item (Lists moved into the
"···" **More** menu to make room; see "Lists" below):
- **`articles`** — one row per Article (title, body, optional
  `cover_url`, denormalized-free — no member/follower counts, since
  an Article has exactly one author and nothing to curate). A soft
  delete (`is_deleted = true`), same mechanism `posts` already uses.
- **Any logged-in account can write one** — unlike Lists there's no
  owner/curator split to configure; the RLS insert policy just
  requires `author_id = auth.uid()`. Only the author can edit or
  delete their own Article.
- **`/articles`** — "All Articles" (everyone's, readable even
  logged out) and "Your Articles" tabs, a search box (title/body
  `ILIKE`, backed by the same `pg_trgm` approach `posts.body`
  already uses), and a "+ Write" button that opens `editarticle.html`.
- **`/i/articles/<id>`** (`article.html`) — the single-Article page:
  cover image (if set), title, author byline with avatar, full body,
  and Edit/Delete buttons shown only to the author.
- **`editarticle.html`** / **`editarticle.html?id=<uuid>`** — one
  form doubles as create and edit, same `?id=` pattern the
  create/edit-List modal uses; editing someone else's Article
  redirects away (RLS is the real backstop either way).
- Indexed for SEO the same way profiles/posts/communities/Lists are —
  see `api/prerender.js`'s `renderArticle()` and `api/sitemap.js`.

## Lists
Run `supabase/lists.sql` in the SQL Editor after `schema.sql` (additive/
idempotent like the others) to enable Twitter-style Lists — curated,
owner-only-editable groups of people:
- **`lists`** — one row per List (name, optional description, Private
  toggle, a denormalized `member_count`). Only the owner can rename,
  delete, or change Privacy.
- **`list_members`** — a join table; being added to someone's List
  never needs the member's consent, same as real Twitter Lists — only
  the owner can add or remove who's on it.
- **Privacy** — a public List (and its membership) is visible to
  anyone; a private List is visible only to its owner, enforced by
  RLS, not just hidden in the UI.
- **Create/add UI** — the "+ Create" button on `/lists`, and the
  "Add/remove from Lists" popup on every profile's "···" menu (which
  can also create a brand-new List on the fly and add that profile to
  it in one step) — see the Lists module in `js/common.js`.
- A List's own page (`/i/lists/<id>`) has a **Posts** tab (a merged
  timeline of everyone on the List, newest first) and a **Members**
  tab (with a Remove button for the owner).

Run `supabase/list_followers.sql` after `lists.sql` to add
Twitter-style List *following*, on top of the above — a separate
concept from being a List's member:
- **`list_followers`** — a join table; anyone can follow (or unfollow)
  a **public** List to pin it into their own `/lists` "Your Lists"
  section, the same way following a List works on Twitter. This never
  makes them a `list_members` row — they're not added as a content
  source, they're just subscribed to see it. A denormalized
  `lists.follower_count` tracks the total, kept in sync by a trigger.
- **`/lists`** now opens with a **Discover new Lists** section — public
  Lists the current account doesn't already own or follow, each with a
  circular Follow button and a small avatar-stack preview of a few of
  its existing followers ("12 followers including @user") — plus a
  "Search Lists" box that filters both Discover and whichever tab is
  open. The **Your Lists** tab is now owned-Lists ∪ followed-Lists,
  merged by most-recent activity; a followed (not owned) row shows a
  small "Following" pill to unfollow right from the row. **Lists
  you're on** is unchanged (`list_members`-based).
- A List's own page (`/i/lists/<id>`) gains a **Follow/Following**
  pill in its header (shown to any logged-in non-owner on a public
  List) and a third **Followers** tab alongside Posts/Members. Both
  the Members and Followers tabs show each person's own personal
  Follow button too (follow that person, not the List), reusing the
  same row shape as `/`<username>`/followers` — see
  `listPersonRowHtml()` in `js/list.js`.

## Post detail page
`thread.html` (tapping into a post) uses its own larger layout —
`.op-detail` in `css/style.css`, built by `loadThread()` in
`js/thread.js` — separate from the compact card `postCardHtml()`
uses everywhere else (feed, profile, search, trending): bigger body
text, a "9:00 PM · Aug 8, 2026 · 64.5k Views" meta line instead of an
inline timestamp, a full-width reply/repost/like/bookmark/share row,
and a "View quotes ›" link (hidden unless the post has at least one)
that expands an inline list of the posts quoting it. Run
`supabase/bookmark_count.sql` after `schema.sql` to get the bookmark
count that row shows — bookmarks themselves stay exactly as private
as before (see "NOTIFICATIONS" section of `schema.sql`); this only
adds a plain aggregate counter, the same way `like_count`/
`reply_count`/`repost_count` already work.

## Editing your own posts & comments
Run `supabase/edit_own_post.sql` in the SQL Editor after `schema.sql`
(additive/idempotent like the others) to let people fix a typo in
their own post or reply shortly after posting it:
- A post or comment can be edited by its author for **15 minutes**
  after it's posted — after that the Edit option disappears from its
  "···" menu. Unlike Delete, Edit is author-only: a community creator
  can still remove someone else's post in their own space, but can't
  rewrite it.
- The 15-minute window is enforced **in the database**, inside the
  `edit_own_post`/`edit_own_reply` SECURITY DEFINER functions this
  file adds — the same pattern `delete_own_post`/`delete_own_reply`
  already use, since this app's client talks to Supabase with the
  public anon key and a client-only check can always be skipped by
  calling the RPC directly. The client-side copy of the same check
  (`withinEditWindow()` in `js/common.js`) exists only to give an
  instant "the edit window has passed" message instead of a round
  trip that fails.
- Adds an `updated_at` column to `posts` and `replies`. Once a post or
  comment has been edited, every place it's rendered (feed, thread,
  profile, search, lightbox) shows a small "· Edited" tag next to its
  timestamp — see `editedSuffix()` in `js/common.js`.

## Customizing
- SEO/indexing: `api/sitemap.js`, `api/robots.js`, `api/prerender.js`
  (bot-only server render), plus `setCanonical()`/`setPageImage()`/
  `setJsonLd()` in `js/common.js` — see "SEO / indexing" above. If you
  ever rotate/move Supabase projects, the URL + anon key are duplicated
  in `js/supabase-config.js` **and** the two `api/*.js` files (a plain
  static-site file can't `import` another one at request time) — update
  all three.
- Colors/fonts/layout: `css/style.css`
- Feed/thread/like/report/bookmark/delete logic: `js/board.js`, `js/thread.js`, `js/common.js`.
  Deleting is a soft delete (`posts.is_deleted = true`, same mechanism
  replies already use) — the existing "users can edit own posts" RLS
  policy already covers it, no schema change needed. A "Delete" option
  appears in a post's "···" menu only for its own author.
- Auth/profile logic: `js/auth.js`, `js/profile.js`
- Search: `js/search.js` (ILIKE against `posts.body` / `profiles.username`,`display_name`;
  backed by the `pg_trgm` indexes added in `supabase/schema.sql`)
- Notifications: `js/notifications.js` — rows are only ever created by
  security-definer triggers on `likes`/`replies`/`follows`/`posts` (for
  mentions) inserts (see schema.sql / settings.sql / mentions.sql), never
  inserted directly by the client, and only when the recipient's
  `user_settings` toggle for that type is on
- Mentions/hashtags/links: `linkifyText()` in `js/common.js` (rendering)
  and `supabase/mentions.sql` (the "mentioned you" notification)
- Articles: `js/articles.js` (browse), `js/article.js` (single view),
  `js/editarticle.js` (write/edit), `supabase/articles.sql` (schema/RLS)
- Post detail page: `.op-detail` in `css/style.css`, `loadThread()` in
  `js/thread.js`, and `supabase/bookmark_count.sql` (the bookmark count
  it shows)
- Chat: `js/chat.js` — flat `messages` table, RLS-scoped to sender/recipient,
  realtime subscription per open thread; who's allowed to start a thread
  with you is controlled by `user_settings.dm_privacy`. Messages can carry
  an image, video, or recorded voice note (`messages.media_url`/`media_type`)
  alongside or instead of text — media is uploaded through the same
  `uploadMedia()` helper and public `media` bucket that posts use, and is
  **not** end-to-end encrypted (only the text caption is, via the existing
  per-pair ECDH scheme in `js/chat-crypto.js`). Voice notes are recorded
  client-side with `MediaRecorder` and rendered with a small custom player
  (`voicePlayerHtml()` in `js/chat.js`); images/video reuse the feed's
  lightbox and `ttv` player. Full DB setup — media, sharing a post into a
  chat (`messages.shared_post_id`), and group/channel messaging
  (`conversations` / `conversation_members`, `messages.conversation_id`) —
  is one script: `supabase/chat_full_setup.sql`. Group/channel messages are
  plain text server-side (not E2E — pairwise ECDH doesn't extend to a
  group); frontend for sharing/groups/channels isn't built yet, schema only.
- Settings: `js/settings.js` — email/password changes via `sb.auth.updateUser()`,
  plus notification toggles and DM privacy, both read/written against
  `user_settings` (see `supabase/settings.sql`)
- Edit profile: `js/editprofile.js` — its own page, separate from
  `profile.js`; banner/avatar upload + display name/bio, all against
  the current session's own row
- Followers/following: `js/followlist.js` — its own page, separate from
  `profile.js`; reads `follows` joined to `profiles`
- Max file size / allowed types: change in **both** `js/supabase-config.js`
  (client-side check, instant feedback) **and** `supabase/schema.sql`'s
  storage bucket insert (server-side enforcement — this is the one that
  actually matters).
