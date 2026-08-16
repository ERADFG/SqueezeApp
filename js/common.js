// ─────────────────────────────────────────────────────────────
// COMMON HELPERS — shared by board.js and thread.js
// ─────────────────────────────────────────────────────────────

// ── URLS — every actual `<a href>` / `location.href = ...` in the
// app is built through the functions below, and they now build the
// pretty Twitter/X-style path directly (/marc, /marc/status/<id>,
// /marc/followers, /messages/marc, ...) instead of the plain
// file+query form. That only resolves correctly on a host that runs
// the `rewrites` in vercel.json (a real Vercel deploy, a Vercel
// Preview URL, or `vercel dev` locally) — see README.md. The
// `legacy*()` versions below build the old file+query form
// (profile.html?u=marc, thread.html?id=<uuid>, ...), which every
// page's own URL-reading code (currentProfileUsername(),
// currentStatusId(), chat.js, followlist.js) still accepts as a
// fallback, so old bookmarks/shared links and non-Vercel hosting
// (GitHub Pages, plain `npx serve .`, opening the file directly)
// keep working — they just won't show the pretty form in the
// address bar.
//
//   profileUrl('marc')                -> /marc
//   postUrl(post)                     -> /marc/status/<id> (or /i/status/<id>
//                                         before we know the author)
//   followListUrl('marc','following') -> /marc/following
//   messagesUrl('marc')               -> /messages/marc
// Updates the page's <meta name="description"> plus the matching OG/Twitter
// tags so a shared link (Discord/iMessage/etc. unfurl, search result) shows
// real content instead of the generic per-page fallback baked into the HTML.
// Call this alongside document.title on any page that renders its title from
// live data (profile bio, thread body, community name, list name, ...).
function setPageDescription(text) {
  if (!text) return;
  text = text.replace(/\s+/g, ' ').trim().slice(0, 200);
  const setMeta = (selector, attr) => {
    const el = document.querySelector(selector);
    if (el) el.setAttribute(attr, text);
  };
  setMeta('meta[name="description"]', 'content');
  setMeta('meta[property="og:description"]', 'content');
  setMeta('meta[name="twitter:description"]', 'content');
  const ogTitle = document.querySelector('meta[property="og:title"]');
  if (ogTitle) ogTitle.setAttribute('content', document.title);
  const twTitle = document.querySelector('meta[name="twitter:title"]');
  if (twTitle) twTitle.setAttribute('content', document.title);
}

// Keeps the page's single static <h1 id="page-h1"> (present as a generic
// placeholder in the HTML for pages whose real title is only known once
// content loads — profile, thread, community, list) in sync with the real
// content, same idea as setPageDescription() above for the meta tags.
function setPageH1(text) {
  if (!text) return;
  const el = document.getElementById('page-h1');
  if (el) el.textContent = text;
}

// Sets <link rel="canonical"> + og:url to the page's real, final address
// (creating the <link> tag if the static HTML didn't already have one).
// Call this alongside setPageDescription() on any page whose canonical
// URL depends on data that only loads client-side (a username, a post
// id, a list id, ...) — without it, search engines have no signal that
// /i/status/<id> and /marc/status/<id> are the same page, or that
// profile.html?u=marc (the legacy fallback form) and /marc are too.
function setCanonical(path) {
  if (!path) return;
  const url = location.origin + path;
  let link = document.querySelector('link[rel="canonical"]');
  if (!link) {
    link = document.createElement('link');
    link.setAttribute('rel', 'canonical');
    document.head.appendChild(link);
  }
  link.setAttribute('href', url);
  const og = document.querySelector('meta[property="og:url"]');
  if (og) og.setAttribute('content', url);
}

// Points og:image / twitter:image at a real avatar/media URL instead of
// the generic logo baked into the HTML, so shared links (Discord/iMessage/
// Slack/X unfurls) show the actual person or post image.
function setPageImage(url) {
  if (!url) return;
  const setMeta = (selector, attr) => {
    const el = document.querySelector(selector);
    if (el) el.setAttribute(attr, url);
  };
  setMeta('meta[property="og:image"]', 'content');
  setMeta('meta[name="twitter:image"]', 'content');
  const card = document.querySelector('meta[name="twitter:card"]');
  if (card) card.setAttribute('content', 'summary_large_image');
}

// Injects (or replaces) a JSON-LD <script> block describing the entity
// this page is about (a Person for profiles, a SocialMediaPosting for
// threads, ...). This is what lets search engines show rich results
// (author, date, engagement counts) instead of a plain blue link, and
// gives them an unambiguous, structured signal of what the page contains
// on top of the plain-text content — helpful since this app has no
// server-rendered content for a crawler that doesn't run JS.
function setJsonLd(obj) {
  if (!obj) return;
  let el = document.getElementById('jsonld-data');
  if (!el) {
    el = document.createElement('script');
    el.type = 'application/ld+json';
    el.id = 'jsonld-data';
    document.head.appendChild(el);
  }
  el.textContent = JSON.stringify(obj);
}

function u_(s) { return encodeURIComponent(s); }

// ── HOVER/TOUCH PREFETCH — this app does full page navigations (no
// SPA router), so the biggest thing standing between a click and a
// painted page is the round trip to fetch that page's HTML. Warming
// it into the browser's cache the moment a pointer touches the link
// (hover on desktop, touchstart on mobile — both fire well before the
// actual click/tap completes) means it's often already there by the
// time navigation starts. Same trick behind Twitter/Bluesky's route
// prefetching, just done with a plain <link rel=prefetch> since there's
// no bundler-level chunk to fetch here.
const _prefetched = new Set();
function prefetchHref(href) {
  if (!href || _prefetched.has(href)) return;
  if (href.startsWith('#') || href.startsWith('http') || href.startsWith('mailto:') || href.startsWith('javascript:')) return;
  _prefetched.add(href);
  const link = document.createElement('link');
  link.rel = 'prefetch';
  link.href = href;
  document.head.appendChild(link);
}
function wireLinkPrefetch() {
  const grab = e => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (a) prefetchHref(a.getAttribute('href'));
  };
  // pointerover bubbles (unlike pointerenter), so one listener on the
  // document catches every link on the page, present now or added later.
  document.addEventListener('pointerover', grab, { passive: true });
  document.addEventListener('touchstart', grab, { passive: true });
}
document.addEventListener('DOMContentLoaded', wireLinkPrefetch);

// ── FALLBACK FADE FOR NAVIGATION — the CSS `@view-transition` rule
// (top of style.css) gives supporting browsers a native cross-fade
// between pages instead of the default hard flash-to-white. Browsers
// that support it also fire the `pageswap`/`pagereveal` events (that's
// the standard feature-detection signal for this API) — checked below
// via 'onpageswap' in window, so this fallback only runs where the
// native transition WON'T: older engines and in-app WebViews that
// still hard-cut. Running both at once was the bug in an earlier
// version of this — two fades stacking on every tap added latency
// and, combined with a scale transform on the native one (now
// removed above), made the fixed nav bars briefly double up. Now
// exactly one of the two ever runs.
function wirePageLeaveFade() {
  if ('onpageswap' in window) return; // native cross-document transition handles it
  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href');
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return;
    if (a.target && a.target !== '' && a.target !== '_self') return;
    if (a.hasAttribute('download')) return;
    let url;
    try { url = new URL(a.href, location.href); } catch (_) { return; }
    if (url.origin !== location.origin) return;
    if (url.pathname === location.pathname && url.search === location.search && url.hash) return; // same-page anchor jump
    e.preventDefault();
    document.documentElement.classList.add('oc-page-leaving');
    setTimeout(() => { location.href = a.href; }, 70);
  });
}
document.addEventListener('DOMContentLoaded', wirePageLeaveFade);
// Safety net: if this page is restored from the back-forward cache
// (browser Back/Forward) it can be restored mid-fade with the class
// still applied, which would leave it stuck invisible — pageshow
// fires on every normal load *and* every bfcache restore, so this
// always clears it.
window.addEventListener('pageshow', () => { document.documentElement.classList.remove('oc-page-leaving'); });

// ── SHARED SCROLL LOCK — the global compose modal, the GIF picker
// (opened *from inside* the compose modal), and the delete-confirm
// modal each need to lock body scroll while open. Previously each
// one set/cleared `document.body.style.overflow` independently, so
// closing an inner modal (e.g. the GIF picker) while an outer one
// (the composer) was still open would blindly clear the lock —
// the page behind would start scrolling/jumping under the still-open
// modal. A simple counter keeps the lock held until every open
// modal has released it.
let _scrollLockCount = 0;
function lockScroll() { _scrollLockCount++; document.body.style.overflow = 'hidden'; }
function unlockScroll() { _scrollLockCount = Math.max(0, _scrollLockCount - 1); if (_scrollLockCount === 0) document.body.style.overflow = ''; }

// ─────────────────────────────────────────────────────────────
// MOBILE KEYBOARD FIX — the full-screen compose modals (global
// compose + the reply popup) pin their icon toolbar to the bottom of
// the screen with flexbox (see the mobile ".modal.gc-modal" rules in
// style.css) — that works great with the keyboard closed, but a lot
// of mobile browsers (iOS Safari especially) don't shrink a
// height:100% element when the on-screen keyboard opens, so the
// toolbar ends up sitting UNDER the keyboard, invisible, instead of
// right above it. window.visualViewport reports how tall the screen
// actually still is once the keyboard has eaten into it — we mirror
// that into a --vvh CSS variable and size the modal off it instead,
// so the flex:none toolbar at the end of the column naturally lands
// right above the keyboard, same as the real X app's compose screen.
// ─────────────────────────────────────────────────────────────
function syncViewportHeight() {
  const h = window.visualViewport ? window.visualViewport.height : window.innerHeight;
  document.documentElement.style.setProperty('--vvh', h + 'px');
}
if (window.visualViewport) {
  window.visualViewport.addEventListener('resize', syncViewportHeight);
  window.visualViewport.addEventListener('scroll', syncViewportHeight);
} else {
  window.addEventListener('resize', syncViewportHeight);
}
syncViewportHeight();

function profileUrl(username) { return `/${u_(username)}`; }
function postUrl(post, replyId = null) {
  const id = replyId || post?.id;
  const base = post?.profile?.username ? `/${u_(post.profile.username)}/status/${u_(post.id)}` : `/i/status/${u_(post?.id ?? id)}`;
  return replyId ? `${base}#reply-${u_(replyId)}` : base;
}
function postUrlById(id, username = null) {
  return username ? `/${u_(username)}/status/${u_(id)}` : `/i/status/${u_(id)}`;
}
function followListUrl(username, tab) { return `/${u_(username)}/${tab === 'following' ? 'following' : 'followers'}`; }
function messagesUrl(username = null) { return username ? `/messages/${u_(username)}` : '/messages'; }
function communityUrl(slug) { return `/communities/${u_(slug)}`; }
function listUrl(id) { return `/i/lists/${u_(id)}`; }
function profileListsUrl(username) { return `/${u_(username)}/lists`; }
function articleUrl(id) { return `/i/articles/${u_(id)}`; }

// Kept as prettyXxx() aliases too — profile.js/thread.js/followlist.js/
// chat.js/common.js's sharePost() already call these names directly
// (for canonicalizing the address bar once a page's own data has
// loaded, and for building the "copy link" URL), so they still work
// unchanged now that the plain names above build the same thing.
function prettyProfileUrl(username) { return profileUrl(username); }
function prettyPostUrl(post, replyId = null) { return postUrl(post, replyId); }
function prettyPostUrlById(id, username = null) { return postUrlById(id, username); }
function prettyFollowListUrl(username, tab) { return followListUrl(username, tab); }
function prettyMessagesUrl(username = null) { return messagesUrl(username); }

// ── LEGACY file+query URLS — the pre-pretty-URL link form. No
// longer used to build any link in the app, but currentProfileUsername()
// still reads the `?u=` param it uses as a fallback (see below), and
// these stay here named/documented in case a host without the Vercel
// rewrites active needs them wired back in as the default.
function legacyProfileUrl(username) { return `profile.html?u=${u_(username)}`; }
function legacyPostUrl(post, replyId = null) {
  const id = replyId || post?.id;
  return `thread.html?id=${u_(post?.id ?? id)}${replyId ? `#reply-${u_(replyId)}` : ''}`;
}
function legacyPostUrlById(id) { return `thread.html?id=${u_(id)}`; }
function legacyFollowListUrl(username, tab) { return `followlist.html?u=${u_(username)}&tab=${tab === 'following' ? 'following' : 'followers'}`; }
function legacyMessagesUrl(username = null) { return username ? `chat.html?u=${u_(username)}` : 'chat.html'; }

// ── STATIC PRETTY-URL UPGRADE — pages with no dynamic id (home,
// search, settings, ...) can't wait for a data load before deciding
// their canonical address, so just swap it in right away. Safe on
// any host: replaceState never touches the network, so this runs
// fine even where the pretty rewrites themselves don't work.
(function upgradeStaticPrettyUrl() {
  const STATIC_PRETTY = {
    'index.html': '/home', '': '/home',
    'notifications.html': '/notifications',
    'bookmarks.html': '/bookmarks',
    'settings.html': '/settings',
    'rules.html': '/rules',
    'login.html': '/login',
    'signup.html': '/signup',
    'search.html': '/search',
    'communities.html': '/communities',
    'lists.html': '/lists',
  };
  const file = location.pathname.split('/').pop();
  const pretty = STATIC_PRETTY[file];
  // try/catch: some browsers throw on history.replaceState when the
  // page is opened straight off disk (file://) instead of served
  // over http(s) — never let that take the rest of common.js down.
  if (pretty) { try { history.replaceState(null, '', pretty + location.search + location.hash); } catch (e) {} }
})();

// Reads the post/reply id out of the current URL on thread.html,
// whether it arrived as a pretty path (/marc/status/123 or
// /i/status/123) or the legacy query form (thread.html?id=123 — kept
// as a fallback for old bookmarked links and for local dev without
// Vercel's rewrite engine, e.g. plain `npx serve`).
function currentStatusId() {
  const m = location.pathname.match(/\/status\/([^/]+)/);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(location.search).get('id');
}

// Reads the profile username out of the current URL on profile.html,
// whether it arrived as a pretty path (/marc) or the legacy query
// form (profile.html?u=marc — used whenever the pretty-path rewrite
// isn't active, e.g. no Vercel rewrites configured, a plain static
// host, or local dev via `python -m http.server` / `npx serve`).
//
// Real usernames only ever match /^[a-zA-Z0-9_]{3,20}$/ (enforced at
// signup — see doSignUp() in auth.js), so that's used as the check
// for "is this path segment actually a pretty username" instead of
// just an exclude-list of reserved words. Without it, hitting the
// page at its own literal filename ("/profile.html") — i.e. every
// visit that isn't going through the pretty-URL rewrite — took
// "profile.html" itself as the first path segment, treated it as
// the username to look up, and always failed with "No user found",
// even for your own profile link.
const RESERVED_TOP_LEVEL = new Set(['home','notifications','messages','bookmarks','settings','search','login','signup','rules','i','communities','lists','articles']);

// Reads the community slug out of the current URL on community.html,
// whether it arrived as a pretty path (/communities/some-slug) or the
// legacy query form (community.html?slug=some-slug — local dev
// without Vercel's rewrite engine). Same idea as currentStatusId().
function currentCommunitySlug() {
  const m = location.pathname.match(/\/communities\/([^/]+)/);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(location.search).get('slug');
}

// Reads the list id out of the current URL on list.html, whether it
// arrived as a pretty path (/i/lists/<uuid>) or the legacy query form
// (list.html?id=<uuid> — local dev without Vercel's rewrite engine).
// Same idea as currentStatusId()/currentCommunitySlug().
function currentListId() {
  const m = location.pathname.match(/\/lists\/([^/]+)/);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(location.search).get('id');
}
// Reads the article id out of the current URL on article.html/
// editarticle.html, whether it arrived as a pretty path
// (/i/articles/<uuid>) or the legacy query form
// (article.html?id=<uuid> — local dev without Vercel's rewrite
// engine). Same idea as currentListId().
function currentArticleId() {
  const m = location.pathname.match(/\/articles\/([^/]+)/);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(location.search).get('id');
}
const USERNAME_RE = /^[a-zA-Z0-9_]{3,20}$/;
function currentProfileUsername() {
  const seg = location.pathname.split('/').filter(Boolean)[0];
  if (seg && USERNAME_RE.test(seg) && !RESERVED_TOP_LEVEL.has(seg.toLowerCase())) return decodeURIComponent(seg);
  return new URLSearchParams(location.search).get('u');
}


// ── ICONS + tweet-style post card rendering ──
const ICON = {
  reply:    '<svg viewBox="0 0 24 24"><path d="M12 3.5C7.03 3.5 3 6.96 3 11.2c0 2.35 1.24 4.46 3.2 5.88-.13.98-.55 2.5-1.6 3.9 1.72-.2 3.29-.98 4.4-1.76.94.3 1.96.46 3 .46 4.97 0 9-3.46 9-7.72s-4.03-8.46-9-8.46z"/></svg>',
  heart:    '<svg viewBox="0 0 24 24"><path d="M12 20.8s-6.9-4.2-9.5-8.4C.9 9.5 1.5 6 4.3 4.5c2.2-1.2 4.6-.5 6 1.3L12 8l1.7-2.2c1.4-1.8 3.8-2.5 6-1.3 2.8 1.5 3.4 5 1.8 7.9-2.6 4.2-9.5 8.4-9.5 8.4z"/></svg>',
  views:    '<svg viewBox="0 0 24 24"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
  share:    '<svg viewBox="0 0 24 24"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>',
  menu:     '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24"><path d="M6.5 3.5h11a1 1 0 0 1 1 1V21l-6.5-4.5L5.5 21V4.5a1 1 0 0 1 1-1Z"/></svg>',
  repost:   '<svg viewBox="0 0 24 24"><polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/><polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/></svg>',
  quote:    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 6c-2.5 1.4-4 3.6-4 6.3 0 2.6 1.7 4.2 3.8 4.2 1.9 0 3.3-1.4 3.3-3.2 0-1.7-1.2-3-2.8-3-.3 0-.6 0-.8.1.2-1.6 1.5-3.2 3.3-4.1L7 6Zm9 0c-2.5 1.4-4 3.6-4 6.3 0 2.6 1.7 4.2 3.8 4.2 1.9 0 3.3-1.4 3.3-3.2 0-1.7-1.2-3-2.8-3-.3 0-.6 0-.8.1.2-1.6 1.5-3.2 3.3-4.1L16 6Z"/></svg>'
};

// ── SIDEBAR NAV — rendered into <nav id="side-nav"></nav> on every
// page, same idea as auth.js's auth-area: one source of truth so the
// "which link is Profile" / unread-count logic doesn't get copy-pasted
// across every HTML file. auth.js calls this once it knows who (if
// anyone) is logged in.
const NAV_ICON = {
  home:     '<svg viewBox="0 0 24 24"><path d="M4 12.3 11.15 5.7a1.3 1.3 0 0 1 1.7 0L20 12.3"/><path d="M6.3 10.6V18a1.6 1.6 0 0 0 1.6 1.6h8.2A1.6 1.6 0 0 0 17.7 18v-7.4"/><path d="M10 19.5v-4.2c0-.75.65-1.3 1.4-1.3h1.2c.75 0 1.4.55 1.4 1.3v4.2"/></svg>',
  search:   '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.75"/><path d="m20 20-4.55-4.55"/></svg>',
  bell:     '<svg viewBox="0 0 24 24"><path d="M12 3.25a5.75 5.75 0 0 0-5.75 5.75v2.6c0 .85-.32 1.67-.9 2.3l-1.05 1.13c-.9.97-.2 2.57 1.13 2.57h13.14c1.33 0 2.03-1.6 1.13-2.57l-1.05-1.13a3.4 3.4 0 0 1-.9-2.3V9A5.75 5.75 0 0 0 12 3.25Z"/><path d="M9.6 19.3a2.4 2.4 0 0 0 4.8 0"/></svg>',
  chat:     '<svg viewBox="0 0 24 24"><rect x="4" y="5" width="16" height="11" rx="4"/><path d="M8.2 16v3.1a.5.5 0 0 0 .82.38L13.4 16"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24"><path d="M7 4.5h10a1 1 0 0 1 1 1V20a.6.6 0 0 1-.95.48L12 16.3l-5.05 4.18A.6.6 0 0 1 6 20V5.5a1 1 0 0 1 1-1Z"/></svg>',
  user:     '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.2" r="3.75"/><path d="M4.5 19.6c1.1-4.15 3.9-6.15 7.5-6.15s6.4 2 7.5 6.15"/></svg>',
  gear:     '<svg viewBox="0 0 24 24"><path d="M3.5 6.2h8.4M15.9 6.2H20.5"/><circle cx="13.9" cy="6.2" r="2.1"/><path d="M3.5 12h3.4M11.1 12H20.5"/><circle cx="9.1" cy="12" r="2.1"/><path d="M3.5 17.8h11.4M18.1 17.8H20.5"/><circle cx="16.1" cy="17.8" r="2.1"/></svg>',
  doc:      '<svg viewBox="0 0 24 24"><path d="M6.5 3.5h8l4.5 4.5v11.5a1 1 0 0 1-1 1h-11.5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M14.5 3.5V8h4.5"/><path d="M8.5 13h7M8.5 16.5h7"/></svg>',
  dots:     '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.8" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="1.8" fill="currentColor" stroke="none"/></svg>',
  people:   '<svg viewBox="0 0 24 24"><circle cx="9" cy="8.3" r="3.3"/><path d="M2.8 20c.9-3.7 3.2-5.6 6.2-5.6s5.3 1.9 6.2 5.6"/><path d="M15.6 5.3a3.2 3.2 0 0 1 0 6.1"/><path d="M16.2 14.8c2.4.5 4.1 2.2 4.9 5.2"/></svg>',
  list:     '<svg viewBox="0 0 24 24"><rect x="4" y="5.5" width="3" height="3" rx="0.8"/><rect x="4" y="10.5" width="3" height="3" rx="0.8"/><rect x="4" y="15.5" width="3" height="3" rx="0.8"/><path d="M10 7h10M10 12h10M10 17h10"/></svg>',
  article:  '<svg viewBox="0 0 24 24"><path d="M5.5 4.5h13a1 1 0 0 1 1 1v13a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1v-13a1 1 0 0 1 1-1Z"/><path d="M8 8.5h8M8 12h8M8 15.5h5"/></svg>',
  info:     '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r="1" fill="currentColor" stroke="none"/></svg>',
  mail:     '<svg viewBox="0 0 24 24"><rect x="3.5" y="5.5" width="17" height="13" rx="2.5"/><path d="m4.3 6.7 7.7 6 7.7-6"/></svg>',
  shield:   '<svg viewBox="0 0 24 24"><path d="M12 3.3 5.3 5.9v5.4c0 4.7 2.9 7.9 6.7 8.9 3.8-1 6.7-4.2 6.7-8.9V5.9Z"/><path d="m9 12 2 2 4-4"/></svg>'
};

// ── THEME — Default (light) / Dim / Lights out (dark), applied via
// data-theme on <html>. A tiny inline script in every page's <head>
// reads THEME_KEY before first paint (no flash); this just gives
// settings.js (and anything else) a shared way to change/read it.
//
// A stored value ('light'/'dim'/'dark') means the person explicitly
// picked one in Settings and it always wins. No stored value (null)
// means "Match device" — the default for everyone who's never opened
// the picker — which follows the OS/browser's prefers-color-scheme,
// live: flipping the phone from light to dark (or back) updates the
// site immediately, no reload, without ever touching localStorage.
// Device dark → the "dark" (Lights out) theme, not "dim". ──
const THEME_KEY = 'oc-theme';
function systemPrefersDark() {
  try { return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches; }
  catch (e) { return false; }
}
// System dark mode is a single boolean, but this app has two dark
// looks (Dim vs. Lights out); "Lights out" (dark) is the one used for
// auto/system dark, so someone whose phone is set to dark mode lands
// on the true dark theme rather than the in-between Dim look.
function resolveTheme(stored) {
  if (stored === 'light' || stored === 'dim' || stored === 'dark') return stored;
  return systemPrefersDark() ? 'dark' : 'light';
}
function getStoredTheme() {
  try { return localStorage.getItem(THEME_KEY); } catch (e) { return null; }
}
// The theme actually on screen right now (resolves "auto" to light/dim).
function getTheme() { return resolveTheme(getStoredTheme()); }
// theme: 'light' | 'dim' | 'dark' (explicit) or 'auto'/falsy (match device).
function applyTheme(theme) {
  if (!theme || theme === 'auto') { try { localStorage.removeItem(THEME_KEY); } catch (e) {} }
  else { try { localStorage.setItem(THEME_KEY, theme); } catch (e) {} }
  const resolved = resolveTheme(theme === 'auto' ? null : theme);
  if (resolved !== 'light') document.documentElement.setAttribute('data-theme', resolved);
  else document.documentElement.removeAttribute('data-theme');
  updateFavicon(resolved);
}
// Live-updates the page the instant the OS theme flips, but only for
// people who haven't overridden it with an explicit Settings choice.
(function watchSystemTheme() {
  try {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onChange = () => { if (!getStoredTheme()) applyTheme('auto'); };
    mq.addEventListener ? mq.addEventListener('change', onChange) : mq.addListener(onChange);
  } catch (e) {}
})();
// Swaps the two <link rel="icon"> hrefs between the light mark (white
// square, black &) and dark mark (black square, white &) so the tab
// favicon always matches Default vs Dim/Lights out. The pre-paint
// inline <script> in every page's <head> does the same thing for the
// very first paint (before this file has even loaded); this is what
// keeps it in sync on a live theme switch from Settings.
function updateFavicon(theme) {
  const dark = theme && theme !== 'light';
  const f32 = document.getElementById('fav32');
  const f512 = document.getElementById('fav512');
  if (f32) f32.href = dark ? 'img/favicon-dark-32.png' : 'img/favicon-32.png';
  if (f512) f512.href = dark ? 'img/favicon-dark.png' : 'img/favicon.png';
}
// ── ACCENT COLOR — same idea as THEME above, but swaps the app's one
// accent color (buttons/links/active states) instead of the surface
// colors. Applied via data-accent on <html>; "green" is the default and
// needs no attribute (matches the :root values in style.css). ──
const ACCENT_KEY = 'oc-accent';
const ACCENT_OPTIONS = [
  { id: 'green',  label: 'Green'  },
  { id: 'blue',   label: 'Blue'   },
  { id: 'red',    label: 'Red'    },
  { id: 'purple', label: 'Purple' },
  { id: 'orange', label: 'Orange' }
];
function applyAccent(accent) {
  if (accent && accent !== 'green') document.documentElement.setAttribute('data-accent', accent);
  else document.documentElement.removeAttribute('data-accent');
  try { localStorage.setItem(ACCENT_KEY, accent || 'green'); } catch (e) {}
}
function getAccent() {
  try { return localStorage.getItem(ACCENT_KEY) || 'green'; } catch (e) { return 'green'; }
}

let unreadNotifCount = 0;
let unreadChatCount = 0;

// Maps the current URL (pretty or legacy .html) to one of the fixed
// nav-item keys below, so highlighting "which tab is active" doesn't
// break now that most pages live at a clean path instead of a
// filename. Checked in order; first match wins.
function currentNavKey() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  if (path === '/' || path === '/home' || path.endsWith('/index.html')) return 'home';
  if (path === '/search' || path.endsWith('/search.html')) return 'search';
  if (path === '/notifications' || path.endsWith('/notifications.html')) return 'notifications';
  if (path === '/messages' || path.startsWith('/messages/') || path.endsWith('/chat.html')) return 'messages';
  if (path === '/bookmarks' || path.endsWith('/bookmarks.html')) return 'bookmarks';
  if (path === '/communities' || path.startsWith('/communities/') || path.endsWith('/communities.html') || path.endsWith('/community.html')) return 'communities';
  if (path === '/articles' || path.startsWith('/i/articles/') || path.endsWith('/articles.html') || path.endsWith('/article.html') || path.endsWith('/editarticle.html')) return 'articles';
  if (path === '/lists' || path.startsWith('/i/lists/') || path.endsWith('/lists.html') || path.endsWith('/list.html')) return 'lists';
  if (path === '/settings' || path.endsWith('/settings.html')) return 'settings';
  if (path === '/rules' || path.endsWith('/rules.html')) return 'rules';
  if (path === '/about' || path.endsWith('/about.html')) return 'about';
  if (path === '/contact' || path.endsWith('/contact.html')) return 'contact';
  if (path === '/privacy' || path.endsWith('/privacy.html')) return 'privacy';
  if (path === '/terms' || path.endsWith('/terms.html')) return 'terms';
  if (currentSession && currentProfile && path.toLowerCase() === profileUrl(currentProfile.username).toLowerCase()) return 'profile';
  return null;
}

// Current page is under /es/, /fr/, etc? Prefix internal links to the
// static pages so a visitor browsing a localized version of the site
// stays on that language's pages instead of being bounced back to
// English by the shared nav (see js/i18n.js getLang() for the
// matching URL-is-truth rule, and I18N_STATIC_LANGS there for the
// list of supported prefixes — add a code there to extend this).
function esPrefix() {
  try {
    const m = location.pathname.match(/^\/([a-z]{2})(\/|$)/);
    return (m && typeof I18N_STATIC_LANGS !== 'undefined' && I18N_STATIC_LANGS.includes(m[1])) ? `/${m[1]}` : '';
  } catch (e) { return ''; }
}

