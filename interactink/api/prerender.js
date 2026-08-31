// ─────────────────────────────────────────────────────────────
// SERVER-RENDERED CONTENT PAGES.
//
// Wired up in vercel.json: EVERY request (not just recognized bots)
// to "/", "/home", "/i/status/:id", "/:username/status/:id",
// "/:username" (profile), "/communities/:slug", "/i/lists/:id", and
// "/i/articles/:id" is rewritten here instead of being served the
// static index.html/thread.html/profile.html/community.html/
// list.html/article.html directly.
//
// WHY THIS EXISTS: index.html/thread.html are otherwise empty shells
// until js/board.js / js/thread.js run in the browser and fetch the
// real content from Supabase client-side. That's invisible to a
// human, but it means anything that doesn't execute JS — most
// crawlers, link-unfurl bots (Slack, Discord, WhatsApp, iMessage,
// Telegram), and Googlebot's non-JS first indexing pass — sees a
// "Loading posts…" spinner and generic <title>/<meta>, not the post.
//
// HOW IT WORKS: this reads the *real* index.html / thread.html file
// (the same one the browser gets) and does a handful of targeted
// string replacements — unique <title>/<meta>/canonical/OG tags, and
// a JSON-LD block — using data fetched from Supabase server-side.
// Every original <script> tag is left in place, so once the page
// loads in a real browser, js/board.js / js/thread.js runs exactly
// as before and takes over (live updates, interactive buttons, etc).
//
// The loading spinner (#feed-posts / #profile-root / #thread-root)
// is deliberately left untouched rather than swapped for real markup:
// this file's response goes to every visitor, not just crawlers, so
// replacing the spinner with plain unstyled HTML meant a real person
// would see that flash on screen for a moment before board.js/
// profile.js/thread.js loaded and replaced it with the styled version
// — looked like a glitch. Instead, the real content this file exists
// to serve to crawlers goes in a visually-hidden sibling right after
// the spinner (see insertHiddenSeoBlock) — present in the HTML source
// for anything reading raw markup, invisible on screen either way.
//
// This used to run only for requests whose User-Agent matched a
// known bot/crawler pattern ("dynamic rendering") — that was fragile
// (any crawler not on the list got nothing) and meant two divergent
// code paths (this file vs. thread.js) to keep in sync. Serving the
// same real template to everyone removes both problems.
// ─────────────────────────────────────────────────────────────

const fs = require('fs');
const path = require('path');

const SUPABASE_URL = 'https://pyitivzoqleukuclajrf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5aXRpdnpvcWxldWt1Y2xhanJmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5Nzg0ODcsImV4cCI6MjEwMTU1NDQ4N30.gKvqOaAREY5wcptIv7OHfjHhZR5ogIaMY8I98jHRmFs';

function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

async function sbGet(tbl, query) {
  const url = `${SUPABASE_URL}/rest/v1/${tbl}?${query}`;
  let resp;
  try {
    resp = await fetch(url, {
      headers: { apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
    });
  } catch (e) {
    console.error(`sbGet(${tbl}) network error:`, e.message, '| url:', url);
    return null;
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '<unreadable body>');
    console.error(`sbGet(${tbl}) failed: ${resp.status} ${resp.statusText} | url: ${url} | body: ${body}`);
    return null;
  }
  const data = await resp.json();
  if (!Array.isArray(data)) {
    console.error(`sbGet(${tbl}) unexpected non-array response | url: ${url} | body:`, data);
    return null;
  }
  return data;
}

// Row-count-only query (no rows fetched) via PostgREST's exact-count
// header — same idea as the `{ count: 'exact', head: true }` calls in
// js/auth.js/js/thread.js, just over the raw REST API since this file
// runs server-side without the supabase-js client.
async function sbCount(tbl, query) {
  const url = `${SUPABASE_URL}/rest/v1/${tbl}?${query}&select=id&limit=1`;
  let resp;
  try {
    resp = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY, Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Prefer: 'count=exact',
      },
    });
  } catch (e) {
    console.error(`sbCount(${tbl}) network error:`, e.message, '| url:', url);
    return 0;
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '<unreadable body>');
    console.error(`sbCount(${tbl}) failed: ${resp.status} ${resp.statusText} | url: ${url} | body: ${body}`);
    return 0;
  }
  const range = resp.headers.get('content-range'); // "0-0/42"
  const total = range && range.split('/')[1];
  if (!total || total === '*') {
    console.error(`sbCount(${tbl}) missing/unparseable content-range header | url: ${url} | header: ${range}`);
  }
  return total && total !== '*' ? parseInt(total, 10) || 0 : 0;
}

