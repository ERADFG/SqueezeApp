// /api/thread/[id].js
//
// Server-renders a single thread as a real, crawlable HTML page:
// full OP text + top comments in the initial HTML (no JS required to
// read it), unique <title>/description per thread, Open Graph/Twitter
// tags, and schema.org DiscussionForumPosting structured data — the
// same markup type that lets Reddit/Quora threads surface in Google's
// "Discussions and forums" results for question-style searches.
//
// After the crawlable content, the page hands off to the existing SPA
// (interactink.html) so a human visitor gets the full interactive app.
// This is the same "SSR shell + client hydration" pattern most
// SEO-crawlable SPAs use — the bot sees content, the user sees the app.
//
// Route this at /thread/:id via vercel.json (see snippet at bottom of
// this file / the README). Uses the SAME quality bar as
// sitemap-threads.js so we never 200+index a thread that isn't in the
// sitemap, and never link a thread from the sitemap that 404s here.

const SUPABASE_URL = process.env.SUPABASE_URL || "https://xdshsodkuyawljzuirqt.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_ANON_KEY;
const DOMAIN = "https://interactink.vercel.app";
const MIN_QUALITY_CHARS = 40; // must match sitemap-threads.js
const MAX_COMMENTS_IN_HTML = 25; // enough for crawlers + rich results, cheap to render

const BOARDS = {
  b:    { label: '/b/',    name: 'Random' },
  q:    { label: '/q/',    name: 'Questions' },
  g:    { label: '/g/',    name: 'Technology' },
  v:    { label: '/v/',    name: 'Gaming' },
  mu:   { label: '/mu/',   name: 'Music' },
  mo:   { label: '/mo/',   name: 'Movies & Anime' },
  sp:   { label: '/sp/',   name: 'Sports' },
  fit:  { label: '/fit/',  name: 'Fitness' },
  biz:  { label: '/biz/',  name: 'Business' },
  sci:  { label: '/sci/',  name: 'Science' },
  his:  { label: '/his/',  name: 'History' },
  pol:  { label: '/pol/',  name: 'Politics' },
  lit:  { label: '/lit/',  name: 'Books' },
  trv:  { label: '/trv/',  name: 'Travel' },
  adv:  { label: '/adv/',  name: 'Advice' },
  rel:  { label: '/rel/',  name: 'Relationships' },
  news: { label: '/news/', name: 'News' },
  conf: { label: '/conf/', name: 'Confessions' },
  diy:  { label: '/look/', name: 'Lookism' },
  deb:  { label: '/deb/',  name: 'Debate' },
};

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function truncate(str, n) {
  const s = String(str || '').trim();
  if (s.length <= n) return s;
  return s.slice(0, n - 1).trimEnd() + '…';
}

async function sbFetch(path) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` },
  });
  if (!res.ok) throw new Error(`Supabase fetch failed: ${res.status}`);
  return res.json();
}

module.exports = async (req, res) => {
  const id = (req.query && req.query.id) || (req.params && req.params.id);

  if (!id) {
    res.status(400).send('Missing thread id');
    return;
  }

  try {
    const threads = await sbFetch(
      `threads?id=eq.${encodeURIComponent(id)}&select=*&limit=1`
    );
    const thread = threads && threads[0];

    // Same quality bar as the sitemap: unapproved or too-thin threads
    // don't get an indexable page. 404 (not 200+noindex) so we don't
    // waste crawl budget or confuse Search Console with soft 404s.
    if (
      !thread ||
      thread.moderation_status !== 'approved' ||
      (thread.content || '').length < MIN_QUALITY_CHARS
    ) {
      res.status(404).setHeader('Content-Type', 'text/html; charset=utf-8').send(
        renderNotFound()
      );
      return;
    }

    const comments = await sbFetch(
      `comments?thread_id=eq.${encodeURIComponent(id)}&select=*&order=timestamp.asc&limit=${MAX_COMMENTS_IN_HTML}`
    );

    const commentCountRows = await sbFetch(
      `comments?thread_id=eq.${encodeURIComponent(id)}&select=id`
    );
    const commentCount = (commentCountRows || []).length;

    const board = BOARDS[thread.board_id] || BOARDS.b;
    const url = `${DOMAIN}/thread/${thread.id}`;
    const displayTitle = thread.title && thread.title.trim()
      ? thread.title.trim()
      : truncate(thread.content, 60);
    const pageTitle = `${displayTitle} — ${board.label} ${board.name} | InteractInk`;
    const description = truncate(thread.content, 155);
    const publishedISO = new Date(thread.timestamp).toISOString();

    const html = renderThreadPage({
      thread, comments, board, url, pageTitle, description, publishedISO,
      displayTitle, commentCount,
    });

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Edge-cache like the sitemap does; revalidate in the background so
    // new replies show up without hammering Supabase per-request.
    res.setHeader('Cache-Control', 'public, s-maxage=600, stale-while-revalidate=86400');
    res.status(200).send(html);
  } catch (err) {
    res.status(500).setHeader('Content-Type', 'text/plain').send('Thread render failed');
  }
};

function renderNotFound() {
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="UTF-8">
<title>Thread not found | InteractInk</title>
<meta name="robots" content="noindex">
</head><body><h1>Thread not found</h1>
<p><a href="${DOMAIN}/">Back to InteractInk</a></p></body></html>`;
}