function renderSideNav() {
  const el = document.getElementById('side-nav');
  if (!el) return;
  const lp = esPrefix();
  const ownHref = (currentSession && currentProfile) ? profileUrl(currentProfile.username) : `${lp}/login`;
  const notifBadge = unreadNotifCount > 0 ? `<span class="navbadge">${unreadNotifCount > 99 ? '99+' : unreadNotifCount}</span>` : '';
  const chatBadge = unreadChatCount > 0 ? `<span class="navbadge">${unreadChatCount > 20 ? '20+' : unreadChatCount}</span>` : '';
  const here = currentNavKey();
  const item = (href, icon, label, key, extra = '') => {
    return `<a href="${href}"${key === here ? ' class="cur"' : ''}><span class="navicon">${icon}${extra}</span><span class="navlabel">${label}</span></a>`;
  };
  const morePage = here === 'settings' || here === 'rules' || here === 'about' || here === 'contact' || here === 'privacy' || here === 'terms' || here === 'lists';
  const postBtn = currentSession
    ? `<button class="sidebar-post-btn" onclick="mobileCompose();return false;">${ICON_COMPOSE}<span>${t('nav.post')}</span></button>`
    : `<a class="sidebar-post-btn" href="${lp}/signup">${ICON_COMPOSE}<span>${t('nav.post')}</span></a>`;
  el.innerHTML =
    item(lp ? `${lp}/home` : '/home', NAV_ICON.home, t('nav.home'), 'home') +
    item('/search', NAV_ICON.search, t('nav.explore'), 'search') +
    item('/notifications', NAV_ICON.bell, t('nav.notifications'), 'notifications', notifBadge) +
    item('/messages', NAV_ICON.chat, t('nav.chat'), 'messages', chatBadge) +
    item('/bookmarks', NAV_ICON.bookmark, t('nav.bookmarks'), 'bookmarks') +
    item('/articles', NAV_ICON.article, t('nav.articles'), 'articles') +
    item(`${lp}/communities`, NAV_ICON.people, t('nav.communities'), 'communities') +
    item(ownHref, NAV_ICON.user, t('nav.profile'), 'profile') +
    `<div class="acct" id="more-wrap">
       <button class="navmore-btn"${morePage ? ' style="font-weight:800;"' : ''} onclick="toggleMoreMenu();return false;">
         <span class="navicon">${NAV_ICON.dots}</span><span class="navlabel">${t('nav.more')}</span>
       </button>
       <div class="acct-menu navmore-menu" id="more-menu">
         <a href="/lists"${here === 'lists' ? ' class="cur"' : ''}>${NAV_ICON.list}${t('nav.lists')}</a>
         <a href="/settings">${NAV_ICON.gear}${t('nav.settings')}</a>
         <a href="${lp}/rules">${NAV_ICON.doc}${t('nav.rules')}</a>
         <a href="${lp}/about">${NAV_ICON.info}${t('nav.about')}</a>
         <a href="${lp}/contact">${NAV_ICON.mail}${t('nav.contact')}</a>
         <a href="${lp}/privacy">${NAV_ICON.shield}${t('nav.privacy')}</a>
         <a href="${lp}/terms">${NAV_ICON.doc}${t('nav.terms')}</a>
       </div>
     </div>` +
    postBtn;
}

function toggleMoreMenu() { document.getElementById('more-wrap')?.classList.toggle('open'); }

// ── MOBILE APP CHROME — top bar, bottom tab bar, compose FAB, and
// slide-out drawer, built fresh into #m-chrome (created once, appended
// to <body>) on every page. CSS keeps all of this display:none above
// the mobile breakpoint, so it costs nothing on desktop. Called from
// auth.js alongside renderSideNav() any time session/profile/unread
// state changes, so the avatar, counts, and badge never go stale. ──
const PLUS_ICON = '<svg viewBox="0 0 24 24"><path d="M12 4v16M4 12h16"/></svg>';
const CHECK_ICON = '<svg viewBox="0 0 24 24"><path d="M5 13l4 4L19 7"/></svg>';
const ICON_COMPOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';

function mchrome() {
  let el = document.getElementById('m-chrome');
  if (!el) { el = document.createElement('div'); el.id = 'm-chrome'; document.body.appendChild(el); }
  return el;
}

function renderMobileChrome() {
  const el = mchrome();
  const here = currentNavKey();
  const cur = key => key === here ? ' cur' : '';
  const badge = unreadNotifCount > 0 ? `<span class="navbadge">${unreadNotifCount > 99 ? '99+' : unreadNotifCount}</span>` : '';
  const chatBadge = unreadChatCount > 0 ? `<span class="navbadge">${unreadChatCount > 20 ? '20+' : unreadChatCount}</span>` : '';
  const lp = esPrefix();
  const ownHref = (currentSession && currentProfile) ? profileUrl(currentProfile.username) : `${lp}/login`;
  const avatar = currentSession ? avatarUrl(currentProfile?.avatar_url) : DEFAULT_AVATAR;

  // On the chat page the floating "+" FAB just detours to the board's
  // composer, which reads as a broken/unrelated button floating over
  // chat's own message composer — so skip it there in favor of chat's
  // own send controls. (The top-right "Post"/"Log in" pill has been
  // removed entirely — posting on mobile goes through the "+" FAB or
  // the drawer's Sign up/Log in CTAs, and the logo now sits centered
  // in the topbar instead of being pushed off-center by that pill.)
  const onChatPage = here === 'messages';

  el.innerHTML = `
    <div id="m-topbar">
      <button class="m-avatar-btn" onclick="openMobileDrawer();return false;" aria-label="Open menu">
        <img class="avatar" src="${esc(avatar)}" alt="">
      </button>
      <a class="m-logo" href="${lp || '/'}">
        <img class="logo-mark logo-mark-light" src="img/logo-light.png" alt="" width="26" height="26">
        <img class="logo-mark logo-mark-dark" src="img/logo-dark.png" alt="" width="26" height="26">
      </a>
    </div>

    <div id="m-tabbar">
      <a class="${cur('home')}" href="${lp || '/'}">${NAV_ICON.home}<span class="m-tab-label">Home</span></a>
      <a class="${cur('search')}" href="search.html">${NAV_ICON.search}<span class="m-tab-label">Search</span></a>
      <a class="${cur('bookmarks')}" href="bookmarks.html">${NAV_ICON.bookmark}<span class="m-tab-label">Saved</span></a>
      <a class="${cur('notifications')}" href="notifications.html">${NAV_ICON.bell}${badge}<span class="m-tab-label">Alerts</span></a>
      <a class="${cur('messages')}" href="chat.html">${NAV_ICON.chat}${chatBadge}<span class="m-tab-label">Chat</span></a>
    </div>

    ${currentSession && !onChatPage ? `<button id="m-fab" onclick="mobileCompose();return false;" aria-label="Post">${PLUS_ICON}</button>` : ''}

    <div class="m-drawer-bg" id="m-drawer-bg" onclick="if(event.target===this)closeMobileDrawer();">
      <div class="m-drawer">
        ${currentSession ? `
          <a href="${ownHref}"><img class="avatar m-drawer-avatar" src="${esc(avatar)}" alt=""></a>
          <a href="${ownHref}" style="text-decoration:none;">
            <span class="m-drawer-name">${esc(currentProfile?.display_name || currentProfile?.username || 'You')}</span>
            <span class="m-drawer-handle">@${esc(currentProfile?.username || '')}</span>
          </a>
          <div class="m-drawer-stats">
            <a href="${currentProfile ? followListUrl(currentProfile.username, 'following') : '#'}"><b>${fmtCount(currentProfile?.following_count)}</b> Following</a>
            <a href="${currentProfile ? followListUrl(currentProfile.username, 'followers') : '#'}"><b>${fmtCount(currentProfile?.followers_count)}</b> Followers</a>
          </div>
          <hr>
          <div class="m-drawer-menu">
            <a href="${ownHref}">${NAV_ICON.user}Profile</a>
            <a href="bookmarks.html">${NAV_ICON.bookmark}Bookmarks</a>
            <a href="articles.html">${NAV_ICON.article}Articles</a>
            <a href="${lp}/communities">${NAV_ICON.people}Communities</a>
            <a href="editprofile.html">${NAV_ICON.doc}Edit profile</a>
            <a href="/settings">${NAV_ICON.gear}Settings and privacy</a>
            <a href="lists.html">${NAV_ICON.list}Lists</a>
            <a href="${lp}/rules">${NAV_ICON.doc}Rules</a>
            <a href="${lp}/about">${NAV_ICON.info}About</a>
            <a href="${lp}/contact">${NAV_ICON.mail}Contact</a>
            <a href="${lp}/privacy">${NAV_ICON.shield}Privacy Policy</a>
            <a href="${lp}/terms">${NAV_ICON.doc}Terms of Service</a>
          </div>
          <hr>
          <button class="m-drawer-logout" onclick="closeMobileDrawer();logOut();"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4.5H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 19.5h3"/><path d="M15.5 16.5 20 12l-4.5-4.5"/><path d="M20 12H9"/></svg>Log out</button>
        ` : `
          <img class="avatar m-drawer-avatar" src="${DEFAULT_AVATAR}" alt="">
          <span class="m-drawer-name">Welcome to InteractInk</span>
          <span class="m-drawer-handle">Log in to follow, post, and reply.</span>
          <div class="m-drawer-menu" style="margin-top:8px;">
            <a href="articles.html">${NAV_ICON.article}Articles</a>
            <a href="${lp}/communities">${NAV_ICON.people}Communities</a>
            <a href="lists.html">${NAV_ICON.list}Lists</a>
            <a href="${lp}/rules">${NAV_ICON.doc}Rules</a>
            <a href="${lp}/about">${NAV_ICON.info}About</a>
            <a href="${lp}/contact">${NAV_ICON.mail}Contact</a>
            <a href="${lp}/privacy">${NAV_ICON.shield}Privacy Policy</a>
            <a href="${lp}/terms">${NAV_ICON.doc}Terms of Service</a>
          </div>
          <div class="m-drawer-cta">
            <a class="cta-primary" href="${lp}/signup">Sign up</a>
            <a class="cta-ghost" href="${lp}/login">Log in</a>
          </div>
        `}
      </div>
    </div>`;
}

// oc-drawer-open on <html> both locks page scroll behind the drawer and
// (via the matching CSS rule) force-drops #board-hdr/#m-topbar/#m-tabbar/
// #m-fab to z-index:0 while it's open — fixes those sticky/backdrop-filter
// bars occasionally compositing above the drawer overlay despite its much
// higher z-index (see .m-drawer-bg comment in style.css).
function openMobileDrawer() {
  document.getElementById('m-drawer-bg')?.classList.add('open');
  document.documentElement.classList.add('oc-drawer-open');
}
function closeMobileDrawer() {
  document.getElementById('m-drawer-bg')?.classList.remove('open');
  document.documentElement.classList.remove('oc-drawer-open');
}

// ─────────────────────────────────────────────────────────────
// GLOBAL COMPOSE MODAL — the sidebar "Post" button, mobile top-bar
// "Post" pill, and mobile "+" FAB all open this, same as tapping
// the Post button in the real X app pops a compose modal over
// whatever page you're already on, instead of navigating away.
// Built once into <body> here (same lazy-inject pattern as
// mchrome()) so it works on every page, not just the board — no
// per-page HTML needed, unlike the quote-post modal.
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// REPLY AUDIENCE PICKER — the "Everyone can reply" pill shown above
// every "new post" composer's toolbar (the global compose modal, the
// home feed's inline composer, a community's inline composer) is
// tappable and opens a small X-style menu: Everyone can reply, or No
// one. One state object + one markup template here covers every
// composer prefix ('gc'/'pf'/'cf'), same idea as composeExtras above.
// The choice rides along on the post itself (posts.reply_audience —
// see submitGlobalCompose()/submitPost()/submitCommunityPost()), and
// postActionsHtml()/opDetailActionsHtml() further down gray out and
// disable that post's reply button everywhere it's rendered whenever
// reply_audience is 'none' — same as X hard-disabling the reply icon
// on a reply-restricted Tweet instead of just hiding it.
// ─────────────────────────────────────────────────────────────
const replyAudienceState = {};
function getReplyAudience(prefix) { return replyAudienceState[prefix] || 'everyone'; }

const GA_ICON = {
  everyone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18"/><path d="M12 3c2.5 2.7 3.8 6 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-6-3.8-9s1.3-6.3 3.8-9Z"/></svg>',
  none:     '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/></svg>'
};
const GA_LABEL = { everyone: 'Everyone can reply', none: 'No one can reply' };
const GA_CHECK = '<svg class="ga-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>';

// Builds the pill + dropdown for one composer. Injected straight into
// gcModalEl()'s template (JS-built) below, and dropped into the
// static pf/cf composer markup at runtime by injectReplyAudienceUi().
function replyAudienceMenuHtml(prefix) {
  return `
    <div class="ga-row">
      <div class="ga-wrap" id="${prefix}-ga-wrap">
        <button type="button" class="ga-btn" id="${prefix}-ga-btn" onclick="toggleAudienceMenu('${prefix}', event)" aria-haspopup="true" aria-label="Who can reply">
          <span class="ga-btn-icon" id="${prefix}-ga-icon">${GA_ICON.everyone}</span>
          <span id="${prefix}-ga-label">${GA_LABEL.everyone}</span>
          <svg class="ga-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m7 10 5 5 5-5"/></svg>
        </button>
        <div class="ga-dd" id="${prefix}-ga-dd" role="menu">
          <div class="ga-dd-title">Who can reply?</div>
          <button type="button" class="ga-opt active" data-val="everyone" onclick="setReplyAudience('${prefix}','everyone');return false;">
            ${GA_ICON.everyone.replace('<svg ', '<svg class="ga-opt-icon" ')}
            <span class="ga-opt-txt"><b>Everyone</b><small>Anyone can reply</small></span>
            ${GA_CHECK}
          </button>
          <button type="button" class="ga-opt" data-val="none" onclick="setReplyAudience('${prefix}','none');return false;">
            ${GA_ICON.none.replace('<svg ', '<svg class="ga-opt-icon" ')}
            <span class="ga-opt-txt"><b>No one</b><small>Nobody will be able to reply</small></span>
            ${GA_CHECK}
          </button>
        </div>
      </div>
    </div>`;
}

// pf (home feed) and cf (community) composers are static per-page
// markup, not JS-built — this drops the same picker in right where
// the page left an empty `<div id="${prefix}-ga-slot">` for it, so
// the HTML/JS stay in sync automatically instead of two copy-pasted
// markup blocks drifting apart.
function injectReplyAudienceUi(prefix) {
  const slot = document.getElementById(`${prefix}-ga-slot`);
  if (slot) slot.outerHTML = replyAudienceMenuHtml(prefix);
}

function toggleAudienceMenu(prefix, ev) {
  if (ev) ev.stopPropagation();
  const wrap = document.getElementById(`${prefix}-ga-wrap`);
  if (!wrap) return;
  const willOpen = !wrap.classList.contains('open');
  document.querySelectorAll('.ga-wrap.open').forEach(w => w.classList.remove('open'));
  if (willOpen) {
    wrap.classList.add('open');
    // Mobile turns this into a full-screen bottom sheet (same trick
    // as the repost/quote menu), so the page behind it shouldn't
    // also scroll while it's open.
    if (window.matchMedia('(max-width: 520px)').matches) document.body.classList.add('oc-sheet-open');
  } else {
    document.body.classList.remove('oc-sheet-open');
  }
}
document.addEventListener('click', (e) => {
  document.querySelectorAll('.ga-wrap.open').forEach(w => {
    if (e.target === w || !w.contains(e.target)) {
      w.classList.remove('open');
      document.body.classList.remove('oc-sheet-open');
    }
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.ga-wrap.open').forEach(w => w.classList.remove('open'));
  document.body.classList.remove('oc-sheet-open');
});

function updateAudienceUi(prefix) {
  const value = getReplyAudience(prefix);
  const btn = document.getElementById(`${prefix}-ga-btn`);
  const iconEl = document.getElementById(`${prefix}-ga-icon`);
  const labelEl = document.getElementById(`${prefix}-ga-label`);
  if (iconEl) iconEl.innerHTML = GA_ICON[value];
  if (labelEl) labelEl.textContent = GA_LABEL[value];
  if (btn) btn.classList.toggle('ga-restricted', value === 'none');
  document.querySelectorAll(`#${prefix}-ga-dd .ga-opt`).forEach(opt => {
    opt.classList.toggle('active', opt.dataset.val === value);
  });
}

function setReplyAudience(prefix, value) {
  replyAudienceState[prefix] = value;
  updateAudienceUi(prefix);
  document.getElementById(`${prefix}-ga-wrap`)?.classList.remove('open');
  document.body.classList.remove('oc-sheet-open');
}

// Back to the default every time a composer is used up (see
// resetComposeExtras() below) — same as X, which never remembers a
// restricted-reply choice into the next Tweet you write.
function resetReplyAudience(prefix) {
  replyAudienceState[prefix] = 'everyone';
  updateAudienceUi(prefix);
}

function gcModalEl() {
  let el = document.getElementById('gc-modal-bg');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'gc-modal-bg';
  el.className = 'modal-bg';
  el.addEventListener('click', e => { if (e.target === el) closeGlobalCompose(); });
  el.innerHTML = `
    <div class="modal gc-modal">
      <a class="modal-close" href="#" onclick="closeGlobalCompose();return false;">&#10005;</a>
      <div class="errmsg" id="gc-err" style="display:none;margin:0 16px 8px;"></div>
      <div class="pf-row gc-row">
        <span class="pf-avatar" id="gc-avatar"></span>
        <div class="pf-col">
          <textarea id="gc-body" maxlength="500" placeholder="${t('compose.placeholder')}"></textarea>
          <div id="gc-fp" class="fp"></div>
          <div class="cx-poll" id="gc-poll-box" hidden>
            <div class="cx-poll-opts" id="gc-poll-opts">
              <input type="text" class="cx-poll-opt" placeholder="Choice 1" maxlength="25">
              <input type="text" class="cx-poll-opt" placeholder="Choice 2" maxlength="25">
            </div>
            <div class="cx-poll-row">
              <button type="button" class="cx-poll-add" onclick="addPollOption('gc');return false;">+ Add option</button>
              <select id="gc-poll-dur"><option value="1">1 day</option><option value="3" selected>3 days</option><option value="7">7 days</option></select>
              <button type="button" class="cx-poll-remove" title="Remove poll" aria-label="Remove poll" onclick="removePoll('gc');return false;">&#10005;</button>
            </div>
          </div>
          <div class="cx-sched" id="gc-sched-box" hidden>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg>
            <input type="datetime-local" id="gc-sched-input">
            <button type="button" class="cx-sched-remove" title="Remove" aria-label="Remove" onclick="removeSchedule('gc');return false;">&#10005;</button>
          </div>
        </div>
      </div>
      ${replyAudienceMenuHtml('gc')}
      <div class="pf-toolbar gc-toolbar">
        <div class="pf-icons">
          <button type="button" class="pf-ic" title="Media" aria-label="Media" onclick="document.getElementById('gc-file').click();return false;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10.5" r="1.6"/><path d="m4 17 5-5 3.5 3.5L17 11l3 3"/></svg>
          </button>
          <button type="button" class="pf-ic" title="GIF" aria-label="GIF" onclick="openGifPicker('gc');return false;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M11.2 9.5H9a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h2.2v-2h-1M13.6 9.5v5M16 14.5v-5h2.4M16 12h1.8"/></svg>
          </button>
          <button type="button" class="pf-ic" title="Poll" aria-label="Poll" onclick="togglePollBuilder('gc');return false;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 15v2M12 11v6M17 8v10"/></svg>
          </button>
          <button type="button" class="pf-ic" title="Emoji" aria-label="Emoji" onclick="toggleEmojiPicker('gc', this);return false;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8.5 10h.01M15.5 10h.01M8 14.5c1 1.2 2.3 1.8 4 1.8s3-.6 4-1.8"/></svg>
          </button>
          <button type="button" class="pf-ic" title="Schedule" aria-label="Schedule" onclick="toggleScheduleBuilder('gc');return false;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/><path d="M8 13.5h1M12 13.5h1M16 13.5h1M8 17h1M12 17h1"/></svg>
          </button>
          <input type="file" id="gc-file" accept="image/*,video/*" style="display:none;">
        </div>
        <input type="submit" id="gc-btn" class="pf-btn" value="Post" onclick="submitGlobalCompose();return false;" disabled>
      </div>
      <span id="gc-st" class="gc-status"></span>
    </div>`;
  document.body.appendChild(el);

  wireFilePreview('gc-file', 'gc-fp', 'gc-err');
  const gcBody = document.getElementById('gc-body');
  gcBody.addEventListener('input', () => {
    updateGcBtnState();
    gcBody.style.height = 'auto';
    gcBody.style.height = Math.max(64, gcBody.scrollHeight) + 'px';
  });
  gcBody.addEventListener('keydown', e => { if (e.key === 'Escape') closeGlobalCompose(); });
  return el;
}

function updateGcBtnState() {
  const bodyEl = document.getElementById('gc-body');
  const btn = document.getElementById('gc-btn');
  if (!bodyEl || !btn) return;
  btn.disabled = bodyEl.value.trim().length === 0;
}

// The FAB, the mobile top-bar "Post" pill, and the desktop sidebar
// "Post" button all call this — same button, same modal, everywhere,
// matching how the real X app's Post button behaves on every screen.
function mobileCompose() { openGlobalCompose(); }

// `prefillText` is optional — used by "Post this" on a List's share
// menu (see listMenuPostThis() in list.js) to drop the List's link
// straight into the composer, same idea as X dropping a quoted card
// in. Every other caller (the FAB, sidebar/mobile "Post" button)
// leaves it undefined, so the composer opens empty as before.
function openGlobalCompose(prefillText) {
  if (!requireLogin()) return;
  const el = gcModalEl();
  if (el.classList.contains('open')) return; // already open — ignore a double tap of the FAB/pill
  const avEl = document.getElementById('gc-avatar');
  if (avEl) avEl.innerHTML = `<img src="${esc(avatarUrl(currentProfile?.avatar_url))}" alt="">`;
  resetReplyAudience('gc');
  el.classList.add('open');
  lockScroll();
  const bodyEl = document.getElementById('gc-body');
  if (bodyEl) {
    bodyEl.value = prefillText || '';
    bodyEl.style.height = 'auto';
    bodyEl.style.height = Math.max(64, bodyEl.scrollHeight) + 'px';
    updateGcBtnState();
  }
  setTimeout(() => document.getElementById('gc-body')?.focus(), 50);
}

function closeGlobalCompose() {
  const el = document.getElementById('gc-modal-bg');
  if (!el || !el.classList.contains('open')) return;
  el.classList.remove('open');
  unlockScroll();
}

async function submitGlobalCompose() {
  if (!requireLogin()) return;
  const bodyEl = document.getElementById('gc-body');
  const fileEl = document.getElementById('gc-file');
  const btn    = document.getElementById('gc-btn');
  const stEl   = document.getElementById('gc-st');
  const errEl  = document.getElementById('gc-err');
  clearErr(errEl);

  const body = bodyEl.value.trim();
  if (!body) { showErr(errEl, "Post can't be empty."); return; }
  if (body.length > 500) { showErr(errEl, 'Post too long (max 500 chars).'); return; }
  if (!validatePollAndSchedule('gc', errEl)) return;

  btn.disabled = true;
  stEl.textContent = 'Posting…';
  try {
    let media_url = null, media_type = null;
    const gifUrl = composeExtras.gc?.gifUrl;
    const file = fileEl.files[0];
    if (gifUrl) {
      media_url = gifUrl; media_type = 'gif';
    } else if (file) {
      if (!validateFile(file, errEl)) { btn.disabled = false; stEl.textContent = ''; return; }
      stEl.textContent = 'Uploading file…';
      ({ media_url, media_type } = await uploadMedia(file, msg => stEl.textContent = msg));
    }
    const poll = collectPoll('gc');
    const scheduled_at = collectSchedule('gc');
    const { data, error } = await sb.from('posts').insert({
      author_id: currentSession.user.id,
      body, media_url, media_type,
      poll_options: poll?.poll_options || null,
      poll_ends_at: poll?.poll_ends_at || null,
      scheduled_at,
      reply_audience: getReplyAudience('gc')
    }).select('*, profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified)').single();
    if (error) throw error;

    bodyEl.value = ''; bodyEl.style.height = '';
    fileEl.value = ''; document.getElementById('gc-fp').innerHTML = '';
    resetComposeExtras('gc');
    stEl.textContent = '';
    closeGlobalCompose();

    if (scheduled_at) {
      alert(`Post scheduled for ${new Date(scheduled_at).toLocaleString()}.`);
      return;
    }
    // Already on the home feed showing "For you"? Drop it straight
    // in, same as posting from the inline composer would. Otherwise
    // (profile/search/chat/thread/anywhere else) jump to the new
    // post so posting from the modal is never a silent no-op.
    if (typeof addPostToFeed === 'function' && document.getElementById('feed-posts')
        && (typeof activeTab === 'undefined' || activeTab === 'foryou')) {
      addPostToFeed(data, true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } else {
      location.href = postUrlById(data.id, currentProfile?.username);
    }
  } catch (e) {
    showErr(errEl, e.message || 'Failed to post.');
    stEl.textContent = '';
  } finally {
    btn.disabled = false;
    updateGcBtnState();
  }
}

document.addEventListener('DOMContentLoaded', renderMobileChrome);

// ─────────────────────────────────────────────────────────────
// REPLY POPUP — tapping the comment/reply icon on a feed post card
// (postCardHtml's postActionsHtml) used to do nothing, since those
// cards never passed a replyHref/replyOnclick. Twitter's equivalent
// opens a small "Post your reply" popup right there instead of
// navigating away — this is that popup. Same lazy-build-into-<body>
// pattern as gcModalEl()/dcModalEl()/ccModalEl() above, so it works
// from any page that renders post cards (feed, community, profile,
// search, bookmarks) with no per-page markup needed. Submits into
// `replies`, not `posts` — this is a comment on the post, never a
// new top-level post.
// ─────────────────────────────────────────────────────────────
let rpcTargetPostId = null;

function rpcModalEl() {
  let el = document.getElementById('rpc-modal-bg');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'rpc-modal-bg';
  el.className = 'modal-bg';
  el.addEventListener('click', e => { if (e.target === el) closeReplyPopup(); });
  el.innerHTML = `
    <div class="modal gc-modal rpc-modal">
      <a class="modal-close" href="#" onclick="closeReplyPopup();return false;">&#10005;</a>
      <div class="rpc-context" id="rpc-context"></div>
      <div class="errmsg" id="rpc-err" style="display:none;margin:0 16px 8px;"></div>
      <div class="pf-row gc-row">
        <span class="pf-avatar" id="rpc-avatar"></span>
        <div class="pf-col">
          <textarea id="rpc-body" maxlength="500" placeholder="${t('compose.reply')}"></textarea>
          <div id="rpc-fp" class="fp"></div>
        </div>
      </div>
      <div class="pf-toolbar gc-toolbar">
        <div class="pf-icons">
          <button type="button" class="pf-ic" title="Media" aria-label="Media" onclick="document.getElementById('rpc-file').click();return false;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10.5" r="1.6"/><path d="m4 17 5-5 3.5 3.5L17 11l3 3"/></svg>
          </button>
          <button type="button" class="pf-ic" title="GIF" aria-label="GIF" onclick="openGifPicker('rpc');return false;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M11.2 9.5H9a1 1 0 0 0-1 1v3a1 1 0 0 0 1 1h2.2v-2h-1M13.6 9.5v5M16 14.5v-5h2.4M16 12h1.8"/></svg>
          </button>
          <button type="button" class="pf-ic" title="Emoji" aria-label="Emoji" onclick="toggleEmojiPicker('rpc', this);return false;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M8.5 10h.01M15.5 10h.01M8 14.5c1 1.2 2.3 1.8 4 1.8s3-.6 4-1.8"/></svg>
          </button>
          <input type="file" id="rpc-file" accept="image/*,video/*" style="display:none;">
        </div>
        <input type="submit" id="rpc-btn" class="pf-btn" value="Reply" onclick="submitReplyPopup();return false;" disabled>
      </div>
      <span id="rpc-st" class="gc-status"></span>
    </div>`;
  document.body.appendChild(el);

  wireFilePreview('rpc-file', 'rpc-fp', 'rpc-err');
  const rpcBody = document.getElementById('rpc-body');
  rpcBody.addEventListener('input', () => {
    updateRpcBtnState();
    rpcBody.style.height = 'auto';
    rpcBody.style.height = Math.max(64, rpcBody.scrollHeight) + 'px';
  });
  rpcBody.addEventListener('keydown', e => { if (e.key === 'Escape') closeReplyPopup(); });
  return el;
}

function updateRpcBtnState() {
  const bodyEl = document.getElementById('rpc-body');
  const btn = document.getElementById('rpc-btn');
  if (!bodyEl || !btn) return;
  btn.disabled = bodyEl.value.trim().length === 0;
}

// `postId` is whichever post's comment icon was tapped — cachePost()
// (called by postCardHtml() for every card ever rendered) means we
// almost always already have that post's author handy for the
// "Replying to @user" line with no extra fetch.
function openReplyPopup(postId) {
  if (!requireLogin()) return;
  if (postCache[postId]?.reply_audience === 'none') {
    toast('Replies are turned off for this post.', 'error');
    return;
  }
  rpcTargetPostId = postId;
  const el = rpcModalEl();
  const p = postCache[postId];
  const ctx = document.getElementById('rpc-context');
  if (ctx) {
    const uname = p?.profile?.username || 'unknown';
    ctx.innerHTML = `Replying to <a href="${profileUrl(uname)}">@${esc(uname)}</a>`;
  }
  const avEl = document.getElementById('rpc-avatar');
  if (avEl) avEl.innerHTML = `<img src="${esc(avatarUrl(currentProfile?.avatar_url))}" alt="">`;
  const errEl = document.getElementById('rpc-err');
  clearErr(errEl);
  if (el.classList.contains('open')) return; // already open — ignore a double tap
  el.classList.add('open');
  lockScroll();
  setTimeout(() => document.getElementById('rpc-body')?.focus(), 50);
}

function closeReplyPopup() {
  const el = document.getElementById('rpc-modal-bg');
  if (!el || !el.classList.contains('open')) return;
  el.classList.remove('open');
  unlockScroll();
  rpcTargetPostId = null;
}

async function submitReplyPopup() {
  if (!requireLogin()) return;
  const targetPostId = rpcTargetPostId;
  if (!targetPostId) return;
  const bodyEl = document.getElementById('rpc-body');
  const fileEl = document.getElementById('rpc-file');
  const btn    = document.getElementById('rpc-btn');
  const stEl   = document.getElementById('rpc-st');
  const errEl  = document.getElementById('rpc-err');
  clearErr(errEl);

  const body = bodyEl.value.trim();
  if (!body) { showErr(errEl, "Reply can't be empty."); return; }
  if (body.length > 500) { showErr(errEl, 'Reply too long (max 500 chars).'); return; }

  btn.disabled = true;
  stEl.textContent = 'Posting…';
  try {
    let media_url = null, media_type = null;
    const gifUrl = composeExtras.rpc?.gifUrl;
    const file = fileEl.files[0];
    if (gifUrl) {
      media_url = gifUrl; media_type = 'gif';
    } else if (file) {
      if (!validateFile(file, errEl)) { btn.disabled = false; stEl.textContent = ''; return; }
      stEl.textContent = 'Uploading file…';
      ({ media_url, media_type } = await uploadMedia(file, msg => stEl.textContent = msg));
    }
    const { data, error } = await sb.from('replies').insert({
      post_id: targetPostId,
      parent_reply_id: null,
      author_id: currentSession.user.id,
      body, media_url, media_type
    }).select('*, profile:profiles(username,display_name,avatar_url,verified)').single();
    if (error) throw error;

    bodyEl.value = ''; bodyEl.style.height = '';
    fileEl.value = ''; document.getElementById('rpc-fp').innerHTML = '';
    resetComposeExtras('rpc');
    stEl.textContent = '';
    closeReplyPopup();

    // Bump the visible reply count on every copy of this post's card
    // that happens to be on screen right now (a repost of it, e.g.,
    // could render twice) — same "every copy" reasoning confirmDeletePost()
    // uses for delete.
    document.querySelectorAll(`[data-post-id="${targetPostId}"] .act.reply .act-label`).forEach(lbl => {
      const n = (parseInt((lbl.textContent || '0').replace(/[^\d]/g, ''), 10) || 0) + 1;
      lbl.textContent = fmtCount(n);
    });

    // If we're already sitting on that post's own thread page, drop
    // the new reply straight into the visible conversation too.
    if (typeof currentStatusId === 'function' && typeof insertReplyIntoTree === 'function'
        && currentStatusId() === targetPostId) {
      insertReplyIntoTree(data);
    }
  } catch (e) {
    showErr(errEl, e.message || 'Failed to post reply.');
    stEl.textContent = '';
  } finally {
    btn.disabled = false;
    updateRpcBtnState();
  }
}


// Wires the (formerly decorative) sidebar search box: Enter jumps to
// the search results page with the typed query.
function wireSidebarSearch() {
  const input = document.getElementById('side-search');
  if (!input) return;
  input.addEventListener('keydown', e => {
    if (e.key !== 'Enter') return;
    const q = input.value.trim();
    if (q) location.href = `search.html?q=${encodeURIComponent(q)}`;
  });
}
document.addEventListener('DOMContentLoaded', wireSidebarSearch);

// ── WHO TO FOLLOW — right-column suggestion box (index.html, thread.html,
// etc.). Self-contained: only runs on pages that actually have a
// #who-to-follow container, same pattern renderSideNav() uses, so no
// other page/script needs to know this exists. Waits on authReady so it
// knows who to exclude (yourself + people already followed). ──
async function renderWhoToFollow() {
  const box = document.getElementById('who-to-follow');
  if (!box) return;
  box.innerHTML = `<div class="t-lbl">Who to follow</div><div class="no-t">Loading&hellip;</div>`;

  const excludeIds = new Set(currentSession ? [currentSession.user.id] : []);
  if (currentSession) {
    const { data: follows } = await sb.from('follows').select('followee_id')
      .eq('follower_id', currentSession.user.id);
    (follows || []).forEach(f => excludeIds.add(f.followee_id));
  }

  // Pull a small pool of recently-active accounts and filter client-side —
  // simplest thing that works for a suggestions box this size, no RPC needed.
  const { data, error } = await sb.from('profiles')
    .select('id,username,display_name,avatar_url,verified')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error || !data) { box.innerHTML = ''; return; }
  const suggestions = data.filter(p => !excludeIds.has(p.id)).slice(0, 3);
  if (!suggestions.length) { box.innerHTML = ''; return; }

  box.innerHTML = `<div class="t-lbl">Who to follow</div>` +
    suggestions.map(whoRowHtml).join('') +
    `<a class="show-more" href="search.html">Show more</a>`;
}

function whoRowHtml(profile) {
  const uname = profile.username || 'unknown';
  return `
    <div class="who-row">
      <a href="${profileUrl(uname)}">
        <img class="avatar pfp-md" src="${esc(avatarUrl(profile.avatar_url))}" alt="" loading="lazy" decoding="async">
      </a>
      <a class="who-row-txt" href="${profileUrl(uname)}">
        <span class="who-row-name">${esc(profile.display_name || uname)}${vBadge(profile)}</span>
        <span class="who-row-handle">@${esc(uname)}</span>
      </a>
      <button class="who-follow-btn" onclick="whoToggleFollow('${profile.id}', this)">${t('action.follow')}</button>
    </div>`;
}

async function whoToggleFollow(userId, btn) {
  if (!requireLogin()) return;
  btn.disabled = true;
  try {
    const { error } = await followUser(userId);
    if (error) throw error;
    // Twitter's own sidebar just drops the card once you've followed —
    // simplest confirmation there is.
    btn.closest('.who-row')?.remove();
  } catch (e) {
    btn.disabled = false;
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  if (!document.getElementById('who-to-follow')) return;
  if (typeof authReady !== 'undefined') await authReady;
  renderWhoToFollow();
});

// ── LIKES ── (private per-user; fetched fresh from the DB whenever a
// page renders a list of posts — same pattern as bookmarked/reposted
// below. This used to be cached in localStorage under 'oc_liked', but
// that key isn't scoped to a user: a browser that had ever liked
// posts would show those same posts as "liked" for a brand-new
// account too, since the Set was seeded from whatever was left in
// localStorage rather than from the signed-in user's own likes. That
// also broke the first tap on such a post — toggleLike() trusted the
// stale "liked" state and fired a delete against a like row that
// never existed for this user, so nothing changed until a second tap.)
let liked = new Set();

async function ensureLikesLoaded() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { liked = new Set(); return; }
  // Likes can point at either a post or a reply (see toggleLike() below),
  // so both columns come back and we fold them into one Set — `liked`
  // is only ever queried by id (`.has(p.id)`), and post/reply ids never
  // collide, so there's no need to track which table an id belongs to.
  const { data } = await sb.from('likes').select('post_id,reply_id').eq('user_id', session.user.id);
  liked = new Set((data || []).flatMap(l => [l.post_id, l.reply_id]).filter(Boolean));
}

function setLikeUiState(btn, isLiked, delta) {
  btn.classList.toggle('liked', isLiked);
  const newCount = Math.max((parseInt(btn.dataset.count, 10) || 0) + delta, 0);
  btn.dataset.count = newCount;
  const lc = btn.querySelector('.lc');
  if (lc) lc.textContent = fmtCount(newCount);
}

// Toggles like/unlike — mirrors toggleBookmark's insert-or-delete pattern.
// OPTIMISTIC: flips the heart and count the instant you tap it, before
// the network call resolves — same as X/Bluesky, and what actually
// makes a like feel instant instead of laggy. If the write fails, it
// quietly rolls back to the pre-tap state and surfaces the error.
//
// `isReply` picks which column the row goes in. Replies aren't rows in
// `posts`, so an insert/delete that always targeted post_id would send
// a reply's id into a column with a FK to posts(id) — Postgres rejects
// that with "violates foreign key constraint likes_post_id_fkey" since
// no such post exists. See supabase/likes_support_replies.sql for the
// matching schema change (post_id/reply_id both nullable, exactly one
// set).
async function toggleLike(id, btn, isReply = false) {
  if (!requireLogin()) return;
  const wasLiked = liked.has(id);
  if (wasLiked) { liked.delete(id); setLikeUiState(btn, false, -1); }
  else { liked.add(id); setLikeUiState(btn, true, 1); }
  const col = isReply ? 'reply_id' : 'post_id';
  try {
    if (wasLiked) {
      const { error } = await sb.from('likes').delete()
        .eq(col, id).eq('user_id', currentSession.user.id);
      if (error) throw error;
    } else {
      const { error } = await sb.from('likes').insert({ [col]: id, user_id: currentSession.user.id });
      // A duplicate-key error here means a like row already existed
      // for this id — most likely liked.has(id) was stale (e.g. liked
      // from another device/tab since this tab last loaded) rather
      // than the insert being genuinely rejected. Recognize that case
      // by more than an exact '23505' code match — some setups
      // surface it as a 409 or just a "duplicate key" message — and
      // treat it as "already liked", not a failure: leave the
      // optimistic UI as liked instead of rolling back.
      const isDuplicate = error && (error.code === '23505' || /duplicate key/i.test(error.message || ''));
      if (error && !isDuplicate) throw error;
      // Row already existed — the optimistic +1 above assumed this was
      // a brand new like, but it wasn't, so the count is one too high
      // now. Correct it back down without touching the liked state.
      if (isDuplicate) setLikeUiState(btn, true, -1);
    }
  } catch (e) {
    // Roll back the optimistic update.
    if (wasLiked) { liked.add(id); setLikeUiState(btn, true, 1); }
    else { liked.delete(id); setLikeUiState(btn, false, -1); }
    console.error('toggleLike failed:', e);
    alert(e.message || 'Could not update like.');
  }
}

// ── BOOKMARKS ── (private per-user; unlike `liked`, this can't just
// live in localStorage since it needs to follow the user across
// devices, so it's fetched fresh from the DB whenever a page renders
// a list of posts.)
let bookmarked = new Set();

async function ensureBookmarksLoaded() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { bookmarked = new Set(); return; }
  const { data } = await sb.from('bookmarks').select('post_id').eq('user_id', session.user.id);
  bookmarked = new Set((data || []).map(b => b.post_id));
}

