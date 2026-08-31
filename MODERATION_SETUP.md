# InteractInk — Free Moderation & Safety Additions

Everything here is free and built to slot into your existing structure —
Vercel API routes next to `verify-captcha.js`/`ip.js`, Supabase SQL next to
`ip_ban.sql`, following the same SECURITY DEFINER + RLS pattern you already
use so no service-role key ever reaches the browser.

## What's new

```
api/moderate-text.js          - text moderation: doxxing, spam, profanity, toxicity, drug/weapon-sale + sexual-solicitation language
api/moderate-media.js         - NEW: server-side enforcement for images/video/avatars — the real security boundary
api/check-password.js         - free breached-password check (HaveIBeenPwned)
nsfw-service/                 - self-hosted, open-source: NSFW + weapon/drug categories, images/video/text
supabase/moderation_pipeline.sql - logs, disposable-email blocking, login lockout
supabase/moderation_media_pipeline.sql - NEW: media moderation columns, RESTRICTIVE RLS enforcement, CSAM audit log, admin queue RPCs
supabase/moderation_audio_pipeline.sql - NEW: audio-transcript moderation columns (audio_toxicity, transcript_excerpt) on moderation_events
supabase/load_disposable_domains.sql - one-paste SQL to load the domain list (no Node needed)
js/moderation.js              - client helpers, same style as verifyHuman()
js/common.js                  - client-side moderation layer + server-side gate wiring (see below)
js/auth.js                    - uploadAvatar() now moderation-gated (covers avatars/banners/community/list/chat-group images)
js/admin.js, admin.html       - NEW: Moderation queue tab, separate from user-submitted Reports
CSAM_SETUP.md                 - NEW: how to actually get CSAM hash-matching access (this needs YOU to apply, not just code)
data/badwords.txt             - free open-source profanity wordlist (LDNOOBW)
data/disposable-email-domains.txt - free open-source list, 8,300+ throwaway domains
scripts/load-disposable-domains.mjs - alternative Node loader (use the .sql file instead if you'd rather not run Node)
```

## Client-side layer (new — runs with zero setup, no server required)

`js/common.js` now also runs moderation **in the browser**, entirely on-device,
using open-source models loaded from jsDelivr at request time (nothing to
install, no build step, no card, no account):