// Reads a static HTML file from the deployed project. Both index.html
// and thread.html ship alongside this function in the same deployment,
// so they're available on disk at request time — this is what lets us
// template the *real* page instead of hand-building a lookalike one.
function readTemplate(file) {
  return fs.readFileSync(path.join(process.cwd(), file), 'utf8');
}

// Replaces the first (and, for these templates, only) occurrence of
// `line` with `replacement`. Throws loudly if the anchor text isn't
// found, so a future edit to index.html/thread.html that changes this
// text breaks the build instead of silently serving stale meta tags.
function replaceLine(html, line, replacement) {
  if (!html.includes(line)) {
    throw new Error(`prerender template anchor not found: ${JSON.stringify(line)}`);
  }
  return html.replace(line, replacement);
}

function injectHead(html, extra) {
  return html.replace('</head>', `${extra}\n</head>`);
}

// Inserts crawler-readable markup right after `anchor` (one of the
// #feed-posts/#profile-root/#thread-root loading-spinner divs) instead
// of replacing that div's contents. The spinner div is left exactly as
// shipped, so a real visitor's browser keeps showing the normal styled
// loading state — same as if this function didn't run at all — right
// up until board.js/profile.js/thread.js swaps in the live, interactive
// version a moment later. This block is only there for the (mostly
// non-JS) crawlers/link-unfurl bots this file exists for; it's visually
// hidden (the same .sr-only pattern used elsewhere on these pages) and
// `aria-hidden` so it never flashes on screen and screen readers don't
// announce it as duplicate content once the real version has loaded in.
function insertHiddenSeoBlock(html, anchor, innerHtml) {
  if (!html.includes(anchor)) {
    throw new Error(`prerender template anchor not found: ${JSON.stringify(anchor)}`);
  }
  return html.replace(anchor, `${anchor}\n<div class="sr-only" aria-hidden="true">${innerHtml}</div>`);
}

// JSON.stringify does NOT escape "</script>" — a post body containing
// that literal string would otherwise close the JSON-LD <script> tag
// early and let the rest of the "JSON" be parsed as raw HTML/script.
// Escaping "<" as \u003c (valid inside a JSON string, and inert in
// HTML) neutralizes that without changing the JSON-LD's meaning.
function jsonLdScriptTag(obj) {
  const json = JSON.stringify(obj).replace(/</g, '\\u003c');
  return `<script type="application/ld+json">${json}</script>`;
}

// ── HOME ("/", "/home") ──

async function renderHome(origin) {
  const posts = await sbGet('posts',
    `is_deleted=eq.false&select=id,body,created_at,like_count,reply_count,repost_count,profile:profiles!posts_author_id_fkey(username,display_name,avatar_url)&order=created_at.desc&limit=30`) || [];

  let html = readTemplate('index.html');

  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    url: origin + '/', name: 'InteractInk',
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: posts.map((p, i) => ({
        '@type': 'ListItem', position: i + 1,
        url: p.profile?.username
          ? `${origin}/${encodeURIComponent(p.profile.username)}/status/${encodeURIComponent(p.id)}`
          : `${origin}/i/status/${encodeURIComponent(p.id)}`,
      })),
    },
  };

  const postsHtml = posts.map(p => {
    const uname = p.profile?.username;
    const href = uname
      ? `${origin}/${encodeURIComponent(uname)}/status/${encodeURIComponent(p.id)}`
      : `${origin}/i/status/${encodeURIComponent(p.id)}`;
    return `<article>
  <a href="${href}"><strong>${esc(p.profile?.display_name || uname || 'unknown')}</strong> @${esc(uname || 'unknown')}</a>
  &middot; <small>${new Date(p.created_at).toLocaleString()}</small>
  <p><a href="${href}">${esc((p.body || '').slice(0, 280))}</a></p>
  <small>${p.like_count || 0} likes &middot; ${p.reply_count || 0} replies &middot; ${p.repost_count || 0} reposts</small>
</article>`;
  }).join('\n');

  // index.html already ships a generic WebSite JSON-LD block — this
  // adds a second, more specific block alongside it rather than
  // replacing it (multiple JSON-LD <script> tags on one page is
  // valid and is how most sites layer WebSite + page-specific data).
  html = injectHead(html, jsonLdScriptTag(jsonLd));

  html = insertHiddenSeoBlock(html,
    '<div id="feed-posts">',
    postsHtml || '<p>No posts yet.</p>');

  return { status: 200, html };
}