function setBookmarkUiState(btn, isBookmarked, delta) {
  btn.classList.toggle('bookmarked', isBookmarked);
  const bc = btn.querySelector('.bc');
  if (bc) {
    const n = Math.max((parseInt(btn.dataset.count, 10) || 0) + delta, 0);
    btn.dataset.count = n;
    bc.textContent = fmtCount(n);
  }
}

// OPTIMISTIC, like toggleLike() above — instant visual state, rolled
// back only if the write actually fails.
async function toggleBookmark(postId, btn) {
  if (!requireLogin()) return;
  const wasBookmarked = bookmarked.has(postId);
  if (wasBookmarked) { bookmarked.delete(postId); setBookmarkUiState(btn, false, -1); }
  else { bookmarked.add(postId); setBookmarkUiState(btn, true, 1); }
  // On the bookmarks page itself, removing one should drop its card
  // right away — same instant feel as the toggle itself.
  if (wasBookmarked && document.body.dataset.page === 'bookmarks') {
    document.getElementById(`post-${postId}`)?.remove();
    if (!document.querySelector('#feed-posts .pc')) {
      document.getElementById('feed-posts').innerHTML = `<div id="feed-empty">No bookmarks yet. Tap the bookmark icon on any post to save it here.</div>`;
    }
  }
  try {
    if (wasBookmarked) {
      const { error } = await sb.from('bookmarks').delete()
        .eq('post_id', postId).eq('user_id', currentSession.user.id);
      if (error) throw error;
    } else {
      const { error } = await sb.from('bookmarks').insert({ post_id: postId, user_id: currentSession.user.id });
      if (error && error.code !== '23505') throw error;
    }
  } catch (e) {
    if (wasBookmarked) { bookmarked.add(postId); setBookmarkUiState(btn, true, 1); }
    else { bookmarked.delete(postId); setBookmarkUiState(btn, false, -1); }
    alert(e.message || 'Could not update bookmark.');
  }
}

// ── REPOSTS ── (mirrors the bookmarks pattern above: private-ish per
// user "did I repost this" state, fetched fresh whenever a page is
// about to render a list of posts.)
let reposted = new Set();

async function ensureRepostsLoaded() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { reposted = new Set(); return; }
  const { data } = await sb.from('reposts').select('post_id').eq('user_id', session.user.id);
  reposted = new Set((data || []).map(r => r.post_id));
}

// ── OWNED COMMUNITIES ── (same fetch-fresh-per-render pattern as
// bookmarked/reposted above.) The set of community ids the current
// user created — used to show a Delete option on ANY post inside a
// community you created, not just your own posts, and to gate the
// "change community picture" control on community.html.
let ownedCommunities = new Set();

async function ensureOwnedCommunitiesLoaded() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) { ownedCommunities = new Set(); return; }
  const { data } = await sb.from('communities').select('id').eq('created_by', session.user.id);
  ownedCommunities = new Set((data || []).map(c => c.id));
}

// Every page about to render a list of posts needs all four of the
// above ("did I like/bookmark/repost this", "which communities do I
// own") before it can render action buttons in the right state.
// They're fully independent fetches, so running them one after another
// (the old pattern at every call site) means paying for four network
// round-trips back to back. Promise.all runs them concurrently instead
// — same four fetches, same end state, just not serialized.
async function ensureFeedPrereqsLoaded() {
  await Promise.all([ensureLikesLoaded(), ensureBookmarksLoaded(), ensureRepostsLoaded(), ensureOwnedCommunitiesLoaded()]);
}

// `liked`/`bookmarked` are fetched ONCE per page load. That's fine for
// the tab that does the liking (toggleLike() keeps its own Set in
// sync as you click), but a tab that's just been sitting open has no
// way to find out a post got liked/unliked from somewhere else —
// another device, another tab, or the like button on a completely
// different page in this same tab. Concretely: like a post on your
// phone, then come back to a laptop tab that's been open since before
// that happened — the heart still shows hollow because `liked` never
// heard about it, and *tapping* it then races an insert against a row
// that already exists (the earlier like), so the optimistic UI can
// flip right back.
//
// Fix: re-pull liked/bookmarked/reposted and repaint every rendered
// action button whenever this tab regains focus or comes back into
// view — cheap (three small id-only queries), and means "switch back
// to this tab" is enough to pick up state changed elsewhere, without
// needing a full page reload.
async function resyncFeedPrereqsUi() {
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  await ensureFeedPrereqsLoaded();
  document.querySelectorAll('.act.like[data-id]').forEach(btn => {
    btn.classList.toggle('liked', liked.has(btn.dataset.id));
  });
  document.querySelectorAll('.act.bookmark[data-id]').forEach(btn => {
    btn.classList.toggle('bookmarked', bookmarked.has(btn.dataset.id));
  });
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') resyncFeedPrereqsUi();
});
window.addEventListener('focus', resyncFeedPrereqsUi);

// Every post rendered as a card is stashed here by id, so the Quote
// modal (opened from a plain onclick with just the post id) can pull
// up the author/body/media to embed in the preview without a refetch.
const postCache = {};
function cachePost(p) { if (p && p.id) postCache[p.id] = p; }

// Opens/closes the small "Repost / Quote" dropdown anchored under the
// repost icon — same interaction pattern as the "···" pc-menu-wrap.
function toggleRepostMenu(id, ev) {
  if (ev) ev.stopPropagation();
  const wrap = document.getElementById(`rpmenu-${id}`);
  if (!wrap) return;
  const willOpen = !wrap.classList.contains('open');
  document.querySelectorAll('.rp-menu-wrap.open, .pc-menu-wrap.open').forEach(w => w.classList.remove('open'));
  if (willOpen) {
    wrap.classList.add('open');
    // Mobile turns this into a full-screen bottom sheet, so the page
    // behind it shouldn't also scroll while it's open.
    if (window.matchMedia('(max-width: 640px)').matches) document.body.classList.add('oc-sheet-open');
  }
}
document.addEventListener('click', (e) => {
  document.querySelectorAll('.rp-menu-wrap.open').forEach(w => {
    // e.target === w covers a tap on the mobile backdrop: it's the
    // wrap's own ::before pseudo-element, so w.contains(e.target)
    // would otherwise be true (an element always "contains" itself)
    // and the sheet would never dismiss on backdrop tap.
    if (e.target === w || !w.contains(e.target)) {
      w.classList.remove('open');
      document.body.classList.remove('oc-sheet-open');
    }
  });
});
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  document.querySelectorAll('.rp-menu-wrap.open').forEach(w => w.classList.remove('open'));
  document.body.classList.remove('oc-sheet-open');
});

// Bumps the little repost count label + the reply-count-style icon
// state (green when you've reposted it) without a full card re-render.
function setRepostUiState(postId, isReposted, delta) {
  const wrap = document.getElementById(`rpmenu-${postId}`);
  if (!wrap) return;
  const btn = wrap.querySelector('.act.repost');
  const label = btn?.querySelector('.act-label');
  btn?.classList.toggle('reposted', isReposted);
  if (label) {
    const n = Math.max((parseInt(btn.dataset.count, 10) || 0) + delta, 0);
    btn.dataset.count = n;
    label.textContent = fmtCount(n);
  }
  const undoBtn = wrap.querySelector('.rp-undo');
  const doBtn = wrap.querySelector('.rp-do');
  if (undoBtn) undoBtn.style.display = isReposted ? '' : 'none';
  if (doBtn) doBtn.style.display = isReposted ? 'none' : '';
}

// OPTIMISTIC, same pattern as toggleLike()/toggleBookmark() — the icon
// flips green and the count bumps immediately on tap, before the
// insert/delete round-trip resolves.
async function doRepost(postId, ev) {
  if (ev) ev.stopPropagation();
  if (!requireLogin()) return;
  toggleRepostMenu(postId);
  if (reposted.has(postId)) return;
  reposted.add(postId);
  setRepostUiState(postId, true, 1);
  const { error } = await sb.from('reposts').insert({ post_id: postId, user_id: currentSession.user.id });
  if (error && error.code !== '23505') {
    reposted.delete(postId);
    setRepostUiState(postId, false, -1);
    alert(error.message || 'Could not repost.');
  }
}

async function undoRepost(postId, ev) {
  if (ev) ev.stopPropagation();
  if (!requireLogin()) return;
  toggleRepostMenu(postId);
  if (!reposted.has(postId)) return;
  reposted.delete(postId);
  setRepostUiState(postId, false, -1);
  const { error } = await sb.from('reposts').delete()
    .eq('post_id', postId).eq('user_id', currentSession.user.id);
  if (error) {
    reposted.add(postId);
    setRepostUiState(postId, true, 1);
    alert(error.message || 'Could not undo repost.');
  }
}

// The repost icon + count, plus its "Repost / Quote" dropdown. Kept
// separate from postActionsHtml's other buttons since it needs two
// distinct actions behind one icon, same as Twitter's retweet button.
function repostMenuHtml(p) {
  const isReposted = reposted.has(p.id);
  return `
    <div class="rp-menu-wrap" id="rpmenu-${p.id}">
      <button class="act repost${isReposted ? ' reposted' : ''}" data-count="${p.repost_count || 0}" onclick="toggleRepostMenu('${p.id}', event)" aria-haspopup="true" aria-label="Repost">
        ${ICON.repost}<span class="act-label">${fmtCount(p.repost_count)}</span>
      </button>
      <div class="rp-menu-dd" role="menu">
        <div class="rp-menu-sheet-title">Repost</div>
        <button class="rp-do" style="${isReposted ? 'display:none;' : ''}" onclick="doRepost('${p.id}', event)">${ICON.repost} Repost</button>
        <button class="rp-undo" style="${isReposted ? '' : 'display:none;'}" onclick="undoRepost('${p.id}', event)">${ICON.repost} Undo repost</button>
        <div class="rp-menu-dd-sep"></div>
        <button class="rp-quote" onclick="openQuoteModal('${p.id}', event)">${ICON.quote} Quote</button>
      </div>
    </div>`;
}

// ── QUOTE POSTS ── (a quote is just a normal post row with quote_of
// set — see submitQuote() below — so it shows up in feeds/profiles
// through the exact same postCardHtml() path as any other post.)
let quotingPostId = null;

function quotedPostHtml(qp) {
  if (!qp || qp.is_deleted) return `<div class="qp-embed-gone">Original post is no longer available.</div>`;
  return `
  <div class="qp-embed" onclick="event.stopPropagation();location.href='${postUrl(qp)}'">
    <div class="ph">${pcNameHtml(qp.profile)}<span class="dt">${timeAgo(qp.created_at)}</span></div>
    <div class="pb">${renderBody((qp.body || '').slice(0, 280))}</div>
    ${renderMedia(qp.media_url, qp.media_type, '', qp)}
  </div>`;
}

// Batch-fetches the posts referenced by other posts' quote_of column
// and attaches them as p.quoted, for every post in the given array
// that has quote_of set. Deliberately a plain `.in('id', ids)` query
// instead of a PostgREST self-referencing embed (`posts!quote_of(...)`)
// — that embed needs PostgREST's schema cache to have already picked
// up the quote_of foreign key, which right after running the SQL
// migration (or if it hasn't been run yet) it may not have, and an
// embed that can't resolve fails the *entire* query it's attached to
// — breaking the whole feed, not just the quote-post cards. A plain
// id lookup can't do that: worst case, posts with a quote_of that
// doesn't exist yet just render without their embed.
async function attachQuotedPosts(posts) {
  const list = Array.isArray(posts) ? posts : [posts];
  const ids = [...new Set(list.map(p => p?.quote_of).filter(Boolean))];
  if (ids.length) {
    try {
      const { data } = await sb.from('posts')
        .select('id,body,media_url,media_type,created_at,is_deleted,author_id,profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified)')
        .in('id', ids);
      const byId = Object.fromEntries((data || []).map(qp => [qp.id, qp]));
      list.forEach(p => { if (p?.quote_of) p.quoted = byId[p.quote_of] || null; });
    } catch (e) {
      console.warn('Could not load quoted posts (has supabase/quotes_and_reposts.sql been run yet?)', e);
    }
  }
  // Same batch-lookup shape, for posts that are promoting an article
  // (post.article_id set — see submitArticle()/openShareArticleModal()
  // in js/editarticle.js and js/article.js) — attached as p._promoArticle
  // and rendered by articleCardHtml() inside postCardHtml().
  const articleIds = [...new Set(list.map(p => p?.article_id).filter(Boolean))];
  if (articleIds.length) {
    try {
      const { data } = await sb.from('articles')
        .select('id,title,body,cover_url,is_deleted')
        .in('id', articleIds);
      const byId = Object.fromEntries((data || []).map(a => [a.id, a]));
      list.forEach(p => { if (p?.article_id) p._promoArticle = byId[p.article_id] || null; });
    } catch (e) {
      console.warn('Could not load promoted articles (has supabase/articles_rich_and_promo.sql been run yet?)', e);
    }
  }
}

// Live "characters left" counter under the quote textarea — amber
// under 20 left, red (and the count itself, not just a separate
// error) once over, same convention as the global compose box.
function qmUpdateCount() {
  const bodyEl = document.getElementById('qm-body');
  const countEl = document.getElementById('qm-count');
  if (!bodyEl || !countEl) return;
  const left = 500 - bodyEl.value.length;
  countEl.textContent = left;
  countEl.classList.toggle('qm-count-warn', left <= 20 && left >= 0);
  countEl.classList.toggle('qm-count-over', left < 0);
}

function openQuoteModal(postId, ev) {
  if (ev) ev.stopPropagation();
  if (!requireLogin()) return;
  const p = postCache[postId];
  quotingPostId = postId;
  const modal = document.getElementById('modal-quote');
  if (!modal) return; // page doesn't include the quote modal markup
  const bodyEl = document.getElementById('qm-body');
  bodyEl.value = '';
  bodyEl.oninput = qmUpdateCount;
  qmUpdateCount();
  document.getElementById('qm-err').style.display = 'none';
  document.getElementById('qm-preview').innerHTML = p ? quotedPostHtml(p) : '<div class="qp-embed-gone">Loading…</div>';
  const avEl = document.getElementById('qm-avatar');
  if (avEl) avEl.innerHTML = `<img src="${esc(avatarUrl(currentProfile?.avatar_url))}" alt="">`;
  modal.classList.add('open');
  bodyEl.focus();
}
function closeQuoteModal() {
  document.getElementById('modal-quote')?.classList.remove('open');
  quotingPostId = null;
}
// Quote and Report are the only two modals built as static page markup
// rather than created on demand by JS (compose, delete-confirm,
// create-community, etc. all wire this up themselves right after
// building their DOM) — so, unlike every other modal in the app, they
// were missing both backdrop-click-to-close and Escape-to-close.
function wireStaticModalDismiss(bgId, closeFn) {
  const el = document.getElementById(bgId);
  if (!el) return;
  el.addEventListener('click', e => { if (e.target === el) closeFn(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && el.classList.contains('open')) closeFn();
  });
}
wireStaticModalDismiss('modal-quote', closeQuoteModal);
wireStaticModalDismiss('modal-report', closeReport);

async function submitQuote() {
  if (!quotingPostId || !requireLogin()) return;
  const bodyEl = document.getElementById('qm-body');
  const errEl  = document.getElementById('qm-err');
  const btn    = document.getElementById('qm-btn');
  const body = bodyEl.value.trim();
  if (!body) { showErr(errEl, 'Add a comment before posting.'); return; }
  if (body.length > 500) { showErr(errEl, 'Comment too long (max 500 chars).'); return; }
  btn.disabled = true;
  try {
    const { data, error } = await sb.from('posts').insert({
      author_id: currentSession.user.id,
      body,
      quote_of: quotingPostId
    }).select('*, profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified)').single();
    if (error) throw error;
    // We already have the quoted post in postCache (it's whatever card
    // the Quote button was clicked from) — reuse it directly instead of
    // an extra fetch. Falls back to attachQuotedPosts() if it's missing.
    if (postCache[quotingPostId]) data.quoted = postCache[quotingPostId];
    else await attachQuotedPosts([data]);
    cachePost(data);
    closeQuoteModal();
    if (typeof addPostToFeed === 'function' && document.getElementById('feed-posts')) {
      addPostToFeed(data, true);
    } else {
      // Not on the main feed (profile/search/bookmarks/thread page) —
      // jump to the new quote post itself so posting it is never a
      // silent no-op.
      location.href = postUrlById(data.id, currentProfile?.username);
    }
  } catch (e) {
    showErr(errEl, e.message || 'Failed to post quote.');
  } finally {
    btn.disabled = false;
  }
}

// Shares a thread's permalink via the OS share sheet (navigator.share)
// on mobile/supporting browsers — the same picker you get sharing from
// Photos or any native app, letting the person pick Messages/WhatsApp/
// Mail/etc. directly instead of only ever landing on the clipboard.
// Desktop Chrome/Firefox (and any browser without the Web Share API,
// or a share the person cancels) falls back to the old copy-link
// behavior, so the button still does *something* useful everywhere.
function sharePost(id, btn) {
  const url = `${location.origin}${prettyPostUrlById(id, postCache?.[id]?.profile?.username)}`;
  const post = postCache?.[id];
  const title = post ? `${post.profile?.display_name || post.profile?.username || 'InteractInk'} on InteractInk` : 'InteractInk';
  const text = post?.body ? post.body.slice(0, 100) : undefined;

  const copyFallback = () => {
    const done = () => {
      if (!btn) return;
      const label = btn.querySelector('.act-label');
      const prev = label ? label.textContent : null;
      btn.classList.add('copied');
      if (label) label.textContent = 'Copied';
      setTimeout(() => { btn.classList.remove('copied'); if (label && prev !== null) label.textContent = prev; }, 1500);
    };
    if (navigator.clipboard?.writeText) {
      navigator.clipboard.writeText(url).then(done).catch(() => prompt('Copy link:', url));
    } else {
      prompt('Copy link:', url);
    }
  };

  if (navigator.share) {
    navigator.share({ title, text, url }).catch(e => {
      // AbortError just means the person closed the share sheet without
      // picking anything — that's not a failure, don't fall back to
      // clipboard behind their back or they'll see two different UIs
      // for one tap. Any other error (unsupported data, etc.) does fall
      // back so the tap isn't a dead end.
      if (e && e.name === 'AbortError') return;
      copyFallback();
    });
  } else {
    copyFallback();
  }
}

// Toggles the small "···" dropdown (Report, etc.) on a post/reply header.
function togglePostMenu(id, ev) {
  if (ev) ev.stopPropagation();
  const wrap = document.getElementById(`pmenu-${id}`);
  if (!wrap) return;
  const willOpen = !wrap.classList.contains('open');
  // Also close any open Repost/Quote dropdown — the two menus used to
  // be able to be open at the same time, which looked broken when a
  // card had both a repost sheet and a "···" menu stacked on screen.
  document.querySelectorAll('.pc-menu-wrap.open, .rp-menu-wrap.open').forEach(w => w.classList.remove('open'));
  document.body.classList.remove('oc-sheet-open');
  if (willOpen) {
    wrap.classList.add('open');
    positionMenuDd(wrap);
  }
}