| Check | Library (license) | What it does |
|---|---|---|
| Image NSFW | [nsfwjs](https://github.com/infinitered/nsfwjs) (MIT) on [TensorFlow.js](https://www.tensorflow.org/js) (Apache-2.0) | Classifies every image upload (Drawing/Hentai/Neutral/Porn/Sexy) before it leaves the device. Wired into `uploadMedia()` — a block-level result stops the upload with a friendly error. |
| Video NSFW | same model, sampled frames | Draws a frame to `<canvas>` every ~2s (capped at 15 samples, stops early on a clear hit) and classifies each one — genuinely frame-by-frame, not just the thumbnail. |
| Text toxicity | [transformers.js](https://github.com/xenova/transformers.js) (Apache-2.0) running `Xenova/toxic-bert` — a quantized port of the same `unitary/toxic-bert` model the server already uses | Gives an instant local toxicity read while typing/submitting, before the server round trip. |
| Doxxing/PII | plain regex, same patterns as `api/moderate-text.js` | Instant, no model needed. |

**Read this before you rely on it:** this client-side layer is a *first pass*,
not a security boundary. Anyone can open devtools, disable the page's JS, or
call the Supabase storage API directly, and every check here is skipped —
it never runs. That's fine for what it's for (catching normal users
uploading normal mistakes, and giving instant feedback instead of a wait),
but it is **not** a substitute for server-side moderation on content that
other users will see.

**Update — this gap is now closed.** `api/moderate-media.js` calls
`/classify` (and the new `/categories`) server-side, right after the
client-side pass, before the content is ever visible to anyone but its
author. See "Server-side enforcement" below for how it actually works.

All models load lazily (first use) and are cached by the browser after
that, so this doesn't add meaningful weight to page load — only to the
first image/video/post someone actually submits in a session. Everything
fails open on model-load failure (offline, ad blocker, old browser): a
broken model load never blocks a legitimate post, same philosophy as the
rest of this file.

## Server-side enforcement (new — the actual security boundary)

The client-side layer above is a UX nicety; this is the part that
can't be bypassed by disabling JS or calling supabase-js directly from
devtools.

**How it works:** `posts` and `replies` gained a `moderation_status`
column (`moderation_media_pipeline.sql`). Any insert with media sets
it to `'pending'` explicitly. A **RESTRICTIVE** RLS policy hides
anything that isn't `'visible'` or `'human_review'` from everyone
except the row's own author and admins — restrictive policies AND
with whatever SELECT policy you already have, so this can only narrow
visibility, never widen it. `api/moderate-media.js` is the *only* code
path allowed to flip a row to `'visible'` (it uses the service-role
key), so a user who skips the client entirely still can't make their
own bypassed upload visible to anyone else.

**What it checks, per image/video:**
- NSFW (`Falconsai/nsfw_image_detection`, same as the client-side pass, run again server-side where it can't be skipped)
- Weapons / drugs / illegal goods (`openai/clip-vit-base-patch32`, zero-shot — see `nsfw-service/main.py`'s `IMAGE_CATEGORY_LABELS`, tune these to your community)
- For video only: toxicity + drug/weapon-sale/sexual-solicitation language in the **audio track** (whisper transcription, then the same text classifiers used on post text — see "Audio got the same treatment too" above)
- CSAM hash-match, if you've configured a provider — **see `CSAM_SETUP.md`, this is the one piece that needs you to apply for external access, not just deploy code**

**Text got the same treatment**: `api/moderate-text.js` now also runs
a zero-shot classifier (`facebook/bart-large-mnli`) for drug-sale/
weapon-sale phrasing and sexual solicitation/explicit sexual content,
since a fixed wordlist misses coded/slang language on purpose —
sellers and solicitors rotate slang specifically to dodge keyword
filters, but "someone offering to sell drugs" or "someone soliciting
sexual content" as a category scores consistently regardless of which
slang term they used this week.

**Audio got the same treatment too (new)**: for video uploads,
`nsfw-service/main.py`'s new `/audio-moderate` endpoint extracts the
audio track (ffmpeg), transcribes it (`openai/whisper-base`), then
runs the transcript through the exact same toxicity and
drug/weapon-sale/sexual-solicitation classifiers used on post text
above — reusing the code, not a separate model or a separate policy. `api/moderate-media.js` calls this for every video upload
(skipped for images, which have no audio track) and folds the result
into the same block / human_review / visible decision, and a video
with no audio track at all (silent, music-only) just comes back with
an empty transcript and zero scores rather than erroring. The
transcript is logged (truncated to ~200 chars, same as post excerpts)
so an admin reviewing a `human_review` item can see what was actually
said, and `moderation_events` gained `audio_toxicity` /
`transcript_excerpt` columns for this — run
`supabase/moderation_audio_pipeline.sql` (after the two moderation SQL
files below) to add them. Whisper is heavier than the other models on
CPU — give the box a bit more headroom if video volume is high, and
tune `MAX_AUDIO_SECONDS` (default 600) / `WHISPER_MODEL` (default
`openai/whisper-base`; drop to `openai/whisper-tiny` for speed or up
to `openai/whisper-small` for accuracy) via env vars on the
`nsfw-service` deployment if needed.

**Avatars, banners, community images, list images, chat-group
avatars** all funnel through the single `uploadAvatar()` function in
`js/auth.js`, which now calls the same moderation endpoint before
returning a URL to the caller — a blocked image is deleted from
storage and never gets attached to anything. There's no per-row
`moderation_status` for these (hiding someone's whole profile over
their avatar would be the wrong fix — RLS is row-level, not
column-level), so enforcement here is "reject at upload time" rather
than "hide until reviewed."

**What's still visible to a fast-but-not-fast-enough attacker:** for
the ~1-3 seconds between a `'pending'` insert and `checkMediaModeration()`
flipping it, the row exists but is invisible to everyone but its
author (that's the RESTRICTIVE policy's job) — so there's no window
where bad content is actually shown to other users, only a brief
window where *their own* post looks like it hasn't gone through yet.

**Admin review queue:** anything the pipeline couldn't confidently
decide on its own lands in `admin.html`'s new **Moderation** tab
(separate from the existing user-submitted **Reports** tab) —
Approve makes it visible, Remove blocks it permanently. Backed by
`admin_list_moderation_queue()`/`admin_review_moderation_item()` in
`moderation_media_pipeline.sql`.

## What this does NOT cover — direct messages

`messages` are end-to-end encrypted (`chat_e2e_encryption.sql` /
`chat_server_side_encryption.sql`) — the server only ever sees
ciphertext, by design, and that's not something this pipeline changes
or should change. That means **none of the server-side checks above
run on DM content or DM media** — there's genuinely nothing for the
server to check, since it can't read it. The client-side layer
(`js/common.js`'s in-browser NSFW/toxicity pass) still runs on chat
media the same as it does for posts, with the same "first pass, not a
security boundary" caveat as before — that's the ceiling for DMs
specifically, not a gap in this integration. If that trade-off doesn't
work for your platform, the only way to get further server-side
checking on DMs is to give up E2E encryption for chat, which is a
bigger call than this doc should make for you.

## Setup

1. **Run the SQL, in order.** `supabase/moderation_pipeline.sql`, then
   `supabase/load_disposable_domains.sql`, then
   `supabase/moderation_media_pipeline.sql` (needs `is_admin()` from
   `admin_panel_advanced.sql`, so run that first if you haven't already),
   then `supabase/moderation_audio_pipeline.sql`.

2. **Copy the data files** into `data/` at your project root (same level as
   `api/` and `js/`) — `moderate-text.js` reads `badwords.txt` from there.

3. **Deploy `nsfw-service/`** — a self-hosted server covering NSFW
   image/video detection, text toxicity, weapon/drug/illegal-goods
   categories for both images and text, AND (new) audio-transcript
   moderation for video, using open-source models
   (`Falconsai/nsfw_image_detection`, `unitary/toxic-bert`,
   `openai/clip-vit-base-patch32`, `facebook/bart-large-mnli`,
   `openai/whisper-base`). Still the only external service you need —
   no third-party account, no API key, free forever. The category and
   whisper models are heavier — give the box at least 2GB RAM (more if
   video volume is high; see `MAX_AUDIO_SECONDS`/`WHISPER_MODEL` env
   vars in `nsfw-service/main.py` to tune cost vs. accuracy).

   ~~We originally planned to use Google's Perspective API for toxicity~~
   — **don't.** Google confirmed it's shutting down entirely on
   December 31, 2026 with no migration path, and stopped accepting new
   usage/quota requests back in February 2026. The self-hosted model
   here replaces it with no external dependency at all.

   ```bash
   cd nsfw-service
   docker build -t interactink-moderation .
   docker run -p 8000:8000 -e NSFW_SERVICE_TOKEN=<pick-a-long-random-string> interactink-moderation
   ```
   Free/cheap hosting: Fly.io (free allowance), Railway, Render, or any
   $5-6/mo VPS. Once deployed, add these in Vercel → Settings →
   Environment Variables:
   - `MODERATION_SERVICE_URL` = your deployed server's URL
   - `MODERATION_SERVICE_TOKEN` = the same random string you set above

4. **Wire the client calls** — already done for you in this project's
   `js/common.js` and `js/auth.js`. Otherwise: right after each
   `verifyHuman(...)` call that gates a post/reply, call
   `checkTextModeration(...)`, and after inserting a post/reply row with
   media call `checkMediaModeration(...)` (see the wiring notes at the
   top of that function in `js/common.js`). In `auth.js`'s signup flow,
   call `isDisposableEmail(...)` and `checkPassword(...)` before account
   creation.

5. **CSAM hash-matching needs a separate application — see
   `CSAM_SETUP.md`.** Nothing else in this pipeline depends on it (NSFW,
   drugs/weapons, toxicity, spam all work without it today), but it's a
   real, currently-unfilled gap until you do this step. `CSAM_PROVIDER`
   unset just means that check is silently skipped, logged as a
   warning — not a blocked upload.

5. **Add security headers** (already done in `vercel.json` if you're using
   the updated project). Otherwise add this rule before
   `{ "handle": "filesystem" }`:
   ```json
   { "src": "^/.*$", "headers": {
       "X-Content-Type-Options": "nosniff",
       "X-Frame-Options": "DENY",
       "Referrer-Policy": "strict-origin-when-cross-origin",
       "Permissions-Policy": "geolocation=(), camera=(), microphone=()"
     }, "continue": true }
   ```

6. **EXIF/GPS stripping** (already fixed in `js/common.js`'s
   `compressImageFile()` if you're using the updated project) — phones
   embed GPS coordinates in photos by default, so an uploaded image can
   leak someone's location without them realizing.

## What this adds, layer by layer

| Layer | Catches | Cost |
|---|---|---|
| Local badword list | Casual profanity/slurs, instantly, no API call | Free |
| Doxxing regex | Phone numbers, addresses, emails, SSN/card-like strings posted in content | Free |
| Spam heuristics | Link floods, repeated chars, shouting, common spam phrases | Free |
| Self-hosted toxicity model | Harassment, threats, nuanced toxicity the wordlist misses | Free forever (your own server) |
| Self-hosted NSFW model (client + server) | Explicit images/video | Free forever (your own server) |
| Zero-shot weapon/drug/illegal-goods (image) | Weapons, drugs, drug paraphernalia in posted media | Free forever (your own server) |
| Zero-shot drug/weapon-sale + sexual-solicitation language (text) | Coded/slang sale or solicitation language a wordlist would miss | Free forever (your own server) |
| Audio transcript moderation (video) | Toxicity/harassment, drug/weapon-sale, and sexual-solicitation language spoken in a video, not just shown or captioned | Free forever (your own server) |
| CSAM hash-matching | Known CSAM, via a vetted provider — **needs setup, see CSAM_SETUP.md** | Free (application required) |
| Server-side enforcement (RESTRICTIVE RLS) | The actual "disable JS and post anything" bypass | Free (just SQL + one API route) |
| Admin moderation queue | Anything the pipeline couldn't confidently decide alone | Free (just SQL + admin panel) |
| Disposable email block | Throwaway-address bot signups | Free |
| Pwned Passwords check | Signups using known-breached passwords | Free |
| Login lockout | Brute-force credential attacks | Free (just SQL) |
| EXIF stripping | Accidental location doxxing via photo metadata | Free |
| Security headers | Session hijacking / XSS leading to account takeover | Free |

Combined with what you already have — the homemade captcha, IP ban on
suspension, and post cooldown — this is a genuinely thorough free stack,
covering posts/replies/avatars/community images end-to-end from upload
through server-side enforcement through an admin review queue, with zero
dependency on any service that could shut down or change pricing on you.
The one piece that still needs your action rather than just code shipping
is CSAM hash-matching (`CSAM_SETUP.md`) — and DMs stay outside all of this
by design, since they're end-to-end encrypted (see above).