// ── PROFILE ("/:username") ──

async function renderProfile(origin, username) {
  let html = readTemplate('profile.html');

  const profiles = await sbGet('profiles', `username=ilike.${encodeURIComponent(username)}&select=*`);
  const profile = profiles && profiles[0];

  if (!profile) {
    html = replaceLine(html, '<title>Profile — InteractInk</title>', '<title>User not found — InteractInk</title>');
    html = replaceLine(html,
      "<meta name=\"description\" content=\"A user's profile on InteractInk — their posts, bio, and activity.\">",
      '<meta name="description" content="No user found with that username.">');
    html = injectHead(html, '<meta name="robots" content="noindex">');
    html = insertHiddenSeoBlock(html,
      '<div id="profile-root">',
      '<p>No user found with that username.</p>');
    return { status: 404, html };
  }

  const canonical = `${origin}/${encodeURIComponent(profile.username)}`;
  // "Posts" counts replies too (see loadReplyCountIntoStat() in
  // js/profile.js) — profiles.posts_count only tracks top-level posts,
  // so add the reply count here for the same total the live page shows.
  // Both queries only depend on profile.id, not on each other, so they
  // run concurrently instead of as two sequential round-trips to
  // Supabase — this was previously adding a full extra RTT (~100-300ms)
  // to every profile page's TTFB for no reason.
  const [posts, replyCount] = await Promise.all([
    sbGet('posts', `author_id=eq.${profile.id}&is_deleted=eq.false&select=id,body,created_at&order=created_at.desc&limit=20`).then(r => r || []),
    sbCount('replies', `author_id=eq.${profile.id}&is_deleted=eq.false`),
  ]);
  const totalPostsCount = (profile.posts_count || 0) + replyCount;

  const titleText = `${profile.display_name || profile.username} (@${profile.username}) — InteractInk`;
  const descText = (profile.bio || `@${profile.username}'s posts on InteractInk.`).slice(0, 200);
  const image = profile.avatar_url || '/img/logo-light.png';

  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'ProfilePage',
    dateCreated: profile.created_at, url: canonical,
    mainEntity: {
      '@type': 'Person', name: profile.display_name || profile.username,
      alternateName: profile.username, description: profile.bio || undefined,
      image: profile.avatar_url || undefined, url: canonical,
    },
  };

  const postsHtml = posts.map(p => `<li><a href="${origin}/${encodeURIComponent(profile.username)}/status/${encodeURIComponent(p.id)}">${esc((p.body || '').slice(0, 140))}</a> <small>(${new Date(p.created_at).toLocaleDateString()})</small></li>`).join('\n');

  const profileRootHtml = `<article>
  <h1>${esc(profile.display_name || profile.username)}</h1>
  <p>@${esc(profile.username)}</p>
  ${profile.bio ? `<p>${esc(profile.bio)}</p>` : ''}
  <small>Joined ${new Date(profile.created_at).toLocaleDateString()} &middot; ${profile.followers_count || 0} followers &middot; ${profile.following_count || 0} following &middot; ${totalPostsCount} posts</small>
</article>
<h2 class="sr-only">Recent posts</h2>
<ul>${postsHtml || '<li>No posts yet.</li>'}</ul>`;

  html = replaceLine(html, '<title>Profile — InteractInk</title>', `<title>${esc(titleText)}</title>`);
  html = replaceLine(html,
    "<meta name=\"description\" content=\"A user's profile on InteractInk — their posts, bio, and activity.\">",
    `<meta name="description" content="${esc(descText)}">`);
  html = replaceLine(html,
    '<meta property="og:title" content="Profile — InteractInk">',
    `<meta property="og:title" content="${esc(titleText)}">`);
  html = replaceLine(html,
    "<meta property=\"og:description\" content=\"A user's profile on InteractInk — their posts, bio, and activity.\">",
    `<meta property="og:description" content="${esc(descText)}">`);
  html = replaceLine(html,
    '<meta property="og:image" content="/img/logo-light.png">',
    `<meta property="og:image" content="${esc(image)}">`);
  html = replaceLine(html,
    '<meta name="twitter:title" content="Profile — InteractInk">',
    `<meta name="twitter:title" content="${esc(titleText)}">`);
  html = replaceLine(html,
    "<meta name=\"twitter:description\" content=\"A user's profile on InteractInk — their posts, bio, and activity.\">",
    `<meta name="twitter:description" content="${esc(descText)}">`);
  html = replaceLine(html,
    '<meta name="twitter:image" content="/img/logo-light.png">',
    `<meta name="twitter:image" content="${esc(image)}">`);
  html = replaceLine(html, '<link rel="canonical">', `<link rel="canonical" href="${esc(canonical)}">`);
  html = replaceLine(html, '<meta property="og:url" content="">', `<meta property="og:url" content="${esc(canonical)}">`);

  html = injectHead(html, jsonLdScriptTag(jsonLd));

  html = insertHiddenSeoBlock(html,
    '<div id="profile-root">',
    profileRootHtml);

  return { status: 200, html };
}

