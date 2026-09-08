# CSAM hash-matching — setup

## Why this is a separate document from everything else in MODERATION_SETUP.md

Every other check in this pipeline (NSFW, toxicity, drug/weapon-sale
language) is a classifier you can run yourself, because being wrong
about those categories is a moderation mistake, not a legal one.

CSAM is different. There is no self-hosted, open-source, "just run
this model" option, and there shouldn't be — a classifier for this
would need to be trained on the material itself, and possessing that
material to train on is a federal crime for anyone outside a small
number of specifically authorized organizations (NCMEC and its
approved partners). This code deliberately does not attempt it.

The actual, legally-correct approach every major platform uses is
**hash-matching**: a vetted provider keeps a database of cryptographic/
perceptual hashes of *known* material (never the material itself), and
you send them a hash of the image you're checking. They tell you match
or no-match. Nothing about the image content ever needs to be exposed
or reviewed by anyone at your end for this to work.

## Providers (pick one)

All three are free for qualifying platforms — this isn't a spend
decision, it's a paperwork one.

- **Thorn Safer** (https://safer.io) — probably the easiest on-ramp for
  a smaller/indie platform; built specifically for this use case,
  handles both hash-matching and (if you want it) an ML-assisted
  review flow on top.
- **Google CSAI Match** — part of Google's Content Safety API,
  reachable via a partner application.
- **Microsoft PhotoDNA Cloud Service** — the oldest and most widely
  deployed of the three; application is through Microsoft/NCMEC.

All three require an application/vetting process before you get
credentials — that's intentional, not a bug you can route around,
since broad access to a "does this hash match known CSAM" oracle is
itself something bad actors would want. Expect to explain what your
platform is, roughly how much media volume it handles, and how you'll
use the result (auto-block + NCMEC report, which is exactly what
`api/moderate-media.js` in this repo already does).

## What to do while you're waiting on approval

Nothing about the rest of this moderation pipeline depends on CSAM
access — NSFW, drugs/weapons, toxicity, and spam detection all work
today, independent of this. `api/moderate-media.js` already checks for
`CSAM_PROVIDER`/`CSAM_API_URL`/`CSAM_API_KEY` and, if they're unset,
logs a warning and skips that check rather than pretending to have
run it. That's a real gap in coverage, not a cosmetic one — treat
getting one of these providers set up as the actual priority here,
not an optional add-on.

## Once you're approved

1. You'll get an API URL and key/credential from whichever provider
   you picked.
2. Set these in Vercel → Settings → Environment Variables:
   - `CSAM_PROVIDER` = `thorn_safer` | `google_csai` | `photodna`
   - `CSAM_API_URL` = the endpoint they give you
   - `CSAM_API_KEY` = your credential
3. Open `api/moderate-media.js`'s `checkCsamHash()` function and
   replace the illustrative `fetch()` call with the exact request
   shape from your provider's integration docs (each of the three has
   a different request/response format — the surrounding decision
   logic in this file doesn't need to change, only that one function
   body).
4. Confirm with your provider how their automatic NCMEC reporting
   works — most of these providers report a confirmed match to NCMEC
   on your behalf automatically once you're registered, which is what
   you want (this is a legal requirement in the US regardless of
   whether the report happens through them or you). Don't build your
   own NCMEC reporting path unless your provider specifically tells
   you it doesn't cover that.
5. Test using your provider's own test/known-safe hash if they supply
   one — never test this with real material, obviously.

## What happens on a match, in this codebase

`api/moderate-media.js` auto-blocks (no human review step — a
confirmed hash match doesn't need one), logs to
`public.csam_hash_matches` for your own audit trail, and — once you've
confirmed your provider's reporting flow per step 4 above — that's
the point where NCMEC gets notified.
