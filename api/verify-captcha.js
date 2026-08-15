// POST /api/verify-captcha  { token: string }  ->  { success: boolean }
//
// The Turnstile *site* key (js/common.js TURNSTILE_SITE_KEY) is public
// by design, but the *secret* key must never reach the browser — this
// is the one place that holds it, read from an environment variable so
// it's never committed to the repo.
//
// Setup: in your Vercel project, Settings -> Environment Variables,
// add TURNSTILE_SECRET_KEY with the secret key from
// https://dash.cloudflare.com/?to=/:account/turnstile (same widget as
// the site key in js/common.js), for Production/Preview/Development,
// then redeploy.
//
// If the env var isn't set yet, this responds { success: true } so a
// half-configured deployment doesn't lock everyone out of posting —
// remove that fallback once TURNSTILE_SECRET_KEY is actually set, if
// you'd rather fail closed instead.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const secret = process.env.TURNSTILE_SECRET_KEY;
  if (!secret) {
    // Not configured yet — see note above.
    return res.status(200).json({ success: true, warning: 'TURNSTILE_SECRET_KEY not set' });
  }

  let token;
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
    token = body?.token;
  } catch (e) {
    return res.status(400).json({ success: false, error: 'Invalid request body' });
  }
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ success: false, error: 'Missing token' });
  }

  try {
    const params = new URLSearchParams({ secret, response: token });
    const remoteIp = req.headers['x-forwarded-for']?.split(',')[0]?.trim();
    if (remoteIp) params.set('remoteip', remoteIp);

    const cfRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await cfRes.json();
    return res.status(200).json({ success: !!data.success });
  } catch (e) {
    return res.status(502).json({ success: false, error: 'Verification service unreachable' });
  }
}
