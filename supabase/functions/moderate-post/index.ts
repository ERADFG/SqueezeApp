// supabase/functions/moderate-post/index.ts
//
// Handles two distinct call shapes from the frontend:
//
// 1. multipart/form-data  (from uploadSelectedMedia in interactink.html)
//    -> fields: file, boardId
//    -> stages the file in the private `post-media-quarantine` bucket, scans it,
//       and on approval copies it into the public `post-media` bucket.
//    -> responds { allowed, url, type, path } or { allowed:false, reason }
//
// 2. application/json  (from runModerationCheck's supabaseClient.functions.invoke)
//    -> body: { text, mediaUrl, mediaType, mediaStoragePath }
//    -> final pre-insert check once media already has a public URL.
//    -> responds { allowed, status, reason }
//
// Deploy with verify_jwt disabled — anonymous posters have no Supabase
// session, so a JWT requirement would reject every request before it
// reaches this code:
//   supabase functions deploy moderate-post --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SIGHTENGINE_API_USER = Deno.env.get("SIGHTENGINE_API_USER");
const SIGHTENGINE_API_SECRET = Deno.env.get("SIGHTENGINE_API_SECRET");

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB
const ALLOWED_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime",
]);

// Which table a pending upload belongs to, keyed by the `kind` field the
// client sends. Used so review-media's approve step knows which row to
// write the published media_url back onto.
const TARGET_TABLE_BY_KIND: Record<string, string> = {
  thread: "threads",
  comment: "comments",
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Admin client — bypasses RLS. This function is the only thing allowed to
// write to storage/tables directly; that's the whole point of routing
// uploads through it instead of letting the anon client touch storage.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const contentType = req.headers.get("content-type") || "";

  try {
    if (contentType.includes("multipart/form-data")) {
      return await handleFileUpload(req);
    }
    if (contentType.includes("application/json")) {
      return await handleFinalCheck(req);
    }
    return json({ allowed: false, error: "Unsupported content type" }, 400);
  } catch (e) {
    console.error("moderate-post error:", e);
    return json({ allowed: false, status: "blocked", reason: "Moderation service error" }, 500);
  }
});

