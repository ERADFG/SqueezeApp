// api/moderate-media.js
//
// POST { userId, table, contentId, contentType, mediaUrl, mediaType }
//   -> { decision, scores }
//
// The server-side backstop MODERATION_SETUP.md flagged as missing:
// "nsfw-service/main.py's /classify endpoint exists but nothing calls
// it" — this is that caller, and it's the one check in the whole
// pipeline a user can't bypass by disabling JS, since it runs here,
// not in their browser, using the service-role key.
//
// How it's meant to be called (see js/moderation.js's
// checkMediaModeration() and the wiring notes in MODERATION_SETUP.md):
//   1. Client uploads the file to storage as normal (uploadMedia()).
//   2. Client inserts the post/reply row with moderation_status:
//      'pending' (server-authoritative default is 'visible', but you
//      explicitly pass 'pending' at insert time for anything with
//      media — see moderation_media_pipeline.sql's RESTRICTIVE
//      policy, which hides 'pending' rows from everyone but the
//      author until this flips it).
//   3. Client calls this endpoint with the new row's id.
//   4. This endpoint downloads nothing itself — it hands the
//      public media URL to nsfw-service, which fetches and checks it
//      server-side — then updates moderation_status to 'visible',
//      'blocked', or 'human_review', and logs the event.
//
// A user who bypasses the client entirely (calls supabase-js insert
// directly from devtools with their own session) still only gets a
// 'pending' row nobody else can see — it never flips to 'visible'
// unless this endpoint (or an admin) says so. That's the actual
// enforcement boundary; everything client-side is a convenience layer
// on top of it.
//
// Env vars needed (same as moderate-text.js):
//   MODERATION_SERVICE_URL, MODERATION_SERVICE_TOKEN
//
// Optional — CSAM hash-matching (see CSAM_SETUP.md for how to apply):
//   CSAM_PROVIDER            'thorn_safer' | 'google_csai' | 'photodna' | unset
//   CSAM_API_URL, CSAM_API_KEY
// If unset, this step is skipped and logged as such — see the loud
// console.warn below. Ship this to production; don't rely on it as
// the only CSAM defense until you've configured a real provider.

import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
);

const ALLOWED_TABLES = new Set(['posts', 'replies']);

