#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────
// Generates a REAL, static /sitemap.xml file on disk.
//
// WHY THIS EXISTS: api/sitemap.js was written as a Vercel serverless
// function (module.exports = async function handler(req, res) {...}),
// rewritten at request time via vercel.json's "^/sitemap\.xml$" ->
// "/api/sitemap" rule. That only works on a host that actually runs
// Vercel Functions. This project is *also* set up to deploy as a
// plain Cloudflare Worker with static assets (see wrangler.jsonc —
// no `main` entry, no /functions directory, so nothing dynamic runs
// there at all). On that host, /sitemap.xml was never generated —
// there's no static file with that name, so it fell through to
// wrangler.jsonc's "not_found_handling": "404-page", which serves
// 404.html. That's an HTML document, hence Search Console's exact
// complaint ("This is not a valid XML sitemap. It looks like an HTML
// page.").
//
// THE FIX: run this script (`node scripts/build-sitemap.mjs`) to
// write an actual sitemap.xml file into the project root before you
// deploy. It reuses the exact same URL-building logic as
// api/sitemap.js (static pages + hreflang alternates, Help Center,
// blog, and — when it can reach Supabase — profiles/posts/
// communities/lists/articles) so the two never drift apart.
//
// RUN THIS AGAIN whenever you add/remove a static page, a Help
// Center article, or a blog post — and periodically (e.g. a weekly
// cron, or by hand before each deploy) to pick up newly-created
// profiles/posts. If you migrate this site to a host that actually
// executes api/sitemap.js on every request (Vercel, or a Cloudflare
// Pages Function), you can delete the static sitemap.xml and let
// vercel.json's existing rewrite take over — this script is only
// needed for a plain static-asset deployment like the current
// Cloudflare Worker setup.
// ─────────────────────────────────────────────────────────────

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Same project + anon key as js/supabase-config.js / api/sitemap.js.
// Public by design (RLS-gated) — see api/sitemap.js's own comment.
const SUPABASE_URL = 'https://pyitivzoqleukuclajrf.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB5aXRpdnpvcWxldWt1Y2xhanJmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU5Nzg0ODcsImV4cCI6MjEwMTU1NDQ4N30.gKvqOaAREY5wcptIv7OHfjHhZR5ogIaMY8I98jHRmFs';
const PAGE_SIZE = 1000;
const MAX_ROWS = 5000;

// Set this to your real domain, or pass one as `node scripts/build-sitemap.mjs https://example.com`.
const ORIGIN = process.argv[2] || 'https://interactink.com';

function fileLastmod(htmlFile) {
  try {
    return fs.statSync(path.join(ROOT, htmlFile)).mtime;
  } catch {
    return null;
  }
}

