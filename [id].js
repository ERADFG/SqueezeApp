// /api/thread/[id].js
// Server-renders a real, crawlable page for a single thread so Google can
// index individual posts. Reached via the clean URL /thread/:id (see the
// rewrite in vercel.json) so there's exactly one canonical URL per thread.
//
// Quality gate: threads with very little real content are still served
// (so no broken links / no fake 404s) but are marked noindex, so they
// don't get counted toward "thin content" site-wide quality signals.
// Deleted / nonexistent threads return a real HTTP 404.

const SUPABASE_URL = process.env.SUPABASE_URL || "https://xdshsodkuyawljzuirqt.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY || "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inhkc2hzb2RrdXlhd2xqenVpcnF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMyMjkyMTEsImV4cCI6MjA5ODgwNTIxMX0.9ozQK1_Dc6_1hjP7HP-Z0dBcSOT-Ook8riBGabRW2Rs";
const DOMAIN = "https://interactink.vercel.app";
const MIN_QUALITY_CHARS = 40; // threads shorter than this are served but noindexed

function esc(str = "") {
  return String(str).replace(/[&<>"']/g, (m) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#x27;" }[m]
  ));
}

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status}`);
  return res.json();
}

function render404() {
  return `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">
<title>Thread Not Found - InteractInk</title>
<meta name="robots" content="noindex">
<style>body{background:#000;color:#e7e9ea;font-family:sans-serif;text-align:center;padding:80px 20px}
a{color:#3b82f6}</style></head><body>
<h1>Thread not found</h1>
<p>This thread doesn't exist or was removed.</p>
<p><a href="${DOMAIN}/index.html">Back to InteractInk</a></p>
</body></html>`;
}

function renderThread(thread, comments) {
  const title = esc(thread.title || "Anonymous");
  const bodyText = esc(thread.content || "");
  const url = `${DOMAIN}/thread/${thread.id}`;
  const dateISO = new Date(thread.timestamp).toISOString();
  const description = (thread.content || "").slice(0, 155).replace(/\s+/g, " ").trim();
  const isQuality = (thread.content || "").length >= MIN_QUALITY_CHARS;
  const robotsTag = isQuality ? "index, follow" : "noindex, follow";

  const commentsHTML = comments.length
    ? comments
        .map(
          (c) => `<div class="comment">
            <div class="meta">${esc(c.tripcode)} &middot; ${new Date(c.timestamp).toLocaleString()}</div>
            <div class="text">${esc(c.text)}</div>
          </div>`
        )
        .join("\n")
    : `<p class="muted">No replies yet.</p>`;

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "DiscussionForumPosting",
    headline: thread.title || "Anonymous thread",
    text: thread.content || "",
    url,
    datePublished: dateISO,
    author: { "@type": "Person", name: "Anonymous" },
    interactionStatistic: {
      "@type": "InteractionCounter",
      interactionType: "https://schema.org/ReplyAction",
      userInteractionCount: comments.length,
    },
    isPartOf: { "@type": "WebSite", name: "InteractInk", url: `${DOMAIN}/` },
  };

  return `<!DOCTYPE html><html lang="en"><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title} - InteractInk</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="${robotsTag}">
<meta property="og:type" content="article">
<meta property="og:site_name" content="InteractInk">
<meta property="og:title" content="${title} - InteractInk">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<style>
  body{background:#000;color:#e7e9ea;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:640px;margin:0 auto;padding:24px 16px;line-height:1.6}
  a{color:#3b82f6;text-decoration:underline}
  h1{font-size:1.2rem;margin-bottom:4px}
  .meta{color:#71767b;font-size:0.8rem;margin-bottom:20px}
  .op{border:1px solid #262626;border-radius:12px;padding:16px;margin-bottom:24px;white-space:pre-wrap;word-wrap:break-word}
  .comment{border-top:1px solid #262626;padding:12px 0}
  .comment .meta{margin-bottom:4px}
  .comment .text{white-space:pre-wrap;word-wrap:break-word}
  .muted{color:#71767b}
  .cta{display:inline-block;margin-top:24px;padding:10px 18px;background:#fff;color:#000;border-radius:999px;text-decoration:none;font-weight:700;font-size:0.9rem}
  nav{margin-bottom:24px;font-size:0.85rem}
</style>
</head><body>
<nav><a href="${DOMAIN}/index.html">&larr; InteractInk Home</a></nav>
<h1>${title}</h1>
<div class="meta">Thread &gt;&gt;${esc(thread.id)} &middot; ${new Date(thread.timestamp).toLocaleString()} &middot; ${comments.length} ${comments.length === 1 ? "reply" : "replies"}</div>
<div class="op">${bodyText}</div>
<h2 style="font-size:1rem;">Replies</h2>
${commentsHTML}
<a class="cta" href="${DOMAIN}/index.html?thread=${esc(thread.id)}">Reply on InteractInk</a>
</body></html>`;
}

module.exports = async (req, res) => {
  const { id } = req.query;
  if (!id || !/^[a-f0-9]{6,10}$/i.test(id)) {
    res.status(404).setHeader("Content-Type", "text/html").send(render404());
    return;
  }

  try {
    const threads = await sbFetch(`threads?id=eq.${encodeURIComponent(id)}&select=*`);
    const thread = threads && threads[0];
    if (!thread) {
      res.status(404).setHeader("Content-Type", "text/html").send(render404());
      return;
    }
    const comments = await sbFetch(
      `comments?thread_id=eq.${encodeURIComponent(id)}&select=*&order=timestamp.asc`
    );

    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.setHeader("Cache-Control", "public, s-maxage=300, stale-while-revalidate=600");
    res.status(200).send(renderThread(thread, comments || []));
  } catch (err) {
    res.status(500).setHeader("Content-Type", "text/html").send(
      `<h1>Something went wrong</h1><p><a href="${DOMAIN}/index.html">Back to InteractInk</a></p>`
    );
  }
};
