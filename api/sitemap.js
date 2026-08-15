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

function urlTag(loc, lastmod, changefreq, priority) {
  return `  <url>
    <loc>${xmlEscape(loc)}</loc>${lastmod ? `
    <lastmod>${new Date(lastmod).toISOString()}</lastmod>` : ''}${changefreq ? `
    <changefreq>${changefreq}</changefreq>` : ''}${priority ? `
    <priority>${priority}</priority>` : ''}
  </url>`;
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
  const staticUrls = [
    urlTag(`${origin}/`, fileLastmod('index.html'), 'hourly', '1.0'),
    urlTag(`${origin}/communities`, fileLastmod('communities.html'), 'daily', '0.5'),
    urlTag(`${origin}/rules`, fileLastmod('rules.html'), 'monthly', '0.3'),
    urlTag(`${origin}/about`, fileLastmod('about.html'), 'monthly', '0.3'),
    urlTag(`${origin}/contact`, fileLastmod('contact.html'), 'monthly', '0.2'),
    urlTag(`${origin}/privacy`, fileLastmod('privacy.html'), 'monthly', '0.2'),
    urlTag(`${origin}/terms`, fileLastmod('terms.html'), 'monthly', '0.2'),
    urlTag(`${origin}/login`, fileLastmod('login.html'), 'yearly', '0.1'),
    urlTag(`${origin}/signup`, fileLastmod('signup.html'), 'yearly', '0.2'),
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
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${[...staticUrls, ...profileUrls, ...postUrls, ...communityUrls, ...listUrls, ...articleUrls].join('\n')}
</urlset>
`;

  res.setHeader('Content-Type', 'application/xml; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=600, s-maxage=600');
  res.status(200).send(xml);
}