// The dropdown normally just sits CSS-anchored (position:absolute;
// right:0) to its own tiny "···" button. That's fine wherever the
// button itself is already hugging the right edge of a full-width row
// (post cards). But on the profile header the button shares a row
// with the display name — and a long name (especially one with no
// spaces to break on, like an underscored username) pushes that row
// to wrap, leaving the button stranded away from the true right edge.
// The menu still opened right:0 relative to that stranded button,
// so it could run off the left side of a narrow screen with no room
// to open into, clipping every item's text. Switching to a
// viewport-clamped position:fixed (computed here, once, on open)
// keeps the dropdown fully on-screen and anchored to wherever the
// button actually ended up, instead of trusting the flex layout to
// have left it near the edge.
function positionMenuDd(wrap) {
  const dd = wrap.querySelector('.pc-menu-dd');
  if (!dd) return;
  const btnRect = wrap.getBoundingClientRect();
  const ddW = dd.offsetWidth;
  const ddH = dd.offsetHeight;
  const margin = 8;
  let left = btnRect.right - ddW;
  left = Math.min(left, window.innerWidth - ddW - margin);
  left = Math.max(left, margin);
  let top = btnRect.bottom + 4;
  if (top + ddH > window.innerHeight - margin) {
    // Not enough room below — open upward instead of running off
    // the bottom of the screen.
    top = Math.max(margin, btnRect.top - ddH - 4);
  }
  dd.style.position = 'fixed';
  dd.style.left = `${left}px`;
  dd.style.top = `${top}px`;
  dd.style.right = 'auto';
}
document.addEventListener('click', (e) => {
  document.querySelectorAll('.pc-menu-wrap.open').forEach(w => {
    if (!w.contains(e.target)) w.classList.remove('open');
  });
});

// Avatar + name/handle building blocks used by the tweet-style post card.
function pcAvatarHtml(profile, sizeClass = '') {
  const uname = profile?.username || 'unknown';
  return `<a class="pc-avatar-lnk" href="${profileUrl(uname)}">` +
         `<img class="avatar pc-avatar ${sizeClass}" src="${esc(avatarUrl(profile?.avatar_url))}" alt="" loading="lazy" decoding="async"></a>`;
}
function pcNameHtml(profile) {
  const uname = profile?.username || 'unknown';
  // Wrapped in .ph-names so the name+handle pair can be measured and
  // truncated as a unit (see .ph-names rules in style.css) — keeps
  // "· time" and the "···" menu pinned in place and always visible
  // instead of getting wrapped onto a second line or shoved off the
  // edge by a long display name/username.
  return `<span class="ph-names"><a class="nm" href="${profileUrl(uname)}">${esc(profile?.display_name || uname)}</a>${vBadge(profile)}` +
         `<span class="pc-handle">@${esc(uname)}</span></span>`;
}

// Renders the standard action row: reply / like / views / share, plus the
// "···" menu with Report — matches the reference layout's icon+count row.
// `replyAttr` is the href or onclick to use for the reply icon (feed cards
// link out to the thread; the thread's own OP scrolls to the reply box).
function postActionsHtml(p, { replyHref = null, replyOnclick = null, replyCount = null, bookmarkable = true, repostable = true, isReply = false } = {}) {
  const isLiked = liked.has(p.id);
  const isBookmarked = bookmarkable && bookmarked.has(p.id);
  // A post with reply_audience === 'none' gets a hard-disabled,
  // grayed-out reply icon everywhere it's rendered — feed cards,
  // profile, search, bookmarks, the lightbox — same as X, which
  // disables (not hides) the reply button on a reply-restricted Tweet
  // rather than just quietly dropping the link/onclick.
  const repliesLocked = p.reply_audience === 'none';
  const replyTag = repliesLocked
    ? `<button class="act reply disabled" disabled title="Replies are turned off for this post.">`
    : (replyHref
      ? `<a class="act reply" href="${replyHref}">`
      : `<button class="act reply" onclick="${esc(replyOnclick)}">`);
  const replyClose = repliesLocked ? '</button>' : (replyHref ? '</a>' : '</button>');
  const rc = replyCount !== null ? replyCount : (p.reply_count || 0);
  return `
    <div class="acts">
      ${replyTag}${ICON.reply}<span class="act-label">${fmtCount(rc)}</span>${replyClose}
      ${repostable ? repostMenuHtml(p) : ''}
      <button class="act like${isLiked ? ' liked' : ''}" data-count="${p.like_count || 0}" data-id="${p.id}" data-reply="${isReply}" onclick="toggleLike('${p.id}', this, ${isReply})">${ICON.heart}<span class="lc act-label">${fmtCount(p.like_count)}</span></button>
      <span class="act views" title="${p.view_count || 0} views">${ICON.views}<span class="act-label">${fmtCount(p.view_count)}</span></span>
      <button class="act share" onclick="sharePost('${p.id}', this)">${ICON.share}<span class="act-label">Share</span></button>
      ${bookmarkable ? `<button class="act bookmark${isBookmarked ? ' bookmarked' : ''}" data-id="${p.id}" onclick="toggleBookmark('${p.id}', this)">${ICON.bookmark}</button>` : ''}
    </div>`;
}

// The post-detail action row (thread.html's OP) — same reply/repost/
// like/bookmark/share buttons as postActionsHtml above (same classes,
// same onclick handlers, so toggleLike/toggleBookmark/the repost menu
// all keep working unmodified), just laid out full-width with bigger
// icons and a visible bookmark count, to match the reference
// post-detail screen instead of the feed's compact row. `replyOnclick`
// scrolls to/focuses the reply composer below, same as the compact
// row's OP variant.
function opDetailActionsHtml(p, replyOnclick) {
  const isLiked = liked.has(p.id);
  const isBookmarked = bookmarked.has(p.id);
  const repliesLocked = p.reply_audience === 'none';
  const replyBtn = repliesLocked
    ? `<button class="act reply disabled" disabled title="Replies are turned off for this post.">${ICON.reply}<span class="act-label">${fmtCount(p.reply_count || 0)}</span></button>`
    : `<button class="act reply" onclick="${esc(replyOnclick)}">${ICON.reply}<span class="act-label">${fmtCount(p.reply_count || 0)}</span></button>`;
  return `
    <div class="op-stats">
      ${replyBtn}
      ${repostMenuHtml(p)}
      <button class="act like${isLiked ? ' liked' : ''}" data-count="${p.like_count || 0}" data-id="${p.id}" data-reply="false" onclick="toggleLike('${p.id}', this)">${ICON.heart}<span class="lc act-label">${fmtCount(p.like_count)}</span></button>
      <button class="act bookmark${isBookmarked ? ' bookmarked' : ''}" data-count="${p.bookmark_count || 0}" data-id="${p.id}" onclick="toggleBookmark('${p.id}', this)">${ICON.bookmark}<span class="bc act-label">${fmtCount(p.bookmark_count || 0)}</span></button>
      <button class="act share" onclick="sharePost('${p.id}', this)">${ICON.share}</button>
    </div>`;
}

// The "···" header menu (Report, and Delete for your own posts/replies,
// or for ANY post in a community you created). `replyId` set only for
// reply-card menus. `authorId` is the author_id of whichever row this
// menu belongs to (the post, or the reply when replyId is set) — used
// to show Delete when it's the logged-in user's own row. Ownership no
// longer excludes replies: a reply you own gets a working Delete
// button too, deleting the reply itself (not the parent post).
// `communityId` (top-level posts only — pass the post's community_id,
// leave null for replies) additionally shows Delete when the current
// user created that community, even if they didn't author the post —
// same as a moderator being able to remove posts in their own space.
function postMenuHtml(postId, replyId = null, authorId = null, communityId = null, createdAt = null) {
  const target = replyId ? `'${postId}','${replyId}'` : `'${postId}'`;
  const isAuthor = currentSession && authorId && currentSession.user.id === authorId;
  const isCommunityCreator = !replyId && currentSession && communityId && ownedCommunities.has(communityId);
  const isOwner = isAuthor || isCommunityCreator;
  const deleteArgs = replyId ? `'${replyId}', event, true` : `'${postId}', event`;
  // Edit is author-only (never a community-mod thing like Delete is —
  // rewriting someone else's words isn't the same as removing them),
  // and only within EDIT_WINDOW_MS of posting — see withinEditWindow().
  const editArgs = replyId ? `'${replyId}', event, true` : `'${postId}', event`;
  const canEdit = isAuthor && withinEditWindow(createdAt);
  // Pin/unpin only makes sense for your own top-level posts (not
  // replies, not posts you can only delete as a community mod).
  const canPin = !replyId && isAuthor;
  const isPinned = canPin && currentProfile && currentProfile.pinned_post_id === postId;
  return `
    <div class="pc-menu-wrap" id="pmenu-${replyId || postId}">
      <button class="pc-menu-btn" onclick="togglePostMenu('${replyId || postId}', event)">${ICON.menu}</button>
      <div class="pc-menu-dd">
        ${canPin ? `<button onclick="togglePin('${postId}', event)">${isPinned ? 'Unpin from profile' : 'Pin to your profile'}</button>` : ''}
        ${canEdit ? `<button onclick="editPost(${editArgs})">Edit</button>` : ''}
        ${isOwner ? `<button class="pc-menu-danger" onclick="deletePost(${deleteArgs})">Delete</button>` : ''}
        <button onclick="openReport(${target})">${t('action.report')}</button>
      </div>
    </div>`;
}

// Pins/unpins one of your own posts to the top of your profile
// (profiles.pinned_post_id — only one at a time, same as Twitter:
// pinning a second post silently replaces the first).
async function togglePin(postId, ev) {
  if (ev) { ev.stopPropagation(); togglePostMenu(postId, ev); }
  if (!requireLogin() || !currentProfile) return;
  const nowPinned = currentProfile.pinned_post_id === postId;
  const newValue = nowPinned ? null : postId;
  try {
    const { error } = await sb.from('profiles').update({ pinned_post_id: newValue }).eq('id', currentProfile.id);
    if (error) throw error;
    currentProfile.pinned_post_id = newValue;
    if (typeof viewedProfile !== 'undefined' && viewedProfile && viewedProfile.id === currentProfile.id) {
      viewedProfile.pinned_post_id = newValue;
      if (typeof loadUserPosts === 'function') loadUserPosts(currentProfile.id);
    }
    toast(nowPinned ? 'Unpinned from your profile.' : 'Pinned to your profile.');
  } catch (e) {
    toast(e.message || 'Could not update pinned post.', 'error');
  }
}

// ─────────────────────────────────────────────────────────────
// DELETE CONFIRMATION MODAL — tapping "Delete" in a post's "···"
// menu no longer fires the browser's plain confirm() popup; it opens
// this modal instead (same lazy-build-into-<body> pattern as
// gcModalEl()/gifModalEl(), so it works from any page with no
// per-page HTML needed). Matches the real "delete post?" dialog
// pattern: a clear warning, a filled red destructive action on top,
// a plain Cancel underneath — destructive action is never the
// visually-quiet option.
// ─────────────────────────────────────────────────────────────
let pendingDeletePostId = null;
let pendingDeleteIsReply = false;

function dcModalEl() {
  let el = document.getElementById('dc-modal-bg');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'dc-modal-bg';
  el.className = 'modal-bg';
  el.addEventListener('click', e => { if (e.target === el) closeDeleteConfirm(); });
  el.innerHTML = `
    <div class="modal dc-modal">
      <h2 class="dc-title">Delete post?</h2>
      <p class="dc-desc">This can't be undone. It will be removed from your profile, the timeline of anyone who follows you, and search results.</p>
      <div class="dc-actions">
        <button type="button" class="dc-btn dc-btn-delete" id="dc-confirm-btn" onclick="confirmDeletePost()">Delete</button>
        <button type="button" class="dc-btn dc-btn-cancel" onclick="closeDeleteConfirm()">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && el.classList.contains('open')) closeDeleteConfirm();
  });
  return el;
}

// Soft-deletes one of the current user's own posts OR replies (sets
// is_deleted = true) via a SECURITY DEFINER RPC — see
// supabase/fix_delete_via_rpc.sql — rather than a raw client-side
// UPDATE gated by RLS. Opens the confirmation modal above instead of
// deleting immediately. `isReply` = true means `id` is a reply id and
// the replies table/RPC is used instead of posts.
function deletePost(id, ev, isReply = false) {
  if (ev) { ev.stopPropagation(); togglePostMenu(id, ev); }
  if (!requireLogin()) return;
  pendingDeletePostId = id;
  pendingDeleteIsReply = isReply;
  const el = dcModalEl();
  if (el.classList.contains('open')) return;
  el.classList.add('open');
  lockScroll();
}

function closeDeleteConfirm() {
  const el = document.getElementById('dc-modal-bg');
  if (el?.classList.contains('open')) { el.classList.remove('open'); unlockScroll(); }
  pendingDeletePostId = null;
  pendingDeleteIsReply = false;
}

// Does the actual delete, called by the modal's red "Delete" button.
// Removes the card from whichever page it's on — using data-post-id +
// querySelectorAll rather than the (non-unique, once reposts can
// duplicate a post onto the same page) "post-<id>" element id, so
// every copy of the post disappears, not just the first one found.
// On thread.html, where the post is the whole page, sends the user
// back to the board instead.
async function confirmDeletePost() {
  const id = pendingDeletePostId;
  const isReply = pendingDeleteIsReply;
  const table = isReply ? 'replies' : 'posts';
  if (!id || !requireLogin()) return;
  const btn = document.getElementById('dc-confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  try {
    // Re-check the session against Supabase itself right before deleting,
    // rather than trusting the in-memory currentSession variable — that
    // variable is only ever set once, at page load (see renderAuthArea()
    // in auth.js), so a session that expired or was signed out in
    // another tab since this page loaded would otherwise go undetected
    // until the delete itself fails with a confusing RLS error.
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      alert('Your session has expired. Please log in again and retry.');
      closeDeleteConfirm();
      location.href = 'login.html';
      return;
    }
    // Confirm ownership client-side before attempting the write, so a
    // real ownership mismatch (e.g. a stale card rendered before an
    // account switch) surfaces as a clear message instead of the raw
    // Postgres RLS error. A post (never a reply) also allows through
    // whoever created the community it's posted in — the RPC below is
    // still the authoritative check either way.
    const { data: existing, error: fetchErr } = await sb.from(table)
      .select(isReply ? 'author_id' : 'author_id, community_id').eq('id', id).maybeSingle();
    if (fetchErr) throw fetchErr;
    if (!existing) throw new Error(isReply ? 'This reply no longer exists.' : 'This post no longer exists.');
    let allowed = existing.author_id === session.user.id;
    if (!allowed && !isReply && existing.community_id) {
      const { data: comm } = await sb.from('communities').select('created_by').eq('id', existing.community_id).maybeSingle();
      allowed = !!comm && comm.created_by === session.user.id;
    }
    if (!allowed) {
      throw new Error(isReply ? "This isn't your reply, so it can't be deleted from here."
                               : "This isn't your post and you don't own its community, so it can't be deleted from here.");
    }

    // Delete now goes through a SECURITY DEFINER RPC (see
    // supabase/fix_delete_via_rpc.sql) instead of a raw client-side
    // UPDATE — that function checks ownership itself and bypasses
    // table RLS for its own write, so it isn't at the mercy of the
    // posts/replies table's RLS policy state the way the old
    // `.update({ is_deleted: true })` call was.
    const { error } = await sb.rpc(isReply ? 'delete_own_reply' : 'delete_own_post',
      isReply ? { reply_id: id } : { post_id: id });
    if (error) throw error;
    closeDeleteConfirm();
    if (!isReply && document.getElementById('op-post') && id === currentStatusId()) {
      location.href = 'index.html';
      return;
    }
    // Reply cards use two different markup shapes depending on the page:
    // profile.js's Replies tab sets data-post-id="<reply id>" on the card,
    // while thread.js's in-thread comment tree uses id="reply-<reply id>"
    // instead (see replyHtml() in thread.js) — cover both so the row
    // actually disappears wherever it's shown.
    document.querySelectorAll(`[data-post-id="${id}"]`).forEach(el => el.remove());
    document.getElementById(`reply-${id}`)?.remove();
    // If we're looking at a profile page's post count, the only way a
    // Delete button can even show is on your own post or reply, and
    // the only profile a Delete button can appear on is your own
    // (other people's posts/replies never render Delete for you) — so
    // this is always safe to decrement when it's present. Replies
    // count toward "Posts" the same as top-level posts (see
    // loadReplyCountIntoStat() in profile.js), so both decrement it now.
    if (typeof bumpStat === 'function' && document.getElementById('stat-posts')) bumpStat('stat-posts', -1);
  } catch (e) {
    // Full object (code/details/hint included) goes to the console so
    // it's inspectable via devtools if this ever needs debugging again
    // — the alert only has room for the short version.
    console.error('deletePost failed:', e);
    closeDeleteConfirm();
    alert(e.message || 'Could not delete that post.');
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = 'Delete'; }
  }
}

// ─────────────────────────────────────────────────────────────
// EDIT OWN POST/REPLY — a post or comment can be edited by its
// author for a short window after posting, same idea as X letting
// you fix a typo right after tweeting but not rewrite history days
// later. postMenuHtml() above only shows the Edit button while
// withinEditWindow() is true; the real gate is the 15-minute check
// inside the edit_own_post/edit_own_reply RPCs (see
// supabase/edit_own_post.sql) — this client-side copy just gives an
// immediate, friendly message instead of a round trip that fails.
// ─────────────────────────────────────────────────────────────
const EDIT_WINDOW_MS = 15 * 60 * 1000;
function withinEditWindow(createdAt) {
  return !!createdAt && (Date.now() - new Date(createdAt).getTime()) < EDIT_WINDOW_MS;
}

// Appended next to a timestamp wherever updated_at differs from
// created_at (they're set by the same INSERT's `now()`, so they land
// exactly equal until an edit changes updated_at — see
// supabase/edit_own_post.sql) — same "· Edited" pattern article.js
// already uses on the Article detail page.
function editedSuffix(p) {
  return (p && p.updated_at && p.updated_at !== p.created_at)
    ? ` · <span class="edited-tag">Edited</span>` : '';
}

let pendingEditId = null;
let pendingEditIsReply = false;

function ecModalEl() {
  let el = document.getElementById('ec-modal-bg');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'ec-modal-bg';
  el.className = 'modal-bg';
  el.addEventListener('click', e => { if (e.target === el) closeEditPost(); });
  el.innerHTML = `
    <div class="modal ec-modal">
      <h2 class="dc-title">Edit</h2>
      <textarea id="ec-body" maxlength="500" rows="5"></textarea>
      <div class="ec-count" id="ec-count">0 / 500</div>
      <div class="errmsg" id="ec-err" style="display:none;"></div>
      <div class="dc-actions">
        <button type="button" class="dc-btn dc-btn-primary" id="ec-save-btn" onclick="confirmEditPost()">Save</button>
        <button type="button" class="dc-btn dc-btn-cancel" onclick="closeEditPost()">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && el.classList.contains('open')) closeEditPost();
  });
  const ta = el.querySelector('#ec-body');
  const count = el.querySelector('#ec-count');
  ta.addEventListener('input', () => { count.textContent = `${ta.value.length} / 500`; });
  return el;
}

// Opens the edit modal for one of the current user's own posts/replies,
// prefilled from postCache — every post/reply card caches itself when
// rendered (see cachePost() above), so this needs no extra fetch.
// `isReply` = true means `id` is a reply id (matches deletePost()'s
// signature/shape above). The 15-minute check here is just a fast,
// friendly guard for a stale menu left open past the window — the
// edit_own_post/edit_own_reply RPC is the real, authoritative check.
function editPost(id, ev, isReply = false) {
  if (ev) { ev.stopPropagation(); togglePostMenu(id, ev); }
  if (!requireLogin()) return;
  const cached = postCache[id];
  if (!cached || !withinEditWindow(cached.created_at)) {
    toast('The 15-minute edit window for this has passed.', 'error');
    return;
  }
  pendingEditId = id;
  pendingEditIsReply = isReply;
  const el = ecModalEl();
  const ta = el.querySelector('#ec-body');
  const errEl = el.querySelector('#ec-err');
  ta.value = cached.body || '';
  el.querySelector('#ec-count').textContent = `${ta.value.length} / 500`;
  clearErr(errEl);
  if (!el.classList.contains('open')) {
    el.classList.add('open');
    lockScroll();
  }
  setTimeout(() => { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }, 50);
}

function closeEditPost() {
  const el = document.getElementById('ec-modal-bg');
  if (el?.classList.contains('open')) { el.classList.remove('open'); unlockScroll(); }
  pendingEditId = null;
  pendingEditIsReply = false;
}

// Saves the edit via the edit_own_post/edit_own_reply RPC (same
// SECURITY-DEFINER-does-the-ownership-check pattern as
// confirmDeletePost() above), then patches every rendered copy of
// this post/reply on the page and tags it "Edited" — see
// applyEditToDom() below.
async function confirmEditPost() {
  const id = pendingEditId;
  const isReply = pendingEditIsReply;
  if (!id || !requireLogin()) return;
  const el = document.getElementById('ec-modal-bg');
  const ta = el.querySelector('#ec-body');
  const errEl = el.querySelector('#ec-err');
  clearErr(errEl);
  const body = ta.value.trim();
  if (!body) { showErr(errEl, isReply ? 'Reply cannot be empty.' : 'Post cannot be empty.'); return; }
  if (body.length > 500) { showErr(errEl, 'Too long (max 500 chars).'); return; }

  const btn = document.getElementById('ec-save-btn');
  btn.disabled = true;
  btn.textContent = 'Saving…';
  try {
    // Same re-check-the-real-session-first move as confirmDeletePost()
    // above, for the same reason: currentSession is only ever set once
    // at page load, so an expired/signed-out-elsewhere session would
    // otherwise surface as a confusing RPC error instead of this.
    const { data: { session } } = await sb.auth.getSession();
    if (!session) {
      alert('Your session has expired. Please log in again and retry.');
      closeEditPost();
      location.href = 'login.html';
      return;
    }
    const { data, error } = await sb.rpc(isReply ? 'edit_own_reply' : 'edit_own_post',
      isReply ? { reply_id: id, new_body: body } : { post_id: id, new_body: body });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    const updatedAt = row?.updated_at || new Date().toISOString();
    applyEditToDom(id, body, updatedAt);
    closeEditPost();
    toast('Saved.');
  } catch (e) {
    console.error('editPost failed:', e);
    showErr(errEl, e.message || 'Could not save changes.');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Save';
  }
}

function markEditedTag(dtEl) {
  if (dtEl && !dtEl.querySelector('.edited-tag')) {
    dtEl.insertAdjacentHTML('beforeend', ` · <span class="edited-tag">Edited</span>`);
  }
}

// Patches every rendered copy of a post/reply on the current page
// (feed card, thread OP, focused-comment view, reply tree, profile
// Replies tab, lightbox sidebar — anywhere data-pb/data-dt was
// stamped with this id in the markup, since the same post can appear
// more than once, e.g. reposted into a feed) after a successful edit,
// no refetch needed. Also updates postCache, and — if thread.js
// happens to be loaded on this page — its own in-memory copies via
// the optional onPostBodyEdited() hook, so a later re-render (hash
// nav, changing comment sort) doesn't revert to the pre-edit body.
function applyEditToDom(id, newBody, updatedAt) {
  if (postCache[id]) { postCache[id].body = newBody; postCache[id].updated_at = updatedAt; }
  document.querySelectorAll(`[data-pb="${id}"]`).forEach(elx => { elx.innerHTML = renderBody(newBody); });
  document.querySelectorAll(`[data-dt="${id}"]`).forEach(markEditedTag);
  if (typeof onPostBodyEdited === 'function') onPostBodyEdited(id, newBody, updatedAt);
}

// ─────────────────────────────────────────────────────────────
// COMMUNITIES — the "+" button next to the For you/Following tabs
// opens this to create a Twitter-Community-style group. Lazy-built
// into <body> the same way as dcModalEl()/gcModalEl() above, so it
// works from any page (index.html's tab bar, communities.html's own
// "Create" button, etc.) with no per-page markup needed.
//
// This is a short step-by-step wizard (name → description → banner/
// picture → rules → moderators), the same shape as X's own "Create a
// Community" flow — everything past the name is optional and can be
// skipped by just hitting Next. All of it (including any picked
// image) is only written to Supabase on the final "Create community"
// step, so backing out or closing the modal midway leaves nothing
// behind.
// ─────────────────────────────────────────────────────────────
const CC_STEPS = ['name', 'description', 'image', 'rules', 'mods'];
let ccWiz = null; // reset fresh every time the modal opens — see openCreateCommunityModal()

function ccFreshWiz() {
  return {
    step: 0,
    name: '', description: '',
    avatarBlob: null, avatarPreviewUrl: null,
    bannerBlob: null, bannerPreviewUrl: null,
    rules: [],  // [{title, description}]
    mods: [],   // [{id, username, display_name, avatar_url}]
  };
}