// ── COMMUNITY ("/communities/:slug") ──

async function renderCommunity(origin, slug) {
  let html = readTemplate('community.html');

  const communities = await sbGet('communities', `slug=eq.${encodeURIComponent(slug)}&select=*`);
  const community = communities && communities[0];

  if (!community) {
    html = replaceLine(html, '<title>Community — InteractInk</title>', '<title>Community not found — InteractInk</title>');
    html = replaceLine(html,
      '<meta name="description" content="A community on InteractInk — join the conversation.">',
      '<meta name="description" content="No community found with that slug.">');
    html = injectHead(html, '<meta name="robots" content="noindex">');
    html = insertHiddenSeoBlock(html,
      '<div id="community-hero">',
      '<p>No community found with that slug.</p>');
    return { status: 404, html };
  }

  const canonical = `${origin}/communities/${encodeURIComponent(community.slug)}`;
  const posts = await sbGet('posts',
    `community_id=eq.${community.id}&is_deleted=eq.false&select=id,body,created_at,like_count,reply_count,repost_count,profile:profiles!posts_author_id_fkey(username,display_name,avatar_url)&order=created_at.desc&limit=20`) || [];

  const titleText = `${community.name} — InteractInk`;
  const descText = (community.description || `${community.name} — a community on InteractInk.`).slice(0, 200);
  const image = community.banner_url || community.avatar_url || '/img/logo-light.png';

  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    url: canonical, name: community.name, description: community.description || undefined,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: posts.map((p, i) => ({
        '@type': 'ListItem', position: i + 1,
        url: p.profile?.username
          ? `${origin}/${encodeURIComponent(p.profile.username)}/status/${encodeURIComponent(p.id)}`
          : `${origin}/i/status/${encodeURIComponent(p.id)}`,
      })),
    },
  };

  const postsHtml = posts.map(p => {
    const uname = p.profile?.username;
    const href = uname
      ? `${origin}/${encodeURIComponent(uname)}/status/${encodeURIComponent(p.id)}`
      : `${origin}/i/status/${encodeURIComponent(p.id)}`;
    return `<article>
  <a href="${href}"><strong>${esc(p.profile?.display_name || uname || 'unknown')}</strong> @${esc(uname || 'unknown')}</a>
  &middot; <small>${new Date(p.created_at).toLocaleString()}</small>
  <p><a href="${href}">${esc((p.body || '').slice(0, 280))}</a></p>
  <small>${p.like_count || 0} likes &middot; ${p.reply_count || 0} replies &middot; ${p.repost_count || 0} reposts</small>
</article>`;
  }).join('\n');

  const communityRootHtml = `<article>
  <h1>${esc(community.name)}</h1>
  ${community.description ? `<p>${esc(community.description)}</p>` : ''}
  <small>${community.member_count || 0} member${community.member_count === 1 ? '' : 's'} &middot; ${community.post_count || 0} post${community.post_count === 1 ? '' : 's'}</small>
</article>
<h2 class="sr-only">Recent posts</h2>
<ul>${postsHtml ? '' : '<li>No posts yet.</li>'}</ul>
${postsHtml}`;

  html = replaceLine(html, '<title>Community — InteractInk</title>', `<title>${esc(titleText)}</title>`);
  html = replaceLine(html,
    '<meta name="description" content="A community on InteractInk — join the conversation.">',
    `<meta name="description" content="${esc(descText)}">`);
  html = replaceLine(html,
    '<meta property="og:title" content="Community — InteractInk">',
    `<meta property="og:title" content="${esc(titleText)}">`);
  html = replaceLine(html,
    '<meta property="og:description" content="A community on InteractInk — join the conversation.">',
    `<meta property="og:description" content="${esc(descText)}">`);
  html = replaceLine(html,
    '<meta property="og:image" content="/img/logo-light.png">',
    `<meta property="og:image" content="${esc(image)}">`);
  html = replaceLine(html,
    '<meta name="twitter:title" content="Community — InteractInk">',
    `<meta name="twitter:title" content="${esc(titleText)}">`);
  html = replaceLine(html,
    '<meta name="twitter:description" content="A community on InteractInk — join the conversation.">',
    `<meta name="twitter:description" content="${esc(descText)}">`);
  html = replaceLine(html,
    '<meta name="twitter:image" content="/img/logo-light.png">',
    `<meta name="twitter:image" content="${esc(image)}">`);
  html = replaceLine(html, '<link rel="canonical">', `<link rel="canonical" href="${esc(canonical)}">`);
  html = replaceLine(html, '<meta property="og:url" content="">', `<meta property="og:url" content="${esc(canonical)}">`);

  html = injectHead(html, jsonLdScriptTag(jsonLd));

  html = insertHiddenSeoBlock(html,
    '<div id="community-hero">',
    communityRootHtml);

  return { status: 200, html };
}

