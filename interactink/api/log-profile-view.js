// POST /api/log-profile-view  { username: string }
//   Records one row in public.profile_views for the Insights page's
//   view counter/trend chart and "Top locations" breakdown (see
//   supabase/analytics_setup.sql). Called from js/profile.js every
//   time someone loads a profile that isn't their own.
//
// WHY THIS HAS TO BE A SERVER FUNCTION (same reasoning as api/ip.js):
// the country a view gets attributed to has to come from something
// the visitor can't just lie about. Vercel's edge network sets
// x-vercel-ip-country from its own geo-IP lookup before this function
// runs, so reading it here — and never accepting a country string the
// client tries to send in the body — is what keeps "Top locations"
// honest. Works for both signed-in and signed-out visitors; an
// Authorization header (when present) is forwarded so the view gets
// attributed to the right viewer_id server-side, same pattern as
// api/ip.js forwarding the caller's own token instead of a
// service_role key.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  let username = '';
  try {
    const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
    username = (body.username || '').trim();
  } catch (e) {
    // fall through with empty username, handled below
  }
  if (!username) return res.status(200).json({ ok: false });

  const country = (req.headers['x-vercel-ip-country'] || '').trim();
  const auth = req.headers['authorization'];

  const SUPABASE_URL = 'https://pyitivzoqleukuclajrf.supabase.co';
  const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5aXRpdnpvcWxldWt1Y2xhanJmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5Nzg0ODcsImV4cCI6MjEwMTU1NDQ4N30.gKvqOaAREY5wcptIv7OHfjHhZR5ogIaMY8I98jHRmFs';

  try {
    await fetch(`${SUPABASE_URL}/rest/v1/rpc/log_profile_view`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_ANON_KEY,
        Authorization: auth || `Bearer ${SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ p_username: username, p_country: country || null }),
    });
    // Fire-and-forget from the caller's point of view — js/profile.js
    // doesn't need the result, so this always reports ok once the
    // request was sent, same "never block the page on this" philosophy
    // as post/reply view counters in view_counts.sql.
    return res.status(200).json({ ok: true });
  } catch (e) {
    return res.status(200).json({ ok: false });
  }
}
