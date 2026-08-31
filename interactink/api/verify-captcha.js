// GET  /api/verify-captcha  ->  { nonce, ts, sig }
// POST /api/verify-captcha  { nonce, ts, sig, hp }  ->  { success: boolean }
//
// A homemade "I'm not a robot" check — not Turnstile/reCAPTCHA/hCaptcha
// or any other third-party service, just a signed time-trap + honeypot
// this project owns end to end. Gates sign up, log in, and every
// posting action, wired up from js/common.js (renderCaptchaIfNeeded /
// verifyHuman) and the checkbox markup it renders.
//
// HOW IT WORKS:
//   1. GET issues a "challenge": a random nonce + this server's own
//      current timestamp, signed with HMAC-SHA256 so the client can
//      carry it around but never forge or backdate it (any change to
//      nonce/ts invalidates the signature).
//   2. The browser shows a checkbox. Clicking it doesn't call the
//      server — it just arms the challenge captchaCardHtml already has.
//   3. Right before the gated action (signup/login/post/reply), POST
//      sends the untouched challenge back plus a honeypot field that
//      should always be empty (real people never see or fill it —
//      it's visually hidden — but a bot that blindly fills every
//      input on the page will).
//   4. This endpoint re-derives the signature server-side and rejects
//      if it doesn't match (proves nonce/ts weren't tampered with),
//      rejects if the honeypot isn't empty, and rejects if the elapsed
//      time between issuing and verifying is too short (faster than a
//      person can plausibly read+click) or too long (the challenge is
//      stale). All three have to pass.
//
// CAVEAT (documented, not hidden): this is a lightweight, self-hosted
// deterrent against basic/scripted bots — not a hardened anti-abuse
// system. A patient attacker who reads this file can satisfy every
// check. It's paired with the server-side post cooldown
// (supabase/post_cooldown.sql) and the IP ban (supabase/ip_ban.sql)
// for defense in depth, same spirit as this project's other
// "good enough for a project this size" tradeoffs.
//
// Set CAPTCHA_SECRET in your Vercel project's Environment Variables
// for a signing key unique to your deployment. There is deliberately
// NO hardcoded fallback: a fixed default value shipped in source (and
// therefore in every clone/export of this project) would let anyone
// who has ever seen this file forge a valid signature for any
// nonce/ts they like, defeating the whole check. The endpoint refuses
// to issue or verify challenges until the real env var is set.
import crypto from 'crypto';

const SECRET = process.env.CAPTCHA_SECRET;
const MIN_DELAY_MS = 700;        // faster than this and it wasn't a real click
const MAX_AGE_MS = 15 * 60 * 1000; // older than this and the challenge is stale

function sign(nonce, ts) {
  return crypto.createHmac('sha256', SECRET).update(`${nonce}.${ts}`).digest('hex');
}
function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

export default async function handler(req, res) {
  if (!SECRET) {
    // Misconfigured deployment — refuse rather than sign/verify with
    // an empty/undefined secret, which would make every challenge
    // trivially forgeable.
    console.error('verify-captcha: CAPTCHA_SECRET is not set');
    return res.status(503).json({ error: 'Captcha not configured' });
  }

  if (req.method === 'GET') {
    const nonce = crypto.randomBytes(16).toString('hex');
    const ts = Date.now();
    return res.status(200).json({ nonce, ts, sig: sign(nonce, ts) });
  }

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'GET, POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch (e) {
    return res.status(400).json({ success: false, error: 'Invalid request body' });
  }
  const { nonce, ts, sig, hp } = body || {};
  if (!nonce || !ts || !sig) {
    return res.status(400).json({ success: false, error: 'Missing challenge' });
  }

  // Honeypot: a real person never fills this (it's hidden with CSS,
  // not just off-screen), a bot filling every field on the page will.
  if (hp) {
    return res.status(200).json({ success: false, error: 'Failed bot check' });
  }

  if (!safeEqual(sig, sign(nonce, ts))) {
    return res.status(200).json({ success: false, error: 'Invalid or tampered challenge' });
  }

  const elapsed = Date.now() - Number(ts);
  if (elapsed < MIN_DELAY_MS) {
    return res.status(200).json({ success: false, error: 'Please try again.' });
  }
  if (elapsed > MAX_AGE_MS) {
    return res.status(200).json({ success: false, error: 'That check expired — please retry.' });
  }

  return res.status(200).json({ success: true });
}