// ── LIST ("/i/lists/:id") ──

async function renderList(origin, id) {
  let html = readTemplate('list.html');

  const lists = await sbGet('lists', `id=eq.${encodeURIComponent(id)}&select=*`);
  const list = lists && lists[0];

  // Private lists get the same "doesn't exist" treatment here as they
  // get in sitemap.js (excluded there via `.filter(l => !l.is_private)`)
  // — a crawler/link-unfurl bot shouldn't be able to discover a
  // private list's name/description/members through this route.
  if (!list || list.is_private) {
    html = replaceLine(html, '<title>List — InteractInk</title>', '<title>List not found — InteractInk</title>');
    html = replaceLine(html,
      '<meta name="description" content="A curated List on InteractInk — a merged timeline of its members\' posts.">',
      '<meta name="description" content="No List found with that id, or it&#39;s private.">');
    html = injectHead(html, '<meta name="robots" content="noindex">');
    html = insertHiddenSeoBlock(html,
      '<div id="list-hero">',
      "<p>No List found with that id, or it's private.</p>");
    return { status: 404, html };
  }

  const canonical = `${origin}/i/lists/${encodeURIComponent(list.id)}`;

  const memberRows = await sbGet('list_members', `list_id=eq.${list.id}&select=member_id`) || [];
  const memberIds = memberRows.map(r => r.member_id);

  const posts = memberIds.length
    ? (await sbGet('posts',
        `author_id=in.(${memberIds.map(m => encodeURIComponent(m)).join(',')})&is_deleted=eq.false&select=id,body,created_at,like_count,reply_count,repost_count,profile:profiles!posts_author_id_fkey(username,display_name,avatar_url)&order=created_at.desc&limit=20`) || [])
    : [];

  const titleText = `${list.name} — InteractInk`;
  const descText = (list.description || `${list.name} — a List on InteractInk.`).slice(0, 200);
  const image = list.banner_url || list.avatar_url || '/img/logo-light.png';

  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'CollectionPage',
    url: canonical, name: list.name, description: list.description || undefined,
    mainEntity: {
      '@type': 'ItemList',
      itemListElement: posts.map((p, i) => ({
        '@type': 'ListItem', position: i + 1,
        url: p.profile?.username
          ? `${origin}/${encodeURIComponent(p.profile.username)}/status/${encodeURIComponent(p.id)}`
          : `${origin}/i/status/${encodeURIComponent(p.id)}`,
      })),
    },
  };

  const postsHtml = posts.map(p => {
    const uname = p.profile?.username;
    const href = uname
      ? `${origin}/${encodeURIComponent(uname)}/status/${encodeURIComponent(p.id)}`
      : `${origin}/i/status/${encodeURIComponent(p.id)}`;
    return `<article>
  <a href="${href}"><strong>${esc(p.profile?.display_name || uname || 'unknown')}</strong> @${esc(uname || 'unknown')}</a>
  &middot; <small>${new Date(p.created_at).toLocaleString()}</small>
  <p><a href="${href}">${esc((p.body || '').slice(0, 280))}</a></p>
  <small>${p.like_count || 0} likes &middot; ${p.reply_count || 0} replies &middot; ${p.repost_count || 0} reposts</small>
</article>`;
  }).join('\n');

  const listRootHtml = `<article>
  <h1>${esc(list.name)}</h1>
  ${list.description ? `<p>${esc(list.description)}</p>` : ''}
  <small>${list.member_count || 0} member${list.member_count === 1 ? '' : 's'} &middot; ${list.follower_count || 0} follower${(list.follower_count || 0) === 1 ? '' : 's'}</small>
</article>
<h2 class="sr-only">Recent posts</h2>
<ul>${postsHtml ? '' : '<li>No posts yet.</li>'}</ul>
${postsHtml}`;

  html = replaceLine(html, '<title>List — InteractInk</title>', `<title>${esc(titleText)}</title>`);
  html = replaceLine(html,
    '<meta name="description" content="A curated List on InteractInk — a merged timeline of its members\' posts.">',
    `<meta name="description" content="${esc(descText)}">`);
  html = replaceLine(html,
    '<meta property="og:title" content="List — InteractInk">',
    `<meta property="og:title" content="${esc(titleText)}">`);
  html = replaceLine(html,
    '<meta property="og:description" content="A curated List on InteractInk — a merged timeline of its members\' posts.">',
    `<meta property="og:description" content="${esc(descText)}">`);
  html = replaceLine(html,
    '<meta property="og:image" content="/img/logo-light.png">',
    `<meta property="og:image" content="${esc(image)}">`);
  html = replaceLine(html,
    '<meta name="twitter:title" content="List — InteractInk">',
    `<meta name="twitter:title" content="${esc(titleText)}">`);
  html = replaceLine(html,
    '<meta name="twitter:description" content="A curated List on InteractInk — a merged timeline of its members\' posts.">',
    `<meta name="twitter:description" content="${esc(descText)}">`);
  html = replaceLine(html,
    '<meta name="twitter:image" content="/img/logo-light.png">',
    `<meta name="twitter:image" content="${esc(image)}">`);
  html = replaceLine(html, '<link rel="canonical">', `<link rel="canonical" href="${esc(canonical)}">`);
  html = replaceLine(html, '<meta property="og:url" content="">', `<meta property="og:url" content="${esc(canonical)}">`);

  html = injectHead(html, jsonLdScriptTag(jsonLd));

  html = insertHiddenSeoBlock(html,
    '<div id="list-hero">',
    listRootHtml);

  return { status: 200, html };
}

