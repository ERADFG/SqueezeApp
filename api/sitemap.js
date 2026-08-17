// ─────────────────────────────────────────────────────────────
// /sitemap.xml  (served by the "/sitemap.xml" -> "/api/sitemap"
// rewrite in vercel.json)
//
// THE MAIN FIX for "every user/post needs its own indexed page":
// this site's content pages (/<username>, /<username>/status/<id>,
// /communities/<slug>, /i/lists/<id>) are all generated from rows a
// crawler has no way to enumerate on its own — there's no static
// list of them anywhere, and the home feed only ever surfaces the
// most recent handful of posts. Without a sitemap, a search engine
// can only ever discover pages it happens to stumble onto by
// following links from other already-discovered pages, so the vast
// majority of profiles and posts would simply never get crawled, let
// alone indexed, no matter how good their on-page SEO is. This
// builds the sitemap straight from the same tables the app itself
// reads (public.profiles / public.posts / public.communities /
// public.lists), through the same public anon key + RLS the client
// already uses — so it only ever lists what a logged-out visitor
// could actually see if they clicked the link, nothing private.
//
// Runs on every request rather than being a static file because the
// data changes constantly (new signups, new posts). Cached at the
// edge for 10 minutes (see Cache-Control below) so it isn't hammering
// Supabase on every single crawler hit.
//
// Capped at ~5,000 rows per table. That's enough for a site this
// size; if this ever needs to scale past that, the standard next
// step is a sitemap *index* file that points at several smaller
// sitemap-<n>.xml files (Google's limit is 50,000 URLs / 50MB per
// file) — ask for that when the cap starts being an issue.
//
// Also includes every localized (es/fr/de/pt/ja/ru) copy of the 9
// static pages that ship one, each carrying the same hreflang
// alternates already declared in that page's own <head> (see
// localizedStaticUrls() below) — so a crawler can discover /es/about,
// /fr/rules, etc. straight from the sitemap instead of only via an
// in-page link off the English version.
// ─────────────────────────────────────────────────────────────

// Same project + anon key as js/supabase-config.js. The anon key is
// meant to be public (see that file's comment) — every read below is
// still filtered by that key's RLS policies same as any other
// logged-out visitor, so this can never expose anything the site
// doesn't already show to anyone who clicks the link. If you ever
// rotate/move Supabase projects, update both this file and
// js/supabase-config.js.
const SUPABASE_URL = 'https://pyitivzoqleukuclajrf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5aXRpdnpvcWxldWt1Y2xhanJmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5Nzg0ODcsImV4cCI6MjEwMTU1NDQ4N30.gKvqOaAREY5wcptIv7OHfjHhZR5ogIaMY8I98jHRmFs';

const PAGE_SIZE = 1000;
const MAX_ROWS = 5000;

// Real <lastmod> for the static pages below, instead of omitting the tag —
// pulled from each HTML file's own mtime on disk (the deploy bundle) rather
// than hardcoded, so it stays accurate without needing to remember to bump
// it by hand every time one of these pages is edited.
const fs = require('fs');
const nodePath = require('path');
function fileLastmod(htmlFile) {
  try {
    return fs.statSync(nodePath.join(process.cwd(), htmlFile)).mtime;
  } catch {
    return null; // falls back to no <lastmod> for that URL if the file can't be stat'd
  }
}

async function fetchAll(path, selectParams) {
  const rows = [];
  let from = 0;
  while (rows.length < MAX_ROWS) {
    const to = from + PAGE_SIZE - 1;
    const url = `${SUPABASE_URL}/rest/v1/${path}?${selectParams}`;
    const resp = await fetch(url, {
      headers: {
        apikey: SUPABASE_ANON_KEY,
        Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
        Range: `${from}-${to}`,
        Prefer: 'count=none',
      },
    });
    if (!resp.ok) break;
    const batch = await resp.json();
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) break;
    from += PAGE_SIZE;
  }
  return rows.slice(0, MAX_ROWS);
}