async function fetchAll(table, selectParams) {
  const rows = [];
  let from = 0;
  while (rows.length < MAX_ROWS) {
    const to = from + PAGE_SIZE - 1;
    const url = `${SUPABASE_URL}/rest/v1/${table}?${selectParams}`;
    let resp;
    try {
      resp = await fetch(url, {
        headers: {
          apikey: SUPABASE_ANON_KEY,
          Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
          Range: `${from}-${to}`,
          Prefer: 'count=none',
        },
      });
    } catch {
      break; // no network reachability to Supabase from here — skip this table
    }
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
    .map(a => `\n    <xhtml:link rel="alternate" hreflang="${a.lang}" href="${xmlEscape(a.href)}"/>`)
    .join('');
  return `  <url>\n    <loc>${xmlEscape(loc)}</loc>${altLinks}${lastmod ? `\n    <lastmod>${new Date(lastmod).toISOString()}</lastmod>` : ''}${changefreq ? `\n    <changefreq>${changefreq}</changefreq>` : ''}${priority ? `\n    <priority>${priority}</priority>` : ''}\n  </url>`;
}

// ── LOCALIZED STATIC PAGES — kept in sync with api/sitemap.js ──
const LOCALES = ['es', 'fr', 'de', 'pt', 'ja', 'ru'];
const STATIC_PAGES = [
  { path: '', file: 'index.html', changefreq: 'hourly', priority: '1.0' },
  { path: 'communities', file: 'communities.html', changefreq: 'daily', priority: '0.5' },
  { path: 'articles', file: 'articles.html', changefreq: 'daily', priority: '0.5' },
  { path: 'rules', file: 'rules.html', changefreq: 'monthly', priority: '0.3' },
  { path: 'about', file: 'about.html', changefreq: 'monthly', priority: '0.3' },
  { path: 'contact', file: 'contact.html', changefreq: 'monthly', priority: '0.2' },
  { path: 'privacy', file: 'privacy.html', changefreq: 'monthly', priority: '0.2' },
  { path: 'terms', file: 'terms.html', changefreq: 'monthly', priority: '0.2' },
  { path: 'login', file: 'login.html', changefreq: 'yearly', priority: '0.1' },
  { path: 'signup', file: 'signup.html', changefreq: 'yearly', priority: '0.2' },
];

function hrefForVariant(origin, p, lang) {
  if (lang === 'en') return p ? `${origin}/${p}` : `${origin}/`;
  return p ? `${origin}/${lang}/${p}` : `${origin}/${lang}`;
}

// ── Help Center — kept in sync with api/sitemap.js and gen_help.py ──
const HELP_CATEGORIES = {
  'using-interactink': ['how-to-post','how-to-follow-and-unfollow','for-you-and-following-feed','reposts-and-quote-posts','replying-and-threads','edit-post-and-undo','delete-a-post','liking-posts','bookmarks','direct-messages','group-chats-and-channels','encrypted-messages','read-receipts-and-typing-indicators','communities','creating-a-community','lists','articles-feature','polls','posting-gifs-images-and-video','search','notifications-overview','mentions-and-replies'],
  'managing-your-account': ['create-an-account','how-to-customize-your-profile','change-your-username','update-your-email-address','resetting-a-forgotten-password','deactivating-your-account','downloading-your-data','notification-settings','changing-your-language','login-issues'],
  'safety-and-security': ['blocking-accounts','muting-accounts','reporting-a-post','reporting-an-account-or-impersonation','public-and-private-accounts','account-security-tips','sensitive-media-settings','recognizing-phishing-and-fake-emails','child-safety','self-harm-and-suicide-resources'],
  'rules-and-policies': ['community-rules-overview','hateful-conduct-policy','abusive-behavior-and-harassment-policy','spam-and-platform-manipulation','impersonation-policy','copyright-and-dmca-policy','enforcement-and-suspensions','appealing-a-suspension','intellectual-property-and-trademark','child-sexual-exploitation-policy'],
  'resources': ['new-user-guide','glossary','accessibility-features','how-recommendations-work','keeping-interactink-safe','contacting-support'],
};
function helpCenterUrls(origin) {
  const urls = [urlTag(`${origin}/help/index.html`, fileLastmod('help/index.html'), 'monthly', '0.4')];
  for (const [cat, slugs] of Object.entries(HELP_CATEGORIES)) {
    urls.push(urlTag(`${origin}/help/${cat}/index.html`, fileLastmod(`help/${cat}/index.html`), 'monthly', '0.4'));
    for (const slug of slugs) {
      urls.push(urlTag(`${origin}/help/${cat}/${slug}.html`, fileLastmod(`help/${cat}/${slug}.html`), 'monthly', '0.3'));
    }
  }
  return urls;
}

// ── Blog — kept in sync with api/sitemap.js ──
const BLOG_SLUGS = [
  'how-to-build-an-online-community-people-stick-around-in',
  'the-first-ten-members-why-who-you-invite-first-decides-everything',
  'writing-rules-people-actually-read',
  'designing-onboarding-that-actually-keeps-people',
  'handling-your-first-troll-without-losing-the-room',
  'the-anatomy-of-a-pile-on',
  'rituals-the-weekly-threads-that-keep-a-community-alive',
  'delegating-without-losing-your-communitys-soul',
  'when-to-split-a-community-and-when-not-to',
  'small-beats-big-the-case-for-staying-small-on-purpose',
  'the-slow-death-of-a-server-a-postmortem',
];
function blogUrls(origin) {
  const urls = [urlTag(`${origin}/blog`, fileLastmod('blog/index.html'), 'weekly', '0.4')];
  for (const slug of BLOG_SLUGS) {
    urls.push(urlTag(`${origin}/blog/${slug}`, fileLastmod(`blog/${slug}.html`), 'monthly', '0.4'));
  }
  return urls;
}

function localizedStaticUrls(origin) {
  const urls = [];
  for (const page of STATIC_PAGES) {
    const enHref = hrefForVariant(origin, page.path, 'en');
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

async function main() {
  const now = Date.now();

  const [profiles, posts, communities, lists, articles] = await Promise.all([
    fetchAll('profiles', 'select=username,created_at&order=created_at.desc'),
    fetchAll('posts', 'select=id,created_at,is_deleted,scheduled_at,profile:profiles!posts_author_id_fkey(username)&is_deleted=eq.false&order=created_at.desc'),
    fetchAll('communities', 'select=slug,created_at&order=created_at.desc'),
    fetchAll('lists', 'select=id,created_at,is_private&order=created_at.desc'),
    fetchAll('articles', 'select=id,created_at,is_deleted&is_deleted=eq.false&order=created_at.desc'),
  ]);

  const staticUrls = localizedStaticUrls(ORIGIN);
  const helpUrls = helpCenterUrls(ORIGIN);
  const blogUrlList = blogUrls(ORIGIN);

  const profileUrls = profiles.map(p =>
    urlTag(`${ORIGIN}/@${encodeURIComponent(p.username)}`, p.created_at, 'daily', '0.8'));

  const postUrls = posts
    .filter(p => !p.scheduled_at || new Date(p.scheduled_at).getTime() <= now)
    .map(p => {
      const p2 = p.profile?.username
        ? `/@${encodeURIComponent(p.profile.username)}/status/${encodeURIComponent(p.id)}`
        : `/i/status/${encodeURIComponent(p.id)}`;
      return urlTag(`${ORIGIN}${p2}`, p.created_at, 'weekly', '0.6');
    });

  const communityUrls = communities.map(c =>
    urlTag(`${ORIGIN}/communities/${encodeURIComponent(c.slug)}`, c.created_at, 'daily', '0.5'));

  const listUrls = lists
    .filter(l => !l.is_private)
    .map(l => urlTag(`${ORIGIN}/i/lists/${encodeURIComponent(l.id)}`, l.created_at, 'weekly', '0.4'));

  const articleUrls = articles.map(a =>
    urlTag(`${ORIGIN}/i/articles/${encodeURIComponent(a.id)}`, a.created_at, 'weekly', '0.5'));

  const allUrls = [...staticUrls, ...helpUrls, ...blogUrlList, ...profileUrls, ...postUrls, ...communityUrls, ...listUrls, ...articleUrls];

  const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n${allUrls.join('\n')}\n</urlset>\n`;

  const outPath = path.join(ROOT, 'sitemap.xml');
  fs.writeFileSync(outPath, xml, 'utf8');

  const dynamicCount = profileUrls.length + postUrls.length + communityUrls.length + listUrls.length + articleUrls.length;
  console.log(`Wrote ${outPath}`);
  console.log(`  ${staticUrls.length} static page URLs, ${helpUrls.length} Help Center URLs, ${blogUrlList.length} blog URLs`);
  console.log(`  ${dynamicCount} dynamic URLs from Supabase (profiles/posts/communities/lists/articles)`);
  if (dynamicCount === 0) {
    console.log('  NOTE: 0 dynamic URLs — this environment likely couldn\'t reach Supabase.');
    console.log('  Run this script again from a machine with normal internet access to include');
    console.log('  profile/post/community/list/article pages in the sitemap.');
  }
}

main();