// ── ARTICLE ("/i/articles/:id") ──

async function renderArticle(origin, id) {
  let html = readTemplate('article.html');

  const articles = await sbGet('articles', `id=eq.${encodeURIComponent(id)}&is_deleted=eq.false&select=*`);
  const article = articles && articles[0];

  if (!article) {
    html = replaceLine(html, '<title>Article — InteractInk</title>', '<title>Article not found — InteractInk</title>');
    html = replaceLine(html,
      '<meta name="description" content="An article written by an InteractInk user.">',
      '<meta name="description" content="No Article found with that id.">');
    html = injectHead(html, '<meta name="robots" content="noindex">');
    html = insertHiddenSeoBlock(html,
      '<div id="article-content">',
      "<p>No Article found with that id.</p>");
    return { status: 404, html };
  }

  const canonical = `${origin}/i/articles/${encodeURIComponent(article.id)}`;

  const authors = await sbGet('profiles', `id=eq.${encodeURIComponent(article.author_id)}&select=username,display_name,avatar_url`);
  const author = authors && authors[0];

  const titleText = `${article.title} — InteractInk`;
  const descText = (article.body || '').replace(/\s+/g, ' ').trim().slice(0, 200);
  const image = article.cover_url || '/img/logo-light.png';

  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'Article',
    headline: article.title, articleBody: article.body,
    datePublished: article.created_at, dateModified: article.updated_at,
    url: canonical, image: article.cover_url || undefined,
    author: author ? { '@type': 'Person', name: author.display_name || author.username } : undefined,
  };

  const authorHref = author ? `${origin}/${encodeURIComponent(author.username)}` : null;
  const articleRootHtml = `<article>
  <h1>${esc(article.title)}</h1>
  ${author ? `<p><a href="${authorHref}">${esc(author.display_name || author.username)} @${esc(author.username)}</a> &middot; <small>${new Date(article.created_at).toLocaleString()}</small></p>` : ''}
  <div>${esc(article.body).split('\n').map(line => `<p>${line}</p>`).join('\n')}</div>
</article>`;

  html = replaceLine(html, '<title>Article — InteractInk</title>', `<title>${esc(titleText)}</title>`);
  html = replaceLine(html,
    '<meta name="description" content="An article written by an InteractInk user.">',
    `<meta name="description" content="${esc(descText)}">`);
  html = replaceLine(html,
    '<meta property="og:title" content="Article — InteractInk">',
    `<meta property="og:title" content="${esc(titleText)}">`);
  html = replaceLine(html,
    '<meta property="og:description" content="An article written by an InteractInk user.">',
    `<meta property="og:description" content="${esc(descText)}">`);
  html = replaceLine(html,
    '<meta property="og:image" content="/img/logo-light.png">',
    `<meta property="og:image" content="${esc(image)}">`);
  html = replaceLine(html,
    '<meta name="twitter:title" content="Article — InteractInk">',
    `<meta name="twitter:title" content="${esc(titleText)}">`);
  html = replaceLine(html,
    '<meta name="twitter:description" content="An article written by an InteractInk user.">',
    `<meta name="twitter:description" content="${esc(descText)}">`);
  html = replaceLine(html,
    '<meta name="twitter:image" content="/img/logo-light.png">',
    `<meta name="twitter:image" content="${esc(image)}">`);
  html = replaceLine(html, '<link rel="canonical">', `<link rel="canonical" href="${esc(canonical)}">`);
  html = replaceLine(html, '<meta property="og:url" content="">', `<meta property="og:url" content="${esc(canonical)}">`);

  html = injectHead(html, jsonLdScriptTag(jsonLd));

  html = insertHiddenSeoBlock(html,
    '<div id="article-content">',
    articleRootHtml);

  return { status: 200, html };
}