function ccModalEl() {
  let el = document.getElementById('cc-modal-bg');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'cc-modal-bg';
  el.className = 'modal-bg';
  el.addEventListener('click', e => { if (e.target === el) closeCreateCommunityModal(); });
  el.innerHTML = `
    <div class="modal cc-modal">
      <a class="modal-close" href="#" onclick="closeCreateCommunityModal();return false;">&#10005;</a>
      <h2>Create a community</h2>
      <div class="cc-dots" id="cc-dots"></div>
      <div class="errmsg" id="cc-err" style="display:none;margin:0 16px 8px;"></div>
      <div id="cc-step-body" class="cc-step-body"></div>
      <div class="cc-nav">
        <button type="button" class="cc-nav-back" id="cc-back-btn" onclick="ccWizBack()">Back</button>
        <button type="button" class="modal-btn cc-nav-next" id="cc-next-btn" onclick="ccWizNext()">Next</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && el.classList.contains('open')) closeCreateCommunityModal();
  });
  return el;
}

function openCreateCommunityModal() {
  if (!requireLogin()) return;
  ccWiz = ccFreshWiz();
  const el = ccModalEl();
  clearErr(document.getElementById('cc-err'));
  el.classList.add('open');
  lockScroll();
  renderCcStep();
}

function closeCreateCommunityModal() {
  const el = document.getElementById('cc-modal-bg');
  if (el?.classList.contains('open')) { el.classList.remove('open'); unlockScroll(); }
  ccWiz = null;
}

// Turns "Shounen Fans!!" into "shounen-fans" — lowercase, non
// alphanumerics collapsed to single hyphens, trimmed of leading/
// trailing ones. Communities.slug's check constraint enforces the
// same shape server-side (see supabase/communities.sql), so this is
// just what gets a normal name there without the user ever seeing
// or typing a slug themselves.
function slugify(name) {
  return name.toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

// ── STEP RENDERING ──
function renderCcStep() {
  if (!ccWiz) return;
  const stepName = CC_STEPS[ccWiz.step];
  document.getElementById('cc-dots').innerHTML = CC_STEPS.map((_, i) =>
    `<span class="cc-dot${i === ccWiz.step ? ' active' : ''}${i < ccWiz.step ? ' done' : ''}"></span>`).join('');
  document.getElementById('cc-back-btn').style.visibility = ccWiz.step === 0 ? 'hidden' : 'visible';
  const nextBtn = document.getElementById('cc-next-btn');
  nextBtn.textContent = stepName === 'mods' ? 'Create community' : 'Next';
  clearErr(document.getElementById('cc-err'));

  const body = document.getElementById('cc-step-body');
  if (stepName === 'name') {
    body.innerHTML = `
      <label>Name your community</label>
      <input type="text" id="cc-name" maxlength="50" placeholder="e.g. Shounen Fans" value="${esc(ccWiz.name)}">
      <p class="cc-step-hint">Choose something that describes what people will find here.</p>`;
    setTimeout(() => document.getElementById('cc-name')?.focus(), 0);
  } else if (stepName === 'description') {
    body.innerHTML = `
      <label>Add a description</label>
      <textarea id="cc-desc" rows="4" maxlength="300" placeholder="What's this community about? Share what you're working on, get feedback…">${esc(ccWiz.description)}</textarea>
      <p class="cc-step-hint">This shows at the top of your community and on its About tab. Optional.</p>`;
  } else if (stepName === 'image') {
    body.innerHTML = `
      <label>Add a banner &amp; picture</label>
      <div class="cc-banner-wrap" id="cc-banner-wrap" style="${ccWiz.bannerPreviewUrl ? `--banner-img:url('${ccWiz.bannerPreviewUrl}')` : ''}">
        <label class="cc-banner-pick" for="cc-banner-file" title="Choose a banner">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h3l2-2h6l2 2h3v12H4V7Z"/><circle cx="12" cy="13" r="3.5"/></svg>
        </label>
        <input type="file" id="cc-banner-file" accept="image/*" style="display:none;">
        <span class="cc-avatar-wrap">
          <span class="cc-avatar-preview" id="cc-avatar-preview">${ccWiz.avatarPreviewUrl ? `<img src="${ccWiz.avatarPreviewUrl}" alt="">` : esc((ccWiz.name || '?').trim().charAt(0).toUpperCase() || '?')}</span>
          <label class="cc-avatar-pick" for="cc-avatar-file" title="Choose a picture">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h3l2-2h6l2 2h3v12H4V7Z"/><circle cx="12" cy="13" r="3.5"/></svg>
          </label>
          <input type="file" id="cc-avatar-file" accept="image/*" style="display:none;">
        </span>
      </div>
      <p class="cc-step-hint">Optional — you (and only you, as creator) can change these anytime.</p>`;
    document.getElementById('cc-avatar-file').addEventListener('change', (e) => {
      const file = e.target.files[0]; e.target.value = '';
      const errEl = document.getElementById('cc-err');
      if (!file || !validateFile(file, errEl)) return;
      clearErr(errEl);
      openCropModal(file, 'square', (cropped) => {
        ccWiz.avatarBlob = cropped;
        ccWiz.avatarPreviewUrl = URL.createObjectURL(cropped);
        document.getElementById('cc-avatar-preview').innerHTML = `<img src="${ccWiz.avatarPreviewUrl}" alt="">`;
      });
    });
    document.getElementById('cc-banner-file').addEventListener('change', (e) => {
      const file = e.target.files[0]; e.target.value = '';
      const errEl = document.getElementById('cc-err');
      if (!file || !validateFile(file, errEl)) return;
      clearErr(errEl);
      openCropModal(file, 'wide', (cropped) => {
        ccWiz.bannerBlob = cropped;
        ccWiz.bannerPreviewUrl = URL.createObjectURL(cropped);
        document.getElementById('cc-banner-wrap').style.setProperty('--banner-img', `url('${ccWiz.bannerPreviewUrl}')`);
      });
    });
  } else if (stepName === 'rules') {
    body.innerHTML = `
      <label>Add rules</label>
      ${ccWiz.rules.length ? `<ol class="comm-rules-list" id="cc-rules-list">${ccWiz.rules.map((r, i) => `
        <li class="comm-rule-row">
          <span class="comm-rule-num"></span>
          <div class="comm-rule-body">
            <div class="comm-rule-title">${esc(r.title)}</div>
            ${r.description ? `<div class="comm-rule-desc">${esc(r.description)}</div>` : ''}
          </div>
          <button type="button" class="comm-row-remove" onclick="ccRemoveRule(${i})">&#10005;</button>
        </li>`).join('')}</ol>` : ''}
      <div class="comm-inline-form">
        <input type="text" id="cc-rule-title" maxlength="100" placeholder="Rule title, e.g. Stay on topic">
        <textarea id="cc-rule-desc" rows="2" maxlength="300" placeholder="Description (optional)"></textarea>
        <div class="comm-inline-form-actions">
          <button type="button" class="modal-btn" style="margin:0;width:auto;padding:7px 16px;" onclick="ccAddRule()">Add rule</button>
        </div>
      </div>
      <p class="cc-step-hint">Optional — set the ground rules for your community, or skip and add them later.</p>`;
  } else if (stepName === 'mods') {
    body.innerHTML = `
      <label>Add moderators</label>
      ${ccWiz.mods.length ? `<div class="comm-mods-list" id="cc-mods-list">${ccWiz.mods.map(m => `
        <div class="who-row comm-mod-row">
          <img class="avatar pfp-md" src="${esc(avatarUrl(m.avatar_url))}" alt="">
          <span class="who-row-txt">
            <span class="who-row-name">${esc(m.display_name || m.username)}</span>
            <span class="who-row-handle">@${esc(m.username)}</span>
          </span>
          <button type="button" class="comm-row-remove" onclick="ccRemoveMod('${m.id}')">&#10005;</button>
        </div>`).join('')}</div>` : ''}
      <div class="comm-inline-form">
        <input type="text" id="cc-mod-search" placeholder="Search by username" autocomplete="off">
        <div id="cc-mod-results"></div>
      </div>
      <p class="cc-step-hint">Optional — as creator, only you can add or remove moderators, ever.</p>`;
    const input = document.getElementById('cc-mod-search');
    input.addEventListener('input', () => {
      clearTimeout(ccWiz._modDebounce);
      ccWiz._modDebounce = setTimeout(() => ccRunModSearch(input.value), 250);
    });
  }
}

function ccWizBack() {
  if (!ccWiz || ccWiz.step === 0) return;
  ccWiz.step--;
  renderCcStep();
}

function ccAddRule() {
  const titleEl = document.getElementById('cc-rule-title');
  const descEl = document.getElementById('cc-rule-desc');
  const title = titleEl.value.trim();
  const description = descEl.value.trim();
  if (!title) { showErr(document.getElementById('cc-err'), 'Give the rule a short title.'); return; }
  if (ccWiz.rules.length >= 20) { showErr(document.getElementById('cc-err'), 'That\u2019s enough rules for now.'); return; }
  ccWiz.rules.push({ title, description });
  renderCcStep();
}
function ccRemoveRule(i) {
  ccWiz.rules.splice(i, 1);
  renderCcStep();
}

async function ccRunModSearch(q) {
  const resultsEl = document.getElementById('cc-mod-results');
  if (!resultsEl) return;
  q = q.trim();
  if (!q) { resultsEl.innerHTML = ''; return; }
  const takenIds = new Set([currentSession.user.id, ...ccWiz.mods.map(m => m.id)]);
  const { data, error } = await sb.from('profiles').select('id,username,display_name,avatar_url,verified')
    .ilike('username', `%${q}%`).limit(6);
  if (error || !data) { resultsEl.innerHTML = ''; return; }
  const candidates = data.filter(p => !takenIds.has(p.id));
  if (!candidates.length) { resultsEl.innerHTML = `<div class="comm-about-empty">No matching members found.</div>`; return; }
  resultsEl.innerHTML = candidates.map(p => `
    <div class="who-row comm-mod-search-row">
      <img class="avatar pfp-md" src="${esc(avatarUrl(p.avatar_url))}" alt="">
      <span class="who-row-txt">
        <span class="who-row-name">${esc(p.display_name || p.username)}${vBadge(p)}</span>
        <span class="who-row-handle">@${esc(p.username)}</span>
      </span>
      <button type="button" class="who-follow-btn" onclick='ccAddMod(${JSON.stringify(p).replace(/'/g, "&#39;")})'>Add</button>
    </div>`).join('');
}
function ccAddMod(profile) {
  ccWiz.mods.push(profile);
  document.getElementById('cc-mod-results').innerHTML = '';
  document.getElementById('cc-mod-search').value = '';
  renderCcStep();
}
function ccRemoveMod(id) {
  ccWiz.mods = ccWiz.mods.filter(m => m.id !== id);
  renderCcStep();
}

function ccWizNext() {
  const stepName = CC_STEPS[ccWiz.step];
  const errEl = document.getElementById('cc-err');
  clearErr(errEl);

  if (stepName === 'name') {
    const name = document.getElementById('cc-name').value.trim();
    if (name.length < 3) { showErr(errEl, 'Give it a name — at least 3 characters.'); return; }
    if (name.length > 50) { showErr(errEl, 'Name is too long (max 50 characters).'); return; }
    if (slugify(name).length < 3) { showErr(errEl, 'That name needs at least a few letters or numbers.'); return; }
    ccWiz.name = name;
  } else if (stepName === 'description') {
    ccWiz.description = document.getElementById('cc-desc').value.trim();
  } else if (stepName === 'mods') {
    submitCreateCommunityWizard();
    return;
  }
  ccWiz.step++;
  renderCcStep();
}

async function submitCreateCommunityWizard() {
  const errEl = document.getElementById('cc-err');
  const btn = document.getElementById('cc-next-btn');
  const backBtn = document.getElementById('cc-back-btn');
  clearErr(errEl);
  btn.disabled = true; backBtn.disabled = true;
  btn.textContent = 'Creating…';
  try {
    const name = ccWiz.name;
    const baseSlug = slugify(name);
    // A second community with the same/similar name just gets a
    // numeric suffix on its slug (shounen-fans-2, shounen-fans-3, …)
    // rather than blocking on the name being taken — same as how
    // usernames vs display names work elsewhere in the app; the name
    // shown to people doesn't have to be unique, only the URL slug.
    let slug = baseSlug, attempt = 0, data, error;
    while (attempt < 6) {
      ({ data, error } = await sb.from('communities').insert({
        name, slug, description: ccWiz.description || null, created_by: currentSession.user.id
      }).select('id,slug').single());
      if (!error) break;
      if (error.code === '23505') { attempt++; slug = `${baseSlug}-${attempt + 1}`; continue; }
      throw error;
    }
    if (error) throw error;
    const communityId = data.id;

    // Banner/picture, rules, and moderators are all best-effort add-ons
    // after the core community row exists — if any one of them fails,
    // the community itself still got created and is reachable, so we
    // surface the error but don't roll anything back.
    const updates = {};
    if (ccWiz.avatarBlob) updates.avatar_url = await uploadAvatar(ccWiz.avatarBlob, currentSession.user.id);
    if (ccWiz.bannerBlob) updates.banner_url = await uploadAvatar(ccWiz.bannerBlob, currentSession.user.id);
    if (Object.keys(updates).length) {
      const { error: imgErr } = await sb.from('communities').update(updates).eq('id', communityId);
      if (imgErr) throw imgErr;
    }

    if (ccWiz.rules.length) {
      const { error: rulesErr } = await sb.from('community_rules').insert(
        ccWiz.rules.map((r, i) => ({ community_id: communityId, position: i, title: r.title, description: r.description || null }))
      );
      if (rulesErr) throw rulesErr;
    }

    if (ccWiz.mods.length) {
      const { error: modsErr } = await sb.from('community_moderators').insert(
        ccWiz.mods.map(m => ({ community_id: communityId, user_id: m.id, added_by: currentSession.user.id }))
      );
      if (modsErr) throw modsErr;
    }

    closeCreateCommunityModal();
    location.href = communityUrl(data.slug);
  } catch (e) {
    showErr(errEl, e.message || 'Failed to create community.');
    btn.disabled = false; backBtn.disabled = false;
    btn.textContent = 'Create community';
  }
}

// Shared join/leave — used by community.html's own header button, the
// sidebar "My communities" box below, and communities.html's browse
// list. Returns {error} so callers can react without duplicating the
// try/catch every time.
async function joinCommunity(communityId) {
  if (!requireLogin()) return { error: new Error('not logged in') };
  const { error } = await sb.from('community_members')
    .insert({ community_id: communityId, user_id: currentSession.user.id });
  return { error };
}
async function leaveCommunity(communityId) {
  if (!requireLogin()) return { error: new Error('not logged in') };
  const { error } = await sb.from('community_members')
    .delete().eq('community_id', communityId).eq('user_id', currentSession.user.id);
  return { error };
}

// Shared "avatar or initial-letter fallback" markup for a community —
// used by the sidebar box, communities.html's browse list, and
// community.html's own hero, so all three stay in sync the moment a
// creator sets/changes their community's picture.
function communityAvatarInner(c) {
  return c.avatar_url ? `<img src="${esc(c.avatar_url)}" alt="">` : esc((c.name || '?').trim().charAt(0).toUpperCase() || '?');
}

// Compact list-row markup for a community — used by the sidebar box
// below and by communities.html's browse list. `joined` controls
// whether the pill reads Join or Joined/Leave-on-hover.
function communityRowHtml(c, joined) {
  const btn = joined
    ? `<button class="who-follow-btn comm-joined-btn" onclick="event.preventDefault();communityToggleJoin('${c.id}', this, true)">Joined</button>`
    : `<button class="who-follow-btn" onclick="event.preventDefault();communityToggleJoin('${c.id}', this, false)">Join</button>`;
  return `
    <a class="who-row comm-row" href="${communityUrl(c.slug)}">
      <span class="comm-avatar">${communityAvatarInner(c)}</span>
      <span class="who-row-txt">
        <span class="who-row-name">${esc(c.name)}</span>
        <span class="who-row-handle">${fmtCount(c.member_count)} member${c.member_count === 1 ? '' : 's'}</span>
      </span>
      ${btn}
    </a>`;
}

async function communityToggleJoin(communityId, btn, currentlyJoined) {
  if (!requireLogin()) return;
  btn.disabled = true;
  try {
    const { error } = currentlyJoined ? await leaveCommunity(communityId) : await joinCommunity(communityId);
    if (error) throw error;
    const nowJoined = !currentlyJoined;
    btn.textContent = nowJoined ? 'Joined' : 'Join';
    btn.classList.toggle('comm-joined-btn', nowJoined);
    btn.setAttribute('onclick', `event.preventDefault();communityToggleJoin('${communityId}', this, ${nowJoined})`);
    btn.disabled = false;
    if (typeof onCommunityMembershipChanged === 'function') onCommunityMembershipChanged(communityId, nowJoined);
  } catch (e) {
    btn.disabled = false;
  }
}

// ── SIDEBAR "MY COMMUNITIES" BOX — index.html's right column, same
// self-contained pattern as renderWhoToFollow(): only runs on pages
// that actually have a #my-communities container. ──
async function renderMyCommunities() {
  const box = document.getElementById('my-communities');
  if (!box) return;
  const header = `<div class="t-lbl">Communities</div>`;
  const createRow = `<a href="#" class="comm-create-row" onclick="openCreateCommunityModal();return false;">
      <span class="comm-avatar comm-avatar-plus">${PLUS_ICON}</span>
      <span class="who-row-txt"><span class="who-row-name">Create a community</span></span>
    </a>`;

  if (!currentSession) {
    box.innerHTML = header + createRow +
      `<a class="show-more" href="communities.html">Browse communities</a>`;
    return;
  }

  const { data, error } = await sb.from('community_members')
    .select('community:communities(id,name,slug,member_count)')
    .eq('user_id', currentSession.user.id)
    .order('joined_at', { ascending: false })
    .limit(4);

  const mine = (error ? [] : data || []).map(r => r.community).filter(Boolean);
  box.innerHTML = header + createRow +
    mine.map(c => communityRowHtml(c, true)).join('') +
    `<a class="show-more" href="communities.html">${mine.length ? 'See all' : 'Browse communities'}</a>`;
}

document.addEventListener('DOMContentLoaded', async () => {
  if (!document.getElementById('my-communities')) return;
  if (typeof authReady !== 'undefined') await authReady;
  renderMyCommunities();
});

// ─────────────────────────────────────────────────────────────
// LISTS — Twitter-Lists-style curated groups of people. Two modals,
// same lazy-built-into-<body> pattern as ccModalEl()/dcModalEl()
// above, so both work from any page with no per-page markup:
//   • Create/edit-list modal (cl-modal-bg) — name, description,
//     Private toggle. Doubles as the edit form when opened with an
//     existing list's id.
//   • Add/remove-from-list modal (alm-modal-bg) — opened from a
//     profile's "···" menu (see profileMenuItemsHtml() in profile.js);
//     lists the current user's own lists as checkable rows, toggling
//     that profile's membership immediately on each click, same as
//     Twitter's own "Add/remove from Lists" popup. Includes a
//     "+ Create a new list" row that opens the create modal and,
//     on success, adds the profile being viewed to the new list too.
// ─────────────────────────────────────────────────────────────

// Shared "picture or glyph fallback" for a list — same idea as
// communityAvatarInner(), just a rounded-square glyph (instead of an
// initial letter) when no picture's been set, so a list card never
// gets mistaken for a person or community at a glance, matching
// Twitter's own square list icons.
function listAvatarInner(l) {
  return l.avatar_url ? `<img src="${esc(l.avatar_url)}" alt="">` : `<span class="list-avatar-glyph">${NAV_ICON.list}</span>`;
}

// Deterministic accent color for a list's square glyph avatar (only
// applied when it has no custom picture) — purely cosmetic, keeps a
// browse list from reading as a wall of identical maroon squares,
// matching Twitter's own varied List icon colors.
function listAvatarColorClass(id) {
  const n = String(id || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
  return `list-avatar-c${(n % 5) + 1}`;
}
function listAvatarClass(l) {
  return `list-avatar${l.avatar_url ? '' : ' ' + listAvatarColorClass(l.id)}`;
}

// Compact list-row markup — used by lists.html's Your Lists/Lists
// you're on tabs, profilelists.js, and the sidebar "My Lists" box.
// `opts.following` marks a row as a followed-not-owned List (see
// lists.js), which swaps in a small "Following" pill so it can be
// unfollowed right from the row.
function listRowHtml(l, ownerProfile = null, opts = {}) {
  const privacyTag = l.is_private
    ? `<span class="list-privacy-tag">${ICON_LOCK}Private</span>`
    : '';
  const byLine = ownerProfile ? `<span class="who-row-handle">by @${esc(ownerProfile.username)}${vBadge(ownerProfile)}</span>` : '';
  const unfollowBtn = opts.following
    ? `<button type="button" class="list-row-unfollow" onclick="event.preventDefault();listToggleFollow('${l.id}', this, true)">Following</button>`
    : '';
  return `
    <a class="who-row list-row" href="${listUrl(l.id)}">
      <span class="${listAvatarClass(l)}">${listAvatarInner(l)}</span>
      <span class="who-row-txt">
        <span class="who-row-name">${esc(l.name)} ${privacyTag}</span>
        ${l.description ? `<span class="comm-desc">${esc(l.description)}</span>` : ''}
        <span class="who-row-handle">${fmtCount(l.member_count)} member${l.member_count === 1 ? '' : 's'}</span>
        ${byLine}
      </span>
      ${unfollowBtn}
    </a>`;
}

// Small overlapping avatar stack + "N followers including @user"
// caption under a Discover row — mirrors the line Twitter's own List
// Discover screen shows under the member count.
function listFollowerPreviewHtml(followerProfiles, followerCount) {
  if (!followerCount) return '';
  const stack = (followerProfiles || []).slice(0, 3)
    .map(p => `<img class="list-fp-avatar" src="${esc(avatarUrl(p.avatar_url))}" alt="" loading="lazy">`).join('');
  const first = (followerProfiles || [])[0];
  return `<span class="list-fp-row">
      ${stack ? `<span class="list-fp-stack">${stack}</span>` : ''}
      <span class="list-fp-txt">${fmtCount(followerCount)} follower${followerCount === 1 ? '' : 's'}${first ? ` including @${esc(first.username)}` : ''}</span>
    </span>`;
}

// Discover-section row — richer than listRowHtml: shows who owns it,
// a follower preview, and a circular Follow button instead of just
// linking through. Used only by lists.html's "Discover new Lists".
function listDiscoverRowHtml(l, ownerProfile, following, followerProfiles) {
  const followBtn = `<button type="button" class="list-follow-btn${following ? ' list-following-btn' : ''}"
      onclick="event.preventDefault();listToggleFollow('${l.id}', this, ${following})"
      aria-label="${following ? 'Unfollow' : 'Follow'} this List">${following ? CHECK_ICON : PLUS_ICON}</button>`;
  return `
    <a class="list-discover-row" href="${listUrl(l.id)}">
      <span class="${listAvatarClass(l)}">${listAvatarInner(l)}</span>
      <span class="list-discover-body">
        <span class="list-discover-name">${esc(l.name)}</span>
        <span class="list-discover-meta">${fmtCount(l.member_count)} member${l.member_count === 1 ? '' : 's'}${ownerProfile ? ` &middot; by @${esc(ownerProfile.username)}` : ''}</span>
        ${listFollowerPreviewHtml(followerProfiles, l.follower_count || 0)}
      </span>
      ${followBtn}
    </a>`;
}

// Shared follow/unfollow for a public List — distinct from
// list_members (who's curated ONTO a List, owner-only). Following a
// List just pins it into the follower's own /lists "Your Lists"
// section, same as Twitter's own List-follow button. Used by
// lists.html's Discover section, its "Your Lists" row pill, and
// list.html's own header.
async function followList(listId) {
  if (!requireLogin()) return { error: new Error('not logged in') };
  const { error } = await sb.from('list_followers')
    .insert({ list_id: listId, follower_id: currentSession.user.id });
  return { error };
}
async function unfollowList(listId) {
  if (!requireLogin()) return { error: new Error('not logged in') };
  const { error } = await sb.from('list_followers')
    .delete().eq('list_id', listId).eq('follower_id', currentSession.user.id);
  return { error };
}

async function listToggleFollow(listId, btn, currentlyFollowing) {
  if (!requireLogin()) return;
  btn.disabled = true;
  try {
    const { error } = currentlyFollowing ? await unfollowList(listId) : await followList(listId);
    if (error) throw error;
    const nowFollowing = !currentlyFollowing;
    btn.setAttribute('onclick', `event.preventDefault();listToggleFollow('${listId}', this, ${nowFollowing})`);
    if (btn.classList.contains('list-follow-btn')) {
      // circular Discover-row button
      btn.classList.toggle('list-following-btn', nowFollowing);
      btn.setAttribute('aria-label', `${nowFollowing ? 'Unfollow' : 'Follow'} this List`);
      btn.innerHTML = nowFollowing ? CHECK_ICON : PLUS_ICON;
    } else if (btn.classList.contains('list-row-unfollow')) {
      // "Following" pill on a Your-Lists row — the row itself drops
      // out once unfollowed, handled by onListFollowChanged() below.
    } else {
      // Follow/Following pill on the single-list page header
      btn.textContent = nowFollowing ? 'Following' : 'Follow';
      btn.classList.toggle('list-follow-pill', !nowFollowing);
      btn.classList.toggle('list-following-pill', nowFollowing);
    }
    btn.disabled = false;
    if (typeof onListFollowChanged === 'function') onListFollowChanged(listId, nowFollowing);
  } catch (e) {
    btn.disabled = false;
    toast(e.message || 'Could not update that List.', 'error');
  }
}

const ICON_LOCK = '<svg class="list-lock-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="5.5" y="10.5" width="13" height="9" rx="1.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/></svg>';

function clModalEl() {
  let el = document.getElementById('cl-modal-bg');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'cl-modal-bg';
  el.className = 'modal-bg';
  el.addEventListener('click', e => { if (e.target === el) closeCreateListModal(); });
  el.innerHTML = `
    <div class="modal cl-modal">
      <a class="modal-close" href="#" onclick="closeCreateListModal();return false;">&#10005;</a>
      <h2 id="cl-title">Create a new List</h2>
      <div class="errmsg" id="cl-err" style="display:none;margin:0 16px 8px;"></div>
      <label>Name</label>
      <input type="text" id="cl-name" maxlength="50" placeholder="e.g. Favorite Artists">
      <label>Description (optional)</label>
      <textarea id="cl-desc" rows="3" maxlength="200" placeholder="What's this list about?"></textarea>
      <div class="settings-row" style="margin:0 16px 14px;">
        <div>
          <div class="lbl">Make private</div>
          <div class="pf-note" style="margin-top:2px;">Only you can see a private List and who's on it.</div>
        </div>
        <label class="toggle">
          <input type="checkbox" id="cl-private">
          <span class="toggle-track"></span>
        </label>
      </div>
      <button type="button" class="modal-btn" id="cl-btn" onclick="submitList()">Create List</button>
    </div>`;
  document.body.appendChild(el);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && el.classList.contains('open')) closeCreateListModal();
  });
  return el;
}

// `editList` is null for a fresh create, or an existing lists row to
// edit in place — same modal either way, just pre-filled and posting
// to a different function on submit.
let clEditingId = null;
// If set (a profile's {id, username}), a successful create also adds
// that profile to the brand-new list and refreshes the Add-to-List
// modal — the "+ Create a new list" row inside it sets this.
let clAddAfterCreate = null;

function openCreateListModal(editList = null) {
  if (!requireLogin()) return;
  const el = clModalEl();
  clEditingId = editList ? editList.id : null;
  document.getElementById('cl-title').textContent = editList ? 'Edit List' : 'Create a new List';
  document.getElementById('cl-name').value = editList ? editList.name : '';
  document.getElementById('cl-desc').value = editList ? (editList.description || '') : '';
  document.getElementById('cl-private').checked = editList ? !!editList.is_private : false;
  document.getElementById('cl-btn').textContent = editList ? 'Save' : 'Create List';
  clearErr(document.getElementById('cl-err'));
  el.classList.add('open');
  lockScroll();
  setTimeout(() => document.getElementById('cl-name')?.focus(), 0);
}

function closeCreateListModal() {
  const el = document.getElementById('cl-modal-bg');
  if (el?.classList.contains('open')) { el.classList.remove('open'); unlockScroll(); }
  clEditingId = null;
  clAddAfterCreate = null;
}

async function submitList() {
  if (!requireLogin()) return;
  const nameEl = document.getElementById('cl-name');
  const descEl = document.getElementById('cl-desc');
  const privEl = document.getElementById('cl-private');
  const errEl = document.getElementById('cl-err');
  const btn = document.getElementById('cl-btn');
  clearErr(errEl);

  const name = nameEl.value.trim();
  const description = descEl.value.trim();
  const is_private = privEl.checked;
  if (!name) { showErr(errEl, 'Give your List a name.'); return; }
  if (name.length > 50) { showErr(errEl, 'Name is too long (max 50 characters).'); return; }

  btn.disabled = true;
  btn.textContent = clEditingId ? 'Saving…' : 'Creating…';
  try {
    if (clEditingId) {
      const { error } = await sb.from('lists')
        .update({ name, description: description || null, is_private })
        .eq('id', clEditingId);
      if (error) throw error;
      toast('List updated.');
      closeCreateListModal();
      if (typeof onListUpdated === 'function') onListUpdated(clEditingId, { name, description: description || null, is_private });
    } else {
      const { data, error } = await sb.from('lists').insert({
        name, description: description || null, is_private, owner_id: currentSession.user.id
      }).select('*').single();
      if (error) throw error;
      if (clAddAfterCreate) {
        await sb.from('list_members').insert({ list_id: data.id, member_id: clAddAfterCreate.id }).select().maybeSingle();
        const pending = clAddAfterCreate;
        closeCreateListModal();
        openAddToListModal(null, pending.id, pending.username);
      } else {
        closeCreateListModal();
        location.href = listUrl(data.id);
      }
    }
  } catch (e) {
    showErr(errEl, e.message || 'Failed to save that List.');
  } finally {
    btn.disabled = false;
    btn.textContent = clEditingId ? 'Save' : 'Create List';
  }
}

async function deleteListConfirm(listId, name) {
  const ok = await ocConfirm({
    title: `Delete "${name}"?`,
    desc: `This can't be undone.`,
    confirmLabel: 'Delete',
    danger: true
  });
  if (!ok) return;
  try {
    const { error } = await sb.from('lists').delete().eq('id', listId);
    if (error) throw error;
    toast('List deleted.');
    location.href = 'lists.html';
  } catch (e) {
    toast(e.message || 'Could not delete that List.', 'error');
  }
}

// ─────────────────────────────────────────────────────────────
// ARTICLES — long-form posts any account can write (see
// supabase/articles.sql). Unlike Lists there's no owner/curator
// split: every article has exactly one author, who's the only one
// who can edit or delete it. Used by js/articles.js (browse),
// js/article.js (single view), and js/editarticle.js (write/edit).
// ─────────────────────────────────────────────────────────────

// A short, plain-text preview of an article's body for its row card
// — strips extra whitespace and caps length, same idea as a blog
// index page's excerpt.
function articleExcerpt(body, max = 140) {
  const flat = String(body || '').replace(/\s+/g, ' ').trim();
  return flat.length > max ? flat.slice(0, max).trim() + '…' : flat;
}

// Compact row — used by articles.html's All/Your Articles tabs.
function articleRowHtml(a, authorProfile = null) {
  const byLine = authorProfile
    ? `<span class="who-row-handle">by @${esc(authorProfile.username)}${vBadge(authorProfile)}</span>`
    : '';
  const cover = a.cover_url
    ? `<span class="article-row-cover"><img src="${esc(a.cover_url)}" alt="" loading="lazy"></span>`
    : '';
  return `
    <a class="who-row article-row" href="${articleUrl(a.id)}">
      <span class="who-row-txt">
        <span class="who-row-name">${esc(a.title)}</span>
        <span class="comm-desc">${esc(articleExcerpt(a.body))}</span>
        <span class="who-row-handle">${timeAgo(a.created_at)}</span>
        ${byLine}
      </span>
      ${cover}
    </a>`;
}

async function deleteArticleConfirm(articleId, title) {
  const ok = await ocConfirm({
    title: `Delete "${title}"?`,
    desc: `This can't be undone.`,
    confirmLabel: 'Delete',
    danger: true
  });
  if (!ok) return;
  try {
    // Goes through a SECURITY DEFINER RPC (see
    // supabase/fix_delete_article_via_rpc.sql) instead of a raw client
    // UPDATE — same fix already used for posts/replies in
    // confirmDeletePost() above, since the direct update is at the
    // mercy of the articles table's RLS WITH CHECK re-validation.
    const { error } = await sb.rpc('delete_own_article', { article_id: articleId });
    if (error) throw error;
    toast('Article deleted.');
    location.href = 'articles.html';
  } catch (e) {
    toast(e.message || 'Could not delete that Article.', 'error');
  }
}

