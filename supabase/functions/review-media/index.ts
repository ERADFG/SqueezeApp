// supabase/functions/review-media/index.ts
//
// Admin-only endpoint for the human moderation queue. Called by
// admin-review.html with a JSON body of one of:
//   { action: "list" }
//   { action: "approve", id }
//   { action: "reject",  id }
//
// Auth: a shared admin secret sent as the `x-admin-secret` header.
// The secret is read from the ADMIN_SECRET env var so it's never
// committed to source. A literal fallback is included ONLY so the
// endpoint keeps working before you've set the env var in Supabase —
// set ADMIN_SECRET in the project's Edge Function secrets and this
// fallback value stops being used at all.
//
// Deploy with verify_jwt disabled — the admin panel has no Supabase
// session, only the shared secret:
//   supabase functions deploy review-media --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET") ?? "sayadi 1233";

const QUARANTINE_BUCKET = "post-media-quarantine";
const PUBLIC_BUCKET = "post-media";
const SIGNED_URL_TTL_SECONDS = 300; // 5 minutes, just enough to render the review queue

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, x-admin-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS_HEADERS, "Content-Type": "application/json" },
  });
}

// Admin client — bypasses RLS. Only this function should touch
// pending_media / the quarantine bucket directly.
const admin = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS_HEADERS });

  const providedSecret = req.headers.get("x-admin-secret") || "";
  if (providedSecret !== ADMIN_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  let body: { action?: string; id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  try {
    switch (body.action) {
      case "list":
        return await listPending();
      case "approve":
        return await decide(body.id, "approve");
      case "reject":
        return await decide(body.id, "reject");
      default:
        return json({ error: "Unknown action" }, 400);
    }
  } catch (e) {
    console.error("review-media error:", e);
    return json({ error: "Internal error" }, 500);
  }
});

// ---------------------------------------------------------------------
// action: list
// ---------------------------------------------------------------------
async function listPending(): Promise<Response> {
  const { data: rows, error } = await admin
    .from("pending_media")
    .select("id, storage_path, board_id, media_type, created_at")
    .eq("status", "pending")
    .order("created_at", { ascending: true });

  if (error) {
    console.error("pending_media select failed:", error);
    return json({ error: "Could not load queue" }, 500);
  }

  const items = await Promise.all(
    (rows || []).map(async (row) => {
      const { data: signed, error: signErr } = await admin.storage
        .from(QUARANTINE_BUCKET)
        .createSignedUrl(row.storage_path, SIGNED_URL_TTL_SECONDS);

      return {
        id: row.id,
        board_id: row.board_id,
        media_type: row.media_type,
        created_at: row.created_at,
        previewUrl: signErr ? null : signed?.signedUrl ?? null,
      };
    })
  );

  return json({ items: items.filter((i) => i.previewUrl) });
}

// ---------------------------------------------------------------------
// action: approve / reject
// ---------------------------------------------------------------------
async function decide(id: string | undefined, action: "approve" | "reject"): Promise<Response> {
  if (!id) return json({ error: "Missing id" }, 400);

  const { data: row, error: fetchErr } = await admin
    .from("pending_media")
    .select("id, storage_path, board_id, media_type, status")
    .eq("id", id)
    .single();

  if (fetchErr || !row) {
    return json({ error: "Item not found" }, 404);
  }
  if (row.status !== "pending") {
    return json({ error: `Item already ${row.status}` }, 409);
  }

  if (action === "reject") {
    await admin.storage.from(QUARANTINE_BUCKET).remove([row.storage_path]);
    const { error: updateErr } = await admin
      .from("pending_media")
      .update({ status: "rejected" })
      .eq("id", id);
    if (updateErr) {
      console.error("pending_media update (reject) failed:", updateErr);
      return json({ error: "Could not update status" }, 500);
    }
    return json({ ok: true, status: "rejected" });
  }

  // action === "approve": move the file from quarantine into the public bucket
  const { data: fileData, error: downloadErr } = await admin.storage
    .from(QUARANTINE_BUCKET)
    .download(row.storage_path);
  if (downloadErr || !fileData) {
    console.error("quarantine download failed:", downloadErr);
    return json({ error: "Could not read file for approval" }, 500);
  }

  const { error: uploadErr } = await admin.storage
    .from(PUBLIC_BUCKET)
    .upload(row.storage_path, fileData, { upsert: true });
  if (uploadErr) {
    console.error("public bucket upload failed:", uploadErr);
    return json({ error: "Could not publish file" }, 500);
  }

  const { data: publicUrlData } = admin.storage.from(PUBLIC_BUCKET).getPublicUrl(row.storage_path);

  const { error: updateErr } = await admin
    .from("pending_media")
    .update({ status: "approved", public_url: publicUrlData.publicUrl })
    .eq("id", id);
  if (updateErr) {
    console.error("pending_media update (approve) failed:", updateErr);
    return json({ error: "Could not update status" }, 500);
  }

  await admin.storage.from(QUARANTINE_BUCKET).remove([row.storage_path]);

  return json({ ok: true, status: "approved", url: publicUrlData.publicUrl });
}