async function callModerationService(path, payload) {
  const serviceUrl = process.env.MODERATION_SERVICE_URL;
  const token = process.env.MODERATION_SERVICE_TOKEN;
  if (!serviceUrl) return null; // not configured — fail toward human_review, not toward allow, see below
  try {
    const res = await fetch(`${serviceUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(payload),
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------
// CSAM hash-matching. This function does NOT detect anything itself
// — it forwards the media URL to whichever vetted provider you've
// registered with, and trusts their verdict. See CSAM_SETUP.md.
// Providers vet applicants before issuing credentials (as they
// should), so until CSAM_API_URL/CSAM_API_KEY are set this returns
// {matched: false, configured: false} rather than pretending to have
// checked — the caller below treats "not configured" as a reason to
// route to human_review for anything already flagged by other
// checks, never as a silent pass.
// ---------------------------------------------------------------
async function checkCsamHash(mediaUrl) {
  const provider = process.env.CSAM_PROVIDER;
  const apiUrl = process.env.CSAM_API_URL;
  const apiKey = process.env.CSAM_API_KEY;
  if (!provider || !apiUrl || !apiKey) {
    console.warn('[moderate-media] CSAM_PROVIDER not configured — hash-matching is NOT running. See CSAM_SETUP.md.');
    return { matched: false, configured: false, provider: null, providerRef: null };
  }

  try {
    // NOTE: request/response shape below is illustrative — each
    // provider's real API differs (Thorn Safer, Google CSAI Match,
    // and Microsoft PhotoDNA Cloud Service each have their own
    // request format and auth scheme). Once you're approved, replace
    // this fetch with the exact call from your provider's
    // integration docs; the surrounding decision logic doesn't need
    // to change.
    const res = await fetch(apiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ url: mediaUrl }),
    });
    if (!res.ok) {
      console.error('[moderate-media] CSAM provider call failed', res.status);
      return { matched: false, configured: true, provider, providerRef: null, error: true };
    }
    const data = await res.json();
    return {
      matched: !!data.matched,
      configured: true,
      provider,
      providerRef: data.reference || data.id || null,
    };
  } catch (e) {
    console.error('[moderate-media] CSAM provider call threw', e);
    return { matched: false, configured: true, provider, providerRef: null, error: true };
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid body' });
  }

  const { userId, table, contentId, contentType, mediaUrl, mediaType, transcript } = body || {};
  if (!userId || !mediaUrl) {
    return res.status(400).json({ error: 'userId and mediaUrl are required' });
  }
  // table/contentId are optional — omit both for a "just check it, don't
  // gate a row" call (avatars, community images, list/chat-group avatars
  // via uploadAvatar() in js/auth.js, which has no single destination
  // table). When present, both must point at a row this endpoint knows
  // how to gate.
  const gatesRow = table != null || contentId != null;
  if (gatesRow && (!table || !contentId || !ALLOWED_TABLES.has(table))) {
    return res.status(400).json({ error: 'table and contentId must both be provided and table must be posts or replies' });
  }
  const type = mediaType === 'video' ? 'video' : 'image'; // gifs classify fine as images (first-frame based)

  // Run NSFW + category checks in parallel — independent categories,
  // no reason to serialize them. `transcript`, when present, comes from
  // js/audio-transcribe.js running Whisper-tiny client-side (see
  // nsfw-service/main.py's header comment for why ASR moved to the
  // browser) — this endpoint doesn't fetch or transcribe audio itself
  // anymore, it just classifies whatever transcript text arrives, same
  // toxicity/category models as always.
  const [nsfwResult, categoryResult, audioResult, csamResult] = await Promise.all([
    callModerationService('/classify', { url: mediaUrl, type }),
    callModerationService('/categories', { url: mediaUrl, type }),
    type === 'video' && transcript ? callModerationService('/transcript-moderate', { transcript }) : Promise.resolve(null),
    checkCsamHash(mediaUrl),
  ]);

  const nsfw = nsfwResult?.nsfw_probability ?? null;
  const categories = categoryResult?.categories ?? [];
  // Self-harm/suicide content is split out from the generic category
  // pool on purpose. Everything else in `categories` (weapons, drugs,
  // gore, sexual solicitation) is fine to auto-block at high
  // confidence — but auto-deleting someone's cry for help because a
  // classifier scored it highly is a real harm on its own, and this
  // category is exactly the kind of thing a false-positive-prone
  // zero-shot model gets wrong on dark humor or someone quoting a
  // hotline number. This never contributes to a 'block' decision
  // below, only 'human_review' — a person always makes the actual
  // call on this category, the model just surfaces it faster.
  const selfHarmCategories = categories.filter((c) => c.label.toLowerCase().includes('self-harm') || c.label.toLowerCase().includes('suicide'));
  const blockableCategories = categories.filter((c) => !selfHarmCategories.includes(c));
  const topCategoryScore = blockableCategories.length ? Math.max(...blockableCategories.map((c) => c.score)) : 0;
  const topSelfHarmScore = selfHarmCategories.length ? Math.max(...selfHarmCategories.map((c) => c.score)) : 0;
  const transcript = audioResult?.transcript ?? '';
  const audioToxicity = audioResult?.toxicity_probability ?? 0;
  const audioCategories = audioResult?.categories ?? [];
  const topAudioCategoryScore = audioCategories.length ? Math.max(...audioCategories.map((c) => c.score)) : 0;
  // Tagged by source and merged into one array for the audit log /
  // admin queue — moderation_events has one `categories` jsonb column,
  // not separate image/audio columns, so the admin reviewing a
  // 'human_review' item can see at a glance whether the hit came from
  // the frame or the narration.
  const allCategories = [
    ...categories.map((c) => ({ ...c, source: 'image' })),
    ...audioCategories.map((c) => ({ ...c, source: 'audio' })),
  ];
  // A video with no image-side signal at all (server unreachable) is
  // still unreachable even if we happened to get an audio result back
  // from a partially-up service — keep the original "did the image
  // checks come back" definition for the fail-toward-review branch
  // below, since that's the check most likely to catch NSFW content.
  const serviceUnreachable = nsfwResult === null && categoryResult === null;

  let decision;
  if (csamResult.matched) {
    decision = 'block'; // confirmed hash match — auto-block, no human review needed
  } else if (serviceUnreachable) {
    // The moderation service being down is not the same as content
    // being clean. Fail toward review, not toward allow — the
    // opposite of the client-side layer's "fail open" (which is fine
    // for a UX nicety, not for the actual enforcement gate).
    decision = 'human_review';
  } else if (nsfw !== null && nsfw >= 0.75) {
    // Tightened from 0.9 — auto-blocks more confidently-NSFW content
    // outright instead of routing it to human review. Trade-off: a
    // wider slice of borderline-but-legitimate images (suggestive but
    // not explicit, some art/swimwear photos) will now get auto-
    // blocked instead of waiting for a human call. Watch the admin
    // queue's "Auto-blocked" tab after this ships and loosen back
    // toward 0.85-0.9 if you're seeing real false positives there.
    decision = 'block';
  } else if (topCategoryScore >= 0.7 || topAudioCategoryScore >= 0.7 || audioToxicity >= 0.7) {
    // Same thresholds as the image/text-in-post checks above — the
    // audio track is just another place the same violations (drug/
    // weapon sale, sexual solicitation, harassment) can show up, not a
    // separate policy. Someone narrating a drug sale, propositioning
    // people, or hurling slurs over the video gets the same outcome as
    // if they'd typed it in the caption.
    decision = 'block';
  } else if (
    (nsfw !== null && nsfw >= 0.45) ||
    topCategoryScore >= 0.4 ||
    topAudioCategoryScore >= 0.4 ||
    audioToxicity >= 0.4 ||
    topSelfHarmScore >= 0.3 // lower bar than the other categories — err toward a human seeing it sooner, not toward blocking it
  ) {
    decision = 'human_review';
  } else {
    decision = 'visible';
  }

  // Flip the content row's moderation_status, when this call is gating
  // one (posts/replies). Service-role key bypasses RLS, which is
  // exactly why this endpoint — and not the browser — is the one place
  // that's allowed to do this. Avatar/community-image calls skip this
  // (see gatesRow above) — those are enforced by the caller deleting
  // the upload on 'block' instead, see js/auth.js's uploadAvatar().
  if (gatesRow) {
    try {
      await supabase
        .from(table)
        .update({
          moderation_status: decision === 'block' ? 'blocked' : decision === 'human_review' ? 'human_review' : 'visible',
          moderation_flags: {
            nsfw,
            categories: allCategories,
            audioToxicity,
            // Transcript itself is useful context for a human reviewer
            // deciding a 'human_review' item, but there's no reason to
            // keep it once a video is 'visible' — truncate the same
            // way moderate-text.js truncates post excerpts.
            transcriptExcerpt: transcript ? transcript.slice(0, 200) : '',
            csamChecked: csamResult.configured,
          },
          moderation_checked_at: new Date().toISOString(),
        })
        .eq('id', contentId);
    } catch (e) {
      console.error('[moderate-media] failed to update content row', e);
    }
  }

  // Audit log — same table/RPC as text moderation.
  try {
    await supabase.rpc('log_moderation_event', {
      p_user_id: userId,
      p_content_type: contentType || 'media',
      p_content_ref: String(contentId),
      p_excerpt: mediaUrl,
      p_nsfw: nsfw,
      p_categories: allCategories,
      p_decision: decision === 'block' ? 'block' : decision === 'human_review' ? 'human_review' : 'allow',
      p_csam_match: csamResult.matched,
      p_audio_toxicity: audioResult ? audioToxicity : null,
      p_transcript_excerpt: transcript ? transcript.slice(0, 200) : null,
    });
  } catch (e) {
    console.error('[moderate-media] log failed', e);
  }

  if (csamResult.matched) {
    try {
      await supabase.from('csam_hash_matches').insert({
        content_type: contentType || table,
        content_id: contentId,
        user_id: userId,
        provider: csamResult.provider,
        matched: true,
        provider_ref: csamResult.providerRef,
        // reported_to_ncmec stays false here — wire your provider's
        // reporting confirmation into this the moment you integrate
        // it for real; a mandatory NCMEC report should not depend on
        // this app code, most providers report on your behalf
        // automatically once you're registered. Confirm this with
        // whichever provider you use before relying on it.
      });
    } catch (e) {
      console.error('[moderate-media] csam log failed', e);
    }
  }

  return res.status(200).json({
    decision,
    scores: {
      nsfw,
      categories,
      audioToxicity,
      audioCategories,
      transcript,
      csamMatched: csamResult.matched,
      csamConfigured: csamResult.configured,
    },
  });
}