// ── THREAD ("/i/status/:id", "/:username/status/:id") ──

async function renderThread(origin, username, id) {
  let html = readTemplate('thread.html');

  // `replies` is keyed off the route's `id` param directly, same as
  // `posts` below — it doesn't depend on the post fetch resolving
  // first, so run both concurrently instead of sequentially. (If the
  // post turns out not to exist, the replies result is just discarded
  // below — cheap, and still a net win since most requests are for
  // posts that DO exist.)
  const [posts, replies] = await Promise.all([
    sbGet('posts', `id=eq.${encodeURIComponent(id)}&is_deleted=eq.false&select=*,profile:profiles!posts_author_id_fkey(username,display_name,avatar_url)`),
    sbGet('replies', `post_id=eq.${encodeURIComponent(id)}&is_deleted=eq.false&select=body,created_at,profile:profiles(username,display_name)&order=created_at.asc&limit=50`).then(r => r || []),
  ]);
  const post = posts && posts[0];

  if (!post) {
    html = replaceLine(html, '<title>Post — InteractInk</title>', '<title>Post not found — InteractInk</title>');
    html = replaceLine(html,
      '<meta name="description" content="A post and its replies on InteractInk.">',
      '<meta name="description" content="This post was not found or has been removed.">');
    html = injectHead(html, '<meta name="robots" content="noindex">');
    html = insertHiddenSeoBlock(html,
      '<div id="thread-root">',
      '<p>This post was not found or has been removed.</p>');
    return { status: 404, html };
  }

  const uname = post.profile?.username || username;
  const canonicalPath = `/${encodeURIComponent(uname)}/status/${encodeURIComponent(post.id)}`;
  const canonical = origin + canonicalPath;

  const titleText = `${post.profile?.display_name || uname} on InteractInk: "${(post.body || '').slice(0, 60)}"`;
  const descText = (post.body || 'A post on InteractInk.').slice(0, 200);
  const image = post.media_url || post.profile?.avatar_url || '/img/logo-light.png';

  const jsonLd = {
    '@context': 'https://schema.org', '@type': 'SocialMediaPosting',
    url: canonical, datePublished: post.created_at, text: post.body,
    author: {
      '@type': 'Person',
      name: post.profile?.display_name || uname,
      url: `${origin}/${encodeURIComponent(uname)}`,
    },
    interactionStatistic: [
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: post.like_count || 0 },
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/ReplyAction', userInteractionCount: post.reply_count || 0 },
    ],
  };

  const repliesHtml = replies.map(r => `<li><strong>@${esc(r.profile?.username || 'unknown')}</strong>: ${esc((r.body || '').slice(0, 300))} <small>(${new Date(r.created_at).toLocaleString()})</small></li>`).join('\n');

  const threadRootHtml = `<article>
  <a href="/${esc(uname)}"><strong>${esc(post.profile?.display_name || uname)}</strong> @${esc(uname)}</a>
  &middot; <small>${new Date(post.created_at).toLocaleString()}</small>
  <p>${esc(post.body)}</p>
  <small>${post.like_count || 0} likes &middot; ${post.reply_count || 0} replies &middot; ${post.repost_count || 0} reposts</small>
</article>
<h2 class="sr-only">Replies</h2>
<ul>${repliesHtml || '<li>No replies yet.</li>'}</ul>`;

  // <title> and the OG/Twitter title tags currently share identical
  // default text ("Post — InteractInk"), same for the descriptions —
  // replace each full tag line individually so every tag ends up with
  // the real (escaped) value even though the source text matched.
  html = replaceLine(html, '<title>Post — InteractInk</title>', `<title>${esc(titleText)}</title>`);
  html = replaceLine(html,
    '<meta name="description" content="A post and its replies on InteractInk.">',
    `<meta name="description" content="${esc(descText)}">`);
  html = replaceLine(html,
    '<meta property="og:title" content="Post — InteractInk">',
    `<meta property="og:title" content="${esc(titleText)}">`);
  html = replaceLine(html,
    '<meta property="og:description" content="A post and its replies on InteractInk.">',
    `<meta property="og:description" content="${esc(descText)}">`);
  html = replaceLine(html,
    '<meta property="og:image" content="/img/logo-light.png">',
    `<meta property="og:image" content="${esc(image)}">`);
  html = replaceLine(html,
    '<meta name="twitter:title" content="Post — InteractInk">',
    `<meta name="twitter:title" content="${esc(titleText)}">`);
  html = replaceLine(html,
    '<meta name="twitter:description" content="A post and its replies on InteractInk.">',
    `<meta name="twitter:description" content="${esc(descText)}">`);
  html = replaceLine(html,
    '<meta name="twitter:image" content="/img/logo-light.png">',
    `<meta name="twitter:image" content="${esc(image)}">`);
  html = replaceLine(html, '<link rel="canonical">', `<link rel="canonical" href="${esc(canonical)}">`);
  html = replaceLine(html, '<meta property="og:url" content="">', `<meta property="og:url" content="${esc(canonical)}">`);

  html = injectHead(html, jsonLdScriptTag(jsonLd));

  html = insertHiddenSeoBlock(html,
    '<div id="thread-root">',
    threadRootHtml);

  return { status: 200, html };
}

