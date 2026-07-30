// supabase/functions/review-media/index.ts
//
// Lets a human moderator list pending uploads and approve/reject them.
// Protected by real Supabase Auth: the caller must send the access token
// from an actual logged-in session (same login as the rest of manage-89dbc2f16c3c.html).
// No secret lives in any client-side file.
//
// Deploy with verify_jwt disabled, same as moderate-post:
//   supabase functions deploy review-media --no-verify-jwt

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

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

  // Real auth check: the caller must be someone who actually logged in via
  // Supabase Auth (the same login manage-89dbc2f16c3c.html already uses) -- not just
  // anyone holding a string. The public anon key alone will NOT pass this,
  // since it has no logged-in user attached to it.
  const authHeader = req.headers.get("authorization") || "";
  const token = authHeader.replace(/^Bearer\s+/i, "");
  if (!token) return json({ error: "Unauthorized" }, 401);

  const { data: userData, error: userErr } = await admin.auth.getUser(token);
  if (userErr || !userData?.user) {
    return json({ error: "Unauthorized" }, 401);
  }

  // Being logged in isn't enough on its own — this must be one of your
  // specific admin accounts, otherwise ANY account that can authenticate
  // against this Supabase project (e.g. if public sign-up is left enabled)
  // could reach the moderation queue. Replace with your real admin email(s).
  const ADMIN_EMAILS = new Set(["you@example.com"]);
  const callerEmail = (userData.user.email || "").toLowerCase();
  if (!ADMIN_EMAILS.has(callerEmail)) {
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