// ---------------------------------------------------------------------
// Path 1: raw file upload — stage, scan, promote or reject
// ---------------------------------------------------------------------
async function handleFileUpload(req: Request): Promise<Response> {
  const form = await req.formData();
  const file = form.get("file");
  const boardId = String(form.get("boardId") || "misc");
  // Identifies the thread/comment row this upload belongs to, so approval
  // later knows where to attach the published media_url. Optional for
  // backward compatibility, but without it an approved file has nothing
  // to attach to and will silently stay invisible on the site.
  const postId = String(form.get("postId") || "").trim() || null;
  const kind = String(form.get("kind") || "").trim();
  const targetTable = TARGET_TABLE_BY_KIND[kind] ?? null;

  if (!(file instanceof File)) {
    return json({ allowed: false, error: "No file provided" }, 400);
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return json({ allowed: false, reason: "Unsupported file type" }, 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return json({ allowed: false, reason: "File too large (25MB limit)" }, 400);
  }

  const ext = (file.name.split(".").pop() || "bin").toLowerCase();
  const quarantinePath = `${boardId}/${crypto.randomUUID()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  // 1. Stage privately — nothing public can see this yet.
  const { error: uploadErr } = await admin.storage
    .from("post-media-quarantine")
    .upload(quarantinePath, bytes, { contentType: file.type });
  if (uploadErr) {
    console.error("Quarantine upload failed:", uploadErr);
    return json({ allowed: false, reason: "Could not stage file" }, 500);
  }

  // 2. Get a short-lived signed URL so scanning services can fetch it
  //    without the bucket ever being public.
  const { data: signed, error: signErr } = await admin.storage
    .from("post-media-quarantine")
    .createSignedUrl(quarantinePath, 300); // 5 minutes
  if (signErr || !signed) {
    await admin.storage.from("post-media-quarantine").remove([quarantinePath]);
    return json({ allowed: false, reason: "Could not prepare file for scanning" }, 500);
  }

  // No automated CSAM detector is connected yet (Thorn Safer / Microsoft
  // PhotoDNA access pending), so nothing gets auto-published. Instead:
  // run the general NSFW/violence pre-filter to reject obviously
  // disallowed content outright, and send everything that passes to a
  // human-review queue rather than the public bucket. Nothing reaches
  // `post-media` without a moderator explicitly approving it.
  const isVideo = file.type.startsWith("video/");
  const prefilter = await runPrefilterOnly(signed.signedUrl, isVideo);
  if (!prefilter.allowed) {
    await admin.storage.from("post-media-quarantine").remove([quarantinePath]);
    return json({ allowed: false, reason: prefilter.reason }, 200);
  }

  const { error: insertErr } = await admin.from("pending_media").insert({
    storage_path: quarantinePath,
    board_id: boardId,
    media_type: isVideo ? "video" : "image",
    status: "pending",
    target_table: targetTable,
    target_id: postId,
  });
  if (insertErr) {
    console.error("pending_media insert failed:", insertErr);
    await admin.storage.from("post-media-quarantine").remove([quarantinePath]);
    return json({ allowed: false, reason: "Could not queue file for review" }, 500);
  }

  return json({
    allowed: true,
    pending: true,
    reason: "Submitted for review — this may take a little while before it's visible to others.",
  });
}

// ---------------------------------------------------------------------
// Path 2: final pre-insert check (text + already-hosted media reference)
// ---------------------------------------------------------------------
async function handleFinalCheck(req: Request): Promise<Response> {
  const body = await req.json();
  const text = String(body.text || "");

  if (!text.trim()) {
    return json({ allowed: true, status: "approved" });
  }

  // 1. Format-based checks: doxxing (phone numbers, street addresses) and
  //    spam. These are pattern-matching, not semantic — cheap, fast, and
  //    don't need an external call.
  const doxx = detectDoxxing(text);
  if (doxx) {
    return json({ allowed: false, status: "blocked", reason: "Post appears to contain personal contact information and was blocked." });
  }
  if (looksLikeSpam(text)) {
    return json({ allowed: true, status: "flagged", reason: "Flagged as possible spam" });
  }

  // 2. Semantic checks: hate speech, harassment, threats, self-harm content,
  //    and sexual content involving minors. This needs real language
  //    understanding, not keyword matching, so it's routed to OpenAI's
  //    moderation model rather than a hand-maintained word list (which is
  //    both weak against phrasing variation and, for the CSAM-adjacent
  //    category specifically, not something that should be reimplemented
  //    as a static term list).
  const modResult = await runTextModeration(text);
  return json(modResult);
}

/**
 * OpenAI's free moderation endpoint. Categories relevant here:
 * hate, harassment, threatening, self-harm, sexual, sexual/minors, violence.
 * Docs: https://platform.openai.com/docs/guides/moderation
 */
async function runTextModeration(text: string): Promise<{ allowed: boolean; status: string; reason?: string }> {
  const apiKey = Deno.env.get("OPENAI_API_KEY");
  if (!apiKey) {
    // Fail closed, same philosophy as the image pipeline: no configured
    // scanner means text isn't waved through unchecked.
    console.error("Text moderation skipped: OPENAI_API_KEY is not set.");
    return { allowed: false, status: "blocked", reason: "Text moderation is not yet configured" };
  }

  // One retry with a short timeout — covers transient network blips /
  // OpenAI hiccups without leaving the request hanging. A real failure
  // (bad key, quota, etc.) will fail the same way on both attempts, and
  // the logged status/error tells you which.
  let lastErr: unknown = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 8000);
      let res: Response;
      try {
        res = await fetch("https://api.openai.com/v1/moderations", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${apiKey}`,
          },
          body: JSON.stringify({ model: "omni-moderation-latest", input: text }),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeout);
      }

      if (!res.ok) {
        const bodyText = await res.text().catch(() => "");
        throw new Error(`Moderation API returned ${res.status} ${res.statusText}: ${bodyText.slice(0, 300)}`);
      }
      const data = await res.json();
      const result = data?.results?.[0];
      if (!result) throw new Error("Unexpected moderation response shape");

      // Sexual content involving minors is always a hard block, regardless
      // of the model's confidence threshold for other categories.
      if (result.categories?.["sexual/minors"]) {
        return { allowed: false, status: "blocked", reason: "This post was blocked." };
      }
      if (result.categories?.["self-harm/intent"] || result.categories?.["self-harm/instructions"]) {
        return { allowed: false, status: "blocked", reason: "This post was blocked. If you're struggling, please reach out to a crisis line or someone you trust." };
      }
      if (result.flagged) {
        const hardBlockCategories = [
          "hate", "hate/threatening",
          "harassment", "harassment/threatening",
          "violence/graphic",
        ];
        const isHardBlock = hardBlockCategories.some((c) => result.categories?.[c]);
        if (isHardBlock) {
          return { allowed: false, status: "blocked", reason: "This post violates our content guidelines." };
        }
        // Only genuinely borderline categories left (e.g. mild general
        // "violence" discussion, non-graphic) go live flagged for review.
        return { allowed: true, status: "flagged", reason: "Flagged for review" };
      }
      return { allowed: true, status: "approved" };
    } catch (e) {
      lastErr = e;
      const isAbort = e instanceof Error && e.name === "AbortError";
      console.error(`Text moderation call failed (attempt ${attempt + 1}/2)${isAbort ? " [timeout]" : ""}:`, e);
      // Only retry on network/timeout-shaped failures, not on a clean
      // HTTP error response (auth/quota issues won't fix themselves on
      // a second try within the same second).
      if (attempt === 0 && !(e instanceof Error && e.message.startsWith("Moderation API returned"))) {
        continue;
      }
      break;
    }
  }

  console.error("Text moderation failed after retry, blocking post. Root cause:", lastErr);
  // Fail closed — same reasoning as the image pipeline.
  return { allowed: false, status: "blocked", reason: "Moderation service temporarily unavailable, please try again shortly." };
}

