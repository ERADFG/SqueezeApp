// GET /api/link-preview?url=<encoded url>
//
// WHY THIS FILE EXISTS: the Bluesky-style link cards in a post's body
// (see linkCardHtml()/hydrateLinkCard() in js/common.js) need a
// target site's og:title/og:description/og:image, but a browser
// can't read those directly — most sites don't send CORS headers
// that let page JS fetch() their HTML from interactink.com, and even
// where they do, shipping the whole page down to every visitor's
// browser just to throw away everything but three <meta> tags is
// wasteful. This proxy does that fetch server-side and returns only
// the handful of fields the card actually renders.
//
// Same fail-soft shape as api/giphy.js: never throws a hard error the
// client has to branch on — a site that's down, blocks bots, or has
// no OG tags at all just comes back with nulls, and the client-side
// hydrateLinkCard() quietly leaves the card unrendered.
export default async function handler(req, res) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const raw = typeof req.query.url === 'string' ? req.query.url : '';
  let target;
  try {
    target = new URL(raw);
    if (target.protocol !== 'http:' && target.protocol !== 'https:') throw new Error('bad protocol');
  } catch {
    return res.status(400).json({ error: 'Invalid url' });
  }

  const host = target.hostname.toLowerCase();
  const domain = host.replace(/^www\./, '');

  // Refuse to let this become an open proxy for probing addresses on
  // Vercel's internal network — a pasted "link" pointing at
  // localhost/169.254.169.254/a private range gets refused outright
  // rather than fetched. Also reused below for every redirect hop
  // (see the manual-redirect loop) — an *external* site that 3xx's to
  // one of these addresses would otherwise sail through unchecked.
  const isPrivateHost = (h) => (
    h === 'localhost' || h === '0.0.0.0' || h.endsWith('.local') ||
    /^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[0-1])\./.test(h) || /^169\.254\./.test(h)
  );
  if (isPrivateHost(host)) {
    return res.status(400).json({ error: 'Invalid url' });
  }

  const empty = { url: target.href, domain, title: null, description: null, image: null };

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    let upstream;
    try {
      let hop = target;
      for (let redirects = 0; ; redirects++) {
        if (redirects > 5) return res.status(200).json(empty);
        upstream = await fetch(hop.href, {
          redirect: 'manual',
          signal: controller.signal,
          headers: {
            // A plain fetch() UA gets silently blocked or served a
            // stripped page by a fair number of sites; a browser-shaped
            // UA is what makes this behave the same as a real Bluesky/
            // Discord/iMessage unfurl for most targets.
            'User-Agent': 'Mozilla/5.0 (compatible; InteractInkBot/1.0; +https://interactink.com)',
            'Accept': 'text/html,application/xhtml+xml',
          },
        });
        if (upstream.status < 300 || upstream.status >= 400 || !upstream.headers.get('location')) break;
        let next;
        try { next = new URL(upstream.headers.get('location'), hop.href); } catch { return res.status(200).json(empty); }
        if (next.protocol !== 'http:' && next.protocol !== 'https:') return res.status(200).json(empty);
        if (isPrivateHost(next.hostname.toLowerCase())) return res.status(200).json(empty);
        hop = next;
      }
    } finally {
      clearTimeout(timeout);
    }

    if (!upstream.ok || !(upstream.headers.get('content-type') || '').includes('text/html') || !upstream.body) {
      res.setHeader('Cache-Control', 'public, max-age=300, s-maxage=3600');
      return res.status(200).json(empty);
    }

    // <head> is always near the top of the document — read chunks
    // until it closes (or a generous cap) instead of downloading a
    // page that might be megabytes of body content just for 3 tags.
    const reader = upstream.body.getReader();
    const decoder = new TextDecoder();
    let html = '';
    while (html.length < 300000) {
      const { done, value } = await reader.read();
      if (done) break;
      html += decoder.decode(value, { stream: true });
      if (/<\/head>/i.test(html)) break;
    }
    reader.cancel().catch(() => {});

    const metaContent = (prop) => {
      const patterns = [
        new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*content=["']([^"']*)["']`, 'i'),
        new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name)=["']${prop}["']`, 'i'),
      ];
      for (const re of patterns) {
        const m = re.exec(html);
        if (m) return decodeEntities(m[1]);
      }
      return null;
    };

    const titleTagMatch = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
    const titleTag = titleTagMatch ? decodeEntities(titleTagMatch[1]) : null;

    let image = metaContent('og:image') || metaContent('twitter:image') || metaContent('twitter:image:src');
    if (image) {
      try { image = new URL(image, target.href).href; } catch { image = null; }
      // Only ever hand back an http(s) image URL — data: URIs etc.
      // aren't a "photo from the site", just something a page happened
      // to put in that meta tag.
      if (image && !/^https?:\/\//i.test(image)) image = null;
    }

    const title = (metaContent('og:title') || titleTag || '').trim().slice(0, 300) || null;
    const description = (metaContent('og:description') || metaContent('description') || '').trim().slice(0, 400) || null;

    res.setHeader('Cache-Control', 'public, max-age=3600, s-maxage=86400, stale-while-revalidate=604800');
    return res.status(200).json({ url: target.href, domain, title, description, image });
  } catch {
    res.setHeader('Cache-Control', 'public, max-age=60, s-maxage=300');
    return res.status(200).json(empty);
  }
}

function decodeEntities(str) {
  return str
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&#x27;/gi, "'");
}
