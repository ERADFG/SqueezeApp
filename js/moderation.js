// js/moderation.js
//
// Client helpers for the free moderation layer, written in the same style
// as verifyHuman()/renderCaptchaIfNeeded() in common.js. Import this on any
// page that submits text content (posts, replies, chat, profile bio) or
// runs signup.
//
// USAGE — text content, right after verifyHuman() passes and before your
// supabase insert:
//
//   if (!(await verifyHuman('post-captcha', errEl))) return;
//   const mod = await checkText({ userId: user.id, contentType: 'text', text: body, contentRef: null });
//   if (mod.decision === 'block') { errEl.textContent = 'This looks like it breaks our rules — please revise.'; return; }
//   if (mod.decision === 'human_review') { /* insert but mark hidden/pending, e.g. status: 'pending_review' */ }
//   // 'allow' and 'soft_flag' -> insert normally (soft_flag still logged for the admin queue)
//
// USAGE — signup, right before creating the account:
//
//   const emailCheck = await isDisposableEmail(email);          // via RPC, see below
//   if (emailCheck) { errEl.textContent = 'Please use a permanent email address.'; return; }
//   const pwCheck = await checkPassword(password);
//   if (pwCheck.breached) { errEl.textContent = `This password has appeared in ${pwCheck.count} known breaches — please choose another.`; return; }

async function checkText({ userId, contentType, text, contentRef }) {
  try {
    const res = await fetch('/api/moderate-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, contentType, text, contentRef }),
    });
    if (!res.ok) return { decision: 'allow', scores: {}, doxHits: [] }; // fail open on outage
    return await res.json();
  } catch {
    return { decision: 'allow', scores: {}, doxHits: [] };
  }
}

// USAGE — media content, AFTER the row exists in the DB (post/reply
// insert must include moderation_status: 'pending' so the
// RESTRICTIVE RLS policy in moderation_media_pipeline.sql hides it
// from everyone but the author until this call flips it):
//
//   const { data } = await sb.from('posts').insert({ ..., media_url, media_type, moderation_status: 'pending' }).select().single();
//   if (media_url) {
//     const mod = await checkMediaModeration({ userId: user.id, table: 'posts', contentId: data.id, contentType: 'post', mediaUrl: media_url, mediaType: media_type });
//     if (mod.decision === 'block') { /* tell the user, row stays hidden forever via moderation_status */ }
//   }
//
// This is a real server round-trip (downloads + runs two ML models),
// so it's slower than the client-side instant check — that's
// expected and correct, this is the enforcement layer, not the UX
// nicety. Show a "checking your upload…" state while it runs.
async function checkMediaModeration({ userId, table, contentId, contentType, mediaUrl, mediaType }) {
  try {
    const res = await fetch('/api/moderate-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId, table, contentId, contentType, mediaUrl, mediaType }),
    });
    // Deliberately NOT fail-open here, unlike checkText()/checkPassword()
    // above — this is the server enforcement boundary for media. If the
    // request itself fails (network blip, deploy in progress), the
    // content simply stays 'pending' — invisible to everyone but its
    // author — rather than defaulting to visible. Nothing further to do
    // client-side; a retry or an admin can unstick it later.
    if (!res.ok) return { decision: 'human_review', scores: {} };
    return await res.json();
  } catch {
    return { decision: 'human_review', scores: {} };
  }
}

async function checkPassword(password) {
  try {
    const res = await fetch('/api/check-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    if (!res.ok) return { breached: false, count: 0 };
    return await res.json();
  } catch {
    return { breached: false, count: 0 };
  }
}

// Uses the is_disposable_email() RPC from moderation_pipeline.sql. Assumes
// `supabase` is already initialized on the page (same as everywhere else
// in this codebase via js/supabase-config.js).
async function isDisposableEmail(email) {
  try {
    const { data, error } = await supabase.rpc('is_disposable_email', { p_email: email });
    if (error) return false; // fail open
    return !!data;
  } catch {
    return false;
  }
}

window.checkText = checkText;
window.checkMediaModeration = checkMediaModeration;
window.checkPassword = checkPassword;
window.isDisposableEmail = isDisposableEmail;
