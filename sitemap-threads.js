// /api/sitemap-threads.js
// Serves a sitemap of every thread, reachable at the clean URL
// /sitemap-threads.xml (see the rewrite in vercel.json).
//
// Only threads that pass the same quality bar used by /api/thread/[id].js
// are included, so we never submit a URL to Google that we've marked
// noindex on the page itself (Search Console flags that as a conflict).
// Capped at 45,000 URLs per file, under the 50,000/file sitemap protocol
// limit — if InteractInk ever grows past that, this needs to be split
// into multiple sitemap-threads-N.xml files behind a sitemap index.

const SUPABASE_URL = process.env.SUPABASE_URL || "https://xdshsodkuyawljzuirqt.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhkc2hzb2RrdXlhd2xqenVpcnF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyMjkyMTEsImV4cCI6MjA5ODgwNTIxMX0.9ozQK1_Dc6_1hjP7HP-Z0dBcSOT-Ook8riBGabRW2Rs";
const DOMAIN = "https://interactink.vercel.app";
const MIN_QUALITY_CHARS = 40;
const MAX_URLS = 45000;

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status}`);
  return res.json();
}

module.exports = async (req, res) => {
  try {
    const threads = await sbFetch(
      `threads?select=id,content,timestamp&order=timestamp.desc&limit=${MAX_URLS}`
    );

    const qualityThreads = (threads || []).filter(
      (t) => (t.content || "").length >= MIN_QUALITY_CHARS
    );

    const urls = qualityThreads
      .map(
        (t) => `
  <url>
    <loc>${DOMAIN}/thread/${t.id}</loc>
    <lastmod>${new Date(t.timestamp).toISOString()}</lastmod>
  </url>`
      )
      .join("");

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    // Cache at the edge for 30 min, serve stale for up to a day while revalidating,
    // so this stays fast without hitting Supabase on every single crawl request.
    res.setHeader("Cache-Control", "public, s-maxage=1800, stale-while-revalidate=86400");
    res.status(200).send(
      `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls}\n</urlset>`
    );
  } catch (err) {
    res.status(500).setHeader("Content-Type", "text/plain").send("Sitemap generation failed");
  }
};
