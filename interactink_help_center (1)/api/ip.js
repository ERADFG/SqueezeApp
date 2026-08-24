// POST /api/ip
//   Anonymous  (no Authorization header) -> { banned: boolean }
//     Used right before signup — checks the *caller's real IP* (read
//     server-side from Vercel's x-forwarded-for, never from anything
//     the browser sends in the body) against public.banned_ips.
//   Signed in  (Authorization: Bearer <access_token>) -> { banned: boolean }
//     Also records the IP against the caller's account via the
//     record_user_ip() RPC (forwarding the caller's own token so it
//     runs as them, not as an admin/service role — this project never
//     ships a service_role key to a server function, same as
//     api/verify-captcha.js and api/giphy.js), and returns whether
//     that IP is currently banned so the caller can be signed out if
//     it just got banned on another account.
//
// WHY THIS HAS TO BE A SERVER FUNCTION: Postgres has no idea what a
// visitor's real IP is unless something trustworthy tells it. A
// browser calling Supabase directly could just send any IP string it
// likes. Vercel's own edge network sets x-forwarded-for to the real
// connecting IP before this function ever runs, so reading it here
// (and never accepting an IP the client tries to supply) is what
// makes the ban actually hold up.
//
// See supabase/ip_ban.sql for the tables/RPCs this calls.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ banned: false, error: 'Method not allowed' });
  }

  const ip = (req.headers['x-forwarded-for']?.split(',')[0] || req.socket?.remoteAddress || '').trim();
  if (!ip) return res.status(200).json({ banned: false });

  const SUPABASE_URL = 'https://pyitivzoqleukuclajrf.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5aXRpdnpvcWxldWt1Y2xhanJmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5Nzg0ODcsImV4cCI6MjEwMTU1NDQ4N30.gKvqOaAREY5wcptIv7OHfjHhZR5ogIaMY8I98jHRmFs';

  const auth = req.headers['authorization'];

  try {
    if (auth) {
      // Signed in: record + check in one RPC call, running as the caller.
      const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/record_user_ip`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_ANON_KEY,
          Authorization: auth,
        },
        body: JSON.stringify({ p_ip: ip }),
      });
      if (!rpcRes.ok) return res.status(200).json({ banned: false });
      const banned = await rpcRes.json();
      return res.status(200).json({ banned: banned === true });
    }

    // Signed out (pre-signup check): no account to record against yet,
    // just ask whether this IP is already on the deny-list.
    const rpcRes = await fetch(`${SUPABASE_URL}/rest/v1/rpc/is_ip_banned`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ p_ip: ip }),
    });
    if (!rpcRes.ok) return res.status(200).json({ banned: false });
    const banned = await rpcRes.json();
    return res.status(200).json({ banned: banned === true });
  } catch (e) {
    // Fail open, same philosophy as verify-captcha.js/giphy.js — an
    // outage here shouldn't lock out every visitor on the site.
    return res.status(200).json({ banned: false });
  }
}
