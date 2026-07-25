// supabase/functions/moderate-post/index.ts
//
// Handles two call shapes from interactink.html:
//   1. multipart/form-data (file upload) -> stages media, queues for human
//      review via the Pending Media tab in admin.html.
//   2. application/json ({ text }) -> checks text against a few fast,
//      dependency-free rules. No external API calls for text at all --
//      this cannot go down, get misconfigured, or need billing.
//
// Deploy with:
//   supabase functions deploy moderate-post --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const contentType = req.headers.get("content-type") || "";

  try {
    if (contentType.includes("multipart/form-data")) {
      return await handleFileUpload(req);
    }
    if (contentType.includes("application/json")) {
      return await handleTextCheck(req);
    }
    return json({ allowed: false, error: "Unsupported content type" }, 400);
  } catch (e) {
    console.error("moderate-post top-level error:", e);
    // Fail OPEN at the top level -- an unexpected crash here should not
    // take text posting down entirely. Media still requires the checks
    // inside handleFileUpload to pass explicitly.
    return json({ allowed: true, status: "approved" }, 200);
  }
});

// ---------------------------------------------------------------------
// TEXT — fast, dependency-free checks only. No external API calls.
// ---------------------------------------------------------------------
async function handleTextCheck(req: Request): Promise<Response> {
  const body = await req.json().catch(() => ({}));
  const text = String(body.text || "");

  if (!text.trim()) {
    return json({ allowed: true, status: "approved" });
  }

  if (containsSevereChildSafetyViolation(text)) {
    console.error("SEVERE: child-safety pattern matched.");
    return json({ allowed: false, status: "blocked", reason: "This post was blocked." });
  }
  if (detectDoxxing(text)) {
    return json({ allowed: false, status: "blocked", reason: "Post appears to contain personal contact information and was blocked." });
  }
  if (looksLikeDrugSale(text)) {
    return json({ allowed: false, status: "blocked", reason: "This post was blocked." });
  }
  if (looksLikeSpam(text)) {
    return json({ allowed: false, status: "blocked", reason: "This looks like spam and was blocked." });
  }

  return json({ allowed: true, status: "approved" });
}

function containsSevereChildSafetyViolation(text: string): boolean {
  const normalized = text.toLowerCase();
  const violenceTerms = [
    "rape", "raping", "raped",
    "molest", "molesting", "molested",
    "sexually abuse", "sexually abusing", "sexually assaulted",
    "have sex with", "having sex with",
  ];
  const minorTerms = [
    "kid", "kids", "child", "children", "children's",
    "minor", "minors", "toddler", "infant", "baby",
    "underage", "preteen", "pre-teen",
  ];
  const hitViolence = violenceTerms.some((t) => normalized.includes(t));
  const hitMinor = minorTerms.some((t) => normalized.includes(t));
  return hitViolence && hitMinor;
}

function detectDoxxing(text: string): boolean {
  const phonePattern = /(\+?\d{1,2}[-.\s]?)?\(?\d{3}\)?[-.\s]\d{3}[-.\s]\d{4}\b/;
  const streetAddressPattern = /\b\d{1,5}\s+([A-Za-z]+\s){1,4}(street|st|avenue|ave|road|rd|boulevard|blvd|lane|ln|drive|dr|court|ct|way|place|pl)\b/i;
  return phonePattern.test(text) || streetAddressPattern.test(text);
}

function looksLikeDrugSale(text: string): boolean {
  const lower = text.toLowerCase();
  const substanceTerms = /\b(weed|marijuana|cannabis|cocaine|coke|heroin|meth|molly|mdma|xanax|percs|percocet|oxy|oxycontin|fentanyl|lsd|shrooms|ketamine|adderall)\b/;
  const transactionalTerms = /\b(for sale|selling|plug|dm me|hit me up|text me|\$\d+|per gram|per oz|delivery|shipped|discreet|prices?|dealer)\b/;
  return substanceTerms.test(lower) && transactionalTerms.test(lower);
}

function looksLikeSpam(text: string): boolean {
  const lower = text.toLowerCase();
  const spamPatterns = [/https?:\/\/\S+\.\S+.*https?:\/\/\S+\.\S+/, /\b(buy now|click here|free money)\b/];
  return spamPatterns.some((p) => p.test(lower));
}

// ---------------------------------------------------------------------
// MEDIA — stage privately, queue for human review. Unchanged approach:
// nothing publishes without a moderator clicking Approve in admin.html.
// ---------------------------------------------------------------------
async function handleFileUpload(req: Request): Promise<Response> {
  const form = await req.formData();
  const file = form.get("file");
  const boardId = String(form.get("boardId") || "misc");

  if (!(file instanceof File)) {
    return json({ allowed: false, error: "No file provided" }, 400);
  }
  if (!ALLOWED_TYPES.has(file.type)) {
    return json({ allowed: false, reason: `Unsupported file type: ${file.type || "unknown"}` }, 400);
  }
  if (file.size > MAX_FILE_BYTES) {
    return json({ allowed: false, reason: "File too large (25MB limit)" }, 400);
  }

  const ext = (file.name.split(".").pop() || "bin").toLowerCase();
  const quarantinePath = `${boardId}/${crypto.randomUUID()}.${ext}`;
  const bytes = new Uint8Array(await file.arrayBuffer());

  const { error: uploadErr } = await admin.storage
    .from("post-media-quarantine")
    .upload(quarantinePath, bytes, { contentType: file.type });
  if (uploadErr) {
    console.error("Quarantine upload failed:", uploadErr);
    return json({ allowed: false, reason: `Could not stage file: ${uploadErr.message}` }, 500);
  }

  const { error: insertErr } = await admin.from("pending_media").insert({
    storage_path: quarantinePath,
    board_id: boardId,
    media_type: file.type.startsWith("video/") ? "video" : "image",
    status: "pending",
  });
  if (insertErr) {
    console.error("pending_media insert failed:", insertErr);
    await admin.storage.from("post-media-quarantine").remove([quarantinePath]);
    return json({ allowed: false, reason: `Could not queue file for review: ${insertErr.message}` }, 500);
  }

  const { data: futurePub } = admin.storage.from("post-media").getPublicUrl(quarantinePath);

  return json({
    allowed: true,
    pending: true,
    url: futurePub.publicUrl,
    type: file.type.startsWith("video/") ? "video" : "image",
    path: quarantinePath,
    reason: "Submitted for review — this may take a little while before it's visible to others.",
  });
}