// ── ARTICLE RICH CONTENT ── the editarticle.html editor is a plain
// contenteditable div (document.execCommand-driven — see
// js/editarticle.js), so what it produces is arbitrary HTML that
// has to be treated as untrusted input no differently than a post
// body, regardless of what the editor's own toolbar allows. This
// whitelist-based sanitizer is the thing that actually enforces
// that, both when an article is saved (defense in depth) and every
// time one is rendered (the real backstop — RLS only checks
// author_id, so nothing stops someone from writing raw HTML into
// content_html directly against the API, bypassing the editor
// entirely).
const ARTICLE_ALLOWED_TAGS = new Set([
  'P', 'BR', 'B', 'STRONG', 'I', 'EM', 'U', 'S',
  'H2', 'H3', 'BLOCKQUOTE', 'UL', 'OL', 'LI', 'A', 'IMG', 'DIV'
]);
function sanitizeArticleHtml(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html');
  // Post-order: clean a node's children before deciding the node's
  // own fate, so an unwrapped disallowed element's children (which
  // may themselves be disallowed) have already been cleaned by the
  // time they're spliced into the parent.
  function walk(el) {
    [...el.childNodes].forEach(child => {
      if (child.nodeType === Node.TEXT_NODE) return;
      if (child.nodeType !== Node.ELEMENT_NODE) { child.remove(); return; }
      walk(child);
      const tag = child.tagName;
      if (!ARTICLE_ALLOWED_TAGS.has(tag)) {
        while (child.firstChild) el.insertBefore(child.firstChild, child);
        el.removeChild(child);
        return;
      }
      [...child.attributes].forEach(attr => {
        const name = attr.name.toLowerCase();
        if (tag === 'A' && name === 'href') {
          if (!/^https?:\/\//i.test(attr.value.trim())) child.removeAttribute(attr.name);
          return;
        }
        if (tag === 'IMG' && name === 'src') {
          if (!/^https?:\/\//i.test(attr.value.trim())) child.removeAttribute(attr.name);
          return;
        }
        if (tag === 'IMG' && name === 'alt') return;
        child.removeAttribute(attr.name);
      });
      if (tag === 'A') { child.setAttribute('target', '_blank'); child.setAttribute('rel', 'noopener noreferrer nofollow'); }
      if (tag === 'IMG') {
        if (!child.getAttribute('src')) { el.removeChild(child); return; }
        child.setAttribute('loading', 'lazy');
        child.setAttribute('decoding', 'async');
      }
    });
  }
  walk(doc.body);
  return doc.body.innerHTML;
}

// The actual rendered body of an article's own page (article.html)
// and, when quoted inline (not currently done, but kept generic),
// anywhere else. Rich HTML (bold/headings/quotes/inline images) for
// anything written since the content_html column shipped; falls
// back to plain-text rendering (same treatment a post body gets)
// for older articles that only have the plain `body` column.
function renderArticleContent(article) {
  if (article.content_html && article.content_html.trim()) {
    return `<div class="article-rich">${sanitizeArticleHtml(article.content_html)}</div>`;
  }
  return renderBody(article.body || '');
}

// The "X Article"-style card a post embeds when it's promoting an
// article (post.article_id set — see attachQuotedPosts() below for
// how `article` gets attached as post._promoArticle). Clicking it
// opens the article itself rather than the post's own thread, same
// stopPropagation pattern quotedPostHtml() uses for its embed.
function articleCardHtml(article) {
  if (!article) return `<div class="qp-embed-gone">This Article is no longer available.</div>`;
  return `
  <div class="article-embed" onclick="event.stopPropagation();location.href='${articleUrl(article.id)}'" onpointerover="prefetchHref('${articleUrl(article.id)}')">
    ${article.cover_url ? `
    <div class="article-embed-media">
      <img src="${esc(article.cover_url)}" alt="" loading="lazy" decoding="async">
      <span class="article-embed-badge">${NAV_ICON.article}Article</span>
    </div>` : `<span class="article-embed-badge article-embed-badge-standalone">${NAV_ICON.article}Article</span>`}
    <div class="article-embed-text">
      <div class="article-embed-title">${esc(article.title)}</div>
      <div class="article-embed-excerpt">${esc(articleExcerpt(article.body, 120))}</div>
    </div>
  </div>`;
}

// ── ADD/REMOVE-FROM-LIST MODAL ── opened from a profile's "···" menu
// with the profile being added/removed (`targetId`/`targetUsername`).
function almModalEl() {
  let el = document.getElementById('alm-modal-bg');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'alm-modal-bg';
  el.className = 'modal-bg';
  el.addEventListener('click', e => { if (e.target === el) closeAddToListModal(); });
  el.innerHTML = `
    <div class="modal alm-modal">
      <a class="modal-close" href="#" onclick="closeAddToListModal();return false;">&#10005;</a>
      <h2 id="alm-title">Add to Lists</h2>
      <div id="alm-body"><span class="spinner">Loading&hellip;</span></div>
    </div>`;
  document.body.appendChild(el);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && el.classList.contains('open')) closeAddToListModal();
  });
  return el;
}

let almTargetId = null;
let almTargetUsername = null;

async function openAddToListModal(ev, targetId, targetUsername) {
  if (ev) closeProfileMenu(ev);
  if (!requireLogin()) return;
  almTargetId = targetId;
  almTargetUsername = decodeURIComponent(targetUsername);
  const el = almModalEl();
  document.getElementById('alm-title').textContent = `Add @${almTargetUsername} to Lists`;
  el.classList.add('open');
  lockScroll();
  await renderAddToListBody();
}

function closeAddToListModal() {
  const el = document.getElementById('alm-modal-bg');
  if (el?.classList.contains('open')) { el.classList.remove('open'); unlockScroll(); }
}

async function renderAddToListBody() {
  const body = document.getElementById('alm-body');
  if (!body || !almTargetId) return;
  body.innerHTML = `<span class="spinner">Loading&hellip;</span>`;
  const [{ data: myLists, error: listsErr }, { data: memberRows, error: memErr }] = await Promise.all([
    sb.from('lists').select('*').eq('owner_id', currentSession.user.id).order('created_at', { ascending: false }),
    sb.from('list_members').select('list_id').eq('member_id', almTargetId)
  ]);
  if (listsErr) { body.innerHTML = `<div class="errmsg">${esc(listsErr.message)}</div>`; return; }
  const memberOf = new Set((memErr ? [] : memberRows || []).map(r => r.list_id));
  const rows = (myLists || []).map(l => `
    <label class="alm-row">
      <span class="list-avatar list-avatar-sm">${listAvatarInner(l)}</span>
      <span class="who-row-txt">
        <span class="who-row-name">${esc(l.name)}</span>
        <span class="who-row-handle">${fmtCount(l.member_count)} member${l.member_count === 1 ? '' : 's'}${l.is_private ? ' &middot; Private' : ''}</span>
      </span>
      <input type="checkbox" class="alm-check" ${memberOf.has(l.id) ? 'checked' : ''} onchange="toggleListMembership('${l.id}', this)">
    </label>`).join('');
  body.innerHTML = `
    <div class="alm-list">${rows || `<div class="empty-note" style="padding:16px;">You haven't created any Lists yet.</div>`}</div>
    <a href="#" class="comm-create-row" onclick="clAddAfterCreate={id:almTargetId,username:almTargetUsername};openCreateListModal();return false;">
      <span class="comm-avatar comm-avatar-plus">${PLUS_ICON}</span>
      <span class="who-row-txt"><span class="who-row-name">Create a new List</span></span>
    </a>`;
}

async function toggleListMembership(listId, checkbox) {
  checkbox.disabled = true;
  try {
    if (checkbox.checked) {
      const { error } = await sb.from('list_members').insert({ list_id: listId, member_id: almTargetId });
      if (error) throw error;
      toast(`Added @${almTargetUsername} to the List.`);
    } else {
      const { error } = await sb.from('list_members').delete().eq('list_id', listId).eq('member_id', almTargetId);
      if (error) throw error;
      toast(`Removed @${almTargetUsername} from the List.`);
    }
  } catch (e) {
    checkbox.checked = !checkbox.checked;
    toast(e.message || 'Could not update that List.', 'error');
  } finally {
    checkbox.disabled = false;
  }
}

// ── SIDEBAR "MY LISTS" BOX — same self-contained pattern as
// renderMyCommunities() above: only runs on pages with a
// #my-lists container.
async function renderMyLists() {
  const box = document.getElementById('my-lists');
  if (!box) return;
  const header = `<div class="t-lbl">Lists</div>`;
  const createRow = `<a href="#" class="comm-create-row" onclick="openCreateListModal();return false;">
      <span class="comm-avatar comm-avatar-plus">${PLUS_ICON}</span>
      <span class="who-row-txt"><span class="who-row-name">Create a List</span></span>
    </a>`;

  if (!currentSession) {
    box.innerHTML = header + createRow +
      `<a class="show-more" href="lists.html">Browse Lists</a>`;
    return;
  }

  // "My Lists" now means owned-or-followed, same as the "Your Lists"
  // tab on lists.html — merge both, newest activity first.
  const [{ data: owned, error: ownErr }, { data: followedRows, error: folErr }] = await Promise.all([
    sb.from('lists').select('*').eq('owner_id', currentSession.user.id).order('created_at', { ascending: false }).limit(4),
    sb.from('list_followers').select('followed_at, list:lists(*)').eq('follower_id', currentSession.user.id).order('followed_at', { ascending: false }).limit(4)
  ]);
  const ownedRows = (ownErr ? [] : owned || []).map(l => ({ l, t: l.created_at }));
  const followedRowsClean = (folErr ? [] : followedRows || []).filter(r => r.list).map(r => ({ l: r.list, t: r.followed_at }));
  const mine = [...ownedRows, ...followedRowsClean]
    .sort((a, b) => new Date(b.t) - new Date(a.t))
    .slice(0, 4)
    .map(r => r.l);

  box.innerHTML = header + createRow +
    mine.map(l => listRowHtml(l)).join('') +
    `<a class="show-more" href="lists.html">${mine.length ? 'See all' : 'Browse Lists'}</a>`;
}

document.addEventListener('DOMContentLoaded', async () => {
  if (!document.getElementById('my-lists')) return;
  if (typeof authReady !== 'undefined') await authReady;
  renderMyLists();
});

// The small "↻ [Name] reposted" line shown above a card that's in a
// feed/profile only because someone reposted it (not authored it) —
// same idea as Twitter. `reposter` is {id, username, display_name}.
// "You reposted" when the reposter is the person currently logged in
// (own profile's repost list, or your repost showing in your own
// view); otherwise it links to the reposter's profile.
function repostBannerHtml(reposter) {
  if (!reposter) return '';
  const isYou = currentSession && currentSession.user.id === reposter.id;
  const name = esc(reposter.display_name || reposter.username);
  const label = isYou ? 'You reposted' : `${name} reposted`;
  const inner = isYou
    ? `<span>${label}</span>`
    : `<a href="${profileUrl(reposter.username)}" onclick="event.stopPropagation()">${label}</a>`;
  return `<div class="repost-banner">${ICON.repost}${inner}</div>`;
}

// The "📌 Pinned" tag shown above a profile's pinned post — same
// banner styling as repostBannerHtml above, just a pin icon + static
// label since (unlike a repost) there's no one else to credit.
const ICON_PIN = '<svg class="pin-ic" viewBox="0 0 24 24"><path d="M16 12V4h1c.55 0 1-.45 1-1s-.45-1-1-1H7c-.55 0-1 .45-1 1s.45 1 1 1h1v8l-2 2v2h5.2v6h1.6v-6H18v-2z"/></svg>';
function pinBannerHtml(pinned) {
  if (!pinned) return '';
  return `<div class="repost-banner">${ICON_PIN}<span>Pinned</span></div>`;
}

// "Scheduled for ..." tag — only ever shown to the post's own author,
// since RLS is what's actually stopping anyone else from seeing the
// row at all before scheduled_at passes. This just makes it visually
// obvious (rather than looking like a normal live post) on the rare
// screens where an author can legitimately see their own pre-publish
// post directly, e.g. its own thread URL.
const ICON_CLOCK_SM = '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9"/><path d="M12 7.5v5l3.5 2"/></svg>';
function scheduledBannerHtml(scheduledAt) {
  if (!scheduledAt || new Date(scheduledAt).getTime() <= Date.now()) return '';
  return `<div class="repost-banner">${ICON_CLOCK_SM}<span>Scheduled for ${esc(new Date(scheduledAt).toLocaleString())}</span></div>`;
}

// Full tweet-style post card — used by the main feed and profile page.
// The whole card is clickable (opens the post's comments), matching
// Twitter — but clicks on an actual link/button/menu inside it are
// left alone so those keep working normally. If `p._repostedBy` is
// set (see board.js/profile.js), a "[Name] reposted" banner is shown
// above the card, same as Twitter.
// ── SKELETON PLACEHOLDERS — swapped in the instant a feed/thread
// starts loading, replaced with real markup once data lands. See the
// .skel-* rules in style.css for the shimmer.
function skeletonFeedHtml(n = 4) {
  const card = `
    <div class="skel-card">
      <div class="skel-avatar"></div>
      <div class="skel-lines">
        <div class="skel-line w40"></div>
        <div class="skel-line w90"></div>
        <div class="skel-line w60"></div>
      </div>
    </div>`;
  return card.repeat(n);
}
function skeletonThreadHtml() {
  return `
    <div class="skel-card skel-op">
      <div class="skel-avatar"></div>
      <div class="skel-lines">
        <div class="skel-line w20"></div>
        <div class="skel-line w90 tall"></div>
        <div class="skel-line w60 tall"></div>
      </div>
    </div>` + skeletonFeedHtml(2);
}

// ── PAGE-NUMBER PAGER — shared by any 10-per-page browse list
// (Communities' "All"/"Joined" tabs, Lists' "Your Lists"/"Lists
// you're on" tabs). `onPageAttr` is the raw JS expression string used
// as each page button's onclick body (e.g. "gotoCommunitiesPage(N)")
// — callers own their own page-state variable and re-render, this
// just builds the numbered-with-ellipsis strip and Prev/Next arrows
// around it. Renders nothing (empty string) when everything already
// fits on one page.
function pagerHtml(page, totalPages, onPageFnName) {
  if (totalPages <= 1) return '';
  const arrowIcon = (dir) => dir === 'prev'
    ? `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M15 6l-6 6 6 6"/></svg>`
    : `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="M9 6l6 6-6 6"/></svg>`;

  // Keep first, last, current, and current's immediate neighbors;
  // collapse every other gap to a single "…".
  const keep = new Set([1, totalPages, page, page - 1, page + 1]);
  const nums = [];
  for (let n = 1; n <= totalPages; n++) {
    if (keep.has(n) && n >= 1 && n <= totalPages) nums.push(n);
  }

  let mid = '';
  let prevN = 0;
  for (const n of nums) {
    if (prevN && n - prevN > 1) mid += `<span class="comm-pager-ellipsis">&hellip;</span>`;
    mid += `<button type="button" class="comm-pager-btn${n === page ? ' active' : ''}" ${n === page ? 'aria-current="page"' : ''} onclick="${onPageFnName}(${n})">${n}</button>`;
    prevN = n;
  }

  return `<div class="comm-pager">
    <button type="button" class="comm-pager-btn" aria-label="Previous page" ${page <= 1 ? 'disabled' : ''} onclick="${onPageFnName}(${page - 1})">${arrowIcon('prev')}</button>
    ${mid}
    <button type="button" class="comm-pager-btn" aria-label="Next page" ${page >= totalPages ? 'disabled' : ''} onclick="${onPageFnName}(${page + 1})">${arrowIcon('next')}</button>
  </div>`;
}

function postCardHtml(p, flash = false) {
  cachePost(p);
  return `
  <div class="pc${flash ? ' flash' : ''}" id="post-${p.id}" data-post-id="${p.id}" data-view="post:${p.id}" onclick="cardClick(event, '${p.id}', ${p.profile?.username ? `'${u_(p.profile.username)}'` : 'null'})" onpointerover="prefetchHref('${postUrl(p)}')" ontouchstart="prefetchHref('${postUrl(p)}')">
    ${repostBannerHtml(p._repostedBy)}
    ${pinBannerHtml(p._pinned)}
    ${scheduledBannerHtml(p.scheduled_at)}
    <div class="pc-row">
      ${pcAvatarHtml(p.profile)}
      <div class="pc-main">
        <div class="ph">
          ${pcNameHtml(p.profile)}
          <span class="dt" data-dt="${p.id}">${timeAgo(p.created_at)}${editedSuffix(p)}</span>
          ${postMenuHtml(p.id, null, p.author_id, p.community_id, p.created_at)}
        </div>
        ${p.body ? `<div class="pb" data-pb="${p.id}">${renderBody(p.body)}</div>` : ''}
        ${p.quote_of ? quotedPostHtml(p.quoted) : ''}
        ${p.article_id ? articleCardHtml(p._promoArticle) : ''}
        ${renderMedia(p.media_url, p.media_type, '', p)}
        ${pollHtml(p)}
        ${postActionsHtml(p, { replyOnclick: `openReplyPopup('${p.id}')` })}
      </div>
    </div>
  </div>`;
}

// Clicking anywhere on a post card opens its comments — unless the
// click actually landed on a link, button, the "···" menu, or an
// input, all of which handle themselves.
function cardClick(ev, postId, username = null) {
  if (ev.target.closest('a, button, input, textarea, .pc-menu-wrap, .pm')) return;
  location.href = postUrlById(postId, username);
}

// A random per-browser id used only to stop the same visitor
// double-liking a post. Not a tracking id — it never leaves
// the browser attached to anything but a like row.
function getDeviceId() {
  let id = localStorage.getItem('oc_device');
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem('oc_device', id);
  }
  return id;
}

// Plain grey silhouette shown when a user has no avatar_url set.
const DEFAULT_AVATAR = "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 40 40'%3E%3Ccircle cx='20' cy='20' r='20' fill='%23E1E8EA'/%3E%3Ccircle cx='20' cy='16' r='7' fill='%23AAB8C2'/%3E%3Cpath d='M6 36c1-9 8-14 14-14s13 5 14 14' fill='%23AAB8C2'/%3E%3C/svg%3E";

function avatarUrl(url) {
  return url || DEFAULT_AVATAR;
}

// Renders the "author" chunk of a post/reply header: avatar + username,
// linking to that user's profile page. `profile` is the joined row from
// `profiles` (author_id -> profiles.*).
function authorHtml(profile) {
  const uname = profile?.username || 'unknown';
  return `<a class="pfl" href="${profileUrl(uname)}">` +
         `<img class="avatar pfp-sm" src="${esc(avatarUrl(profile?.avatar_url))}" alt="" loading="lazy" decoding="async">` +
         `${esc(profile?.display_name || uname)}${vBadge(profile)}</a>`;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

// The verified checkmark shown right after a display name. `profile`
// is any joined `profiles` row that included the `verified` column in
// its select() — see js/supabase-config.js's ADMIN_PANEL note. Every
// name-rendering helper below (pcNameHtml, whoRowHtml, authorHtml,
// userRowHtml) calls this, so setting profiles.verified = true from
// the admin panel is enough to make the badge show up everywhere.
//
// Rendered as an inline <svg><use> against a single shared <symbol>
// (injected once by ensureBadgeDefs() below) rather than the old PNG.
// That fixes two things the raster version couldn't: it's pixel-crisp
// at every size/DPI instead of going soft when scaled, and the scalloped
// seal shape is drawn from an exact vector path instead of a slightly
// lumpy rasterized outline, so it reads as a clean, deliberate mark
// instead of a blurry sticker.
// The verified checkmark shown right after a display name. `profile`
// is any joined `profiles` row that included the `verified` column in
// its select() — see js/supabase-config.js's ADMIN_PANEL note. Every
// name-rendering helper below (pcNameHtml, whoRowHtml, authorHtml,
// userRowHtml) calls this, so setting profiles.verified = true from
// the admin panel is enough to make the badge show up everywhere.
//
// Uses the glossy 3D badge art in img/verified-badge-256.png as the
// single source image — it's rendered ~4-16x larger than its on-screen
// size (16-21px) so it stays crisp at any display density instead of
// softening the way a source sized 1:1 to the CSS box would.
function vBadge(profile) {
  return profile?.verified
    ? `<img class="verified-badge" src="img/verified-badge-256.png" alt="Verified" title="Verified">`
    : '';
}

// Renders body text with basic greentext (> lines) support, plus
// Twitter-style rich text: @mentions, #hashtags, and bare URLs all
// become links. Input is escaped first, and linkifyText() only ever
// re-inserts the handful of <a> tags below, so this still cannot
// inject HTML no matter what the post body contains.
function renderBody(body) {
  return linkifyText(esc(body))
    .split('\n')
    .map(line => line.trim().startsWith('&gt;') ? `<span class="gt">${line}</span>` : line)
    .join('\n');
}

// Turns already-HTML-escaped text into Twitter-style rich text:
//   - https://... / http://... -> clickable link (opens in a new tab)
//   - @username -> link to that user's profile
//   - #hashtag  -> link to a search for that hashtag
// Runs on esc()'d input, so `escaped` can only ever contain entities
// (&amp; &lt; &gt; &quot; &#39;) plus plain text — there's no raw < or
// " left in it for a crafted post body to break out of the <a> tags
// added below with, so matching on whitespace alone is enough.
function linkifyText(escaped) {
  return escaped.replace(
    /(https?:\/\/[^\s]+)|(^|[^\w&])@([a-zA-Z0-9_]{3,20})|(^|[^\w&])#([a-zA-Z0-9_]+)/g,
    (match, url, mBefore, mHandle, hBefore, hTag) => {
      if (url) {
        // Trim trailing punctuation that's obviously sentence
        // punctuation rather than part of the URL (a period ending
        // the sentence, a closing paren that opened outside the URL,
        // etc.) off the link, but keep it in the surrounding text.
        const trailing = url.match(/[.,!?:;]+$/);
        const clean = trailing ? url.slice(0, -trailing[0].length) : url;
        const rest = trailing ? trailing[0] : '';
        if (!clean) return match;
        return `<a href="${clean}" target="_blank" rel="noopener noreferrer nofollow" class="body-link" onclick="event.stopPropagation()">${clean}</a>${rest}`;
      }
      if (mHandle) {
        return `${mBefore}<a href="${profileUrl(mHandle)}" class="body-mention" onclick="event.stopPropagation()">@${mHandle}</a>`;
      }
      return `${hBefore}<a href="search.html?q=${encodeURIComponent('#' + hTag)}" class="body-hashtag" onclick="event.stopPropagation()">#${hTag}</a>`;
    }
  );
}

function timeAgo(iso) {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return t('time.now');
  if (diff < 3600) return `${Math.floor(diff / 60)}${t('time.m')}`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}${t('time.h')}`;
  if (diff < 604800) return `${Math.floor(diff / 86400)}${t('time.d')}`;
  return new Date(iso).toLocaleDateString(getLang());
}

// "9:00 PM · Aug 8, 2026" — the full timestamp shown on a post's own
// detail page (thread.html), as opposed to the relative "3h ago" used
// everywhere else (see timeAgo() above).
function fullDateTime(iso) {
  const d = new Date(iso);
  const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  const date = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
  return `${time} \u00b7 ${date}`;
}

function shortId(id) {
  return id.slice(0, 8);
}

// Compact number formatting for counts (views, followers, etc): 1.2k, 3.4M
function fmtCount(n) {
  n = n || 0;
  if (n < 1000) return String(n);
  if (n < 1000000) return (n / 1000).toFixed(n % 1000 >= 100 ? 1 : 0).replace(/\.0$/, '') + 'k';
  return (n / 1000000).toFixed(1).replace(/\.0$/, '') + 'M';
}

// ── VIEW COUNTS ──
// Each browser only bumps a given post/reply's view count once per
// session (sessionStorage, not localStorage — a fresh visit later
// still counts as a new view). Fire-and-forget: a failed RPC call
// should never block rendering the page.
function seenThisSession(key) {
  const seen = new Set(JSON.parse(sessionStorage.getItem('oc_seen') || '[]'));
  if (seen.has(key)) return true;
  seen.add(key);
  sessionStorage.setItem('oc_seen', JSON.stringify([...seen]));
  return false;
}

function bumpPostView(postId) {
  if (seenThisSession('p:' + postId)) return;
  sb.rpc('increment_post_view', { p_id: postId }).then(({ error }) => {
    if (error) console.warn('view count rpc failed', error);
  });
}

function bumpReplyViews(replyIds) {
  const fresh = replyIds.filter(id => !seenThisSession('r:' + id));
  if (!fresh.length) return;
  sb.rpc('increment_reply_views', { p_ids: fresh }).then(({ error }) => {
    if (error) console.warn('view count rpc failed', error);
  });
}

// ── SCROLL-BASED VIEW TRACKING ──
// A post/reply counts as "viewed" the moment its card scrolls into
// view in the feed/thread — no click required. Any element carrying
// data-view="post:<id>" or data-view="reply:<id>" (see postCardHtml()
// and thread.js's replyHtml()) is watched by a single shared
// IntersectionObserver; once at least half the card has been on
// screen for a short moment, it's counted and then left alone (so
// scrolling back and forth over the same card doesn't recount it).
// The actual dedup — so the same user never adds more than one view
// to a given post, whether they scrolled past it, opened its thread,
// or both — still happens in bumpPostView()/bumpReplyViews() above
// via seenThisSession(), so this is purely about *when* that fires,
// not *whether* it can fire twice.
const VIEW_DWELL_MS = 400; // must stay ~half-visible this long to count as an actual view, not just a fast scroll-by
const _viewTimers = new WeakMap();

const _viewObserver = ('IntersectionObserver' in window) ? new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    const el = entry.target;
    if (entry.isIntersecting) {
      if (_viewTimers.has(el)) return;
      const t = setTimeout(() => {
        _viewTimers.delete(el);
        _viewObserver.unobserve(el);
        const raw = el.dataset.view;
        if (!raw) return;
        const sep = raw.indexOf(':');
        const kind = raw.slice(0, sep), id = raw.slice(sep + 1);
        if (kind === 'post') bumpPostView(id);
        else if (kind === 'reply') bumpReplyViews([id]);
      }, VIEW_DWELL_MS);
      _viewTimers.set(el, t);
    } else {
      const t = _viewTimers.get(el);
      if (t) { clearTimeout(t); _viewTimers.delete(el); }
    }
  });
}, { threshold: 0.5 }) : null;

// Starts watching every trackable card under `root` (defaults to the
// whole document). Safe to call repeatedly — cards already being
// watched, or already counted this session, are just skipped.
function trackViewsIn(root = document) {
  if (!_viewObserver) return;
  const nodes = root.matches?.('[data-view]') ? [root] : [];
  nodes.push(...root.querySelectorAll('[data-view]'));
  nodes.forEach(el => _viewObserver.observe(el));
}

// Auto-watches any card added anywhere on the page — feed pagination,
// realtime inserts, thread replies, quote-post previews, etc. — so
// individual pages/renders never have to remember to call
// trackViewsIn() themselves.
if ('MutationObserver' in window) {
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        trackViewsIn(node);
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
}

// ── FOLLOW / UNFOLLOW ──
// @marpe is auto-followed on signup and can't be unfollowed (enforced
// both here in the UI and, as the real guardrail, by the "users can
// unfollow" RLS policy in supabase/pin_follow_marpe.sql). Keep this
// username check in one place so every follow button agrees.
const PROTECTED_FOLLOW_USERNAME = 'marpe';
function isProtectedFollowUsername(username) {
  return !!username && username.toLowerCase() === PROTECTED_FOLLOW_USERNAME;
}
const ICON_LOCK_SM = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:12px;height:12px;margin-right:4px;vertical-align:-1px;"><rect x="5.5" y="10.5" width="13" height="9" rx="1.5"/><path d="M8.5 10.5V7.5a3.5 3.5 0 0 1 7 0v3"/></svg>';

async function isFollowing(followeeId) {
  if (!currentSession) return false;
  const { data } = await sb.from('follows').select('follower_id')
    .eq('follower_id', currentSession.user.id).eq('followee_id', followeeId).maybeSingle();
  return !!data;
}

async function followUser(followeeId) {
  return sb.from('follows').insert({ follower_id: currentSession.user.id, followee_id: followeeId });
}

async function unfollowUser(followeeId) {
  return sb.from('follows').delete()
    .eq('follower_id', currentSession.user.id).eq('followee_id', followeeId);
}

// ── MUTE / BLOCK — same shape as follow/unfollow above. Muting only
// affects your own feeds (nothing to tell the other person); blocking
// is mutual-visible, same as Twitter, and the DB trigger in
// profile_extras.sql drops any existing follow either direction the
// moment a block row is inserted.
async function isMuted(mutedId) {
  if (!currentSession) return false;
  const { data } = await sb.from('mutes').select('muter_id')
    .eq('muter_id', currentSession.user.id).eq('muted_id', mutedId).maybeSingle();
  return !!data;
}
async function muteUser(mutedId) {
  return sb.from('mutes').insert({ muter_id: currentSession.user.id, muted_id: mutedId });
}
async function unmuteUser(mutedId) {
  return sb.from('mutes').delete()
    .eq('muter_id', currentSession.user.id).eq('muted_id', mutedId);
}

async function isBlocked(blockedId) {
  if (!currentSession) return false;
  const { data } = await sb.from('blocks').select('blocker_id')
    .eq('blocker_id', currentSession.user.id).eq('blocked_id', blockedId).maybeSingle();
  return !!data;
}
async function blockUser(blockedId) {
  return sb.from('blocks').insert({ blocker_id: currentSession.user.id, blocked_id: blockedId });
}
async function unblockUser(blockedId) {
  return sb.from('blocks').delete()
    .eq('blocker_id', currentSession.user.id).eq('blocked_id', blockedId);
}

function mediaTypeFor(file) {
  if (file.type.startsWith('image/')) return 'image';
  if (file.type.startsWith('video/')) return 'video';
  return null;
}

function validateFile(file, errEl) {
  if (!ALLOWED_MIME.includes(file.type)) {
    showErr(errEl, 'Unsupported file type. Allowed: JPEG, PNG, GIF, WebP, MP4, WebM.');
    return false;
  }
  if (file.size > MAX_FILE_MB * 1024 * 1024) {
    showErr(errEl, `File too large. Max ${MAX_FILE_MB}MB.`);
    return false;
  }
  return true;
}

function showErr(el, msg) {
  if (!el) { alert(msg); return; }
  el.textContent = msg;
  el.style.display = 'block';
}

function clearErr(el) {
  if (!el) return;
  el.style.display = 'none';
  el.textContent = '';
  el.classList.remove('auth-ok');
}

// ── "I'm not a robot" CAPTCHA (Cloudflare Turnstile) ──
// Gates sign up, log in, and every posting action (new post, community
// post, top-level reply, inline comment reply). Shared across all of
// them instead of duplicated per-page so there's exactly one place
// that knows how to render/verify a widget and one place to update if
// the site ever swaps providers.
//
// Was Google reCAPTCHA v2 — switched to Turnstile because privacy
// extensions/blockers (Privacy Badger, uBlock Origin's privacy lists,
// etc.) commonly block Google's recaptcha/api.js and its tracking
// cookie, which left the checkbox never rendering and the person
// stuck unable to post. Turnstile is privacy-first (no tracking
// cookie, doesn't fingerprint across sites) so it isn't caught by the
// same blocklists, and it's a near drop-in: same "tick a box" UX, same
// render/getResponse/reset widget API, same secret+siteverify
// server-side check.
//
// SETUP REQUIRED — this ships disabled-safe (fails OPEN, not closed)
// until you fill in a real site key here, so the site keeps working
// out of the box:
//   1. Create a Turnstile widget (Managed / "checkbox" mode) at
//      https://dash.cloudflare.com/?to=/:account/turnstile for your
//      domain(s) — free, no Cloudflare-hosted DNS required.
//   2. Paste the SITE key below.
//   3. Set the SECRET key as the TURNSTILE_SECRET_KEY environment
//      variable in your Vercel project (Settings → Environment
//      Variables) — see api/verify-captcha.js. Never put the secret
//      key in client code.
// Until both are done, renderCaptchaIfNeeded()/verifyHuman() silently
// no-op (widgets stay hidden, checks pass) so nothing breaks — but
// posting/signup/login are NOT actually bot-protected yet.
const TURNSTILE_SITE_KEY = 'YOUR_TURNSTILE_SITE_KEY';
function captchaConfigured() {
  return !!TURNSTILE_SITE_KEY && !TURNSTILE_SITE_KEY.startsWith('YOUR_');
}

// Passing one checkbox re-verifies the person for a little while
// instead of demanding a fresh checkbox on every single post/reply —
// same tradeoff most sites make between "annoying" and "bot-proof".
const HUMAN_VERIFIED_MINUTES = 20;
const HUMAN_VERIFIED_KEY = 'oc-human-verified-until';
function isHumanVerified() {
  try { return Date.now() < (+sessionStorage.getItem(HUMAN_VERIFIED_KEY) || 0); }
  catch (e) { return false; }
}
function markHumanVerified() {
  try { sessionStorage.setItem(HUMAN_VERIFIED_KEY, String(Date.now() + HUMAN_VERIFIED_MINUTES * 60000)); }
  catch (e) {}
}

// Markup for the captcha "card" — a shield icon + label header over a
// shimmer placeholder that renderCaptchaIfNeeded() swaps for the real
// Turnstile checkbox once it's ready (see below). Used both for the
// static containers baked into signup/login/index/community's HTML
// and for the reply composers thread.js builds at runtime (one per
// reply-to-reply box), so there's a single template for the look.
function captchaCardHtml(containerId) {
  return `<div id="${containerId}" class="captcha-card" style="display:none;">
    <div class="captcha-card-head">
      <span class="captcha-card-icon">
        <svg class="cci-shield" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l7 3v6c0 4.5-3 8-7 9-4-1-7-4.5-7-9V6l7-3Z"/><path d="m9 12 2 2 4-4"/></svg>
        <svg class="cci-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.5 9.5 17 19 7"/></svg>
      </span>
      <span class="captcha-card-text">
        <span class="captcha-card-title">Quick security check</span>
        <span class="captcha-card-sub">Confirm you're human to continue</span>
      </span>
    </div>
    <div class="captcha-card-body"><div class="captcha-skeleton"></div></div>
  </div>`;
}

const _captchaWidgets = {}; // containerId -> turnstile widget id

// #<containerId> is the *card* (see captchaCardHtml() below) — the
// checkbox itself mounts into a child slot we create on first render,
// so the shimmer placeholder that ships in the card's initial markup
// stays put until Turnstile is actually ready to draw into it.
function captchaSlotId(containerId) { return `${containerId}-slot`; }

// Matches the Turnstile widget's theme to whichever of the app's own
// themes (Default/Dim/Lights out) is currently active, so the
// checkbox iframe doesn't look like a stray light-mode box dropped
// onto a dark page.
function currentCaptchaTheme() {
  const t = document.documentElement.getAttribute('data-theme');
  return (t === 'dim' || t === 'dark') ? 'dark' : 'light';
}

// Renders (once) the checkbox into the card at #<containerId> if a
// check is actually still needed right now; hides/no-ops otherwise.
// Safe to call every time a composer opens.
function renderCaptchaIfNeeded(containerId, _attempt = 0) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!captchaConfigured() || isHumanVerified()) { el.style.display = 'none'; el.classList.remove('is-error'); return; }
  el.style.display = '';
  if (_captchaWidgets[containerId] != null) return;
  if (window.turnstile?.render) {
    const body = el.querySelector('.captcha-card-body');
    if (body) body.innerHTML = `<div id="${captchaSlotId(containerId)}"></div>`;
    _captchaWidgets[containerId] = turnstile.render(`#${captchaSlotId(containerId)}`, {
      sitekey: TURNSTILE_SITE_KEY,
      theme: currentCaptchaTheme(),
      size: 'flexible',
      callback: () => { el.classList.remove('is-error'); el.classList.add('is-verified'); },
      'error-callback': () => {
        el.classList.add('is-error');
        setTimeout(() => el.classList.remove('is-error'), 500);
      },
      'expired-callback': () => { el.classList.remove('is-verified'); }
    });
  } else if (_attempt < 20) {
    // turnstile's script loads async — it may not be ready yet the
    // first time a composer/auth form appears, so retry briefly
    // (the shimmer placeholder in the card covers this wait).
    setTimeout(() => renderCaptchaIfNeeded(containerId, _attempt + 1), 250);
  }
}
// Passed as ?onload=initAllCaptchas to the turnstile <script> tag on
// every page that has one or more containers below — each call is a
// no-op for any id not present on the current page.
function initAllCaptchas() {
  ['su-captcha', 'li-captcha', 'pf-captcha', 'cf-captcha', 'rf-captcha'].forEach(renderCaptchaIfNeeded);
}

