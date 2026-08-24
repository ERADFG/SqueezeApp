// GET /api/giphy?type=trending
// GET /api/giphy?type=search&q=<query>
//
// WHY THIS FILE EXISTS: js/common.js's GIF picker used to call
// api.giphy.com directly from the browser with the API key baked
// right into the JS bundle (`const GIPHY_API_KEY = '...'`) — anyone
// could open devtools, copy it out, and use it themselves against
// GIPHY's shared per-key rate limit, which is the same limit this
// site's own GIF picker draws from. This proxy holds the key
// server-side (env var, never shipped to the browser) and forwards
// only the two things the client actually needs to control: which
// endpoint (trending vs search) and the search term. Same
// fail-soft-when-unconfigured pattern as verify-captcha.js.
//
// Setup: in your Vercel project, Settings -> Environment Variables,
// add GIPHY_API_KEY with the key from https://developers.giphy.com/dashboard/
// for Production/Preview/Development, then redeploy.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ data: [], error: 'Method not allowed' });
  }

  // Requires GIPHY_API_KEY to be set in Vercel Settings -> Environment
  // Variables. No hardcoded fallback key here — a real API key baked
  // into source (even server-only source) ends up in git history and
  // in this project's zip/export, which is enough exposure to warrant
  // rotating a key if one is ever found here. Fail soft instead: the
  // picker just returns no GIFs until the env var is configured.
  const apiKey = process.env.GIPHY_API_KEY;
  if (!apiKey) {
    return res.status(200).json({ data: [], error: 'GIPHY not configured' });
  }

  const type = req.query.type === 'search' ? 'search' : 'trending';
  const q = typeof req.query.q === 'string' ? req.query.q.slice(0, 100) : '';
  if (type === 'search' && !q) {
    return res.status(400).json({ data: [], error: 'Missing q' });
  }

  const params = new URLSearchParams({ api_key: apiKey, limit: '24', rating: 'pg-13' });
  if (type === 'search') params.set('q', q);
  const upstream = `https://api.giphy.com/v1/gifs/${type}?${params.toString()}`;

  try {
    const giphyRes = await fetch(upstream);
    const json = await giphyRes.json();
    // Only pass through the fields fetchGifs() in js/common.js actually
    // reads (id/title/images) — no need to relay GIPHY's own key/meta
    // plumbing back to the client.
    const data = (json.data || []).map(g => ({
      id: g.id,
      title: g.title,
      images: {
        fixed_width: { url: g.images?.fixed_width?.url },
        original: { url: g.images?.original?.url },
      },
    }));
    res.setHeader('Cache-Control', 'public, max-age=120, s-maxage=120');
    return res.status(200).json({ data });
  } catch (e) {
    return res.status(502).json({ data: [], error: 'GIPHY unreachable' });
  }
}
