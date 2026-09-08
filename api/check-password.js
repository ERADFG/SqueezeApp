// api/check-password.js
//
// POST { password }  ->  { breached: boolean, count: number }
//
// Uses the free "Have I Been Pwned" Pwned Passwords API. This is safe to
// call with a real password because of k-anonymity: we only ever send the
// first 5 characters of the SHA-1 hash, never the password itself or the
// full hash. HIBP returns every suffix that matches that 5-char prefix and
// we check locally. No API key needed, no rate limit for this endpoint.
//
// Wire this in at signup (js/auth.js) right before account creation: if
// breached is true, tell the user to pick a different password. This stops
// credential-stuffing bots from using your signup form to test leaked
// password lists, and protects users who'd otherwise reuse a compromised
// password.

import crypto from 'crypto';

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  let body;
  try {
    body = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
  } catch {
    return res.status(400).json({ error: 'Invalid body' });
  }

  const { password } = body || {};
  if (!password || typeof password !== 'string') {
    return res.status(400).json({ error: 'password is required' });
  }

  const sha1 = crypto.createHash('sha1').update(password).digest('hex').toUpperCase();
  const prefix = sha1.slice(0, 5);
  const suffix = sha1.slice(5);

  try {
    const hibpRes = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { 'Add-Padding': 'true' }, // extra privacy: response padded with noise entries
    });
    if (!hibpRes.ok) {
      // Fail open: don't block signup if HIBP is briefly down.
      return res.status(200).json({ breached: false, count: 0, note: 'check unavailable' });
    }
    const text = await hibpRes.text();
    const match = text.split('\n').find((line) => line.startsWith(suffix));
    const count = match ? parseInt(match.split(':')[1].trim(), 10) : 0;

    return res.status(200).json({ breached: count > 0, count });
  } catch (e) {
    console.error('pwned password check failed', e);
    return res.status(200).json({ breached: false, count: 0, note: 'check unavailable' });
  }
}
