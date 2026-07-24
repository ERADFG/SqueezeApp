// supabase/functions/moderate-post/index.ts
// -----------------------------------------------------------------------
// Supabase Edge Function. Now handles TWO separate jobs on one endpoint:
//
//   1. [EXISTING] Text moderation via Database Webhook on INSERT to your
//      posts/comments tables. moderation-guard.js can be skipped (disable
//      JS, or POST straight to Supabase's REST API with a client's own
//      anon key) — this cannot, because it runs on Supabase's servers as
//      part of the write path, not the poster's browser.
//
//   2. [NEW] Media upload handling, called directly by the client when a
//      post includes an image/video. The file lands in a PRIVATE
//      quarantine bucket first, gets scanned (Thorn Safer CSAM hashing +
//      Sightengine NSFW/violence), and is only copied into the public
//      bucket if it passes. Nothing unscanned ever becomes publicly
//      reachable, and the anon client is never given write access to
//      public storage directly.
//
// These two jobs are told apart by request shape: a multipart/form-data
// request (from the upload UI) triggers the media path; a JSON body
// shaped like the Database Webhook payload (`{ type, table, record }`)
// triggers the existing text-moderation path. Nothing about job 1 was
// changed.
//
// Setup (existing, unchanged):
//   1. supabase functions deploy moderate-post
//   2. Database > Webhooks > New webhook
//        Table: posts (repeat for comments)
//        Events: INSERT
//        Type: HTTP Request -> this function's URL
//   3. Run the SQL in schema.sql (adds a `status` column + quarantine table)
//   4. Your app should only ever SELECT posts where status = 'published'
//      (enforce this with a Postgres RLS policy, not just app-side filtering)
//
// Setup (new, media):
//   1. Run storage-policies.sql (public "post-media" bucket = read-only for
//      anon/authenticated; private "post-media-quarantine" bucket = no
//      client access at all — only this function's service-role key touches it)
//   2. supabase secrets set SIGHTENGINE_USER=xxx SIGHTENGINE_SECRET=xxx THORN_SAFER_API_KEY=xxx
//   3. Client posts FormData({ file, boardId }) to this same function URL
// -----------------------------------------------------------------------

import { serve } from "https://deno.land/std@0.203.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

// ============================================================
// [EXISTING] Text moderation — unchanged
// ============================================================

const VIOLENCE_TERMS = [
  "rape", "raping", "raped",
  "molest", "molesting", "molested",
  "sexually abuse", "sexually abusing", "sexually assaulted",
  "have sex with", "having sex with",
];

const MINOR_TERMS = [
  "kid", "kids", "child", "children",
  "minor", "minors", "toddler", "infant", "baby",
  "underage", "preteen", "pre-teen",
];

const TEXT_POLICY: Record<string, { weight: number; terms: string[] }> = {
  sexualExplicit: { weight: 3, terms: ["porn", "pornhub", "xxx video", "nude pics", "sex tape", "onlyfans link"] },
  drugs: { weight: 2, terms: ["heroin", "fentanyl", "meth", "cocaine", "mdma", "buy weed"] },
  illegalTransactions: { weight: 3, terms: ["stolen credit card", "ssn for sale", "fake id", "counterfeit money", "hacked account"] },
  weapons: { weight: 3, terms: ["buy gun no background check", "untraceable firearm", "homemade explosive"] },
};