// Resolves true once the person is verified human (already verified
// recently, or just solved the checkbox in containerId and it passed
// server-side verification). Shows an error in errEl and returns
// false otherwise. Call this right before the network request a
// captcha is meant to gate (sign up, log in, submit post/reply).
async function verifyHuman(containerId, errEl) {
  if (!captchaConfigured() || isHumanVerified()) return true;
  renderCaptchaIfNeeded(containerId);
  const cardEl = document.getElementById(containerId);
  const widgetId = _captchaWidgets[containerId];
  const token = widgetId != null && window.turnstile ? turnstile.getResponse(widgetId) : '';
  if (!token) {
    cardEl?.classList.add('is-error');
    setTimeout(() => cardEl?.classList.remove('is-error'), 500);
    showErr(errEl, "Please check the box to confirm you're not a robot.");
    return false;
  }
  try {
    const res = await fetch('/api/verify-captcha', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token })
    });
    const out = await res.json();
    if (!out.success) {
      showErr(errEl, 'Captcha check failed — please try again.');
      cardEl?.classList.remove('is-verified');
      cardEl?.classList.add('is-error');
      if (widgetId != null) turnstile.reset(widgetId);
      return false;
    }
    markHumanVerified();
    cardEl?.classList.add('is-verified');
    return true;
  } catch (e) {
    showErr(errEl, 'Could not verify the captcha right now — please try again.');
    return false;
  }
}

// ── 30s POSTING COOLDOWN — client-side spam brake shared by every
// "create a post/reply" action. Kept in localStorage (not a JS
// variable) so it survives this site's real full-page navigations —
// see supabase/post_cooldown.sql for the server-side trigger that
// actually enforces this (client-side alone can always be bypassed by
// someone calling the Supabase API directly). ──
const POST_COOLDOWN_MS = 30000;
function postCooldownRemainingMs() {
  try {
    const rem = POST_COOLDOWN_MS - (Date.now() - (+localStorage.getItem('oc-last-post-at') || 0));
    return rem > 0 ? rem : 0;
  } catch (e) { return 0; }
}
function markPosted() {
  try { localStorage.setItem('oc-last-post-at', String(Date.now())); } catch (e) {}
}
// Returns true and does nothing if clear to post; otherwise shows the
// remaining wait in errEl and returns false.
function enforceCooldown(errEl) {
  const rem = postCooldownRemainingMs();
  if (rem > 0) {
    showErr(errEl, `You're posting too fast — wait ${Math.ceil(rem / 1000)}s and try again.`);
    return false;
  }
  return true;
}
// Disables btn and live-counts down its label until the cooldown
// clears, then restores it. Call right after a successful post.
function startCooldownCountdown(btn, restoreLabel) {
  if (!btn) return;
  const tick = () => {
    const rem = postCooldownRemainingMs();
    if (rem <= 0) { btn.disabled = false; btn.value = restoreLabel; return; }
    btn.disabled = true;
    btn.value = `Wait ${Math.ceil(rem / 1000)}s`;
    setTimeout(tick, 250);
  };
  tick();
}

// ── AUTOMATIC MEDIA COMPRESSION ──
// Every file a person attaches to a post/reply is re-encoded
// client-side, before it ever reaches the network, so it takes as
// little storage as possible with no visible loss in quality:
//   • Still images  → re-encoded to WebP at a very high quality
//     setting (compressImageFile).
//   • Animated GIFs → losslessly re-packed with Gifsicle — same
//     pixels, same frames, same timing, just a tighter encoding
//     (compressGifFile).
//   • Video (mp4/webm) → re-encoded at a visually-lossless CRF, which
//     strips the huge bitrate overhead most phone/screen-recorder
//     exports bake in without introducing visible artifacts
//     (compressVideoFile).
// Every step is best-effort and wrapped so it can never block a
// post: on any failure (old browser, slow device, CDN hiccup, a file
// that's already optimal) it silently falls back to the original,
// untouched file.

// Re-encodes a still image to WebP at a very high quality setting.
// WebP's lossy mode at this quality is visually indistinguishable
// from the source but usually runs 25–50% smaller, and it also
// strips EXIF/metadata bloat as a side effect of the canvas
// round-trip. Falls back to the original file untouched if the
// browser can't decode it, or if re-encoding somehow comes out
// larger (e.g. an already-optimized WebP/AVIF).
const IMAGE_COMPRESS_QUALITY = 0.92;
async function compressImageFile(file) {
  // Defensive guard: drawing a GIF to a canvas only captures its
  // first frame, which would silently kill the animation. GIFs are
  // routed to compressGifFile() instead — see uploadMedia().
  if (file.type === 'image/gif') return file;
  try {
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', IMAGE_COMPRESS_QUALITY));
    if (!blob || blob.size >= file.size) return file;
    const name = file.name.replace(/\.[^.]+$/, '') + '.webp';
    return new File([blob], name, { type: 'image/webp' });
  } catch {
    return file;
  }
}

// Gifsicle compiled to WASM (~150KB gzipped), loaded on demand the
// first time someone actually uploads a GIF — pinned to a fixed
// version so a CDN update can't silently change behavior.
const GIFSICLE_CDN_URL = 'https://cdn.jsdelivr.net/npm/gifsicle-wasm-browser@1.5.19/dist/gifsicle.min.js';
let _gifsiclePromise = null;
function loadGifsicle() {
  if (!_gifsiclePromise) _gifsiclePromise = import(GIFSICLE_CDN_URL).then(m => m.default);
  return _gifsiclePromise;
}

// Losslessly re-optimizes an animated GIF with Gifsicle. `-O3` (or
// `-O2` for bigger files — O3's cost grows sharply past ~10MB for
// almost no extra savings) rebuilds the frame/LZW/color-table
// encoding more efficiently; it never touches a pixel, a frame, or
// the timing, so the output is the exact same animation, just packed
// tighter. No `--lossy` flag is used anywhere — that's the flag that
// would trade quality for size, and it's intentionally left off.
async function compressGifFile(file) {
  if (file.size > 40 * 1024 * 1024) return file; // too large to safely optimize in-tab
  try {
    const gifsicle = await loadGifsicle();
    const level = file.size > 10 * 1024 * 1024 ? '-O2' : '-O3';
    const [out] = await gifsicle.run({
      input: [{ file, name: 'in.gif' }],
      command: [`${level} in.gif -o /out/out.gif`]
    });
    if (!out || out.size >= file.size) return file;
    return new File([out], file.name, { type: 'image/gif' });
  } catch {
    return file;
  }
}

// ffmpeg.wasm, loaded on demand the first time someone actually
// uploads a video. Uses the single-threaded core (not core-mt), which
// works without the site needing to send COOP/COEP headers — slower
// than the multi-threaded build, but nothing to configure. Pinned
// versions for the same reason as Gifsicle above.
const FFMPEG_VERSION = '0.12.15';
const FFMPEG_CORE_VERSION = '0.12.10';
let _ffmpegPromise = null;
async function loadFFmpeg() {
  if (_ffmpegPromise) return _ffmpegPromise;
  _ffmpegPromise = (async () => {
    const [{ FFmpeg }, { toBlobURL }] = await Promise.all([
      import(`https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm/index.js`),
      import(`https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js`)
    ]);
    const ffmpeg = new FFmpeg();
    const coreBase = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${FFMPEG_CORE_VERSION}/dist/esm`;
    const ffmpegBase = `https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@${FFMPEG_VERSION}/dist/esm`;
    await ffmpeg.load({
      coreURL: await toBlobURL(`${coreBase}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${coreBase}/ffmpeg-core.wasm`, 'application/wasm'),
      // The worker script has to be fetched into a same-origin blob:
      // URL too — browsers won't spawn a Worker directly from a
      // cross-origin CDN URL.
      classWorkerURL: await toBlobURL(`${ffmpegBase}/worker.js`, 'text/javascript')
    });
    return ffmpeg;
  })();
  return _ffmpegPromise;
}

// Re-encodes video at a visually-lossless CRF (18 for H.264 — the
// point past which x264's own guidance says artifacts stop being
// perceptible; true mathematically-lossless is CRF 0 and produces
// *bigger* files, not smaller) instead of whatever bitrate a phone or
// screen recorder baked in, which is almost always far more than the
// content needs. Audio is re-encoded at a high, transparent bitrate
// rather than dropped. Skips anything too large to safely transcode
// in a browser tab or that hangs past a couple of minutes, and always
// falls back to the original file the instant anything goes wrong.
const VIDEO_COMPRESS_CRF = 18;
const VIDEO_COMPRESS_TIMEOUT_MS = 120000;
async function compressVideoFile(file) {
  if (file.size > 80 * 1024 * 1024) return file; // too large to safely transcode in-tab
  try {
    const [ffmpeg, { fetchFile }] = await Promise.all([
      loadFFmpeg(),
      import(`https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.2/dist/esm/index.js`)
    ]);
    const isWebm = file.type === 'video/webm';
    const inName = isWebm ? 'in.webm' : 'in.mp4';
    const outName = isWebm ? 'out.webm' : 'out.mp4';
    const codecArgs = isWebm
      ? ['-c:v', 'libvpx-vp9', '-crf', String(VIDEO_COMPRESS_CRF + 12), '-b:v', '0', '-c:a', 'libopus']
      : ['-c:v', 'libx264', '-crf', String(VIDEO_COMPRESS_CRF), '-preset', 'veryfast', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart'];

    await ffmpeg.writeFile(inName, await fetchFile(file));
    const run = ffmpeg.exec(['-i', inName, ...codecArgs, outName]);
    const timedOut = Symbol('timeout');
    const result = await Promise.race([
      run,
      new Promise(resolve => setTimeout(() => resolve(timedOut), VIDEO_COMPRESS_TIMEOUT_MS))
    ]);
    if (result === timedOut) {
      // Reset so the next attempt gets a fresh worker instead of one
      // still stuck mid-encode.
      try { ffmpeg.terminate(); } catch {}
      _ffmpegPromise = null;
      return file;
    }

    const data = await ffmpeg.readFile(outName);
    ffmpeg.deleteFile(inName).catch(() => {});
    ffmpeg.deleteFile(outName).catch(() => {});
    const blob = new Blob([data.buffer], { type: file.type });
    if (blob.size >= file.size) return file;
    return new File([blob], file.name, { type: file.type });
  } catch {
    return file;
  }
}

// Uploads a file to the media bucket and returns { media_url, media_type }.
// `onStatus(message)`, if given, is called with a short human-readable
// status as compression/upload progresses, for callers that want to
// reflect it in the UI (e.g. "Compressing video…").
async function uploadMedia(file, onStatus) {
  const notify = onStatus || (() => {});
  const type = mediaTypeFor(file);
  if (type === 'image') {
    if (file.type === 'image/gif') {
      notify('Optimizing GIF…');
      file = await compressGifFile(file);
    } else {
      notify('Compressing image…');
      file = await compressImageFile(file);
    }
  } else if (type === 'video') {
    notify('Compressing video…');
    file = await compressVideoFile(file);
  }
  notify('Uploading…');
  const ext = file.name.split('.').pop().toLowerCase();
  const path = `${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from(MEDIA_BUCKET).upload(path, file, {
    cacheControl: '3600',
    upsert: false,
    contentType: file.type
  });
  if (error) throw error;
  const { data } = sb.storage.from(MEDIA_BUCKET).getPublicUrl(path);
  return { media_url: data.publicUrl, media_type: type };
}

// `owner` is the full post/reply row this media belongs to (already
// carries its own .profile join) — stashed in _mediaRegistry so the
// lightbox can build its post-detail side panel / mobile action bar
// without a refetch. Passing null still opens the lightbox, just
// without that panel (e.g. contexts that don't have the full row).
function renderMedia(url, type, extraClass = '', owner = null) {
  if (!url) return '';
  const idx = registerLbMedia(url, type, owner);
  if (type === 'video') {
    return `<div class="pm">${ttvHtml(url)}</div>`;
  }
  return `<div class="pm"><img src="${esc(url)}" class="${extraClass}" alt="" onclick="openLightbox(${idx})" loading="lazy" decoding="async"></div>`;
}

// ─────────────────────────────────────────────────────────────
// MEDIA LIGHTBOX — full-screen photo/video viewer opened by
// clicking any post's media, matching X's "click a photo" modal:
// desktop docks the media next to a post-detail side panel, mobile
// goes edge-to-edge with a slim bottom action bar. Both images and
// videos support scroll-wheel/pinch/double-click zoom and
// drag-to-pan once zoomed in.
// ─────────────────────────────────────────────────────────────
const _lbRegistry = [];
function registerLbMedia(url, type, owner) {
  _lbRegistry.push({ url, type, owner });
  return _lbRegistry.length - 1;
}

// Videos get the full TTV player (see js/video-player.js) both in
// the feed and here in the lightbox, so there's no separate
// "clicking the video opens the lightbox" path anymore — the video
// itself is a complete player, same as tapping a video on X plays
// it in place rather than jumping to a detail view.

const lbState = { scale: 1, x: 0, y: 0, dragging: false, dragStartX: 0, dragStartY: 0, dragOrigX: 0, dragOrigY: 0, pointers: new Map(), pinchDist: 0 };
let lbGesturesWired = false;

function lbEl() {
  let el = document.getElementById('lb-bg');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'lb-bg';
  el.className = 'lb-bg';
  el.innerHTML = `
    <div class="lb-topbar">
      <button type="button" class="lb-icon-btn lb-close" onclick="closeLightbox()" aria-label="Close">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M5 5l14 14M19 5L5 19"/></svg>
      </button>
      <button type="button" class="lb-icon-btn lb-panel-toggle" id="lb-panel-toggle" onclick="toggleLbPanel()" aria-label="Toggle post details">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 6 6 6-6 6"/></svg>
      </button>
    </div>
    <div class="lb-body">
      <div class="lb-stage" id="lb-stage">
        <div class="lb-media-wrap" id="lb-media-wrap"></div>
      </div>
      <aside class="lb-sidebar" id="lb-sidebar"></aside>
    </div>
    <div class="lb-mobile-bar" id="lb-mobile-bar"></div>`;
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el || e.target.id === 'lb-stage') closeLightbox(); });
  wireLightboxGestures();
  return el;
}

function openLightbox(idx) {
  const item = _lbRegistry[idx];
  if (!item || !item.url) return;
  const el = lbEl();
  el.classList.remove('panel-collapsed');
  lbResetZoomState();
  const wrap = document.getElementById('lb-media-wrap');
  wrap.innerHTML = item.type === 'video'
    ? ttvHtml(item.url, { videoAttrs: 'autoplay' })
    : `<img src="${esc(item.url)}" alt="">`;
  renderLbSidebar(item.owner);
  renderLbMobileBar(item.owner);
  el.classList.add('open');
  lockScroll();
  document.addEventListener('keydown', lbKeyHandler);
}

function closeLightbox() {
  const el = document.getElementById('lb-bg');
  if (!el || !el.classList.contains('open')) return;
  document.getElementById('lb-media-wrap')?.querySelector('video')?.pause();
  el.classList.remove('open');
  unlockScroll();
  document.removeEventListener('keydown', lbKeyHandler);
  setTimeout(() => { document.getElementById('lb-media-wrap').innerHTML = ''; }, 0);
}

function toggleLbPanel() {
  document.getElementById('lb-bg')?.classList.toggle('panel-collapsed');
}

function lbKeyHandler(e) {
  if (e.key === 'Escape') closeLightbox();
  else if (e.key === '+' || e.key === '=') lbSetZoom(lbState.scale * 1.25, innerWidth / 2, innerHeight / 2);
  else if (e.key === '-') lbSetZoom(lbState.scale * 0.8, innerWidth / 2, innerHeight / 2);
  else if (e.key === '0') lbResetZoomState();
}

// A reply row carries post_id (which post it's replying under); a
// top-level post never does — same test thread.js relies on elsewhere.
function lbIsReply(owner) { return !!owner?.post_id; }

// Reply permalinks are "<post>#reply-<id>" (no dedicated URL of their
// own), and we may not know the OP's username from the reply row
// alone — postUrlById() falls back to the generic /i/status/ form,
// same one thread.js upgrades to the canonical address once loaded.
function lbOwnerHref(owner) {
  if (!owner) return '#';
  return lbIsReply(owner) ? `${postUrlById(owner.post_id)}#reply-${u_(owner.id)}` : postUrl(owner);
}

// Post-detail side panel (desktop) — a trimmed-down echo of thread.js's
// opBlockHtml(): same header/body/meta/action-row markup and CSS
// classes so it looks native to the app, minus the media (already
// filling the stage) and the reply thread (this is a quick preview,
// not the full conversation — "View full conversation" links out to it).
function renderLbSidebar(owner) {
  const sidebar = document.getElementById('lb-sidebar');
  const toggleBtn = document.getElementById('lb-panel-toggle');
  if (!sidebar) return;
  if (!owner) {
    sidebar.innerHTML = '';
    sidebar.hidden = true;
    if (toggleBtn) toggleBtn.hidden = true;
    return;
  }
  sidebar.hidden = false;
  if (toggleBtn) toggleBtn.hidden = false;
  const isReply = lbIsReply(owner);
  const href = lbOwnerHref(owner);
  const uname = owner.profile?.username || 'unknown';
  const actions = isReply
    ? postActionsHtml(owner, { replyOnclick: `location.href='${href}'`, bookmarkable: false, repostable: false, isReply: true })
    : opDetailActionsHtml(owner, `location.href='${href}'`);
  sidebar.innerHTML = `
    <div class="lb-sb-head">
      ${pcAvatarHtml(owner.profile)}
      <div class="op-detail-names">
        <span class="op-name-line"><a class="nm" href="${profileUrl(uname)}">${esc(owner.profile?.display_name || uname)}</a>${vBadge(owner.profile)}</span>
        <span class="pc-handle">@${esc(uname)}</span>
      </div>
      ${postMenuHtml(isReply ? owner.post_id : owner.id, isReply ? owner.id : null, owner.author_id, isReply ? null : owner.community_id, owner.created_at)}
    </div>
    <div class="op-detail-body" data-pb="${owner.id}">${renderBody(owner.body || '')}</div>
    <div class="op-detail-meta"><span data-dt="${owner.id}">${fullDateTime(owner.created_at)}${editedSuffix(owner)}</span> &middot; <b>${fmtCount(owner.view_count)}</b> Views</div>
    <div class="op-detail-divider"></div>
    ${actions}
    <div class="op-detail-divider"></div>
    <a class="lb-sb-replybox" href="${href}">
      <img class="avatar pfp-sm" src="${esc(avatarUrl(currentProfile?.avatar_url))}" alt="">
      <span>${t('compose.reply')}</span>
    </a>
    <a class="lb-sb-viewall" href="${href}">View full conversation &rsaquo;</a>`;
}

// Slim overlay action row for mobile — same compact .acts markup/
// classes the feed cards use (so like/repost/bookmark/share all
// actually work here too), just recolored for a dark background.
function renderLbMobileBar(owner) {
  const bar = document.getElementById('lb-mobile-bar');
  if (!bar) return;
  if (!owner) { bar.innerHTML = ''; bar.hidden = true; return; }
  bar.hidden = false;
  const isReply = lbIsReply(owner);
  bar.innerHTML = postActionsHtml(owner, { replyHref: lbOwnerHref(owner), bookmarkable: !isReply, repostable: !isReply, isReply });
}

// ── ZOOM / PAN ──
function lbApplyTransform() {
  const wrap = document.getElementById('lb-media-wrap');
  if (wrap) wrap.style.transform = `translate(${lbState.x}px,${lbState.y}px) scale(${lbState.scale})`;
}
function lbResetZoomState() {
  lbState.scale = 1; lbState.x = 0; lbState.y = 0;
  lbState.dragging = false; lbState.pointers.clear(); lbState.pinchDist = 0;
  lbApplyTransform();
  document.getElementById('lb-media-wrap')?.classList.remove('dragging');
}
function lbSetZoom(newScale, cx, cy) {
  const stage = document.getElementById('lb-stage');
  if (!stage) return;
  newScale = Math.min(4, Math.max(1, newScale));
  const rect = stage.getBoundingClientRect();
  const originX = cx - (rect.left + rect.width / 2);
  const originY = cy - (rect.top + rect.height / 2);
  const k = newScale / lbState.scale;
  lbState.x = originX - (originX - lbState.x) * k;
  lbState.y = originY - (originY - lbState.y) * k;
  lbState.scale = newScale;
  if (lbState.scale <= 1.001) { lbState.scale = 1; lbState.x = 0; lbState.y = 0; }
  lbApplyTransform();
}

// Wired once (the stage/wrap elements are built once by lbEl() and
// reused for every open — only the media inside lb-media-wrap is
// swapped per-open), covering: wheel-to-zoom, double-click-to-zoom,
// and pointer-based pan + pinch-zoom (one pointer pans once zoomed
// in, two pointers pinch-zoom from any zoom level, mouse or touch).
function wireLightboxGestures() {
  if (lbGesturesWired) return;
  lbGesturesWired = true;
  const stage = document.getElementById('lb-stage');
  const wrap = document.getElementById('lb-media-wrap');
  if (!stage || !wrap) return;

  stage.addEventListener('wheel', e => {
    if (!e.target.closest('img,video')) return;
    e.preventDefault();
    lbSetZoom(lbState.scale * Math.exp(-e.deltaY * 0.0015), e.clientX, e.clientY);
  }, { passive: false });

  stage.addEventListener('dblclick', e => {
    if (!e.target.closest('img,video')) return;
    if (lbState.scale > 1) lbResetZoomState();
    else lbSetZoom(2.5, e.clientX, e.clientY);
  });

  wrap.addEventListener('pointerdown', e => {
    if (!e.target.closest('img,video')) return;
    lbState.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    try { wrap.setPointerCapture(e.pointerId); } catch {}
    if (lbState.pointers.size === 2) {
      lbState.dragging = false;
      wrap.classList.remove('dragging');
      const pts = [...lbState.pointers.values()];
      lbState.pinchDist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
    } else if (lbState.scale > 1) {
      lbState.dragging = true;
      lbState.dragStartX = e.clientX; lbState.dragStartY = e.clientY;
      lbState.dragOrigX = lbState.x; lbState.dragOrigY = lbState.y;
      wrap.classList.add('dragging');
    }
  });

  wrap.addEventListener('pointermove', e => {
    if (!lbState.pointers.has(e.pointerId)) return;
    lbState.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (lbState.pointers.size === 2) {
      const pts = [...lbState.pointers.values()];
      const dist = Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y);
      const cx = (pts[0].x + pts[1].x) / 2, cy = (pts[0].y + pts[1].y) / 2;
      if (lbState.pinchDist) lbSetZoom(lbState.scale * (dist / lbState.pinchDist), cx, cy);
      lbState.pinchDist = dist;
    } else if (lbState.dragging) {
      lbState.x = lbState.dragOrigX + (e.clientX - lbState.dragStartX);
      lbState.y = lbState.dragOrigY + (e.clientY - lbState.dragStartY);
      lbApplyTransform();
    }
  });

  function releasePointer(e) {
    lbState.pointers.delete(e.pointerId);
    if (lbState.pointers.size < 2) lbState.pinchDist = 0;
    if (lbState.pointers.size === 0) { lbState.dragging = false; wrap.classList.remove('dragging'); }
  }
  wrap.addEventListener('pointerup', releasePointer);
  wrap.addEventListener('pointercancel', releasePointer);
  wrap.addEventListener('pointerleave', e => { if (lbState.pointers.size <= 1) releasePointer(e); });
}

