// /api/sitemap-threads.js
// Auto-generates a sitemap covering every real thread as a URL, straight
// from the live database — no manual maintenance, never stale, and never
// references a thread that doesn't exist. Reached via the clean URL
// /sitemap-threads.xml (see rewrite in vercel.json).
//
// Quality gate: only threads with real content (>= MIN_QUALITY_CHARS) are
// included. This is deliberate — indexing every one-line/spam post would
// dilute the whole domain's quality signal in Google and hurt rankings
// site-wide, not just for the thin pages. Better a smaller, clean sitemap
// than a bloated, low-quality one.
//
// Capped well under the 50,000 URL / 50MB sitemap protocol limit; if the
// board grows past that, split into sitemap-threads-1.xml, -2.xml, etc.
// behind a sitemap index.

const SUPABASE_URL = process.env.SUPABASE_URL || "https://xdshsodkuyawljzuirqt.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhkc2hzb2RrdXlhd2xqenVpcnF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyMjkyMTEsImV4cCI6MjA5ODgwNTIxMX0.9ozQK1_Dc6_1hjP7HP-Z0dBcSOT-Ook8riBGabRW2Rs";
const DOMAIN = "https://interactink.vercel.app";
const MIN_QUALITY_CHARS = 40;
const MAX_URLS = 45000;

module.exports = async (req, res) => {
  try {
    const url = `${SUPABASE_URL}/rest/v1/threads?select=id,content,timestamp&order=timestamp.desc&limit=${MAX_URLS}`;
    const r = await fetch(url, {
      headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
    });
    if (!r.ok) throw new Error(`Supabase error ${r.status}`);
    const threads = await r.json();

    const quality = threads.filter((t) => (t.content || "").trim().length >= MIN_QUALITY_CHARS);

    const body = quality
      .map((t) => {
        const lastmod = new Date(t.timestamp).toISOString().slice(0, 10);
        return `  <url>\n    <loc>${DOMAIN}/thread/${t.id}</loc>\n    <lastmod>${lastmod}</lastmod>\n    <changefreq>weekly</changefreq>\n    <priority>0.5</priority>\n  </url>`;
      })
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${body}\n</urlset>\n`;

    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=3600, stale-while-revalidate=7200");
    res.status(200).send(xml);
  } catch (err) {
    res.status(500).setHeader("Content-Type", "text/plain").send("Sitemap temporarily unavailable");
  }
};