function renderThreadPage({ thread, comments, board, url, pageTitle, description, publishedISO, displayTitle, commentCount }) {
  const commentsHTML = (comments || []).map((c) => `
      <li itemprop="comment" itemscope itemtype="https://schema.org/Comment">
        <div class="c-meta">
          <span itemprop="author" itemscope itemtype="https://schema.org/Person">
            <span itemprop="name">${esc(c.tripcode || 'Anonymous')}</span>
          </span>
          <time itemprop="dateCreated" datetime="${new Date(c.timestamp).toISOString()}">${new Date(c.timestamp).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })}</time>
        </div>
        <p itemprop="text">${esc(c.text)}</p>
      </li>`).join('\n');

  const jsonLd = {
    "@context": "https://schema.org",
    "@type": "DiscussionForumPosting",
    "headline": displayTitle,
    "text": thread.content,
    "url": url,
    "datePublished": publishedISO,
    "author": { "@type": "Person", "name": "Anonymous" },
    "interactionStatistic": [
      {
        "@type": "InteractionCounter",
        "interactionType": "https://schema.org/CommentAction",
        "userInteractionCount": commentCount,
      },
      {
        "@type": "InteractionCounter",
        "interactionType": "https://schema.org/LikeAction",
        "userInteractionCount": thread.upvotes || 0,
      },
    ],
    "comment": (comments || []).slice(0, 10).map((c) => ({
      "@type": "Comment",
      "text": c.text,
      "dateCreated": new Date(c.timestamp).toISOString(),
      "author": { "@type": "Person", "name": c.tripcode || "Anonymous" },
    })),
  };

  const breadcrumbLd = {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    "itemListElement": [
      { "@type": "ListItem", "position": 1, "name": "InteractInk", "item": `${DOMAIN}/` },
      { "@type": "ListItem", "position": 2, "name": `${board.label} ${board.name}`, "item": `${DOMAIN}/interactink.html?board=${board_id_safe(board)}` },
      { "@type": "ListItem", "position": 3, "name": displayTitle, "item": url },
    ],
  };

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(pageTitle)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${url}">
<meta name="robots" content="index, follow">

<meta property="og:type" content="article">
<meta property="og:site_name" content="InteractInk">
<meta property="og:title" content="${esc(displayTitle)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${url}">
<meta property="og:image" content="${DOMAIN}/favicon2.png">
<meta property="article:published_time" content="${publishedISO}">

<meta name="twitter:card" content="summary">
<meta name="twitter:title" content="${esc(displayTitle)}">
<meta name="twitter:description" content="${esc(description)}">
<meta name="twitter:image" content="${DOMAIN}/favicon2.png">

<link rel="icon" type="image/png" href="${DOMAIN}/favicon2.png">

<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>
<script type="application/ld+json">${JSON.stringify(breadcrumbLd)}</script>

<style>
  body{background:#000;color:#e7e9ea;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;max-width:680px;margin:0 auto;padding:16px;line-height:1.5}
  .board-tag{color:#10b981;font-weight:700;font-size:12px;text-transform:uppercase;font-family:ui-monospace,Menlo,monospace}
  h1{font-size:20px;margin:8px 0 12px}
  .op-body{white-space:pre-wrap;word-break:break-word;border-bottom:1px solid #2f3336;padding-bottom:16px;margin-bottom:16px}
  ul.comments{list-style:none;padding:0;margin:0}
  ul.comments li{border-bottom:1px solid #1a1a1a;padding:10px 0}
  .c-meta{font-size:12px;color:#71767b;font-family:ui-monospace,Menlo,monospace;margin-bottom:4px}
  .c-meta time{margin-left:8px}
  a.back{color:#10b981;text-decoration:none;font-size:14px;display:inline-block;margin-bottom:16px}
  a.open-app{display:inline-block;margin-top:20px;background:#10b981;color:#000;font-weight:700;padding:10px 16px;border-radius:20px;text-decoration:none}
</style>
</head>
<body itemscope itemtype="https://schema.org/DiscussionForumPosting">
  <a class="back" href="${DOMAIN}/interactink.html?board=${board_id_safe(board)}">&larr; ${esc(board.label)} ${esc(board.name)}</a>
  <span class="board-tag">${esc(board.label)}</span>
  <h1 itemprop="headline">${esc(displayTitle)}</h1>
  <p class="op-body" itemprop="text">${esc(thread.content)}</p>

  <ul class="comments">
    ${commentsHTML || '<li><em>No replies yet.</em></li>'}
  </ul>

  <a class="open-app" href="${DOMAIN}/interactink.html?board=${board_id_safe(board)}&thread=${esc(thread.id)}">Reply on InteractInk &rarr;</a>

  <script>
    // Progressive enhancement only: crawlers and no-JS visitors already
    // have the full content above. JS visitors get bounced straight
    // into the live app for the interactive experience.
    if (!navigator.userAgent.match(/bot|crawl|spider|slurp|googlebot|bingbot/i)) {
      location.replace(${JSON.stringify(`${DOMAIN}/interactink.html?board=`)} + ${JSON.stringify(board_id_safe(board))} + ${JSON.stringify('&thread=')} + ${JSON.stringify(String((thread||{}).id||''))});
    }
  </script>
</body>
</html>`;
}

function board_id_safe(board) {
  // board object doesn't carry its own id key in this map; recover it
  // by reverse lookup so URLs stay correct.
  const entry = Object.entries(BOARDS).find(([, v]) => v === board);
  return entry ? entry[0] : 'b';
}

/*
=====================================================================
vercel.json — add this rewrite (alongside your existing sitemap ones)
=====================================================================
{
  "rewrites": [
    { "source": "/thread/:id", "destination": "/api/thread/:id" },
    { "source": "/sitemap.xml", "destination": "/api/sitemap.js" },
    { "source": "/sitemap-pages.xml", "destination": "/sitemap-pages.xml" },
    { "source": "/sitemap-threads.xml", "destination": "/api/sitemap-threads.js" }
  ]
}
=====================================================================
*/