// ─────────────────────────────────────────────────────────────
// POLLS — poll_options/poll_ends_at live on the posts row itself;
// individual votes live in public.poll_votes (one row per voter,
// unique per post). Rendering is async (a second query for the vote
// tally) so pollHtml() drops a placeholder in synchronously and
// fills it in a moment later — same trick used for lazy quote lists.
// ─────────────────────────────────────────────────────────────
function pollHtml(p) {
  if (!p.poll_options || !p.poll_options.length) return '';
  setTimeout(() => renderPollInto(p.id), 0);
  return `<div class="poll-box" id="poll-${p.id}" onclick="event.stopPropagation()"><span class="spinner">Loading&hellip;</span></div>`;
}

async function renderPollInto(postId) {
  const box = document.getElementById(`poll-${postId}`);
  const post = postCache[postId];
  if (!box || !post || !post.poll_options) return;
  let votes = [];
  try {
    const { data, error } = await sb.from('poll_votes').select('option_index,user_id').eq('post_id', postId);
    if (error) throw error;
    votes = data || [];
  } catch (e) {
    box.innerHTML = `<div class="no-t">Poll (run supabase/gifs_polls_scheduling.sql to enable voting).</div>`;
    return;
  }
  const ended = post.poll_ends_at && new Date(post.poll_ends_at) <= new Date();
  const counts = post.poll_options.map((_, i) => votes.filter(v => v.option_index === i).length);
  const total = counts.reduce((a, b) => a + b, 0);
  const myVote = currentSession ? votes.find(v => v.user_id === currentSession.user.id) : null;
  const locked = ended || !!myVote;
  box.innerHTML = post.poll_options.map((opt, i) => {
    const pct = total ? Math.round(counts[i] / total * 100) : 0;
    if (locked) {
      return `<div class="poll-opt-result${myVote && myVote.option_index === i ? ' mine' : ''}">` +
             `<div class="poll-opt-fill" style="width:${pct}%"></div>` +
             `<span class="poll-opt-label">${esc(opt)}</span><span class="poll-opt-pct">${pct}%</span></div>`;
    }
    return `<button type="button" class="poll-opt-btn" onclick="voteOnPoll('${postId}', ${i})">${esc(opt)}</button>`;
  }).join('') + `<div class="poll-meta">${fmtCount(total)} votes &middot; ${ended ? 'Final results' : pollTimeLeft(post.poll_ends_at)}</div>`;
}

function pollTimeLeft(endsAt) {
  if (!endsAt) return '';
  const ms = new Date(endsAt) - new Date();
  if (ms <= 0) return 'Final results';
  const h = Math.ceil(ms / 3600000);
  return h < 24 ? `${h}h left` : `${Math.ceil(h / 24)}d left`;
}

async function voteOnPoll(postId, optionIndex) {
  if (!requireLogin()) return;
  try {
    const { error } = await sb.from('poll_votes').insert({ post_id: postId, user_id: currentSession.user.id, option_index: optionIndex });
    if (error) throw error;
  } catch (e) {
    alert(e.message || 'Could not vote.');
    return;
  }
  renderPollInto(postId);
}

// ─────────────────────────────────────────────────────────────
// COMPOSER EXTRAS — GIFs (Giphy), emoji, polls, and scheduling,
// shared across every composer (main feed, the global compose
// modal, and the thread reply box) via a `prefix` naming
// convention: each composer's textarea is `${prefix}-body`, its
// file preview slot `${prefix}-fp`, its poll builder
// `${prefix}-poll-box`, its schedule picker `${prefix}-sched-box`.
// ─────────────────────────────────────────────────────────────
// GIF search/trending goes through /api/giphy (see that file) instead
// of calling api.giphy.com directly — keeps the GIPHY API key
// server-side only, never shipped in this JS bundle.
let composeExtras = {}; // { [prefix]: { gifUrl } }
let gifPickerTarget = null;

function gifModalEl() {
  let el = document.getElementById('gif-modal-bg');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'gif-modal-bg';
  el.className = 'modal-bg';
  el.addEventListener('click', e => { if (e.target === el) closeGifPicker(); });
  el.innerHTML = `
    <div class="modal gif-modal">
      <a class="modal-close" href="#" onclick="closeGifPicker();return false;">&#10005;</a>
      <h2>GIFs</h2>
      <div class="gif-search-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="text" id="gif-search-input" placeholder="Search GIPHY">
      </div>
      <div class="gif-grid" id="gif-grid"><span class="spinner">Loading&hellip;</span></div>
      <div class="gif-attrib">Powered by GIPHY</div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#gif-grid').addEventListener('click', e => {
    const btn = e.target.closest('.gif-item');
    if (btn) pickGif(btn.dataset.url);
  });
  const input = el.querySelector('#gif-search-input');
  let deb;
  input.addEventListener('input', () => {
    clearTimeout(deb);
    deb = setTimeout(() => searchGifs(input.value.trim()), 350);
  });
  return el;
}

function openGifPicker(prefix) {
  if (!requireLogin()) return;
  gifPickerTarget = prefix;
  const el = gifModalEl();
  if (el.classList.contains('open')) return;
  el.classList.add('open');
  lockScroll();
  const input = el.querySelector('#gif-search-input');
  input.value = '';
  setTimeout(() => input.focus(), 50);
  loadTrendingGifs();
}
function closeGifPicker() {
  const el = document.getElementById('gif-modal-bg');
  if (!el || !el.classList.contains('open')) return;
  el.classList.remove('open');
  unlockScroll();
}
async function loadTrendingGifs() {
  await fetchGifs(`/api/giphy?type=trending`);
}
async function searchGifs(q) {
  if (!q) { loadTrendingGifs(); return; }
  await fetchGifs(`/api/giphy?type=search&q=${encodeURIComponent(q)}`);
}
async function fetchGifs(url) {
  const grid = document.getElementById('gif-grid');
  if (!grid) return;
  grid.innerHTML = `<span class="spinner">Loading&hellip;</span>`;
  try {
    const res = await fetch(url);
    const json = await res.json();
    const items = json.data || [];
    if (!items.length) { grid.innerHTML = `<div class="no-t">No GIFs found.</div>`; return; }
    grid.innerHTML = items.map(g => {
      const thumb = g.images?.fixed_width?.url || g.images?.original?.url || '';
      const full = g.images?.original?.url || thumb;
      return `<button type="button" class="gif-item" data-url="${esc(full)}"><img src="${esc(thumb)}" alt="${esc(g.title || 'GIF')}" loading="lazy"></button>`;
    }).join('');
  } catch (e) {
    grid.innerHTML = `<div class="errmsg">Couldn't load GIFs. Check your connection.</div>`;
  }
}
function pickGif(url) {
  if (url && gifPickerTarget) setComposerGif(gifPickerTarget, url);
  closeGifPicker();
}
function setComposerGif(prefix, url) {
  if (!composeExtras[prefix]) composeExtras[prefix] = {};
  composeExtras[prefix].gifUrl = url;
  removePoll(prefix); // a post can carry media OR a poll, never both — same as X
  const fileEl = document.getElementById(`${prefix}-file`);
  if (fileEl) fileEl.value = '';
  const fp = document.getElementById(`${prefix}-fp`);
  if (fp) {
    fp.innerHTML = `<img src="${esc(url)}" alt="GIF"><br><span class="rm-f" id="${prefix}-gif-rm">remove GIF</span>`;
    document.getElementById(`${prefix}-gif-rm`).onclick = () => clearComposerGif(prefix);
  }
  if (prefix === 'pf' && typeof updatePostBtnState === 'function') updatePostBtnState();
  if (prefix === 'gc' && typeof updateGcBtnState === 'function') updateGcBtnState();
}
function clearComposerGif(prefix) {
  if (composeExtras[prefix]) composeExtras[prefix].gifUrl = null;
  const fp = document.getElementById(`${prefix}-fp`);
  if (fp) fp.innerHTML = '';
}
function clearComposerMedia(prefix) {
  clearComposerGif(prefix);
  const fileEl = document.getElementById(`${prefix}-file`);
  if (fileEl) fileEl.value = '';
  const fp = document.getElementById(`${prefix}-fp`);
  if (fp) fp.innerHTML = '';
}

// ── EMOJI ──
// Each entry is [emoji, search keywords]. Keywords are what the
// search box in the picker matches against (case-insensitive
// substring), so e.g. typing "laugh" finds 😂 and "fire" finds 🔥
// even though neither word appears in the emoji glyph itself.
const EMOJI_SET = [
  ['😀','grinning happy smile'], ['😁','beaming grin happy'], ['😂','joy laughing crying funny lol'],
  ['🤣','rofl laughing floor funny'], ['🙂','slight smile'], ['🙃','upside down silly'],
  ['😉','wink'], ['😊','blush smile happy'], ['😍','heart eyes love adore'],
  ['🥰','love hearts adore smiling'], ['😘','kiss love'], ['😋','yum tasty tongue'],
  ['😎','cool sunglasses'], ['🤩','star struck excited amazed'], ['🥳','party celebrate birthday'],
  ['😏','smirk sly'], ['😌','relieved content calm'], ['😴','sleep tired zzz'],
  ['🤤','drool hungry'], ['😪','sleepy tired'], ['🤔','think hmm thinking'],
  ['🫡','salute respect'], ['🤨','skeptical suspicious eyebrow'], ['😐','neutral meh'],
  ['😑','expressionless blank'], ['🙄','eyeroll annoyed whatever'], ['😬','grimace awkward cringe'],
  ['🤐','zip lips quiet secret'], ['😯','surprised shock'], ['😦','frown shock'],
  ['😧','anguish shock'], ['😮','wow surprised open mouth'], ['😲','astonished shock wow'],
  ['🥱','yawn bored tired'], ['😢','sad cry tear'], ['😭','sobbing crying sad bawling'],
  ['😤','frustrated huff angry steam'], ['😠','angry mad'], ['😡','rage angry mad furious'],
  ['🤬','swearing cursing angry furious'], ['🤯','mind blown shocked wow'], ['😳','flushed embarrassed shocked'],
  ['🥵','hot sweating heat'], ['🥶','cold freezing'], ['😱','scream fear shocked omg'],
  ['😨','fearful scared'], ['😰','anxious nervous sweat'], ['😥','sad relieved disappointed'],
  ['😓','sweat nervous tired'], ['🤗','hug welcoming'], ['🤭','giggle oops whoops'],
  ['🫢','gasp shock surprised'], ['🤫','shh quiet secret'], ['🤥','lying pinocchio liar'],
  ['😷','sick mask ill'], ['🤒','sick fever thermometer'], ['🤕','hurt injured bandage'],
  ['🤢','sick nauseous gross'], ['🤮','vomit sick gross throw up'], ['🥴','woozy dizzy drunk'],
  ['😵','dizzy dead knocked out'], ['😵‍💫','dizzy confused spinning'], ['🤠','cowboy hat'],
  ['🥸','disguise incognito glasses'], ['😈','devil mischievous evil'], ['👿','angry devil evil'],
  ['💀','skull dead lol'], ['☠️','skull crossbones danger dead'], ['👻','ghost spooky'],
  ['👽','alien ufo'], ['🤖','robot bot'], ['🎃','pumpkin halloween'],
  ['💩','poop crap'], ['🤡','clown joke'], ['👍','thumbs up yes good agree'],
  ['👎','thumbs down no bad disagree'], ['👌','ok okay perfect'], ['🤌','chefs kiss italian pinch'],
  ['✌️','peace victory'], ['🤞','fingers crossed hope luck'], ['🫰','finger heart'],
  ['🤟','love you rock'], ['🤘','rock horns metal'], ['👊','fist bump punch'],
  ['✊','fist power'], ['👏','clap applause'], ['🙌','praise hands up celebrate'],
  ['🫶','heart hands love'], ['🙏','pray please thanks'], ['🤝','handshake deal agree'],
  ['💪','muscle strong flex gym'], ['👀','eyes looking watching sus'], ['👋','wave hi hello bye'],
  ['🤙','call me shaka hang loose'], ['✋','stop hand high five'], ['🖐️','hand five'],
  ['🤦','facepalm annoyed'], ['🤷','shrug idk dunno whatever'], ['💃','dance party'],
  ['🕺','dance party'], ['❤️','love heart red'], ['🧡','heart orange'],
  ['💛','heart yellow'], ['💚','heart green'], ['💙','heart blue'],
  ['💜','heart purple'], ['🖤','heart black'], ['🤍','heart white'],
  ['🤎','heart brown'], ['💔','broken heart heartbreak sad'], ['❤️‍🔥','heart fire passion love'],
  ['💕','hearts love cute'], ['💞','hearts revolving love'], ['💓','heartbeat love'],
  ['💗','growing heart love'], ['💖','sparkling heart love'], ['💘','cupid heart arrow love'],
  ['💝','heart gift love'], ['💯','hundred perfect score'], ['🔥','fire lit hot amazing'],
  ['✨','sparkle shiny magic'], ['⭐','star'], ['🌟','glowing star special'],
  ['💫','dizzy star sparkle'], ['⚡','lightning bolt energy fast'], ['☀️','sun sunny weather'],
  ['🌙','moon night'], ['🌈','rainbow pride'], ['☁️','cloud weather'],
  ['🎉','party celebrate confetti'], ['🎊','confetti party celebrate'], ['🎈','balloon party'],
  ['🎁','gift present'], ['🏆','trophy win winner champion'], ['🥇','gold medal first winner'],
  ['🎮','gaming controller games'], ['🕹️','joystick arcade games'], ['🎧','headphones music'],
  ['🎵','music note'], ['🎶','music notes'], ['📱','phone mobile'],
  ['💻','laptop computer'], ['📷','camera photo'], ['🔔','bell notification alert'],
  ['💡','idea lightbulb'], ['🧠','brain smart mind'], ['👑','crown king queen royalty'],
  ['💎','gem diamond blue precious'], ['🎯','target bullseye goal'], ['🍕','pizza food'],
  ['🍔','burger food'], ['🍜','ramen noodles food'], ['🍣','sushi food'],
  ['🍩','donut sweet food'], ['🍰','cake dessert birthday'], ['☕','coffee drink caffeine'],
  ['🍺','beer drink'], ['🍷','wine drink'], ['🐶','dog puppy'],
  ['🐱','cat kitty'], ['🐼','panda cute'], ['🦋','butterfly'],
  ['🌸','cherry blossom flower spring'], ['🌹','rose flower love'], ['🍀','clover luck lucky'],
];
let emojiPickerTarget = null;
function renderEmojiGrid(filter) {
  const grid = document.getElementById('emoji-grid');
  if (!grid) return;
  const q = (filter || '').trim().toLowerCase();
  const matches = q
    ? EMOJI_SET.filter(([e, k]) => k.includes(q) || e === filter)
    : EMOJI_SET;
  grid.innerHTML = matches.length
    ? matches.map(([e]) => `<button type="button" class="cx-emoji-item" data-e="${e}">${e}</button>`).join('')
    : `<div class="cx-emoji-empty">No emoji found</div>`;
}
function toggleEmojiPicker(prefix, anchorBtn) {
  if (!requireLogin()) return;
  let pop = document.getElementById('emoji-pop');
  if (pop && emojiPickerTarget === prefix && !pop.hidden) { pop.hidden = true; return; }
  if (!pop) {
    pop = document.createElement('div');
    pop.id = 'emoji-pop';
    pop.className = 'cx-emoji-pop';
    pop.hidden = true;
    pop.innerHTML = `
      <input type="text" class="cx-emoji-search" id="emoji-search" placeholder="Search emoji" autocomplete="off">
      <div class="cx-emoji-grid" id="emoji-grid"></div>`;
    document.body.appendChild(pop);
    renderEmojiGrid('');
    pop.querySelector('#emoji-search').addEventListener('input', e => renderEmojiGrid(e.target.value));
    pop.addEventListener('click', e => {
      const btn = e.target.closest('.cx-emoji-item');
      if (!btn || !emojiPickerTarget) return;
      insertAtCursor(document.getElementById(`${emojiPickerTarget}-body`), btn.dataset.e);
    });
    document.addEventListener('click', e => {
      if (pop.hidden || e.target.closest('.cx-emoji-pop') || e.target.closest('[title="Emoji"]')) return;
      pop.hidden = true;
    });
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape' && !pop.hidden) pop.hidden = true;
    });
  }
  emojiPickerTarget = prefix;
  const search = pop.querySelector('#emoji-search');
  search.value = '';
  renderEmojiGrid('');
  const r = anchorBtn.getBoundingClientRect();
  pop.style.top = `${r.bottom + window.scrollY + 6}px`;
  pop.style.left = `${Math.max(8, r.left + window.scrollX - 100)}px`;
  pop.hidden = false;
  setTimeout(() => search.focus(), 30);
}
function insertAtCursor(el, text) {
  if (!el) return;
  const start = el.selectionStart ?? el.value.length;
  const end = el.selectionEnd ?? el.value.length;
  el.value = el.value.slice(0, start) + text + el.value.slice(end);
  const pos = start + text.length;
  el.focus();
  el.setSelectionRange(pos, pos);
  el.dispatchEvent(new Event('input', { bubbles: true }));
}

// ── POLL BUILDER ──
function togglePollBuilder(prefix) {
  if (!requireLogin()) return;
  const box = document.getElementById(`${prefix}-poll-box`);
  if (!box) return;
  if (box.hidden) {
    clearComposerMedia(prefix); // poll & media/GIF are mutually exclusive — same as X
    box.hidden = false;
    box.querySelector('.cx-poll-opt')?.focus();
  } else {
    removePoll(prefix);
  }
}
function addPollOption(prefix) {
  const wrap = document.getElementById(`${prefix}-poll-opts`);
  if (!wrap || wrap.querySelectorAll('.cx-poll-opt').length >= 4) return;
  const n = wrap.querySelectorAll('.cx-poll-opt').length;
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'cx-poll-opt'; inp.maxLength = 25;
  inp.placeholder = `Choice ${n + 1}`;
  wrap.appendChild(inp);
  inp.focus();
}
function removePoll(prefix) {
  if (composeExtras[prefix]) composeExtras[prefix].poll = null;
  const box = document.getElementById(`${prefix}-poll-box`);
  if (!box) return;
  box.hidden = true;
  box.querySelectorAll('.cx-poll-opt').forEach((o, i) => { if (i > 1) o.remove(); else o.value = ''; });
  const dur = document.getElementById(`${prefix}-poll-dur`);
  if (dur) dur.value = '3';
}
function collectPoll(prefix) {
  const box = document.getElementById(`${prefix}-poll-box`);
  if (!box || box.hidden) return null;
  const opts = Array.from(box.querySelectorAll('.cx-poll-opt')).map(i => i.value.trim()).filter(Boolean);
  if (opts.length < 2) return null;
  const days = Number(document.getElementById(`${prefix}-poll-dur`)?.value || 1);
  return { poll_options: opts, poll_ends_at: new Date(Date.now() + days * 86400000).toISOString() };
}

// ── SCHEDULE PICKER ──
// Twitter/X caps scheduled posts at 1 year out; we cap this one further
// out at 4 years, per product decision. Computed via setFullYear (not
// a fixed millisecond offset) so it lands on the same calendar date 4
// years from now regardless of leap years.
function maxScheduleDate() {
  const d = new Date();
  d.setFullYear(d.getFullYear() + 4);
  return d;
}
function toggleScheduleBuilder(prefix) {
  if (!requireLogin()) return;
  const box = document.getElementById(`${prefix}-sched-box`);
  if (!box) return;
  if (box.hidden) {
    box.hidden = false;
    const input = document.getElementById(`${prefix}-sched-input`);
    if (input) {
      input.max = toLocalDatetimeValue(maxScheduleDate());
      if (!input.value) input.value = toLocalDatetimeValue(new Date(Date.now() + 30 * 60000));
    }
    input?.focus();
  } else {
    removeSchedule(prefix);
  }
}
function removeSchedule(prefix) {
  const box = document.getElementById(`${prefix}-sched-box`);
  if (box) box.hidden = true;
  const input = document.getElementById(`${prefix}-sched-input`);
  if (input) input.value = '';
}
function toLocalDatetimeValue(d) {
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function collectSchedule(prefix) {
  const box = document.getElementById(`${prefix}-sched-box`);
  if (!box || box.hidden) return null;
  const input = document.getElementById(`${prefix}-sched-input`);
  const d = input?.value ? new Date(input.value) : null;
  if (!d || isNaN(d.getTime()) || d.getTime() <= Date.now() || d.getTime() > maxScheduleDate().getTime()) return null;
  return d.toISOString();
}
function validatePollAndSchedule(prefix, errEl) {
  const pollBox = document.getElementById(`${prefix}-poll-box`);
  if (pollBox && !pollBox.hidden) {
    const opts = Array.from(pollBox.querySelectorAll('.cx-poll-opt')).map(i => i.value.trim()).filter(Boolean);
    if (opts.length < 2) { showErr(errEl, 'Add at least 2 poll options.'); return false; }
  }
  const schedBox = document.getElementById(`${prefix}-sched-box`);
  if (schedBox && !schedBox.hidden) {
    const input = document.getElementById(`${prefix}-sched-input`);
    const d = input?.value ? new Date(input.value) : null;
    if (!d || isNaN(d.getTime()) || d.getTime() <= Date.now()) { showErr(errEl, 'Pick a future date/time to schedule this post.'); return false; }
    if (d.getTime() > maxScheduleDate().getTime()) { showErr(errEl, 'You can schedule a post at most 4 years ahead.'); return false; }
  }
  return true;
}
function resetComposeExtras(prefix) {
  composeExtras[prefix] = { gifUrl: null };
  removePoll(prefix);
  removeSchedule(prefix);
  resetReplyAudience(prefix);
}

// ── FILE PREVIEW WIDGET ──
function wireFilePreview(inputId, previewId, errElId) {
  const input = document.getElementById(inputId);
  const preview = document.getElementById(previewId);
  const prefix = inputId.replace(/-file$/, '');
  input.addEventListener('change', () => {
    preview.innerHTML = '';
    const file = input.files[0];
    if (!file) return;
    const errEl = errElId ? document.getElementById(errElId) : null;
    if (!validateFile(file, errEl)) { input.value = ''; return; }
    clearErr(errEl);
    if (composeExtras[prefix]) composeExtras[prefix].gifUrl = null; // file + GIF are mutually exclusive
    removePoll(prefix); // media & poll are mutually exclusive
    const url = URL.createObjectURL(file);
    const type = mediaTypeFor(file);
    const el = type === 'video'
      ? Object.assign(document.createElement('video'), { src: url, controls: true })
      : Object.assign(document.createElement('img'), { src: url });
    preview.appendChild(el);
    const rm = document.createElement('span');
    rm.className = 'rm-f';
    rm.textContent = 'remove file';
    rm.onclick = () => { input.value = ''; preview.innerHTML = ''; };
    preview.appendChild(document.createElement('br'));
    preview.appendChild(rm);
  });
}

// Renders a compact row for a "follower/following list" modal —
// shared by profile.js. `profile` is a row from public.profiles.
function userRowHtml(profile) {
  const uname = profile?.username || 'unknown';
  return `
  <a class="ulrow" href="${profileUrl(uname)}">
    <img class="avatar pfp-md" src="${esc(avatarUrl(profile?.avatar_url))}" alt="" loading="lazy" decoding="async">
    <div class="ulrow-txt">
      <span class="ulrow-name">${esc(profile?.display_name || uname)}${vBadge(profile)}</span>
      <span class="ulrow-handle">@${esc(uname)}</span>
    </div>
  </a>`;
}

// ── TOAST — small, non-blocking confirmation popup (bottom-center),
// used for routine "did the thing" feedback (muted, blocked, link
// copied, report sent, etc.) so those don't have to interrupt the
// person with a native alert() box. Auto-dismisses on its own; a new
// toast simply replaces whatever's currently showing.
let _toastTimer = null;
function toastEl() {
  let el = document.getElementById('oc-toast');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'oc-toast';
  el.className = 'oc-toast';
  document.body.appendChild(el);
  return el;
}
function toast(message, type = 'default') {
  const el = toastEl();
  el.innerHTML = `${type === 'error' ? ICON_TOAST_ERR : ICON_TOAST_OK}<span>${esc(message)}</span>`;
  el.className = `oc-toast oc-toast-${type} show`;
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 3400);
}
const ICON_TOAST_OK  = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="m8 12.5 2.5 2.5L16 9.5"/></svg>';
const ICON_TOAST_ERR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M12 8v5"/><circle cx="12" cy="16" r="0.8" fill="currentColor" stroke="none"/></svg>';

// ── CONFIRM MODAL — a generic, promise-based replacement for
// window.confirm() styled to match the rest of the app (same shape as
// the delete-post confirmation modal). await ocConfirm({...}) resolves
// true/false depending which button was pressed.
let _ocConfirmResolve = null;
function ocConfirmEl() {
  let el = document.getElementById('oc-confirm-bg');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'oc-confirm-bg';
  el.className = 'modal-bg';
  el.addEventListener('click', e => { if (e.target === el) resolveOcConfirm(false); });
  el.innerHTML = `
    <div class="modal dc-modal">
      <h2 class="dc-title" id="oc-confirm-title"></h2>
      <p class="dc-desc" id="oc-confirm-desc"></p>
      <div class="dc-actions">
        <button type="button" class="dc-btn" id="oc-confirm-btn"></button>
        <button type="button" class="dc-btn dc-btn-cancel" onclick="resolveOcConfirm(false)">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && el.classList.contains('open')) resolveOcConfirm(false); });
  return el;
}
function ocConfirm({ title = 'Are you sure?', desc = '', confirmLabel = 'Confirm', danger = true } = {}) {
  const el = ocConfirmEl();
  document.getElementById('oc-confirm-title').textContent = title;
  document.getElementById('oc-confirm-desc').textContent = desc;
  const btn = document.getElementById('oc-confirm-btn');
  btn.textContent = confirmLabel;
  btn.className = `dc-btn ${danger ? 'dc-btn-delete' : 'dc-btn-primary'}`;
  btn.onclick = () => resolveOcConfirm(true);
  el.classList.add('open');
  lockScroll();
  return new Promise(resolve => { _ocConfirmResolve = resolve; });
}
function resolveOcConfirm(result) {
  const el = document.getElementById('oc-confirm-bg');
  if (el?.classList.contains('open')) { el.classList.remove('open'); unlockScroll(); }
  if (_ocConfirmResolve) { _ocConfirmResolve(result); _ocConfirmResolve = null; }
}

// ── REPORT MODAL (shared across board + thread pages) ──
let reportTarget = null; // { postId, replyId } or { userId }

function openReport(postId, replyId = null) {
  if (typeof requireLogin === 'function' && !requireLogin()) return;
  reportTarget = { postId, replyId };
  document.getElementById('modal-report').classList.add('open');
}
// Reports a profile itself (the "···" menu on a profile page), rather
// than one specific post/reply of theirs.
function openReportUser(userId) {
  if (typeof requireLogin === 'function' && !requireLogin()) return;
  reportTarget = { userId };
  document.getElementById('modal-report').classList.add('open');
}
function closeReport() {
  document.getElementById('modal-report').classList.remove('open');
  reportTarget = null;
}
// ── BUTTON PRESS BOUNCE — delegated so it also covers buttons the app
// renders later (post actions, follow buttons, modals, etc.), not just
// the ones present at page load. Re-triggers the .oc-bounce keyframe
// (defined in style.css) on every press of a button-like control OR
// a real link — nav items, the logo, back arrows, modal-close, trend
// cards, author names, etc. all get the same bounce now, since on
// mobile those are just as much "buttons" to the person tapping them.
// Excluded: the inline @mention/#hashtag/URL links linkifyText() puts
// inside post bodies (.body-link/.body-mention/.body-hashtag) — those
// read as plain text, not controls, so they keep the tap-highlight
// fix from style.css without the scale bounce. Whole-card click-through
// wrappers (.pc, .rc, .qp-embed, the mobile drawer backdrop, etc.) are
// plain <div>s, so this selector naturally skips them too — bouncing
// an entire feed card would look broken, not tactile. ──
// .logo/.m-logo (the site logo, top of the sidebar / mobile topbar) are
// excluded: they're plain <a href="/"> links with no client-side routing,
// so a tap triggers a real full-page reload. That reload interrupts the
// .22s scale animation mid-flight, which reads as the logo jumping off
// position for a frame before the new page loads. Since the animation can
// never finish on those links anyway, skip it rather than let it glitch.
const OC_BOUNCE_SELECTOR = 'button, [role="button"], .accent-swatch, input[type="submit"], input[type="button"], img[onclick], a[href]:not(.body-link):not(.body-mention):not(.body-hashtag):not(.logo):not(.m-logo)';
document.addEventListener('click', (e) => {
  const el = e.target.closest(OC_BOUNCE_SELECTOR);
  if (!el || el.disabled) return;
  el.classList.remove('oc-bounce');
  // Force reflow so re-adding the class restarts the animation on rapid repeat clicks.
  void el.offsetWidth;
  el.classList.add('oc-bounce');
});
document.addEventListener('animationend', (e) => {
  if (e.animationName === 'oc-btn-bounce') e.target.classList.remove('oc-bounce');
});

async function submitReport() {
  if (!reportTarget) return;
  const reason = document.getElementById('report-reason').value;
  const details = document.getElementById('report-details').value.trim().slice(0, 500);
  try {
    await sb.from('reports').insert({
      post_id: reportTarget.postId || null,
      reply_id: reportTarget.replyId || null,
      reported_user_id: reportTarget.userId || null,
      reporter_id: currentSession?.user?.id,
      reason,
      details
    });
    closeReport();
    toast(t('toast.reportSubmitted'));
  } catch (e) {
    toast('Could not submit report: ' + e.message, 'error');
  }
}