module.exports = async function handler(req, res) {
  // This response is publicly cached at the edge for every visitor,
  // not just bots (see Cache-Control below) — building `origin`
  // straight from the request's x-forwarded-host header let anyone
  // who can influence that header get their own domain baked into
  // the cached canonical/og:url links, which every later visitor
  // hitting the same cached URL would then receive (host-header
  // cache poisoning). Same guard as api/sitemap.js's safeOrigin() —
  // CANONICAL_HOST is this project's real domain; *.vercel.app is
  // still allowed through for preview deployments, anything else
  // (including a spoofed Host) falls back to the canonical domain.
  const CANONICAL_HOST = 'interactink.vercel.app';
  const rawHost = (req.headers['x-forwarded-host'] || req.headers.host || '').split(',')[0].trim().toLowerCase();
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const host = (rawHost === CANONICAL_HOST || rawHost.endsWith('.vercel.app')) ? rawHost : CANONICAL_HOST;
  const origin = `${proto}://${host}`;
  const { type, username, id, slug } = req.query;

  try {
    let result;
    if (type === 'home') {
      result = await renderHome(origin);
    } else if (type === 'thread' && id) {
      result = await renderThread(origin, username, id);
    } else if (type === 'profile' && username) {
      result = await renderProfile(origin, username);
    } else if (type === 'community' && slug) {
      result = await renderCommunity(origin, slug);
    } else if (type === 'list' && id) {
      result = await renderList(origin, id);
    } else if (type === 'article' && id) {
      result = await renderArticle(origin, id);
    } else {
      res.status(400).send('Bad request');
      return;
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    // Short edge cache: keeps Supabase load down while still refreshing
    // often enough that like/reply counts and new posts don't go stale
    // for long. Applies to every visitor now (not just bots), so this
    // is also just... your CDN cache for the page.
    res.setHeader('Cache-Control', 'public, max-age=0, s-maxage=60, stale-while-revalidate=300');
    res.status(result.status).send(result.html);
  } catch (e) {
    console.error(`prerender handler failed | type=${type} username=${username} id=${id} slug=${slug} origin=${origin}:`, e.stack || e.message);
    res.status(502).send('Render failed: ' + e.message);
  }
}