function xmlEscape(s) {
  return String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function urlTag(loc, lastmod, changefreq, priority, alternates) {
  const altLinks = (alternates || [])
    .map(a => `
    <xhtml:link rel="alternate" hreflang="${a.lang}" href="${xmlEscape(a.href)}"/>`)
    .join('');
  return `  <url>
    <loc>${xmlEscape(loc)}</loc>${altLinks}${lastmod ? `
    <lastmod>${new Date(lastmod).toISOString()}</lastmod>` : ''}${changefreq ? `
    <changefreq>${changefreq}</changefreq>` : ''}${priority ? `
    <priority>${priority}</priority>` : ''}
  </url>`;
}

// ── LOCALIZED STATIC PAGES ──
// Every one of these 9 pages already ships with its own <link
// rel="alternate" hreflang="..."> block in <head> (en + es/fr/de/pt/ja/ru
// + x-default) — see e.g. about.html's <head>. This mirrors that same
// set of URLs into the sitemap with matching xhtml:link alternates, so
// crawlers get the language cluster from the sitemap itself instead of
// only discovering /es/about etc. by following an in-page link from
// the English version (which they may never crawl deeply enough to
// reach). `path: ''` is the home page, whose locale URLs are bare
// "/es" (no trailing segment) per vercel.json's "^/es$" route rather
// than "/es/" — every href built below follows that same shape.
const LOCALES = ['es', 'fr', 'de', 'pt', 'ja', 'ru'];
const STATIC_PAGES = [
  { path: '', file: 'index.html', changefreq: 'hourly', priority: '1.0' },
  { path: 'communities', file: 'communities.html', changefreq: 'daily', priority: '0.5' },
  { path: 'rules', file: 'rules.html', changefreq: 'monthly', priority: '0.3' },
  { path: 'about', file: 'about.html', changefreq: 'monthly', priority: '0.3' },
  { path: 'contact', file: 'contact.html', changefreq: 'monthly', priority: '0.2' },
  { path: 'privacy', file: 'privacy.html', changefreq: 'monthly', priority: '0.2' },
  { path: 'terms', file: 'terms.html', changefreq: 'monthly', priority: '0.2' },
  { path: 'login', file: 'login.html', changefreq: 'yearly', priority: '0.1' },
  { path: 'signup', file: 'signup.html', changefreq: 'yearly', priority: '0.2' },
];

function hrefForVariant(origin, path, lang) {
  if (lang === 'en') return path ? `${origin}/${path}` : `${origin}/`;
  return path ? `${origin}/${lang}/${path}` : `${origin}/${lang}`;
}

function localizedStaticUrls(origin) {
  const urls = [];
  for (const page of STATIC_PAGES) {
    const enHref = hrefForVariant(origin, page.path, 'en');
    // Bidirectional per Google's spec: every language variant of a
    // page lists the FULL set of alternates (itself included), plus
    // x-default pointing at the English version.
    const alternates = [
      { lang: 'en', href: enHref },
      ...LOCALES.map(l => ({ lang: l, href: hrefForVariant(origin, page.path, l) })),
      { lang: 'x-default', href: enHref },
    ];
    urls.push(urlTag(enHref, fileLastmod(page.file), page.changefreq, page.priority, alternates));
    for (const l of LOCALES) {
      const file = page.path ? `${l}/${page.file}` : `${l}/index.html`;
      urls.push(urlTag(hrefForVariant(origin, page.path, l), fileLastmod(file), page.changefreq, page.priority, alternates));
    }
  }
  return urls;
}

module.exports = async function handler(req, res) {
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0];
  const origin = `${proto}://${host}`;

  let profiles = [], posts = [], communities = [], lists = [], articles = [];
  try {
    [profiles, posts, communities, lists, articles] = await Promise.all([
      fetchAll('profiles', 'select=username,created_at&order=created_at.desc'),
      fetchAll('posts', 'select=id,created_at,is_deleted,scheduled_at,profile:profiles!posts_author_id_fkey(username)&is_deleted=eq.false&order=created_at.desc'),
      fetchAll('communities', 'select=slug,created_at&order=created_at.desc').catch(() => []),
      fetchAll('lists', 'select=id,created_at,is_private&order=created_at.desc').catch(() => []),
      fetchAll('articles', 'select=id,created_at,is_deleted&is_deleted=eq.false&order=created_at.desc').catch(() => []),
    ]);
  } catch (e) {
    res.status(502).send('Failed to build sitemap: ' + e.message);
    return;
  }

  const now = Date.now();
  // 9 pages x (1 English + 6 locales) = 63 URLs, each carrying the
  // full hreflang alternates set.
  const staticUrls = [
    ...localizedStaticUrls(origin),
    // Not localized (no /es/articles route exists), so just the plain
    // English URL, same as before this change.
    //
    // Deliberately NOT adding /lists here even though it's a real
    // page: robots.js Disallows it (it's a browse-your-own-lists
    // utility screen, not indexable content — the individual public
    // lists at /i/lists/<id> below are the actual content and are
    // already included), and a URL that's blocked in robots.txt but
    // present in the sitemap is a contradiction Search Console flags
    // as an error. Keep these two files in sync if that ever changes.
    urlTag(`${origin}/articles`, fileLastmod('articles.html'), 'daily', '0.5'),
  ];

  const profileUrls = profiles.map(p =>
    urlTag(`${origin}/${encodeURIComponent(p.username)}`, p.created_at, 'daily', '0.8'));

  const postUrls = posts
    // a scheduled-but-not-yet-published post is invisible to everyone
    // per RLS (see supabase/gifs_polls_scheduling.sql) — skip it here too
    .filter(p => !p.scheduled_at || new Date(p.scheduled_at).getTime() <= now)
    .map(p => {
      const path = p.profile?.username
        ? `/${encodeURIComponent(p.profile.username)}/status/${encodeURIComponent(p.id)}`
        : `/i/status/${encodeURIComponent(p.id)}`;
      return urlTag(`${origin}${path}`, p.created_at, 'weekly', '0.6');
    });

  const communityUrls = (communities || []).map(c =>
    urlTag(`${origin}/communities/${encodeURIComponent(c.slug)}`, c.created_at, 'daily', '0.5'));

  const listUrls = (lists || [])
    .filter(l => !l.is_private)
    .map(l => urlTag(`${origin}/i/lists/${encodeURIComponent(l.id)}`, l.created_at, 'weekly', '0.4'));

  const articleUrls = (articles || [])
    .map(a => urlTag(`${origin}/i/articles/${encodeURIComponent(a.id)}`, a.created_at, 'weekly', '0.5'));

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${[...staticUrls, ...profileUrls, ...postUrls, ...communityUrls, ...listUrls, ...articleUrls].join('\n')}
</urlset>
`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=600');
  res.status(200).send(xml);
}
