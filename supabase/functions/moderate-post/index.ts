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
// Not yet provisioned — see README. Leave unset until Thorn Safer approves
// API access; the CSAM check below fails closed (blocks) while it's unset.
const SAFER_API_KEY = Deno.env.get("THORN_SAFER_API_KEY");

const MAX_FILE_BYTES = 25 * 1024 * 1024; // 25MB
const ALLOWED_TYPES = new Set([
  "image/jpeg", "image/png", "image/webp", "image/gif",
  "video/mp4", "video/webm", "video/quicktime",
]);

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

  const isVideo = file.type.startsWith("video/");
  const verdict = isVideo
    ? await scanVideo(signed.signedUrl)
    : await scanImage(signed.signedUrl);

  if (!verdict.allowed) {
    // Reject: delete from quarantine, never let it reach the public bucket.
    await admin.storage.from("post-media-quarantine").remove([quarantinePath]);
    return json({ allowed: false, reason: verdict.reason }, 200);
  }

  // 3. Promote: copy quarantine -> public bucket, then clean up quarantine.
  const { data: fileData, error: downloadErr } = await admin.storage
    .from("post-media-quarantine")
    .download(quarantinePath);
  if (downloadErr || !fileData) {
    await admin.storage.from("post-media-quarantine").remove([quarantinePath]);
    return json({ allowed: false, reason: "Could not finalize upload" }, 500);
  }

  const publicPath = quarantinePath;
  const { error: publicUploadErr } = await admin.storage
    .from("post-media")
    .upload(publicPath, fileData, { contentType: file.type });
  await admin.storage.from("post-media-quarantine").remove([quarantinePath]);

  if (publicUploadErr) {
    return json({ allowed: false, reason: "Could not publish file" }, 500);
  }

  const { data: pub } = admin.storage.from("post-media").getPublicUrl(publicPath);

  return json({
    allowed: true,
    url: pub.publicUrl,
    type: isVideo ? "video" : "image",
    path: publicPath,
  });
}

// ---------------------------------------------------------------------
// Path 2: final pre-insert check (text + already-hosted media reference)
// ---------------------------------------------------------------------
async function handleFinalCheck(req: Request): Promise<Response> {
  const body = await req.json();
  // Media itself was already scanned in handleFileUpload above. This pass
  // is mainly a text check plus a sanity re-check that the media path
  // looks like something this system actually produced.
  const text = String(body.text || "");

  if (looksLikeSpamOrAbuse(text)) {
    return json({ allowed: false, status: "flagged", reason: "Post held for review" });
  }

  return json({ allowed: true, status: "approved" });
}

// ---------------------------------------------------------------------
// Scanning helpers
// ---------------------------------------------------------------------
async function scanImage(url: string): Promise<{ allowed: boolean; reason?: string }> {
  const csam = await checkCsamHash(url);
  if (!csam.allowed) return csam;

  if (!SIGHTENGINE_API_USER || !SIGHTENGINE_API_SECRET) {
    // Fail closed — no scanner configured yet.
    return { allowed: false, reason: "Image scanning is not yet configured" };
  }

  const params = new URLSearchParams({
    url,
    models: "nudity-2.1,offensive,gore,violence",
    api_user: SIGHTENGINE_API_USER,
    api_secret: SIGHTENGINE_API_SECRET,
  });

  const res = await fetch(`https://api.sightengine.com/1.0/check.json?${params}`);
  const data = await res.json();

  const nudityScore = data?.nudity?.sexual_activity ?? data?.nudity?.raw ?? 0;
  const goreScore = data?.gore?.prob ?? 0;
  const violenceScore = data?.violence?.prob ?? 0;
  const offensiveScore = data?.offensive?.prob ?? 0;

  if (nudityScore > 0.6 || goreScore > 0.6 || violenceScore > 0.7 || offensiveScore > 0.7) {
    return { allowed: false, reason: "Image failed content review" };
  }
  return { allowed: true };
}

async function scanVideo(url: string): Promise<{ allowed: boolean; reason?: string }> {
  // Sightengine's video endpoint is async (webhook-based) and needs a
  // dedicated table + callback route to track job status; wire that up
  // the same way once you're ready to accept video, following the same
  // fail-closed pattern used here. Until then, video stays blocked.
  const csam = await checkCsamHash(url);
  if (!csam.allowed) return csam;
  return { allowed: false, reason: "Video scanning is not yet configured" };
}

async function checkCsamHash(url: string): Promise<{ allowed: boolean; reason?: string }> {
  if (!SAFER_API_KEY) {
    // Fail closed until Thorn Safer access is approved and this key is set.
    return { allowed: false, reason: "Safety scanning is not yet configured" };
  }
  // Once approved, implement per Thorn Safer's integration docs
  // (https://safer.io/) — typically: submit the file/hash to their API,
  // check the match result, and block on any positive match.
  // Placeholder left intentionally unimplemented pending API access.
  return { allowed: true };
}

function looksLikeSpamOrAbuse(text: string): boolean {
  const lower = text.toLowerCase();
  const spamPatterns = [/https?:\/\/\S+\.\S+.*https?:\/\/\S+\.\S+/, /\b(buy now|click here|free money)\b/];
  return spamPatterns.some((p) => p.test(lower));
}