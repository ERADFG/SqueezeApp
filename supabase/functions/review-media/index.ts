// supabase/functions/review-media/index.ts
//
// Lets a human moderator list pending uploads and approve/reject them.
// Protected by a shared secret (ADMIN_SECRET) since this app has no user
// accounts — anyone with the secret can moderate, so treat it like a
// password and don't share it or commit it anywhere.
//
// Deploy with verify_jwt disabled, same as moderate-post:
//   supabase functions deploy review-media --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const ADMIN_SECRET = Deno.env.get("ADMIN_SECRET")!;

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-admin-secret",
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

  const providedSecret = req.headers.get("x-admin-secret");
  if (!ADMIN_SECRET || providedSecret !== ADMIN_SECRET) {
    return json({ error: "Unauthorized" }, 401);
  }

  try {
    const body = await req.json();
    const action = body.action;

    if (action === "list") {
      const { data, error } = await admin
        .from("pending_media")
        .select("*")
        .eq("status", "pending")
        .order("created_at", { ascending: true })
        .limit(50);
      if (error) throw error;

      // Attach a short-lived signed URL to each item so the moderator can
      // actually view the image/video without the quarantine bucket ever
      // being made public.
      const withUrls = await Promise.all(
        (data || []).map(async (item) => {
          const { data: signed } = await admin.storage
            .from("post-media-quarantine")
            .createSignedUrl(item.storage_path, 600); // 10 minutes
          return { ...item, previewUrl: signed?.signedUrl || null };
        })
      );
      return json({ items: withUrls });
    }

    if (action === "approve") {
      const id = body.id;
      const { data: item, error: fetchErr } = await admin
        .from("pending_media")
        .select("*")
        .eq("id", id)
        .single();
      if (fetchErr || !item) return json({ error: "Item not found" }, 404);

      const { data: fileData, error: downloadErr } = await admin.storage
        .from("post-media-quarantine")
        .download(item.storage_path);
      if (downloadErr || !fileData) return json({ error: "Could not read file" }, 500);

      const { error: publicUploadErr } = await admin.storage
        .from("post-media")
        .upload(item.storage_path, fileData, {
          contentType: item.media_type === "video" ? "video/mp4" : "image/jpeg",
        });
      if (publicUploadErr) return json({ error: "Could not publish file" }, 500);

      await admin.storage.from("post-media-quarantine").remove([item.storage_path]);
      const { data: pub } = admin.storage.from("post-media").getPublicUrl(item.storage_path);

      await admin.from("pending_media").update({ status: "approved", public_url: pub.publicUrl }).eq("id", id);

      return json({ ok: true, url: pub.publicUrl });
    }

    if (action === "reject") {
      const id = body.id;
      const { data: item } = await admin.from("pending_media").select("*").eq("id", id).single();
      if (item) {
        await admin.storage.from("post-media-quarantine").remove([item.storage_path]);
        await admin.from("pending_media").update({ status: "rejected" }).eq("id", id);
      }
      return json({ ok: true });
    }

    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    console.error("review-media error:", e);
    return json({ error: "Internal error" }, 500);
  }
});