/**
 * Flags US-style phone numbers and street-address-shaped text. Not
 * exhaustive (doxxing can take many forms — usernames, workplaces,
 * indirect identifiers) but catches the most common, unambiguous cases
 * without false-positiving on ordinary numbers in posts.
 */
function detectDoxxing(text: string): boolean {
  const phonePattern = /(\+?\d{1,2}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/;
  const streetAddressPattern = /\b\d{1,5}\s+([A-Za-z]+\s){1,4}(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl)\b/i;
  return phonePattern.test(text) || streetAddressPattern.test(text);
}

function looksLikeSpam(text: string): boolean {
  const lower = text.toLowerCase();
  const spamPatterns = [/https?:\/\/\S+\.\S+.*https?:\/\/\S+\.\S+/, /\b(buy now|click here|free money)\b/];
  return spamPatterns.some((p) => p.test(lower));
}

// ---------------------------------------------------------------------
// Scanning helpers
// ---------------------------------------------------------------------
/**
 * Runs ONLY the general NSFW/violence pre-filter (Sightengine) — this is
 * not a substitute for CSAM detection, just a first pass that keeps
 * obviously extreme content out of the human-review queue entirely.
 * Everything that passes still needs a moderator's manual approval before
 * it becomes publicly visible (see handleFileUpload).
 */
async function runPrefilterOnly(url: string, isVideo: boolean): Promise<{ allowed: boolean; reason?: string }> {
  if (isVideo) {
    // No video pre-filter wired up yet — goes straight to the review
    // queue for a human to check manually.
    return { allowed: true };
  }
  if (!SIGHTENGINE_API_USER || !SIGHTENGINE_API_SECRET) {
    return { allowed: true }; // pre-filter optional; human review is the real gate
  }

  const params = new URLSearchParams({
    url,
    models: "nudity-2.1,offensive,gore,violence",
    api_user: SIGHTENGINE_API_USER,
    api_secret: SIGHTENGINE_API_SECRET,
  });

  try {
    const res = await fetch(`https://api.sightengine.com/1.0/check.json?${params}`);
    const data = await res.json();
    const nudityScore = data?.nudity?.sexual_activity ?? data?.nudity?.raw ?? 0;
    const goreScore = data?.gore?.prob ?? 0;
    if (nudityScore > 0.6 || goreScore > 0.6) {
      return { allowed: false, reason: "Image failed automatic content review" };
    }
    return { allowed: true };
  } catch (e) {
    console.error("Sightengine pre-filter failed:", e);
    return { allowed: true }; // pre-filter is best-effort; human review is the real gate
  }
}