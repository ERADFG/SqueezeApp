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
window.checkPassword = checkPassword;
window.isDisposableEmail = isDisposableEmail;