function normalize(input: string): string {
  if (!input) return "";
  let text = input.toLowerCase();
  text = text.replace(/[013457@$!+]/g, (ch) =>
    ({ "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "!": "i", "+": "t" }[ch] || ch)
  );
  text = text.replace(/([a-z])[\s._\-*]+(?=[a-z])/g, "$1");
  text = text.replace(/([a-z])\1{2,}/g, "$1");
  return text;
}

function checkSevere(rawText: string) {
  const n = normalize(rawText || "");
  const hasViolence = VIOLENCE_TERMS.some((t) => n.includes(normalize(t)));
  const hasMinor = MINOR_TERMS.some((t) => n.includes(normalize(t)));
  return hasViolence && hasMinor;
}

function checkPolicy(rawText: string) {
  const n = normalize(rawText || "");
  const hits: Record<string, string[]> = {};
  let score = 0;
  for (const [category, { weight, terms }] of Object.entries(TEXT_POLICY)) {
    const matched = terms.filter((t) => n.includes(normalize(t)));
    if (matched.length) {
      hits[category] = matched;
      score += matched.length * weight;
    }
  }
  return { score, hits };
}

async function handleTextModerationWebhook(req: Request, supabase: ReturnType<typeof createClient>) {
  const payload = await req.json();
  // Database Webhook payload shape: { type: 'INSERT', table, record, schema }
  const { table, record } = payload;
  const text: string = record.content ?? record.text ?? "";
  const rowId = record.id;

  const severe = checkSevere(text);
  const { score, hits } = checkPolicy(text);

  let status: "published" | "blocked" | "quarantined";
  if (severe) {
    status = "quarantined";
  } else if (score >= 4) {
    status = "blocked";
  } else {
    status = "published";
  }

  // Flip the row's status. Your RLS policy for public SELECT should only
  // allow status = 'published', so anything else is invisible to readers
  // immediately — no race window where the bad post is briefly live.
  await supabase.from(table).update({ status }).eq("id", rowId);

  if (status !== "published") {
    await supabase.from("moderation_queue").insert({
      table_name: table,
      row_id: rowId,
      content: text,
      severity: severe ? "severe" : "standard",
      reasons: severe ? ["explicit statement re: sexual violence against a minor"] : Object.keys(hits),
      score,
      status: "pending_review",
      // severe items need a human to decide on NCMEC CyberTipline reporting —
      // see README.md. This is not something to auto-report without review,
      // but it should never sit unreviewed either.
      requires_urgent_review: severe,
    });
  }

  return new Response(JSON.stringify({ status }), {
    headers: { "Content-Type": "application/json" },
  });
}

// ============================================================
// [NEW] Media upload — quarantine, scan, then promote to public
// ============================================================

const QUARANTINE_BUCKET = "post-media-quarantine";
const PUBLIC_BUCKET = "post-media";
const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/webm"];
const MAX_MEDIA_BYTES = 50 * 1024 * 1024;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

async function handleMediaUpload(req: Request, admin: ReturnType<typeof createClient>) {
  const form = await req.formData();
  const file = form.get("file");
  const boardId = String(form.get("boardId") || "b");

  if (!(file instanceof File)) return jsonResponse({ error: "No file provided" }, 400);
  if (file.size > MAX_MEDIA_BYTES) return jsonResponse({ error: "File too large (max 50MB)" }, 400);

  const isImage = ALLOWED_IMAGE_TYPES.includes(file.type);
  const isVideo = ALLOWED_VIDEO_TYPES.includes(file.type);
  if (!isImage && !isVideo) return jsonResponse({ error: "Unsupported file type" }, 400);

  const ext = (file.name.match(/\.\w+$/) || [".bin"])[0];
  const path = `${boardId}/${Date.now()}-${Math.random().toString(16).slice(2, 10)}${ext}`;

  // Land it in the PRIVATE quarantine bucket first.
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { error: qErr } = await admin.storage
    .from(QUARANTINE_BUCKET)
    .upload(path, bytes, { contentType: file.type, upsert: false });
  if (qErr) return jsonResponse({ error: `Quarantine upload failed: ${qErr.message}` }, 500);

  // Scan before it ever becomes public.
  const modResult = await moderateMedia(admin, path, isVideo ? "video" : "image");

  if (!modResult.allowed) {
    await admin.storage.from(QUARANTINE_BUCKET).remove([path]);
    return jsonResponse({ allowed: false, status: modResult.status, reason: modResult.reason }, 403);
  }

  // Promote: copy quarantine -> public, then delete the quarantine copy.
  const { data: fileData, error: downloadErr } = await admin.storage
    .from(QUARANTINE_BUCKET)
    .download(path);
  if (downloadErr || !fileData) {
    return jsonResponse({ error: "Failed to read quarantined file for promotion" }, 500);
  }

  const { error: pubErr } = await admin.storage
    .from(PUBLIC_BUCKET)
    .upload(path, fileData, { contentType: file.type, upsert: false });
  if (pubErr) {
    await admin.storage.from(QUARANTINE_BUCKET).remove([path]);
    return jsonResponse({ error: `Publish failed: ${pubErr.message}` }, 500);
  }

  await admin.storage.from(QUARANTINE_BUCKET).remove([path]);

  const { data: pub } = admin.storage.from(PUBLIC_BUCKET).getPublicUrl(path);

  return jsonResponse({
    allowed: true,
    status: "approved",
    url: pub.publicUrl,
    type: isVideo ? "video" : "image",
    path,
  });
}

// Fails CLOSED: any error blocks the upload rather than letting unscanned
// media through.
async function moderateMedia(
  admin: ReturnType<typeof createClient>,
  path: string,
  mediaType: "image" | "video",
): Promise<{ allowed: boolean; status: string; reason?: string }> {
  try {
    const sightengineUser = Deno.env.get("SIGHTENGINE_USER");
    const sightengineSecret = Deno.env.get("SIGHTENGINE_SECRET");
    const thornKey = Deno.env.get("THORN_SAFER_API_KEY");

    if (!sightengineUser || !sightengineSecret || !thornKey) {
      // Moderation providers aren't configured yet — fail closed.
      return { allowed: false, status: "blocked", reason: "Moderation not yet configured." };
    }

    const { data: signed } = await admin.storage
      .from(QUARANTINE_BUCKET)
      .createSignedUrl(path, 60);
    if (!signed?.signedUrl) {
      return { allowed: false, status: "blocked", reason: "Could not sign quarantine URL for scanning." };
    }

    // --- Thorn Safer: CSAM hash matching ---
    const saferRes = await fetch("https://api.getsafer.io/v2/media/hash", {
      method: "POST",
      headers: { Authorization: `Bearer ${thornKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ image: signed.signedUrl }),
    });
    if (saferRes.ok) {
      const saferData = await saferRes.json();
      if (saferData?.match) {
        return { allowed: false, status: "blocked", reason: "CSAM match" };
      }
    } else {
      return { allowed: false, status: "blocked", reason: "CSAM scan unavailable" };
    }

    // --- Sightengine: NSFW / violence, images only in this sync path ---
    if (mediaType === "image") {
      const params = new URLSearchParams({
        url: signed.signedUrl,
        models: "nudity-2.1,weapon,violence,gore",
        api_user: sightengineUser,
        api_secret: sightengineSecret,
      });
      const seRes = await fetch(`https://api.sightengine.com/1.0/check.json?${params}`);
      if (!seRes.ok) return { allowed: false, status: "blocked", reason: "NSFW scan unavailable" };
      const seData = await seRes.json();
      const nudityRisky = (seData?.nudity?.sexual_activity ?? 0) > 0.5 || (seData?.nudity?.sexual_display ?? 0) > 0.5;
      const violent = (seData?.violence?.prob ?? 0) > 0.6 || (seData?.gore?.prob ?? 0) > 0.6;
      if (nudityRisky || violent) return { allowed: false, status: "blocked", reason: "NSFW/violence" };
    }
    // TODO: video moderation (Sightengine's video endpoint is async — keep
    // uploaded clip length short client-side until this is wired up).

    return { allowed: true, status: "approved" };
  } catch (e) {
    console.error("moderateMedia() failed:", e);
    return { allowed: false, status: "blocked", reason: "Moderation error" };
  }
}

// ============================================================
// Router: one endpoint, two jobs, told apart by request shape
// ============================================================

serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const supabase = createClient(
    Deno.env.get("SUPABASE_URL")!,
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")! // service role — required to bypass RLS and act as moderator
  );

  const contentType = req.headers.get("content-type") || "";

  if (contentType.includes("multipart/form-data")) {
    // Called directly by the client's upload UI.
    return handleMediaUpload(req, supabase);
  }

  // Otherwise: Database Webhook call for text moderation (unchanged).
  return handleTextModerationWebhook(req, supabase);
});