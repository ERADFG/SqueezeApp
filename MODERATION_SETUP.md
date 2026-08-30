# InteractInk — Free Moderation & Safety Additions

Everything here is free and built to slot into your existing structure —
Vercel API routes next to `verify-captcha.js`/`ip.js`, Supabase SQL next to
`ip_ban.sql`, following the same SECURITY DEFINER + RLS pattern you already
use so no service-role key ever reaches the browser.

## What's new

```
api/moderate-text.js          - text moderation: doxxing, spam, profanity, toxicity
api/check-password.js         - free breached-password check (HaveIBeenPwned)
nsfw-service/                 - self-hosted, open-source: NSFW images/video + text toxicity
supabase/moderation_pipeline.sql - logs, disposable-email blocking, login lockout
supabase/load_disposable_domains.sql - one-paste SQL to load the domain list (no Node needed)
js/moderation.js              - client helpers, same style as verifyHuman()
data/badwords.txt             - free open-source profanity wordlist (LDNOOBW)
data/disposable-email-domains.txt - free open-source list, 8,300+ throwaway domains
scripts/load-disposable-domains.mjs - alternative Node loader (use the .sql file instead if you'd rather not run Node)
```

## Setup

1. **Run the SQL.** Paste `supabase/moderation_pipeline.sql` into the
   Supabase SQL editor after your existing migrations, then paste and run
   `supabase/load_disposable_domains.sql` to load the throwaway-domain list.

2. **Copy the data files** into `data/` at your project root (same level as
   `api/` and `js/`) — `moderate-text.js` reads `badwords.txt` from there.

3. **Deploy `nsfw-service/`** — a self-hosted server covering *both* NSFW
   image/video detection and text toxicity, using open-source models
   (`Falconsai/nsfw_image_detection` and `unitary/toxic-bert`). This is
   the only external service you need — no third-party account, no API
   key, free forever.

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

4. **Wire the client calls** (already done for you in `js/common.js` and
   `js/auth.js` if you're using the files from `InteractInk_updated.zip`).
   Otherwise: right after each `verifyHuman(...)` call that gates a
   post/reply/chat message, call `checkText(...)` from `js/moderation.js`
   and act on the decision. In `auth.js`'s signup flow, call
   `isDisposableEmail(...)` and `checkPassword(...)` before account
   creation.

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
| Self-hosted NSFW model | Explicit images/video | Free forever (your own server) |
| Disposable email block | Throwaway-address bot signups | Free |
| Pwned Passwords check | Signups using known-breached passwords | Free |
| Login lockout | Brute-force credential attacks | Free (just SQL) |
| EXIF stripping | Accidental location doxxing via photo metadata | Free |
| Security headers | Session hijacking / XSS leading to account takeover | Free |

Combined with what you already have — the homemade captcha, IP ban on
suspension, and post cooldown — this is a genuinely solid free stack, and
now has zero dependency on any service that could shut down or change
pricing on you. CSAM reporting is the one piece intentionally left to a
legally-vetted external process (NCMEC/Thorn Safer) rather than any code
here — see the earlier notes on why.
