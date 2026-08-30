// ─────────────────────────────────────────────────────────────
// COMMON HELPERS — shared by board.js and thread.js
// ─────────────────────────────────────────────────────────────

// ── Shared PostgREST select strings ──
// Declared ONCE here (common.js only ever loads once per tab — see
// pjax.js's loadedScripts dedup) rather than in each page bundle that
// uses it. board.js, community.js, list.js, profile.js, search.js and
// thread.js used to each declare their own `const POST_SELECT = ...`
// (profile.js/thread.js also each had their own `const REPLY_SELECT`).
// Because pjax keeps every page bundle's script alive in the same JS
// realm for the life of the tab instead of tearing it down between
// navigations, loading a second page bundle that redeclared the same
// top-level `const` threw "Identifier 'POST_SELECT' has already been
// declared" the instant it was parsed — which silently kills that
// ENTIRE script (nothing in it runs, not even its DOMContentLoaded
// listener), so the destination page's loader never ran and its
// skeleton placeholder just sat there forever. Only a hard reload
// (a fresh JS realm with no prior declarations) ever cleared it. E.g.
// visiting the home feed then tapping into a profile — or any other
// pair of pages from that list of six — reproduced this every time.
const POST_SELECT = '*, profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified,verification_type)';
const REPLY_SELECT = '*, profile:profiles(username,display_name,avatar_url,verified,verification_type)';

// ── SPECULATIVE PRERENDERING — this is a plain multi-page app (every
// internal link is a real full navigation, no SPA router), so the
// single biggest lever for making clicks feel instant is starting the
// next page's load before the click even happens. The Speculation
// Rules API tells supporting browsers (Chrome/Edge 121+) to prerender
// same-origin links the moment the user hovers/touches them — by the
// time the click registers, the destination is often already fully
// rendered in a hidden background tab, so navigation is a swap, not a
// load. Unsupported browsers just ignore the tag and get normal
// navigation, so this is pure upside. Kept to "moderate" eagerness
// (hover/touchstart, not viewport-wide) to avoid over-fetching, and
// explicitly excludes logout/destructive/auth links, external hosts,
// and anything with a query string (?u=, ?id=, etc. legacy links can
// carry side-effecting params we don't want speculatively loaded).
(function initSpeculationRules() {
  try {
    if (!HTMLScriptElement.supports || !HTMLScriptElement.supports('speculationrules')) return;
    const script = document.createElement('script');
    script.type = 'speculationrules';
    script.textContent = JSON.stringify({
      prerender: [{
        where: {
          and: [
            { href_matches: '/*' },
            { not: { href_matches: '/*\\?*' } },
            { not: { href_matches: '/logout*' } },
            { not: { href_matches: 'mailto:*' } },
            { not: { href_matches: 'tel:*' } },
            { not: { selector_matches: '[data-no-prerender], [download], [target=_blank]' } },
          ],
        },
        eagerness: 'moderate',
      }],
    });
    document.head.appendChild(script);
  } catch (e) { /* progressive enhancement only — never let this block the page */ }
})();

// ── PRERENDER-ACTIVATION REPAINT FIX — the speculation-rules prerender
// above (and, separately, the browser's own back/forward cache) can
// finish a page's full layout while it's sitting in a hidden
// background tab. On some Chrome/WebView builds, elements that combine
// `backdrop-filter` with `position:sticky` or `position:fixed` — here
// that's #board-hdr (home's "For you/Following" bar), .sec-bar and
// .search-topbar (their equivalents elsewhere), and #m-topbar (the
// mobile hamburger/logo bar, injected by renderMobileChrome() below)
// — get composited into a layer while hidden that never gets
// re-painted once the tab is swapped to the front, so they show up as
// a blank gap where the bar should be until something else forces a
// repaint (a scroll, a resize, DevTools open/close). Since it's the
// *contents* of the compositing layer that are stale, not the
// element's box (it still takes up its normal space — hence the gap,
// not a collapse), a class toggle that briefly takes the element out
// of layout and back in forces the browser to recompute that layer
// from scratch. Wired to every event that can plausibly be the first
// paint after a hidden-tab activation: 'prerenderingchange' (fires
// the instant a prerendered page is swapped in), 'pageshow' with
// event.persisted (bfcache restore — doesn't fire a fresh
// DOMContentLoaded, so nothing above would otherwise re-run), and
// 'visibilitychange' (belt-and-suspenders for browsers that support
// neither of the above signals cleanly).
function repaintStickyChrome() {
  ['board-hdr', 'm-topbar', 'm-tabbar', 'm-fab'].forEach(id => {
    const el = document.getElementById(id);
    if (!el) return;
    el.style.display = 'none';
    void el.offsetHeight; // force the browser to actually drop the old layer here
    el.style.display = '';
  });
  document.querySelectorAll('.sec-bar, .search-topbar').forEach(el => {
    el.style.display = 'none';
    void el.offsetHeight;
    el.style.display = '';
  });
}

// ── WHOLE-PAGE BACKGROUND-RESUME RECOVERY — the stale-compositing-
// layer bug above turns out not to be limited to the sticky bars the
// original fix (repaintStickyChrome) targets. Tapping a mailto:/tel:
// link hands off to another app (Gmail, Phone) without a real
// navigation, so the tab is simply backgrounded/suspended and later
// resumed rather than reloaded — and on return we've seen it also
// leave `transform`-positioned elements with a stale/blank paint
// (the centered logo `<img>` in #m-topbar, which is placed with
// `transform:translate(-50%,-50%)`) and, separately, text inside a
// `:active`/`transition`-bearing control frozen mid-transition-state
// (the "Email us" button on the Contact page: the tap's touchend/
// mouseup never fires because the OS intercepted the gesture to open
// the mail app chooser, so the browser can come back with the
// button's own transition still "stuck" partway). Both are symptoms
// of the same underlying cause — a compositing layer computed while
// hidden that the browser never re-derives once the tab is visible
// again — so rather than hand-picking every element that can be
// affected, force one reflow of the *entire* page on the same
// resume signals repaintStickyChrome already listens for. Toggling
// display on <body> itself (not visibility/opacity, which wouldn't
// drop the stale layers) is cheap, invisible to the user (synchronous,
// no animation to interrupt), and catches any affected element
// without needing to keep growing an ID whitelist.
function recoverFromBackgroundResume() {
  repaintStickyChrome();
  const b = document.body;
  b.style.display = 'none';
  void b.offsetHeight;
  b.style.display = '';
  // Belt-and-suspenders on top of the body-level toggle above: anchor
  // buttons styled with .auth-submit (e.g. the Contact page's "Email
  // us" link) are the control most consistently seen losing their
  // label after a mailto:/tel: handoff, so give them their own
  // explicit reflow too rather than relying solely on the body toggle
  // to cascade down to them.
  //
  // BUG THIS USED TO HAVE: setting `el.style.display = ''` doesn't
  // restore the element's previous inline display — it *deletes* the
  // display property from the inline style entirely. The Contact
  // page's "Email us" link only looks like a button because of an
  // inline `style="display:inline-block;..."` on the <a> itself (the
  // .auth-submit class never declares `display`, since it's shared
  // with <input type="submit"> elsewhere that don't need it). So this
  // "fix" was wiping that inline-block out on every resume, leaving
  // the anchor as a plain inline element — which ignores width/
  // max-width/padding the same way, i.e. it visually collapses. That
  // is exactly the bug this function exists to prevent. Capturing and
  // restoring the actual previous value (instead of blanking it)
  // fixes that, and .auth-submit now also carries its own
  // `display:inline-block` in CSS as a second safety net in case any
  // element using this class has no inline display of its own.
  document.querySelectorAll('.auth-submit').forEach(el => {
    const prevDisplay = el.style.display;
    el.style.display = 'none';
    void el.offsetHeight;
    el.style.display = prevDisplay;
  });
  // Some Chrome/WebView builds drop the in-flight network request for
  // an <img> outright when the tab is backgrounded rather than just
  // stale-painting it — that shows up as a genuinely broken image
  // (naturalWidth 0 after `complete`), which a plain repaint can't
  // fix since there's no decoded frame to recomposite. Re-assigning
  // the same src forces a fresh fetch for exactly those images (any
  // image that loaded fine is left alone).
  document.querySelectorAll('img').forEach(img => {
    if (img.complete && img.naturalWidth === 0 && img.src) {
      const src = img.src;
      img.src = '';
      img.src = src;
    }
  });
}
if ('prerendering' in document) {
  document.addEventListener('prerenderingchange', recoverFromBackgroundResume, { once: true });
}
// Note: we no longer gate this on event.persisted — on some Android
// Custom Tab / WebView builds, resuming from a backgrounded mailto:/
// tel: handoff fires a plain (non-persisted) pageshow rather than a
// bfcache restore, so gating on persisted silently skipped the exact
// case this function exists for. The repaint work is cheap, so
// running it unconditionally on every pageshow is harmless.
window.addEventListener('pageshow', recoverFromBackgroundResume);
// 'focus' on window is a second, independent signal for the same
// "we just came back from another app" moment (some builds fire this
// reliably even when neither pageshow nor visibilitychange do after a
// mailto:/tel: handoff), and blurring whatever element still thinks
// it's mid-touch clears any stuck :active/transition state left over
// from the interrupted touchend (e.g. the Contact page's email
// button).
window.addEventListener('focus', () => {
  if (document.activeElement && document.activeElement !== document.body) {
    document.activeElement.blur();
  }
  recoverFromBackgroundResume();
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') recoverFromBackgroundResume(); });
// Belt-and-suspenders for a plain, ordinary navigation (not a
// prerender activation or bfcache restore) into a page whose
// backdrop-filter + position:fixed bars (#m-topbar/#m-tabbar/#m-fab,
// #board-hdr, .sec-bar) paint stale on first frame — seen on some
// in-app WebViews (Instagram/Facebook/TikTok/Line's built-in browser)
// where the native cross-document view transition below finishes
// compositing the incoming page's fixed chrome as a leftover
// translucent layer instead of the real, current content. Cheap and
// idempotent, so running it unconditionally shortly after every load
// costs nothing on browsers that never had the bug.
document.addEventListener('DOMContentLoaded', () => { requestAnimationFrame(() => requestAnimationFrame(repaintStickyChrome)); });

// ── IN-APP BROWSER VIEW-TRANSITION GUARD — Instagram/Facebook/TikTok/
// Line/WeChat's built-in in-app browsers are Chromium-based (so they
// report native cross-document View Transition support, same as the
// 'onpageswap' in window check wirePageLeaveFade() uses below) but a
// number of them mis-composite `backdrop-filter` + `position:fixed`
// elements while the transition runs — the incoming page's #m-topbar
// (hamburger/logo bar) and whatever composer UI was on the outgoing
// page get left behind as a stuck, semi-transparent ghost layer on
// top of the real, fully-loaded page underneath, instead of cleanly
// resolving. Skipping the native transition specifically for these
// UAs avoids the glitch entirely; wirePageLeaveFade()'s simple JS
// fade (opacity, no fixed-position bars involved) is used instead. */
const IN_APP_BROWSER_UA = /Instagram|FBAN|FBAV|Line\/|MicroMessenger|TikTok|BytedanceWebview|Snapchat/i.test(navigator.userAgent || '');
if (IN_APP_BROWSER_UA) {
  window.addEventListener('pagereveal', (e) => { e.viewTransition?.skipTransition(); });
}

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
// Guarded against pjax.js's synthetic DOMContentLoaded re-dispatch (see
// its navigate()): this listener lives on `document` itself, which
// pjax never replaces, so without this flag every soft navigation was
// stacking another pair of document-level pointerover/touchstart
// listeners on top of the last — after browsing N pages, hovering a
// single link fired prefetchHref() N times.
let _linkPrefetchWired = false;
function wireLinkPrefetch() {
  if (_linkPrefetchWired) return;
  _linkPrefetchWired = true;
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
// Same document-level-listener leak as wireLinkPrefetch above: guard
// against pjax's synthetic DOMContentLoaded re-running this on every
// soft navigation, which would otherwise attach another 'click'
// listener each time and fire the fade (and the eventual
// `location.href` reassignment) once per stacked copy on every click.
let _pageLeaveFadeWired = false;
function wirePageLeaveFade() {
  if (_pageLeaveFadeWired) return;
  // Native support is skipped outright for IN_APP_BROWSER_UA above (see
  // the pagereveal listener), so those UAs need this plain fade too —
  // 'onpageswap' in window alone isn't a safe signal for them.
  if ('onpageswap' in window && !IN_APP_BROWSER_UA) return;
  _pageLeaveFadeWired = true;
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
function lockScroll() { _scrollLockCount++; document.documentElement.style.overflow = 'hidden'; document.body.style.overflow = 'hidden'; }
function unlockScroll() { _scrollLockCount = Math.max(0, _scrollLockCount - 1); if (_scrollLockCount === 0) { document.documentElement.style.overflow = ''; document.body.style.overflow = ''; } }
// Safety net: every opener above is supposed to keep lock/unlock calls
// balanced, but a missed guard (a double-tap firing the same opener
// twice, an interrupted flow, etc.) only has to slip once to leave
// _scrollLockCount stuck above 0 — and once that happens the page is
// unscrollable until a hard reload, on both desktop and mobile, with
// no visible open modal to explain it. Since no modal legitimately
// stays open across a fresh page load or a bfcache restore, force the
// counter and the lock back to a clean state on both.
//
// Two OTHER scroll-lock mechanisms exist outside this counter —
// html.oc-drawer-open (mobile hamburger drawer, see openMobileDrawer()/
// closeMobileDrawer() above) and body.oc-sheet-open (mobile repost
// sheet / new-chat sheet) — each also sets CSS overflow:hidden while
// its own UI is open. Same failure mode applies: leave with the
// drawer/sheet open (a link inside it navigating away without calling
// its close function first, or a bfcache snapshot taken mid-open) and
// the *next* page load or restore can inherit an overflow:hidden lock
// with no visible drawer/sheet on screen to explain it. Nothing
// legitimately stays open across a fresh load or bfcache restore, so
// clear all three locks together in one place.
function _resetScrollLock() {
  _scrollLockCount = 0;
  document.documentElement.style.overflow = '';
  document.body.style.overflow = '';
  document.documentElement.classList.remove('oc-drawer-open');
  document.documentElement.classList.remove('oc-sheet-open');
  document.body.classList.remove('oc-sheet-open');
  document.getElementById('m-drawer-bg')?.classList.remove('open');
}
document.addEventListener('DOMContentLoaded', _resetScrollLock);
window.addEventListener('pageshow', _resetScrollLock);

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
// Bluesky-style action-row glyphs — softer, more rounded strokes than
// the old Twitter-ish set (gentler bezier curves, no sharp elbows),
// so the reply/repost/like/bookmark row reads as smooth outline icons
// at 19px the way Bluesky's own action bar does. Still pure stroke
// (fill:none via .act svg in style.css) except the two that render
// solid — views (bars) and the liked/reposted/bookmarked filled
// states, both handled the same as before in CSS.
const ICON = {
  reply:    '<svg viewBox="0 0 24 24"><path d="M1.75 10.1C1.75 5.68 5.33 2.1 9.75 2.1h4.4c4.5 0 8.15 3.64 8.15 8.15 0 2.97-1.61 5.7-4.2 7.13l-8.06 4.47v-3.7h-.07c-4.5.1-8.22-3.53-8.22-8.05Z" stroke-linejoin="round"/></svg>',
  heart:    '<svg viewBox="0 0 24 24"><path d="M12 6.24C10.4 4.4 7.85 3.9 5.8 5.1 3.4 6.5 2.66 9.6 4.24 12.15c1.9 3.06 4.9 5.5 7.76 7.6 2.86-2.1 5.86-4.54 7.76-7.6 1.58-2.55.84-5.65-1.56-7.05-2.05-1.2-4.6-.7-6.2 1.14z" stroke-linejoin="round"/></svg>',
  views:    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="3" y="12.5" width="3" height="8.5" rx="1.2"/><rect x="8.5" y="15.5" width="3" height="5.5" rx="1.2"/><rect x="14" y="7" width="3" height="14" rx="1.2"/><rect x="19.5" y="14" width="3" height="7" rx="1.2"/></svg>',
  // Forward/share arrow — a single solid (fill, not stroke) glyph: a
  // curved tail sweeping up into an arrowhead, matching the reference
  // share icon. fill:currentColor overrides .act svg's shared
  // fill:none/stroke:currentColor, same trick ICON.views/menu/quote
  // already use for their own solid glyphs.
  share:    '<svg viewBox="0 0 24 24" class="icon-share" fill="currentColor" stroke="none"><path d="M13.5 4.6a1.15 1.15 0 0 1 1.94-.86l6.3 5.75a1.15 1.15 0 0 1 0 1.7l-6.3 5.75a1.15 1.15 0 0 1-1.94-.86v-2.72c-5.02.22-8.2 2.1-10.02 5.9a1.05 1.05 0 0 1-1.99-.5C1.9 11.6 6.2 7.36 13.5 7.03V4.6Z"/></svg>',
  menu:     '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
  // Bookmark ribbon — heavier, more rounded stroke and a smooth
  // curved notch at the bottom (instead of a sharp V), matching the
  // reference save icon.
  bookmark: '<svg viewBox="0 0 24 24" class="icon-bookmark"><path d="M6.25 6.4A2.65 2.65 0 0 1 8.9 3.75h6.2A2.65 2.65 0 0 1 17.75 6.4v13.2a.85.85 0 0 1-1.36.68L12 16.9l-4.39 3.38a.85.85 0 0 1-1.36-.68V6.4Z" stroke-linejoin="round"/></svg>',
  repost:   '<svg viewBox="0 0 24 24"><path d="M17 1.5 21 5.5l-4 4" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 11.5v-2a4 4 0 0 1 4-4h14" stroke-linecap="round"/><path d="M7 22.5 3 18.5l4-4" stroke-linecap="round" stroke-linejoin="round"/><path d="M21 12.5v2a4 4 0 0 1-4 4H3" stroke-linecap="round"/></svg>',
  quote:    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M6.5 6.2c-2.3 1.4-3.7 3.5-3.7 6 0 2.4 1.6 3.9 3.5 3.9 1.75 0 3-1.3 3-2.95 0-1.55-1.1-2.75-2.6-2.75-.25 0-.5 0-.75.1.2-1.5 1.4-3 3-3.85L6.5 6.2Zm9 0c-2.3 1.4-3.7 3.5-3.7 6 0 2.4 1.6 3.9 3.5 3.9 1.75 0 3-1.3 3-2.95 0-1.55-1.1-2.75-2.6-2.75-.25 0-.5 0-.75.1.2-1.5 1.4-3 3-3.85l-2.45-2.3Z"/></svg>'
};

// ── SIDEBAR NAV — rendered into <nav id="side-nav"></nav> on every
// page, same idea as auth.js's auth-area: one source of truth so the
// "which link is Profile" / unread-count logic doesn't get copy-pasted
// across every HTML file. auth.js calls this once it knows who (if
// anyone) is logged in.
// Minimalist/modern pass: chunkier uniform strokes, generous rounded
// corners, blunt rather than sharp terminals — matches the squircle
// "flower" settings glyph and continuous-outline home glyph used as
// the style reference for this set. home/gear are fully redesigned;
// the rest are re-drafted with the same rounder, bolder language.
const NAV_ICON = {
  home:     '<svg viewBox="0 0 24 24"><path d="M5.6 19.2V12.4C5.6 11.6 5.95 10.85 6.55 10.35L11.15 6.35C11.65 5.9 12.35 5.9 12.85 6.35L17.45 10.35C18.05 10.85 18.4 11.6 18.4 12.4V19.2"/><path d="M9.9 19.2V14.6C9.9 13.5 10.6 12.9 11.6 12.9H12.4C13.4 12.9 14.1 13.5 14.1 14.6V19.2"/></svg>',
  search:   '<svg viewBox="0 0 24 24"><circle cx="10.5" cy="10.5" r="6.9"/><path d="m19.5 19.5-4.35-4.35"/></svg>',
  bell:     '<svg viewBox="0 0 24 24"><path d="M12 3.1a5.9 5.9 0 0 0-5.9 5.9v2.5c0 .95-.35 1.85-1 2.55l-.85.95c-1 1.1-.2 2.85 1.28 2.85h13.94c1.48 0 2.28-1.75 1.28-2.85l-.85-.95c-.65-.7-1-1.6-1-2.55V9A5.9 5.9 0 0 0 12 3.1Z"/><path d="M9.3 19.5a2.7 2.7 0 0 0 5.4 0"/></svg>',
  chat:     '<svg viewBox="0 0 24 24"><path d="M14.3 8.6a2.3 2.3 0 0 1-2.3 2.3H6.4l-3.65 3.4V4.3a2.3 2.3 0 0 1 2.3-2.3h6.95a2.3 2.3 0 0 1 2.3 2.3Z"/><path d="M18.1 8.6H20a2 2 0 0 1 2 2v10.5l-3.65-3.4h-5.75a2 2 0 0 1-2-2v-.7"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24"><path d="M6.4 5.6A2.2 2.2 0 0 1 8.6 3.4h6.8a2.2 2.2 0 0 1 2.2 2.2V20a.75.75 0 0 1-1.2.6L12 16.7l-4.4 3.9A.75.75 0 0 1 6.4 20Z"/></svg>',
  user:     '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.1" r="4"/><path d="M4.3 19.7c1.05-4.3 3.95-6.4 7.7-6.4s6.65 2.1 7.7 6.4"/></svg>',
  gear:     '<svg viewBox="0 0 24 24"><path d="M12.00 3.40C11.15 3.40 10.45 5.39 9.44 5.81C8.42 6.23 6.52 5.31 5.92 5.92C5.31 6.52 6.23 8.42 5.81 9.44C5.39 10.45 3.40 11.15 3.40 12.00C3.40 12.85 5.39 13.55 5.81 14.56C6.23 15.58 5.31 17.48 5.92 18.08C6.52 18.69 8.42 17.77 9.44 18.19C10.45 18.61 11.15 20.60 12.00 20.60C12.85 20.60 13.55 18.61 14.56 18.19C15.58 17.77 17.48 18.69 18.08 18.08C18.69 17.48 17.77 15.58 18.19 14.56C18.61 13.55 20.60 12.85 20.60 12.00C20.60 11.15 18.61 10.45 18.19 9.44C17.77 8.42 18.69 6.52 18.08 5.92C17.48 5.31 15.58 6.23 14.56 5.81C13.55 5.39 12.85 3.40 12.00 3.40Z"/><circle cx="12" cy="12" r="3.3"/></svg>',
  doc:      '<svg viewBox="0 0 24 24"><path d="M6.5 3.5h7.2a1.7 1.7 0 0 1 1.2.5l3.6 3.6a1.7 1.7 0 0 1 .5 1.2V19a1.6 1.6 0 0 1-1.6 1.6h-10.9a1.6 1.6 0 0 1-1.6-1.6V5.1a1.6 1.6 0 0 1 1.6-1.6Z"/><path d="M14.3 3.6V7.4a1.5 1.5 0 0 0 1.5 1.5h3.8"/><path d="M8.3 13.2h7.4M8.3 16.6h5.2"/></svg>',
  // Open book — used for Blog so it reads distinctly from the
  // folded-corner "doc" icon shared by Rules/Terms.
  book:     '<svg viewBox="0 0 24 24"><path d="M4 5.6c2.5-1.15 5.15-1.15 8 .3v12.8c-2.85-1.4-5.5-1.4-8-.3Z" stroke-linejoin="round"/><path d="M20 5.6c-2.5-1.15-5.15-1.15-8 .3v12.8c2.85-1.4 5.5-1.4 8-.3Z" stroke-linejoin="round"/></svg>',
  dots:     '<svg viewBox="0 0 24 24"><circle cx="5" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="2" fill="currentColor" stroke="none"/><circle cx="19" cy="12" r="2" fill="currentColor" stroke="none"/></svg>',
  people:   '<svg viewBox="0 0 24 24"><circle cx="9" cy="8.1" r="3.6"/><path d="M2.5 20.1c1-4 3.4-6 6.5-6s5.5 2 6.5 6"/><path d="M15.4 5a3.5 3.5 0 0 1 0 6.7"/><path d="M16.1 14.7c2.5.55 4.3 2.4 5.1 5.4"/></svg>',
  list:     '<svg viewBox="0 0 24 24"><rect x="3.7" y="5.2" width="3.6" height="3.6" rx="1.3"/><rect x="3.7" y="10.2" width="3.6" height="3.6" rx="1.3"/><rect x="3.7" y="15.2" width="3.6" height="3.6" rx="1.3"/><path d="M10.5 7h10M10.5 12h10M10.5 17h10"/></svg>',
  article:  '<svg viewBox="0 0 24 24"><rect x="4.5" y="3.5" width="15" height="17" rx="2.4"/><path d="M8 8.3h8M8 12h8M8 15.7h5"/></svg>',
  info:     '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.1"/><path d="M12 10.8v6.1"/><circle cx="12" cy="7.4" r="1.15" fill="currentColor" stroke="none"/></svg>',
  mail:     '<svg viewBox="0 0 24 24"><rect x="3.2" y="5.2" width="17.6" height="13.6" rx="3.2"/><path d="m4 6.5 7.55 5.9a.75.75 0 0 0 .9 0L20 6.5"/></svg>',
  shield:   '<svg viewBox="0 0 24 24"><path d="M12 3.1 5.1 5.75v5.55c0 4.85 3 8.15 6.9 9.2 3.9-1.05 6.9-4.35 6.9-9.2V5.75Z" stroke-linejoin="round"/><path d="m8.8 12.1 2.1 2.1 4.3-4.3"/></svg>',
  globe:    '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.1"/><path d="M2.9 12h18.2"/><path d="M12 2.9c2.6 2.6 3.95 6 3.95 9.1s-1.35 6.5-3.95 9.1c-2.6-2.6-3.95-6-3.95-9.1S9.4 5.5 12 2.9Z"/></svg>',
  palette:  '<svg viewBox="0 0 24 24"><path d="M12 3.1a8.9 8.9 0 1 0 0 17.8c1.05 0 1.85-.85 1.85-1.85 0-.5-.2-.95-.5-1.28-.32-.32-.5-.76-.5-1.24 0-.98.8-1.78 1.85-1.78h2c2.45 0 4.4-1.95 4.4-4.4C21 6.35 16.6 3.1 12 3.1Z" stroke-linejoin="round"/><circle cx="7.5" cy="11.2" r="1.3" fill="currentColor" stroke="none"/><circle cx="10.2" cy="7.2" r="1.3" fill="currentColor" stroke="none"/><circle cx="15.1" cy="7.6" r="1.3" fill="currentColor" stroke="none"/><circle cx="17.2" cy="12" r="1.3" fill="currentColor" stroke="none"/></svg>',
  help:     '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="9.1"/><path d="M9.1 9.35a2.9 2.9 0 1 1 4.2 2.6c-.75.4-1.3 1.05-1.3 1.9v.35"/><circle cx="12" cy="17.2" r="1.15" fill="currentColor" stroke="none"/></svg>',
  trophy:   '<svg viewBox="0 0 24 24"><path d="M6.8 4.3h10.4v4.5c0 3.25-2.35 5.65-5.2 5.65s-5.2-2.4-5.2-5.65Z" stroke-linejoin="round"/><path d="M6.8 5.4H4.2c0 2.5.95 4.2 3 4.6M17.2 5.4h2.6c0 2.5-.95 4.2-3 4.6"/><path d="M12 14.45V18.3M8.6 19.7h6.8" stroke-linecap="round"/></svg>'
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
  if (f32) f32.setAttribute('href', f32.getAttribute('href').replace(dark ? 'favicon-32.png' : 'favicon-dark-32.png', dark ? 'favicon-dark-32.png' : 'favicon-32.png'));
  if (f512) f512.setAttribute('href', f512.getAttribute('href').replace(dark ? 'favicon.png' : 'favicon-dark.png', dark ? 'favicon-dark.png' : 'favicon.png'));
}
// Belt-and-suspenders: the pre-paint inline <script> in <head> already sets
// the right favicon before first paint (for people with dark saved/system
// theme), but if it ever fails silently (localStorage disabled, etc.) this
// re-syncs the tab icon to whatever theme actually ended up on screen, on
// every single page load — not just live OS flips or a manual Settings change.
updateFavicon(getTheme());
// ── PULL TO REFRESH ──────────────────────────────────────────────
// Twitter-style: drag down from the very top of a feed page and it
// re-fetches just the posts in place instead of the browser doing a
// full-page reload (which is what mobile Chrome/a PWA does natively
// when you pull down at scrollTop 0 — the "site refreshes" behavior
// this replaces). Works on any page that has a #feed-posts list and
// defines one of the load functions below; each feed page already
// has exactly one of these, so no per-page wiring is needed.
// Touch-only — a mouse drag never triggers it.
(function initPullToRefresh() {
  const THRESHOLD = 64;   // px of actual finger travel needed to trigger a refresh
  const MAX_PULL = 100;   // visual cap on how far the indicator opens up
  const DAMP = 0.5;       // drag feels "heavier" than a 1:1 finger tracking
  const DEAD_ZONE = 8;    // px of initial wiggle room before committing to a direction — this
                          // is what stops a normal upward scroll swipe (whose very first
                          // touchmove sample can jitter a pixel or two downward before the
                          // real motion kicks in) from being misread as the start of a pull.
                          // Calling preventDefault() on that stray first sample was cancelling
                          // scrolling for the *whole* gesture, even once the real, negative-dy
                          // motion followed — that was the "can't scroll posts" bug.
  let startX = null, startY = null, indicator = null, lastPull = 0, refreshing = false;
  // phase: null (not armed) | 'watching' (armed, still inside the dead zone,
  // direction not yet decided) | 'confirmed' (deliberate downward pull — we
  // own this gesture and call preventDefault) | 'abandoned' (turned out to be
  // a scroll/horizontal swipe/etc — hands off for the rest of this touch)
  let phase = null;

  function feedRefreshFn() {
    if (typeof loadFeed === 'function') return loadFeed;
    if (typeof loadCommunityFeed === 'function') return loadCommunityFeed;
    if (typeof loadBookmarks === 'function') return loadBookmarks;
    return null;
  }

  function ensureIndicator() {
    if (indicator) return indicator;
    const feed = document.getElementById('feed-posts');
    if (!feed || !feed.parentNode) return null;
    indicator = document.createElement('div');
    indicator.id = 'ptr-indicator';
    indicator.innerHTML = `<span class="ptr-spinner">
      <svg viewBox="0 0 50 50" aria-hidden="true">
        <circle class="ptr-track" cx="25" cy="25" r="18"></circle>
        <circle class="ptr-arc" cx="25" cy="25" r="18"></circle>
      </svg>
    </span>`;
    feed.parentNode.insertBefore(indicator, feed);
    return indicator;
  }

  function atTop() {
    return (window.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0) <= 0;
  }

  function resetIndicator() {
    if (!indicator) return;
    indicator.classList.remove('ptr-loading', 'ptr-visible', 'ptr-dragging');
    indicator.style.height = '0px';
    // Drop the drag-tracking rotation too — see the ptr-loading branch of
    // onTouchEnd() below for why a leftover --ptr-rot is what makes the
    // "loading" spin freeze instead of actually spinning.
    const spinnerEl = indicator.querySelector('.ptr-spinner');
    if (spinnerEl) spinnerEl.style.removeProperty('--ptr-rot');
    lastPull = 0;
  }

  function onTouchStart(e) {
    phase = null;
    if (refreshing || !e.touches || e.touches.length !== 1) return;
    if (!feedRefreshFn() || !document.getElementById('feed-posts')) return;
    if (!atTop()) return;
    // The mobile hamburger drawer (.m-drawer, inside the fixed
    // .m-drawer-bg overlay) locks the underlying page's scroll via
    // html.oc-drawer-open{overflow:hidden}, so atTop() above stays true
    // the entire time the drawer is open — a downward drag to scroll
    // back up through a long drawer menu was getting misread as a
    // pull-to-refresh gesture and had its touchmove default suppressed,
    // which is exactly what made the drawer's own overflow-y:auto
    // scroll stop working. Bail out immediately whenever the drawer is
    // open, and also skip drags starting inside anything else with its
    // own scroll/gestures (sidebar, modals, chat panes, the mobile
    // topbar) so this only ever fires over the main feed column.
    if (document.documentElement.classList.contains('oc-drawer-open')) return;
    if (e.target.closest && e.target.closest('#sidebar, .modal, .chat-msgs, #m-topbar, .gif-grid, .cx-emoji-grid, .m-drawer, .m-drawer-bg')) return;
    startX = e.touches[0].clientX;
    startY = e.touches[0].clientY;
    phase = 'watching';
  }

  function onTouchMove(e) {
    if (!phase || phase === 'abandoned' || refreshing) return;
    const dx = e.touches[0].clientX - startX;
    const dy = e.touches[0].clientY - startY;

    if (phase === 'watching') {
      // Not enough movement yet to know what this gesture is — do nothing
      // (and critically, no preventDefault) until it clears the dead zone.
      if (Math.abs(dx) < DEAD_ZONE && Math.abs(dy) < DEAD_ZONE) return;
      // Only a clearly-vertical, clearly-downward drag becomes a pull.
      // Anything else (upward scroll, a horizontal swipe) is abandoned for
      // good — we never touch preventDefault for the rest of this touch,
      // so native scrolling behaves exactly as it would with no PTR code at all.
      if (dy <= 0 || Math.abs(dx) > Math.abs(dy) || !atTop()) { phase = 'abandoned'; return; }
      phase = 'confirmed';
    }

    if (dy <= 0 || !atTop()) { phase = 'abandoned'; resetIndicator(); return; }
    const ind = ensureIndicator();
    if (!ind) { phase = 'abandoned'; return; }
    e.preventDefault(); // suppress the native scroll bounce / OS pull-to-refresh while dragging
    lastPull = Math.min(dy * DAMP, MAX_PULL);
    ind.classList.add('ptr-dragging', 'ptr-visible');
    ind.style.height = lastPull + 'px';
    ind.querySelector('.ptr-spinner').style.setProperty('--ptr-rot', (Math.min(lastPull / MAX_PULL, 1) * 360) + 'deg');
  }

  async function onTouchEnd() {
    const wasConfirmed = phase === 'confirmed';
    phase = null;
    if (!wasConfirmed) return;
    const ind = indicator;
    if (!ind) return;
    ind.classList.remove('ptr-dragging');
    if (lastPull >= THRESHOLD) {
      const fn = feedRefreshFn();
      refreshing = true;
      // .ptr-spinner's own (non-animated) CSS rule is
      // `transform:rotate(var(--ptr-rot, 0deg))`, and onTouchMove above
      // just spent the whole drag setting that inline --ptr-rot to track
      // the finger — commonly landing at/near 360deg for any pull that
      // reached MAX_PULL. The ptr-loading animation below only declares a
      // `to { rotate(360deg) }` keyframe, so its implicit starting point
      // is whatever the element's rotation already is. Left at 360deg,
      // that animates 360deg -> 360deg: no visible motion at all — a
      // spinner frozen in place instead of spinning, exactly like a
      // static image. Clearing it here first means the animation always
      // starts from the CSS default (0deg), so it actually spins.
      const spinnerEl = ind.querySelector('.ptr-spinner');
      if (spinnerEl) spinnerEl.style.removeProperty('--ptr-rot');
      ind.classList.add('ptr-loading');
      ind.style.height = '48px';
      try { if (fn) await fn(); } finally {
        refreshing = false;
        resetIndicator();
      }
    } else {
      resetIndicator();
    }
  }

  document.addEventListener('touchstart', onTouchStart, { passive:true });
  document.addEventListener('touchmove', onTouchMove, { passive:false });
  document.addEventListener('touchend', onTouchEnd, { passive:true });
  document.addEventListener('touchcancel', onTouchEnd, { passive:true });
})();

// ── ACCENT COLOR — same idea as THEME above, but swaps the app's one
// accent color (buttons/links/active states) instead of the surface
// colors. Applied via data-accent on <html>; "blue" is the default and
// needs no attribute (matches the :root values in style.css). ──
const ACCENT_KEY = 'oc-accent';
const ACCENT_OPTIONS = [
  { id: 'blue',   label: 'Blue'   },
  { id: 'green',  label: 'Green'  },
  { id: 'red',    label: 'Red'    },
  { id: 'purple', label: 'Purple' },
  { id: 'orange', label: 'Orange' }
];
function applyAccent(accent) {
  if (accent && accent !== 'blue') document.documentElement.setAttribute('data-accent', accent);
  else document.documentElement.removeAttribute('data-accent');
  try { localStorage.setItem(ACCENT_KEY, accent || 'blue'); } catch (e) {}
}
function getAccent() {
  try { return localStorage.getItem(ACCENT_KEY) || 'blue'; } catch (e) { return 'blue'; }
}

let unreadNotifCount = 0;
let unreadChatCount = 0;

// Maps the current URL (pretty or legacy .html) to one of the fixed
// nav-item keys below, so highlighting "which tab is active" doesn't
// break now that most pages live at a clean path instead of a
// filename. Checked in order; first match wins.
function currentNavKey() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  // Order matters: more specific section checks (blog, help, rules, ...)
  // must run before the generic home check below, since every one of
  // those sections also has its own index.html — a bare
  // `path.endsWith('/index.html')` would match all of them and mark
  // "Home" as current no matter which section you're actually on.
  if (path === '/search' || path.endsWith('/search.html')) return 'search';
  if (path === '/notifications' || path.endsWith('/notifications.html')) return 'notifications';
  if (path === '/messages' || path.startsWith('/messages/') || path.endsWith('/chat.html')) return 'messages';
  if (path === '/bookmarks' || path.endsWith('/bookmarks.html')) return 'bookmarks';
  if (path === '/communities' || path.startsWith('/communities/') || path.endsWith('/communities.html') || path.endsWith('/community.html')) return 'communities';
  if (path === '/articles' || path.startsWith('/i/articles/') || path.endsWith('/articles.html') || path.endsWith('/article.html') || path.endsWith('/editarticle.html')) return 'articles';
  if (path === '/lists' || path.startsWith('/i/lists/') || path.endsWith('/lists.html') || path.endsWith('/list.html')) return 'lists';
  if (path === '/settings' || path.endsWith('/settings.html')) return 'settings';
  if (path === '/achievements' || path.endsWith('/achievements.html')) return 'achievements';
  if (path === '/rules' || path.endsWith('/rules.html')) return 'rules';
  if (path === '/about' || path.endsWith('/about.html')) return 'about';
  if (path === '/contact' || path.endsWith('/contact.html')) return 'contact';
  if (path === '/privacy' || path.endsWith('/privacy.html')) return 'privacy';
  if (path === '/terms' || path.endsWith('/terms.html')) return 'terms';
  if (path === '/blog' || path.startsWith('/blog/')) return 'blog';
  if (path === '/help' || path.startsWith('/help/')) return 'help';
  if (currentSession && currentProfile && path.toLowerCase() === profileUrl(currentProfile.username).toLowerCase()) return 'profile';
  if (path === '/' || path === '/home' || path.endsWith('/index.html')) return 'home';
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
  // "More" — replaces the old standalone Settings row with a
  // three-dot flyout (X's own pattern) so Settings can sit alongside
  // the pages that used to only be reachable from the page footer or
  // mobile drawer (Articles, Rules, About, Contact, Privacy, Terms).
  // Reuses the exact same .acct/.acct-menu open-state + outside-click
  // machinery as the account card at the bottom of the sidebar (see
  // auth.js) — #more-wrap just needs the shared "acct" class and its
  // own toggle, both already wired up below/in toggleMoreMenu().
  const moreItem = (href, icon, label) => `<a href="${href}"><span class="navicon">${icon}</span>${label}</a>`;
  const moreCur = ['settings', 'achievements', 'articles', 'blog', 'rules', 'about', 'contact', 'privacy', 'terms', 'help'].includes(here);
  const moreBtn = `
    <div class="acct" id="more-wrap">
      <button class="navmore-btn${moreCur ? ' cur' : ''}" onclick="toggleMoreMenu();return false;">
        <span class="navicon">${NAV_ICON.dots}</span><span class="navlabel">${t('nav.more')}</span>
      </button>
      <div class="acct-menu navmore-menu" id="more-menu">
        ${moreItem('/settings', NAV_ICON.gear, t('nav.settings'))}
        ${currentSession ? moreItem('/achievements', NAV_ICON.trophy, 'Achievements') : ''}
        ${moreItem(`${lp}/articles`, NAV_ICON.article, t('nav.articles'))}
        ${moreItem('/blog/index.html', NAV_ICON.book, 'Blog')}
        ${moreItem(`${lp}/rules`, NAV_ICON.doc, t('nav.rules'))}
        ${moreItem(`${lp}/about`, NAV_ICON.info, t('nav.about'))}
        ${moreItem(`${lp}/contact`, NAV_ICON.mail, t('nav.contact'))}
        ${moreItem(`${lp}/privacy`, NAV_ICON.shield, t('nav.privacy'))}
        ${moreItem(`${lp}/terms`, NAV_ICON.doc, t('nav.terms'))}
        ${moreItem('/help/index.html', NAV_ICON.help, 'Help Center')}
      </div>
    </div>`;
  const postBtn = currentSession
    ? `<button class="sidebar-post-btn" onclick="mobileCompose();return false;">${ICON_COMPOSE}<span>${t('nav.post')}</span></button>`
    : `<a class="sidebar-post-btn" href="${lp}/signup">${ICON_COMPOSE}<span>${t('nav.post')}</span></a>`;
  // Same 9-item order as Bluesky's own sidebar/drawer: Home, Explore,
  // Notifications, Chat, [Feeds slot] Lists, Saved, Profile, More —
  // the only swaps are this app's Communities feature standing in for
  // Bluesky's Feeds slot, and a three-dot "More" flyout (X's own
  // pattern, see above) replacing the old standalone Settings row.
  el.innerHTML =
    item(lp ? `${lp}/home` : '/home', NAV_ICON.home, t('nav.home'), 'home') +
    item('/search', NAV_ICON.search, t('nav.explore'), 'search') +
    item('/notifications', NAV_ICON.bell, t('nav.notifications'), 'notifications', notifBadge) +
    item('/messages', NAV_ICON.chat, t('nav.chat'), 'messages', chatBadge) +
    item(`${lp}/communities`, NAV_ICON.people, t('nav.communities'), 'communities') +
    item('/lists', NAV_ICON.list, t('nav.lists'), 'lists') +
    item('/bookmarks', NAV_ICON.bookmark, t('nav.bookmarks'), 'bookmarks') +
    item(ownHref, NAV_ICON.user, t('nav.profile'), 'profile') +
    moreBtn +
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
// Same magnifying-glass shape already inlined in every .xsearch box
// across the app (search page, member pickers, etc.) — pulled out
// here as a shared constant for the chat "Search a user" trigger so
// its icon actually matches what the action does now.
const ICON_SEARCH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>';
// Hamburger (opens the drawer) and hashtag/Feeds icon, both used in the
// mobile top bar — matches the reference app's icon-left / logo-center /
// icon-right topbar layout.
const ICON_HAMBURGER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18M3 12h18M3 18h18"/></svg>';
const ICON_FEEDS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>';

function mchrome() {
  let el = document.getElementById('m-chrome');
  if (!el) { el = document.createElement('div'); el.id = 'm-chrome'; document.body.appendChild(el); }
  return el;
}

function renderMobileChrome() {
  const el = mchrome();
  // If the drawer was open at the moment this re-render fires — auth
  // state/unread counts resolving right after initial load is the
  // classic case, but any of the several renderMobileChrome() calls
  // in auth.js can land here — innerHTML below throws away the old
  // #m-drawer-bg and builds a brand-new one in its default *closed*
  // state. <html class="oc-drawer-open"> (which hides the topbar/
  // tabbar/FAB and locks scroll — see style.css) stays set the whole
  // time, so without this the person is left staring at a screen with
  // no visible drawer, no visible chrome, and no scrolling: looks
  // exactly like a frozen page. Carrying the open state onto the new
  // element (no-anim so it doesn't visibly slide open again) keeps
  // the drawer's actual DOM state in sync with <html>'s class the
  // whole time, on every page that calls this.
  const wasOpen = document.getElementById('m-drawer-bg')?.classList.contains('open');
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

  // chat.js appends #chat-fab / #chat-fab-sheet-bg straight to <body>
  // (not into the pjax-swapped root), so they survive navigating away
  // from the chat page and end up stacked on top of this #m-fab on
  // every other page. renderMobileChrome() runs on every page/nav
  // (see comment above), so this is the one place guaranteed to fire
  // after leaving chat — tear the chat FAB down here whenever we're
  // not on the chat page.
  if (!onChatPage) {
    document.getElementById('chat-fab')?.remove();
    document.getElementById('chat-fab-sheet-bg')?.remove();
    document.body.classList.remove('oc-sheet-open');
  }

  el.innerHTML = `
    <div id="m-topbar">
      <button class="m-menu-btn" onclick="openMobileDrawer();return false;" aria-label="Open menu">${ICON_HAMBURGER}</button>
      <a class="m-logo" href="${lp || '/'}">
        <img class="logo-mark logo-mark-light" src="img/logo-light.png" alt="" width="26" height="26">
        <img class="logo-mark logo-mark-dark" src="img/logo-dark.png" alt="" width="26" height="26">
      </a>
    </div>

    <div id="m-tabbar">
      <a class="${cur('home')}" href="${lp || '/'}"><span class="m-tab-hit">${NAV_ICON.home}</span><span class="m-tab-label">Home</span></a>
      <a class="${cur('search')}" href="search.html"><span class="m-tab-hit">${NAV_ICON.search}</span><span class="m-tab-label">Search</span></a>
      <a class="${cur('messages')}" href="chat.html"><span class="m-tab-hit">${NAV_ICON.chat}${chatBadge}</span><span class="m-tab-label">Chat</span></a>
      <a class="${cur('notifications')}" href="notifications.html"><span class="m-tab-hit">${NAV_ICON.bell}${badge}</span><span class="m-tab-label">Notifications</span></a>
      <a class="${cur('profile')} m-tab-avatar" href="${ownHref}"><span class="m-tab-hit"><img class="avatar${avSqClass(currentProfile)}" src="${esc(avatar)}" decoding="async" alt=""></span><span class="m-tab-label">Profile</span></a>
    </div>

    ${currentSession && !onChatPage ? `<button id="m-fab" onclick="mobileCompose();return false;" aria-label="Post">${ICON_COMPOSE}</button>` : ''}

    <div class="m-drawer-bg" id="m-drawer-bg" onclick="if(event.target===this)closeMobileDrawer();">
      <div class="m-drawer">
        ${currentSession ? `
          <a href="${ownHref}"><img class="avatar m-drawer-avatar${avSqClass(currentProfile)}" src="${esc(avatar)}" loading="lazy" decoding="async" alt=""></a>
          <a href="${ownHref}" style="text-decoration:none;">
            <span class="m-drawer-name">${esc(currentProfile?.display_name || currentProfile?.username || 'You')}</span>
            <span class="m-drawer-handle">@${esc(currentProfile?.username || '')}</span>
          </a>
          <div class="m-drawer-stats">
            <a href="${currentProfile ? followListUrl(currentProfile.username, 'followers') : '#'}"><b>${fmtCount(currentProfile?.followers_count)}</b> followers</a>
            <a href="${currentProfile ? followListUrl(currentProfile.username, 'following') : '#'}"><b>${fmtCount(currentProfile?.following_count)}</b> following</a>
          </div>
          <hr>
          <div class="m-drawer-menu">
            <a href="${ownHref}">${NAV_ICON.user}Profile</a>
            <a href="${lp || '/'}">${NAV_ICON.home}Home</a>
            <a href="notifications.html">${NAV_ICON.bell}${badge}Notifications</a>
            <a href="chat.html">${NAV_ICON.chat}${chatBadge}Chat</a>
            <a href="search.html">${NAV_ICON.search}Explore</a>
            <a href="${lp}/communities">${NAV_ICON.people}Communities</a>
            <a href="lists.html">${NAV_ICON.list}Lists</a>
            <a href="bookmarks.html">${NAV_ICON.bookmark}Saved</a>
            <a href="/achievements">${NAV_ICON.trophy}Achievements</a>
            <a href="/settings">${NAV_ICON.gear}Settings</a>
          </div>
          <span class="m-drawer-group-label">More</span>
          <div class="m-drawer-menu">
            <a href="${lp}/articles">${NAV_ICON.article}Articles</a>
            <a href="${lp}/rules">${NAV_ICON.doc}Rules</a>
            <a href="${lp}/about">${NAV_ICON.info}About</a>
            <a href="${lp}/contact">${NAV_ICON.mail}Contact</a>
            <a href="${lp}/privacy">${NAV_ICON.shield}Privacy Policy</a>
          </div>
          <hr>
          <a class="m-drawer-tos" href="${lp}/terms">Terms of Service</a>
          <div class="m-drawer-footer-row">
            <a class="m-drawer-pill" href="${lp}/contact">Feedback</a>
            <a class="m-drawer-pill" href="/help/index.html">Help</a>
          </div>
          <hr>
          <button class="m-drawer-logout" onclick="closeMobileDrawer();logOut();"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M9 4.5H6a1.5 1.5 0 0 0-1.5 1.5v12A1.5 1.5 0 0 0 6 19.5h3"/><path d="M15.5 16.5 20 12l-4.5-4.5"/><path d="M20 12H9"/></svg>Log out</button>
        ` : `
          <img class="avatar m-drawer-avatar" src="${DEFAULT_AVATAR}" loading="lazy" decoding="async" alt="">
          <span class="m-drawer-name">Welcome to InteractInk</span>
          <span class="m-drawer-handle">You need an account to post.</span>
          <hr>
          <div class="m-drawer-menu" style="margin-top:8px;">
            <a href="search.html">${NAV_ICON.search}Explore</a>
            <a href="${lp}/communities">${NAV_ICON.people}Communities</a>
            <a href="lists.html">${NAV_ICON.list}Lists</a>
          </div>
          <span class="m-drawer-group-label">About</span>
          <div class="m-drawer-menu">
            <a href="${lp}/rules">${NAV_ICON.doc}Rules</a>
            <a href="${lp}/about">${NAV_ICON.info}About</a>
            <a href="${lp}/contact">${NAV_ICON.mail}Contact</a>
            <a href="${lp}/privacy">${NAV_ICON.shield}Privacy Policy</a>
            <a href="${lp}/terms">${NAV_ICON.doc}Terms of Service</a>
          </div>
          <div class="m-drawer-cta">
            <a class="cta-primary" href="/start">Create account</a>
          </div>
        `}
      </div>
    </div>`;

  if (wasOpen) {
    document.getElementById('m-drawer-bg')?.classList.add('no-anim', 'open');
  }
}

// oc-drawer-open on <html> both locks page scroll behind the drawer and
// (via the matching CSS rule) force-drops #board-hdr/#m-topbar/#m-tabbar/
// #m-fab to z-index:0 while it's open — fixes those sticky/backdrop-filter
// bars occasionally compositing above the drawer overlay despite its much
// higher z-index (see .m-drawer-bg comment in style.css).
function openMobileDrawer() {
  // Clear a leftover no-anim (set right before a drawer-link
  // navigation — see below) in case this page was bfcache-restored
  // with it still applied, so re-opening the drawer slides in normally.
  document.getElementById('m-drawer-bg')?.classList.remove('no-anim');
  document.getElementById('m-drawer-bg')?.classList.add('open');
  document.documentElement.classList.add('oc-drawer-open');
}
function closeMobileDrawer() {
  document.getElementById('m-drawer-bg')?.classList.remove('open');
  document.documentElement.classList.remove('oc-drawer-open');
}
// The drawer's own links (Home, Chat, Settings, etc.) are plain
// `<a href>`s that navigate immediately on click — none of them
// call closeMobileDrawer() first. On a normal click that's harmless
// (the whole document unloads a moment later anyway), but the native
// cross-document view transition (see @view-transition in style.css)
// captures a *snapshot of the page exactly as it looked* right before
// navigation as its "old" frame — with the drawer still wide open —
// and crossfades that into the next page. The result is the drawer
// appearing to hang open, floating over the new page's real content,
// for the whole transition instead of just vanishing. Closing it
// synchronously (transition-free, so the snapshot reflects "closed"
// rather than a half-finished slide) the instant a drawer link is
// clicked — before the browser hands off to navigation — fixes that
// without touching the click/navigation itself.
document.addEventListener('click', (e) => {
  const bg = document.getElementById('m-drawer-bg');
  if (!bg || !bg.classList.contains('open')) return;
  if (!e.target.closest || !e.target.closest('.m-drawer a')) return;
  bg.classList.add('no-anim');
  closeMobileDrawer();
});

// ─────────────────────────────────────────────────────────────
// ACCOUNT SWITCHER — holding down the tab bar's Profile icon (the
// same gesture Instagram uses on its own bottom-nav avatar) pops an
// X/IG-style sheet listing every account that's ever logged in on
// *this device*, so switching between them is one tap instead of a
// full log out → log back in round trip. Every account that
// successfully authenticates gets remembered here — see
// upsertSavedAccount(), called from auth.js's renderAuthArea() once a
// session+profile resolve cleanly.
//
// Storage: localStorage, one row per account (id/username/display
// name/avatar + that account's current access+refresh token pair so
// switching can call sb.auth.setSession() directly instead of asking
// for a password again). Hard-capped at ACCT_SWITCH_MAX (10, per
// spec) — once full, upsertSavedAccount() silently leaves a brand
// new account out of the list (it's still logged in and usable, just
// not fast-switchable) rather than quietly evicting an old one, and
// the sheet's own "Add account" row turns into an explicit "limit
// reached" notice so the cap is never a surprise. The small "×" on
// each non-active row is the only way to free a slot.
// ─────────────────────────────────────────────────────────────
const ACCT_SWITCH_KEY = 'ii-saved-accounts';
const ACCT_SWITCH_MAX = 10;

function loadSavedAccounts() {
  try {
    const raw = JSON.parse(localStorage.getItem(ACCT_SWITCH_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch (e) { return []; }
}
function saveSavedAccounts(list) {
  try { localStorage.setItem(ACCT_SWITCH_KEY, JSON.stringify(list.slice(0, ACCT_SWITCH_MAX))); } catch (e) {}
}

// Called once per successful renderAuthArea() resolution (real
// session + profile, already past the IP-ban/suspension checks).
// Refreshes that account's saved row (name/avatar/tokens can all
// change between visits) and bumps it to the front — most-recently-
// used first, so the sheet always opens on a useful order. A
// genuinely new account only gets added while there's room under the
// strict 10 cap; see the block comment above for why it isn't
// auto-evicted instead.
function upsertSavedAccount(session, profile) {
  if (!session?.user?.id) return;
  const list = loadSavedAccounts();
  const idx = list.findIndex(a => a.id === session.user.id);
  const row = {
    id: session.user.id,
    username: profile?.username || '',
    display_name: profile?.display_name || '',
    avatar_url: profile?.avatar_url || '',
    verified: !!profile?.verified,
    verification_type: profile?.verification_type || null,
    access_token: session.access_token,
    refresh_token: session.refresh_token,
  };
  if (idx !== -1) {
    list.splice(idx, 1);
    list.unshift(row);
  } else if (list.length < ACCT_SWITCH_MAX) {
    list.unshift(row);
  } // else: at the cap and this is a not-yet-saved account — leave it unsaved, don't evict.
  saveSavedAccounts(list);
}

function removeSavedAccount(id) {
  saveSavedAccounts(loadSavedAccounts().filter(a => a.id !== id));
  renderAccountSwitchSheet();
}

function acctSwitchSheetEl() {
  let bg = document.getElementById('acctswitch-sheet-bg');
  if (!bg) {
    bg = document.createElement('div');
    bg.id = 'acctswitch-sheet-bg';
    bg.className = 'acctswitch-sheet-bg';
    bg.onclick = (e) => { if (e.target === bg) closeAccountSwitchSheet(); };
    document.body.appendChild(bg);
  }
  return bg;
}

function renderAccountSwitchSheet() {
  const bg = acctSwitchSheetEl();
  const list = loadSavedAccounts();
  const activeId = currentSession?.user?.id || null;

  const rows = list.map(a => {
    const isActive = a.id === activeId;
    const badge = a.verified ? vBadge({ verified: true, verification_type: a.verification_type }) : '';
    const trailing = isActive
      ? `<span class="acctswitch-row-check">${CHECK_ICON}</span>`
      : `<button class="acctswitch-remove" onclick="event.stopPropagation();removeSavedAccount('${a.id}');" aria-label="Remove account" title="Remove">&times;</button>`;
    return `<div class="acctswitch-row${isActive ? ' active' : ''}" role="menuitem" onclick="${isActive ? '' : `switchAccount('${a.id}');`}">
      <img class="avatar${a.verification_type === 'gold' ? ' avatar-square' : ''}" src="${esc(avatarUrl(a.avatar_url))}" alt="" loading="lazy" decoding="async">
      <span class="acctswitch-row-txt">
        <span class="acctswitch-row-name">${esc(a.display_name || a.username || 'Account')}${badge}</span>
        <span class="acctswitch-row-handle">@${esc(a.username || '')}</span>
      </span>
      ${trailing}
    </div>`;
  }).join('');

  const lp = esPrefix();
  const addRow = list.length >= ACCT_SWITCH_MAX
    ? `<div class="acctswitch-row acctswitch-limit" role="note">
        <span class="acctswitch-row-txt">
          <span class="acctswitch-row-name">Account limit reached (${ACCT_SWITCH_MAX}/${ACCT_SWITCH_MAX})</span>
          <span class="acctswitch-row-handle">Remove an account above to add another</span>
        </span>
      </div>`
    : `<div class="acctswitch-row acctswitch-add" role="menuitem" onclick="closeAccountSwitchSheet();location.href='${lp}/login';">
        <span class="acctswitch-add-icon">${PLUS_ICON}</span>
        <span class="acctswitch-row-txt"><span class="acctswitch-row-name">Add account</span></span>
      </div>`;

  bg.innerHTML = `<div class="acctswitch-sheet" role="menu" aria-label="Switch accounts">
    <div class="acctswitch-title">Switch accounts</div>
    <div class="acctswitch-list">${rows}</div>
    ${addRow}
  </div>`;
}

function openAccountSwitchSheet() {
  if (!currentSession) return;
  renderAccountSwitchSheet();
  acctSwitchSheetEl().classList.add('open');
  document.body.classList.add('oc-sheet-open');
}
function closeAccountSwitchSheet() {
  document.getElementById('acctswitch-sheet-bg')?.classList.remove('open');
  document.body.classList.remove('oc-sheet-open');
}

// Swaps the live Supabase session to a saved account's tokens —
// setSession() re-authenticates in place and fires onAuthStateChange,
// which auth.js already listens for. Once it lands, a full
// navigation to the home feed (same as doLogIn()) guarantees every
// page's own cached per-user state (likes, bookmarks, feed) repaints
// clean for whoever's now signed in, instead of leaving stale bits
// from the previous account on screen.
async function switchAccount(id) {
  if (!currentSession || id === currentSession.user.id) { closeAccountSwitchSheet(); return; }
  const list = loadSavedAccounts();
  const acct = list.find(a => a.id === id);
  if (!acct) { closeAccountSwitchSheet(); return; }
  closeAccountSwitchSheet();
  try {
    const { error } = await sb.auth.setSession({ access_token: acct.access_token, refresh_token: acct.refresh_token });
    if (error) throw error;
    location.href = esPrefix() || '/';
  } catch (e) {
    console.error('Account switch failed:', e);
    removeSavedAccount(id);
    toast("That account's session expired — log in again to switch to it.", 'error');
  }
}

// Long-press (mirrors Instagram's own bottom-nav gesture) on the tab
// bar's Profile icon. Delegated on document rather than bound to the
// anchor itself since renderMobileChrome() tears down and rebuilds
// #m-tabbar's markup on every page/nav — a direct listener would be
// lost the moment that happens.
let acctLpTimer = null, acctLpFired = false, acctLpX = 0, acctLpY = 0;
const ACCT_LP_MS = 500, ACCT_LP_TOL = 10;
document.addEventListener('pointerdown', (e) => {
  if (!e.target.closest || !e.target.closest('.m-tab-avatar') || !currentSession) return;
  acctLpFired = false;
  acctLpX = e.clientX; acctLpY = e.clientY;
  clearTimeout(acctLpTimer);
  acctLpTimer = setTimeout(() => {
    acctLpFired = true;
    if (navigator.vibrate) navigator.vibrate(10);
    openAccountSwitchSheet();
  }, ACCT_LP_MS);
});
document.addEventListener('pointermove', (e) => {
  if (!acctLpTimer) return;
  if (Math.abs(e.clientX - acctLpX) > ACCT_LP_TOL || Math.abs(e.clientY - acctLpY) > ACCT_LP_TOL) {
    clearTimeout(acctLpTimer); acctLpTimer = null;
  }
});
['pointerup', 'pointercancel'].forEach(ev => document.addEventListener(ev, () => { clearTimeout(acctLpTimer); acctLpTimer = null; }));
// The long-press already opened the sheet by the time the browser's
// own click fires right after pointerup — swallow just that one click
// so it doesn't also navigate to the profile page out from under the
// sheet.
document.addEventListener('click', (e) => {
  if (acctLpFired && e.target.closest && e.target.closest('.m-tab-avatar')) {
    e.preventDefault(); e.stopPropagation(); acctLpFired = false;
  }
}, true);

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
              <div class="cx-poll-opt-row"><input type="text" class="cx-poll-opt" placeholder="Choice 1" maxlength="25"></div>
              <div class="cx-poll-opt-row"><input type="text" class="cx-poll-opt" placeholder="Choice 2" maxlength="25"></div>
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
          ${captchaCardHtml('gc-captcha')}
        </div>
      </div>
      ${replyAudienceMenuHtml('gc')}
      <div class="gc-spacer" aria-hidden="true"></div>
      <div class="pf-toolbar gc-toolbar">
        <div class="pf-icons">
          <button type="button" class="pf-ic" title="Media" aria-label="Media" onclick="document.getElementById('gc-file').click();return false;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10.5" r="1.6"/><path d="m4 17 5-5 3.5 3.5L17 11l3 3"/></svg>
          </button>
          <button type="button" class="pf-ic" title="GIF" aria-label="GIF" onclick="openGifPicker('gc');return false;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="3.5"/><text x="12" y="15.2" font-family="Arial,Helvetica,sans-serif" font-size="7.3" font-weight="700" letter-spacing="0.3" text-anchor="middle" fill="currentColor" stroke="none">GIF</text></svg>
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

// Free layered text moderation (doxxing/PII, spam, profanity, toxicity —
// see api/moderate-text.js). Called right after verifyHuman() passes and
// before the actual insert, on every post/reply/quote. Defined here in
// common.js (rather than a separate js/moderation.js <script> tag) so it's
// automatically available on every page that already includes common.js,
// with no extra HTML edits needed. Fails open on network errors so a
// moderation-service outage never blocks someone from posting.
async function checkTextModeration(contentType, text, contentRef, errEl) {
  // Instant local pass first (doxxing regex +, if the model's already
  // warm, an in-browser toxicity read) — see checkTextLocal above. Never
  // adds real latency: the toxicity model is bounded by
  // LOCAL_TOXICITY_TIMEOUT_MS, and the regex check is instant either
  // way. The server call below still always runs and is still what
  // actually decides soft_flag/human_review and gets logged — this only
  // short-circuits the obvious block cases so the person doesn't have
  // to wait on a round trip to find out.
  const local = await checkTextLocal(text);
  if (local.decision === 'block') {
    showErr(errEl, "This looks like it breaks our rules — please revise and try again.");
    return false;
  }
  try {
    const res = await fetch('/api/moderate-text', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: currentSession.user.id, contentType, text, contentRef: contentRef ?? null }),
    });
    if (!res.ok) return true; // fail open on outage
    const { decision } = await res.json();
    if (decision === 'block') {
      showErr(errEl, "This looks like it breaks our rules — please revise and try again.");
      return false;
    }
    // 'allow', 'soft_flag', and 'human_review' all let the post through;
    // soft_flag/human_review are logged server-side for the admin queue
    // (see admin_get_flagged_content() in moderation_pipeline.sql).
    return true;
  } catch {
    return true; // fail open — never block a real user because of a network hiccup
  }
}

// Server-side media enforcement (see api/moderate-media.js) — the
// backstop that closes the bypass the client-side nsfwjs check in
// uploadMedia() can't: someone with devtools open and a valid session
// can skip the browser check entirely by inserting straight through
// supabase-js, but they can't make a 'pending' row visible themselves
// — only this endpoint (or an admin) can flip that, since
// moderation_media_pipeline.sql's RESTRICTIVE policy hides anything
// that isn't 'visible' from everyone but its author.
//
// Called AFTER the row already exists with moderation_status:
// 'pending' — see submitGlobalCompose()/submitReply() below for the
// call site. Unlike checkTextModeration above, this does NOT fail
// open: a failed request just leaves the row pending (invisible to
// everyone but the author) rather than defaulting it to visible.
async function checkMediaModeration(table, contentId, contentType, mediaUrl, mediaType) {
  try {
    const res = await fetch('/api/moderate-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: currentSession.user.id, table, contentId, contentType, mediaUrl, mediaType,
      }),
    });
    if (!res.ok) return { decision: 'human_review' };
    return await res.json();
  } catch {
    return { decision: 'human_review' };
  }
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
  if (!ensureCaptchaRevealed('gc-captcha')) return;
  if (!(await verifyHuman('gc-captcha', errEl))) return;
  if (!(await checkTextModeration('text', body, null, errEl))) return;

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
    // media_url present -> insert hidden ('pending') until the server-side
    // check below flips it; see moderation_media_pipeline.sql's
    // RESTRICTIVE select policy. Text-only posts skip straight to
    // 'visible' (default) since checkTextModeration already gated them.
    const { data, error } = await sb.from('posts').insert({
      author_id: currentSession.user.id,
      body, media_url, media_type,
      poll_options: poll?.poll_options || null,
      poll_ends_at: poll?.poll_ends_at || null,
      scheduled_at,
      reply_audience: getReplyAudience('gc'),
      ...(media_url ? { moderation_status: 'pending' } : {}),
    }).select('*, profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified,verification_type)').single();
    if (error) throw error;

    if (media_url) {
      stEl.textContent = 'Checking upload…';
      const mod = await checkMediaModeration('posts', data.id, 'post', media_url, media_type);
      if (mod.decision === 'block') {
        stEl.textContent = '';
        showErr(errEl, "Your post was published but the media didn't pass review, so it's hidden from others.");
      } else if (mod.decision === 'human_review') {
        stEl.textContent = '';
        showErr(errEl, "Your post is up, but the media needs a quick manual review before others can see it.");
      }
    }

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
          ${captchaCardHtml('rpc-captcha')}
        </div>
      </div>
      <div class="gc-spacer" aria-hidden="true"></div>
      <div class="pf-toolbar gc-toolbar">
        <div class="pf-icons">
          <button type="button" class="pf-ic" title="Media" aria-label="Media" onclick="document.getElementById('rpc-file').click();return false;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10.5" r="1.6"/><path d="m4 17 5-5 3.5 3.5L17 11l3 3"/></svg>
          </button>
          <button type="button" class="pf-ic" title="GIF" aria-label="GIF" onclick="openGifPicker('rpc');return false;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="3.5"/><text x="12" y="15.2" font-family="Arial,Helvetica,sans-serif" font-size="7.3" font-weight="700" letter-spacing="0.3" text-anchor="middle" fill="currentColor" stroke="none">GIF</text></svg>
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
  if (!ensureCaptchaRevealed('rpc-captcha')) return;
  if (!(await verifyHuman('rpc-captcha', errEl))) return;
  if (!(await checkTextModeration('chat', body, targetPostId, errEl))) return;

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
      body, media_url, media_type,
      ...(media_url ? { moderation_status: 'pending' } : {}),
    }).select('*, profile:profiles(username,display_name,avatar_url,verified,verification_type)').single();
    if (error) throw error;

    if (media_url) {
      stEl.textContent = 'Checking upload…';
      const mod = await checkMediaModeration('replies', data.id, 'reply', media_url, media_type);
      if (mod.decision === 'block') {
        showErr(errEl, "Your reply was posted but the media didn't pass review, so it's hidden from others.");
      } else if (mod.decision === 'human_review') {
        showErr(errEl, 'Your reply is up, but the media needs a quick manual review before others can see it.');
      }
    }

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

// #sidebar (the right-hand "Search / Trending / Who to follow" column)
// is position:fixed with its own overflow-y:auto, deliberately taken out
// of normal document flow so it stays put while the feed scrolls (see
// the CSS comment above #sidebar's rule for why). Being a fixed element
// with an independent scroll box, whether the mouse wheel actually
// lands on IT — rather than chaining straight past it to the document —
// is left entirely to each browser/OS's own wheel-to-scroll-container
// resolution, which has proven inconsistent in the wild: some desktop
// setups only ever scroll the document (i.e. only the native scrollbar
// track works), leaving #sidebar's own content stuck. Handling wheel
// input on #sidebar ourselves removes that ambiguity so it scrolls the
// same way everywhere. Runs on every page since #sidebar is shared
// markup; pages without it (login, signup, etc.) just no-op below.
function wireFixedColumnWheelScroll(el) {
  if (!el || el.__wheelScrollWired) return;
  el.__wheelScrollWired = true;
  el.addEventListener('wheel', e => {
    if (e.deltaY === 0 || el.scrollHeight <= el.clientHeight) return;
    const atTop = el.scrollTop <= 0;
    const atBottom = Math.ceil(el.scrollTop + el.clientHeight) >= el.scrollHeight;
    // At either edge, let the event carry on as normal (e.g. so an
    // overscroll past the bottom can still fall through to the page)
    // instead of trapping the wheel gesture with nowhere left to go.
    if ((atTop && e.deltaY < 0) || (atBottom && e.deltaY > 0)) return;
    el.scrollTop += e.deltaY;
    e.preventDefault();
  }, { passive: false });
}
document.addEventListener('DOMContentLoaded', () => {
  wireFixedColumnWheelScroll(document.getElementById('sidebar'));
});

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
    .select('id,username,display_name,avatar_url,verified,verification_type')
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
        <img class="avatar pfp-md${avSqClass(profile)}" src="${esc(avatarUrl(profile.avatar_url))}" alt="" loading="lazy" decoding="async">
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
  // Reuses the already-resolved session from auth.js instead of calling
  // sb.auth.getSession() again here — see the note above
  // ensureFeedPrereqsLoaded() for why: four of these used to each call
  // getSession() independently and run concurrently via Promise.all,
  // which is exactly the pattern that can deadlock supabase-js's
  // internal navigator.locks-based auth lock (a known upstream issue —
  // concurrent getSession() calls can queue behind each other and never
  // resolve). authReady/currentSession are already the single source of
  // truth for "who's logged in" everywhere else in this file (see
  // renderWhoToFollow() above), so just reading them here removes the
  // redundant network+lock round trip entirely, not just the race.
  if (typeof authReady !== 'undefined') await authReady;
  const session = currentSession;
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
  if (isLiked) spawnLikeBurst(btn);
}

// Fires a quick radial burst of small dots out of an action icon's
// center (see .act-burst-particle in style.css). Uses
// getBoundingClientRect() + position:fixed particles rather than
// appending inside the button itself, since .act has overflow:hidden
// for its own frosted-glass press effect and would clip anything
// bigger than the pill. Shared by like/save/repost/quote/share/
// comment — colorVar picks which action color (--like, --save,
// --repost, --share, --maroon) the particles render in, so every
// action gets the same flourish in its own themed color. Same effect
// on mobile and desktop — it's plain viewport math, no separate
// mobile path.
function spawnActionBurst(btn, colorVar) {
  const icon = btn.querySelector('svg') || btn;
  const r = icon.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  const count = 8;
  for (let i = 0; i < count; i++) {
    const angle = (Math.PI * 2 * i) / count + (Math.random() * 0.4 - 0.2);
    const dist = 16 + Math.random() * 10;
    const dot = document.createElement('span');
    dot.className = 'act-burst-particle';
    dot.style.left = `${cx}px`;
    dot.style.top = `${cy}px`;
    dot.style.setProperty('--tx', `${Math.cos(angle) * dist}px`);
    dot.style.setProperty('--ty', `${Math.sin(angle) * dist}px`);
    dot.style.background = `var(${colorVar})`;
    dot.addEventListener('animationend', () => dot.remove());
    document.body.appendChild(dot);
  }
}
// Kept as a thin wrapper — spawnLikeBurst(btn) is still called by name
// wherever the like flow used to reference it directly.
function spawnLikeBurst(btn) { spawnActionBurst(btn, '--like'); }

// Comment doesn't toggle a persistent state the way like/save/repost
// do — tapping it just opens a composer — so instead of hooking every
// call site's replyOnclick string, one delegated listener bursts
// whichever reply button was actually tapped, covering every page
// that renders one (feed cards, thread OP, lightbox, replies) with a
// single rule.
document.addEventListener('click', (e) => {
  const replyBtn = e.target.closest('.act.reply:not(.disabled)');
  if (replyBtn) spawnActionBurst(replyBtn, '--maroon');
});

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
  // See the comment in ensureLikesLoaded() above — reuses the shared
  // session instead of calling sb.auth.getSession() again.
  if (typeof authReady !== 'undefined') await authReady;
  const session = currentSession;
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
  if (isBookmarked) spawnActionBurst(btn, '--save');
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
  // See the comment in ensureLikesLoaded() above — reuses the shared
  // session instead of calling sb.auth.getSession() again.
  if (typeof authReady !== 'undefined') await authReady;
  const session = currentSession;
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
  // See the comment in ensureLikesLoaded() above — reuses the shared
  // session instead of calling sb.auth.getSession() again.
  if (typeof authReady !== 'undefined') await authReady;
  const session = currentSession;
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
  // See the comment in ensureLikesLoaded() above — reuses the shared
  // session instead of calling sb.auth.getSession() again. currentSession
  // already tracks sign-in/out from other tabs via auth.js's
  // onAuthStateChange listener, so this stays accurate without its own
  // network+lock round trip.
  if (typeof authReady !== 'undefined') await authReady;
  if (!currentSession) return;
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
  // Immediate purple tap feedback the moment the icon is pressed —
  // previously the button only turned purple via the plain CSS
  // :active pseudo-class (unreliable on touch, and gone the instant
  // the finger lifts) or after actually completing a repost from the
  // dropdown, so tapping the icon itself gave no visible response.
  const btn = wrap.querySelector('.act.repost');
  if (btn) {
    btn.classList.add('rp-tapped');
    setTimeout(() => btn.classList.remove('rp-tapped'), 300);
  }
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
  if (isReposted && btn) spawnActionBurst(btn, '--repost');
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
  if (!qp) return `<div class="qp-embed-gone">Original post is no longer available.</div>`;
  // A post that was auto-removed because its author got suspended
  // (see admin_suspend_user() in supabase/admin_panel_advanced.sql,
  // which soft-deletes every post/reply of theirs and sets
  // deleted_by_suspension so this can be told apart from an ordinary
  // self/mod deletion) gets Twitter's own wording instead of the
  // generic "no longer available" — same idea whether the profile
  // itself got suspended after this embed was cached (qp.profile
  // .banned) or the post row already reflects it (qp.deleted_by_suspension).
  if (qp.is_deleted || qp.profile?.banned) {
    if (qp.deleted_by_suspension || qp.profile?.banned) {
      return `<div class="qp-embed-gone">This post is from a suspended account.</div>`;
    }
    return `<div class="qp-embed-gone">Original post is no longer available.</div>`;
  }
  return `
  <div class="qp-embed" onclick="event.stopPropagation();location.href='${postUrl(qp)}'">
    <div class="ph">${pcNameHtml(qp.profile)}<span class="dt">${timeAgo(qp.created_at)}</span></div>
    <div class="pb">${renderBody((qp.body || '').slice(0, 280))}</div>
    ${renderMedia(qp.media_url, qp.media_type, '', qp)}
    ${linkCardHtml(qp.body, !!qp.media_url)}
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
        .select('id,body,media_url,media_type,created_at,is_deleted,deleted_by_suspension,author_id,profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified,verification_type,banned)')
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
  if (!ensureCaptchaRevealed('qm-captcha')) return;
  if (!(await verifyHuman('qm-captcha', errEl))) return;
  if (!(await checkTextModeration('text', body, quotingPostId, errEl))) return;
  btn.disabled = true;
  try {
    const { data, error } = await sb.from('posts').insert({
      author_id: currentSession.user.id,
      body,
      quote_of: quotingPostId
    }).select('*, profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified,verification_type)').single();
    if (error) throw error;
    // We already have the quoted post in postCache (it's whatever card
    // the Quote button was clicked from) — reuse it directly instead of
    // an extra fetch. Falls back to attachQuotedPosts() if it's missing.
    if (postCache[quotingPostId]) data.quoted = postCache[quotingPostId];
    else await attachQuotedPosts([data]);
    cachePost(data);
    // Same repost/quote family as doRepost() above — burst the
    // original post's repost icon (if it's visible anywhere on
    // screen) so quoting gets the same instant flourish as a plain
    // repost, not just a silently-closing modal.
    const quotedRepostBtn = document.getElementById(`rpmenu-${quotingPostId}`)?.querySelector('.act.repost');
    if (quotedRepostBtn) spawnActionBurst(quotedRepostBtn, '--repost');
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
  if (btn) spawnActionBurst(btn, '--share');
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
    // A fast re-tap can land while the browser's own chrome (the
    // address bar hiding/showing as the page scrolls) is still
    // resizing the visual viewport — the getBoundingClientRect() read
    // inside positionMenuDd() above can get measured mid-transition,
    // landing the dropdown noticeably off from the "···" button for a
    // moment. Re-measuring one and two frames later catches and
    // corrects that with no visible flicker (same double-rAF
    // self-correction used for the fullscreen video layout in
    // video-player.js's ttvSyncFullscreenLayout). Each callback
    // re-checks .open in case a second fast tap already closed the
    // menu again by the time it runs.
    requestAnimationFrame(() => {
      if (!wrap.classList.contains('open')) return;
      positionMenuDd(wrap);
      requestAnimationFrame(() => {
        if (wrap.classList.contains('open')) positionMenuDd(wrap);
      });
    });
    // Quick icon pop on the "···" button itself, same flourish family
    // as the like/reply/share/bookmark buttons (see .pc-menu-btn.menu-open
    // in style.css) — works identically for a mouse click on desktop and
    // a tap on mobile since it's just a class toggle off the same click.
    const btn = wrap.querySelector('.pc-menu-btn');
    if (btn) {
      btn.classList.remove('menu-open');
      void btn.offsetWidth;
      btn.classList.add('menu-open');
    }
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
// The dropdown is positioned with real viewport pixel coordinates
// (see positionMenuDd() above), computed once at the moment it opens.
// Scrolling doesn't touch those inline styles again, so the menu used
// to just hang there floating in place — visibly detached from its
// own "···" button — while the whole page scrolled underneath it.
// Closing it as soon as a scroll happens (capture:true so this also
// catches scrolling inside a nested scrollable container, not just
// the window) matches how these transient action menus behave
// elsewhere (X/Twitter, most mobile apps): scrolling dismisses them
// rather than leaving them stranded mid-air.
document.addEventListener('scroll', () => {
  document.querySelectorAll('.pc-menu-wrap.open, .rp-menu-wrap.open').forEach(w => w.classList.remove('open'));
}, { passive: true, capture: true });

// Avatar + name/handle building blocks used by the tweet-style post card.
function pcAvatarHtml(profile, sizeClass = '') {
  const uname = profile?.username || 'unknown';
  return `<a class="pc-avatar-lnk" href="${profileUrl(uname)}">` +
         `<img class="avatar pc-avatar ${sizeClass}${avSqClass(profile)}" src="${esc(avatarUrl(profile?.avatar_url))}" alt="" loading="lazy" decoding="async"></a>`;
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
        <button class="pc-menu-danger" onclick="openReport(${target})">${t('action.report')}</button>
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
    // getSessionSafe() (see auth.js) races this against a timeout and
    // falls back to currentSession, so a stuck Supabase auth lock can
    // never wedge the delete button forever.
    const session = await getSessionSafe();
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
    // getSessionSafe() (see auth.js) protects against a stuck Supabase
    // auth lock hanging this forever.
    const session = await getSessionSafe();
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
  document.querySelectorAll(`[data-pb="${id}"]`).forEach(elx => { elx.innerHTML = renderBodyToggle(newBody); });
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
// This is a single-screen modal — name, picture, description and
// privacy up front; rules and moderators are optional add-ons tucked
// under a collapsible "Advanced" section below, so nothing that used
// to only be settable at creation time (rules, mods) was dropped, it
// just isn't gated behind a multi-step wizard anymore. Same markup
// renders on mobile and desktop — the shared .modal-bg/.modal shell
// already centers and caps width responsively, so there's no separate
// mobile layout to keep in sync.
let ccWiz = null; // reset fresh every time the modal opens — see openCreateCommunityModal()

function ccFreshWiz() {
  return {
    name: '', description: '', isPrivate: false,
    avatarBlob: null, avatarPreviewUrl: null,
    bannerBlob: null, bannerPreviewUrl: null,
    rules: [],  // [{title, description}]
    mods: [],   // [{id, username, display_name, avatar_url}]
    advancedOpen: false,
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
      <div class="cc-head">
        <h2>Create a community</h2>
        <a class="modal-close" href="#" onclick="closeCreateCommunityModal();return false;">&#10005;</a>
      </div>
      <div class="errmsg" id="cc-err" style="display:none;margin:0 16px 8px;"></div>
      <div id="cc-step-body" class="cc-step-body"></div>
      <div class="cc-nav">
        <button type="button" class="cc-nav-back" onclick="closeCreateCommunityModal()">Cancel</button>
        <button type="button" class="modal-btn cc-nav-next" id="cc-next-btn" onclick="submitCreateCommunityWizard()">Create community</button>
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
  if (!el.classList.contains('open')) {
    el.classList.add('open');
    lockScroll();
  }
  renderCcForm();
}

function closeCreateCommunityModal() {
  const el = document.getElementById('cc-modal-bg');
  if (el?.classList.contains('open')) { el.classList.remove('open'); unlockScroll(); }
  // Drop the blob: URLs for any picked avatar/banner before losing
  // the only reference to them (ccWiz) — otherwise the browser holds
  // that memory for the rest of the page's lifetime.
  if (ccWiz?.avatarPreviewUrl) URL.revokeObjectURL(ccWiz.avatarPreviewUrl);
  if (ccWiz?.bannerPreviewUrl) URL.revokeObjectURL(ccWiz.bannerPreviewUrl);
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
    .slice(0, 20);
}

// ── SINGLE-SCREEN FORM ──
function renderCcForm() {
  if (!ccWiz) return;
  const body = document.getElementById('cc-step-body');
  body.innerHTML = `
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

    <label>Name</label>
    <input type="text" id="cc-name" maxlength="20" placeholder="e.g. Shounen Fans" value="${esc(ccWiz.name)}">

    <label>Description</label>
    <textarea id="cc-desc" rows="3" maxlength="80" placeholder="What's this community about? Optional.">${esc(ccWiz.description)}</textarea>

    <div class="cc-priv-row">
      <div><div class="cc-priv-title">Private community</div><div class="cc-priv-sub">Only members can see posts</div></div>
      <button type="button" class="cc-switch${ccWiz.isPrivate ? ' on' : ''}" id="cc-priv-switch" onclick="ccTogglePrivate()" aria-pressed="${ccWiz.isPrivate}"></button>
    </div>

    <button type="button" class="cc-advanced-toggle" onclick="ccToggleAdvanced()">
      ${ccWiz.advancedOpen ? 'Hide' : 'Add'} rules &amp; moderators <span class="cc-hint">(optional)</span>
    </button>

    <div id="cc-advanced" style="${ccWiz.advancedOpen ? '' : 'display:none;'}">
      <label>Rules</label>
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

      <label style="margin-top:16px;">Moderators</label>
      ${ccWiz.mods.length ? `<div class="comm-mods-list" id="cc-mods-list">${ccWiz.mods.map(m => `
        <div class="who-row comm-mod-row">
          <img class="avatar pfp-md${avSqClass(m)}" src="${esc(avatarUrl(m.avatar_url))}" loading="lazy" decoding="async" alt="">
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
    </div>`;

  document.getElementById('cc-avatar-file').addEventListener('change', (e) => {
    const file = e.target.files[0]; e.target.value = '';
    const errEl = document.getElementById('cc-err');
    if (!file || !validateFile(file, errEl)) return;
    clearErr(errEl);
    openCropModal(file, 'square', (cropped) => {
      if (ccWiz.avatarPreviewUrl) URL.revokeObjectURL(ccWiz.avatarPreviewUrl);
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
      if (ccWiz.bannerPreviewUrl) URL.revokeObjectURL(ccWiz.bannerPreviewUrl);
      ccWiz.bannerBlob = cropped;
      ccWiz.bannerPreviewUrl = URL.createObjectURL(cropped);
      document.getElementById('cc-banner-wrap').style.setProperty('--banner-img', `url('${ccWiz.bannerPreviewUrl}')`);
    });
  });
  const modInput = document.getElementById('cc-mod-search');
  if (modInput) {
    modInput.addEventListener('input', () => {
      clearTimeout(ccWiz._modDebounce);
      ccWiz._modDebounce = setTimeout(() => ccRunModSearch(modInput.value), 250);
    });
  }
  setTimeout(() => document.getElementById('cc-name')?.focus(), 0);
}

function ccTogglePrivate() {
  ccWiz.isPrivate = !ccWiz.isPrivate;
  document.getElementById('cc-priv-switch').classList.toggle('on', ccWiz.isPrivate);
  document.getElementById('cc-priv-switch').setAttribute('aria-pressed', ccWiz.isPrivate);
}

function ccToggleAdvanced() {
  ccWiz.advancedOpen = !ccWiz.advancedOpen;
  renderCcForm();
}

function ccAddRule() {
  const titleEl = document.getElementById('cc-rule-title');
  const descEl = document.getElementById('cc-rule-desc');
  const title = titleEl.value.trim();
  const description = descEl.value.trim();
  const errEl = document.getElementById('cc-err');
  if (!title) { showErr(errEl, 'Give the rule a short title.'); return; }
  if (ccWiz.rules.length >= 20) { showErr(errEl, 'That\u2019s enough rules for now.'); return; }
  clearErr(errEl);
  ccWiz.rules.push({ title, description });
  ccWiz.advancedOpen = true;
  renderCcForm();
}
function ccRemoveRule(i) {
  ccWiz.rules.splice(i, 1);
  ccWiz.advancedOpen = true;
  renderCcForm();
}

async function ccRunModSearch(q) {
  const resultsEl = document.getElementById('cc-mod-results');
  if (!resultsEl) return;
  q = q.trim();
  if (!q) { resultsEl.innerHTML = ''; return; }
  const takenIds = new Set([currentSession.user.id, ...ccWiz.mods.map(m => m.id)]);
  const { data, error } = await sb.from('profiles').select('id,username,display_name,avatar_url,verified,verification_type')
    .ilike('username', `%${q}%`).limit(6);
  if (error || !data) { resultsEl.innerHTML = ''; return; }
  const candidates = data.filter(p => !takenIds.has(p.id));
  if (!candidates.length) { resultsEl.innerHTML = `<div class="comm-about-empty">No matching members found.</div>`; return; }
  resultsEl.innerHTML = candidates.map(p => `
    <div class="who-row comm-mod-search-row">
      <img class="avatar pfp-md${avSqClass(p)}" src="${esc(avatarUrl(p.avatar_url))}" loading="lazy" decoding="async" alt="">
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
  ccWiz.advancedOpen = true;
  renderCcForm();
}
function ccRemoveMod(id) {
  ccWiz.mods = ccWiz.mods.filter(m => m.id !== id);
  ccWiz.advancedOpen = true;
  renderCcForm();
}

async function submitCreateCommunityWizard() {
  const errEl = document.getElementById('cc-err');
  const btn = document.getElementById('cc-next-btn');
  clearErr(errEl);

  const name = document.getElementById('cc-name').value.trim();
  if (name.length < 3) { showErr(errEl, 'Give it a name — at least 3 characters.'); return; }
  if (name.length > 20) { showErr(errEl, 'Name is too long (max 20 characters).'); return; }
  if (slugify(name).length < 3) { showErr(errEl, 'That name needs at least a few letters or numbers.'); return; }
  ccWiz.name = name;
  const description = document.getElementById('cc-desc').value.trim();
  if (description.length > 80) { showErr(errEl, 'Description is too long (max 80 characters).'); return; }
  ccWiz.description = description;

  btn.disabled = true;
  btn.textContent = 'Creating\u2026';
  try {
    const baseSlug = slugify(ccWiz.name);
    // A second community with the same/similar name just gets a
    // numeric suffix on its slug (shounen-fans-2, shounen-fans-3, …)
    // rather than blocking on the name being taken — same as how
    // usernames vs display names work elsewhere in the app; the name
    // shown to people doesn't have to be unique, only the URL slug.
    let slug = baseSlug, attempt = 0, data, error;
    while (attempt < 6) {
      ({ data, error } = await sb.from('communities').insert({
        name: ccWiz.name, slug, description: ccWiz.description || null, is_private: ccWiz.isPrivate, created_by: currentSession.user.id
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
    btn.disabled = false;
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
  if (!el.classList.contains('open')) {
    el.classList.add('open');
    lockScroll();
  }
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
  if (!el.classList.contains('open')) {
    el.classList.add('open');
    lockScroll();
  }
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
  // A post the person hid via the long-press preview (see hidePost() /
  // isPostHidden() below) renders as nothing at all, everywhere
  // postCardHtml() is called from — feed, profile, search, bookmarks,
  // lists — since this is the one shared render path all of those go
  // through. The hidden-id list lives client-side only (localStorage),
  // so it's a per-browser "don't show me this again", not a real
  // delete or block.
  if (isPostHidden(p.id)) return '';
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
        ${p.body ? `<div class="pb" data-pb="${p.id}">${renderBodyToggle(p.body)}</div>` : ''}
        ${p.quote_of ? quotedPostHtml(p.quoted) : ''}
        ${p.article_id ? articleCardHtml(p._promoArticle) : ''}
        ${renderMedia(p.media_url, p.media_type, '', p)}
        ${pollHtml(p)}
        ${linkCardHtml(p.body, !!(p.media_url || p.quote_of || p.article_id || p.poll_options?.length))}
        ${postActionsHtml(p, { replyOnclick: `openReplyPopup('${p.id}')` })}
      </div>
    </div>
  </div>`;
}

// Clicking anywhere on a post card opens its comments — unless the
// click actually landed on a link, button, the "···" menu, or an
// input, all of which handle themselves.
function cardClick(ev, postId, username = null) {
  if (ev.target.closest('a, button, input, textarea, .pc-menu-wrap, .rp-menu-wrap, .pm')) return;
  // A press that just triggered the long-press preview (see below)
  // still ends in a pointerup + synthesized click on this same card
  // (touch implicitly captures to whatever element the press started
  // on) — without this check that click would fire right after the
  // preview opens and immediately navigate to the thread underneath
  // it. _lpFired is set the instant the preview opens and cleared
  // here so it never leaks into the next, unrelated tap.
  if (_lpFired) { _lpFired = false; ev.preventDefault(); return; }
  location.href = postUrlById(postId, username);
}

// ── LONG-PRESS POST PREVIEW ──────────────────────────────────────
// Holding a post card for ~2 seconds pops it up front-and-center over
// a blurred backdrop (like iOS's "peek" / Android's long-press card
// preview) with a row of quick actions underneath: Hide, Copy text,
// Block, Report. Wired once here via delegated listeners so it works
// on every `.pc` card the app ever renders (feed, profile, search,
// bookmarks, lists) with no per-page setup.
const LP_HOLD_MS = 480; // ~half a second — a deliberate hold, not a sluggish wait
const LP_MOVE_TOLERANCE = 10; // px of finger drift before we treat it as a scroll, not a hold
let _lpTimer = null;
let _lpStartX = 0, _lpStartY = 0;
let _lpPressedCard = null;
let _lpFired = false; // true from the moment the preview opens until cardClick() consumes it

function lpClearTimer() {
  clearTimeout(_lpTimer);
  _lpTimer = null;
  if (_lpPressedCard) { _lpPressedCard.classList.remove('lp-pressing'); _lpPressedCard = null; }
}

document.addEventListener('pointerdown', (ev) => {
  if (ev.pointerType === 'mouse' && ev.button !== 0) return; // ignore right/middle click
  const card = ev.target.closest('.pc[data-post-id]');
  if (!card) return;
  // Don't hijack presses that land on already-interactive bits of the
  // card (like/reply/share/bookmark, the "···" menu, links) — those
  // have their own tap behavior and shouldn't also arm a long-press.
  if (ev.target.closest('a, button, input, textarea, .pc-menu-wrap, .acts')) return;
  lpClearTimer();
  _lpStartX = ev.clientX;
  _lpStartY = ev.clientY;
  const postId = card.dataset.postId;
  _lpPressedCard = card;
  card.classList.add('lp-pressing');
  _lpTimer = setTimeout(() => {
    _lpFired = true;
    openLongPressPreview(postId);
    lpClearTimer();
  }, LP_HOLD_MS);
});
document.addEventListener('pointermove', (ev) => {
  if (!_lpTimer) return;
  if (Math.abs(ev.clientX - _lpStartX) > LP_MOVE_TOLERANCE || Math.abs(ev.clientY - _lpStartY) > LP_MOVE_TOLERANCE) lpClearTimer();
}, { passive: true });
['pointerup', 'pointercancel', 'pointerleave', 'scroll'].forEach(evt => {
  document.addEventListener(evt, lpClearTimer, { passive: true, capture: evt === 'scroll' });
});
// Stops the OS's own text-selection/callout menu from popping up
// mid-hold on mobile browsers and racing our own preview.
document.addEventListener('contextmenu', (ev) => {
  if (ev.target.closest('.pc[data-post-id]')) ev.preventDefault();
});
// Belt-and-suspenders for the same thing: some Android/Chrome builds
// still start a native text selection (the "Copy / Translate / Select
// all" toolbar) on a long-press even with user-select:none set in
// CSS — the CSS property stops the selection from becoming visible/
// draggable, but a couple of WebView versions fire `selectstart`
// once before that's fully honored. Killing the event itself here is
// a second, independent line of defense so nothing can ever slip
// through, on any browser.
document.addEventListener('selectstart', (ev) => {
  if (ev.target.closest && ev.target.closest('.pc[data-post-id]')) ev.preventDefault();
});

function lpOverlayEl() {
  let el = document.getElementById('lp-overlay');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'lp-overlay';
  el.className = 'lp-overlay';
  el.addEventListener('click', (e) => { if (e.target === el) closeLongPressPreview(); });
  document.body.appendChild(el);
  return el;
}

const ICON_LP = {
  hide:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 12s3.75-7 10-7 10 7 10 7-3.75 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/><path d="M4 4l16 16"/></svg>',
  copy:   '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M4 15V6a2 2 0 0 1 2-2h9"/></svg>',
  block:  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="m5.5 5.5 13 13"/></svg>',
  report: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 3v18"/><path d="M5 4h11l-2.5 4L16 12H5"/></svg>'
};

// Renders the popped-up card + action row for `postId` and fades the
// blurred backdrop in. The card inside is a plain re-render of the
// same postCardHtml() markup, but wrapped in a pointer-events:none
// layer — it's a peek, not a functional card, so nothing inside it
// (like/reply/menu/links) is tappable; only the action row below is.
function openLongPressPreview(postId) {
  const p = postCache[postId];
  if (!p) return;
  const overlay = lpOverlayEl();
  if (overlay.classList.contains('open')) return; // already showing one — ignore a stray re-trigger
  if (navigator.vibrate) navigator.vibrate(12);
  const isOwn = currentSession && p.author_id === currentSession.user.id;
  overlay.innerHTML = `
    <div class="lp-card-wrap"><div class="lp-card">${postCardHtml(p)}</div></div>
    <div class="lp-actions">
      <button class="lp-act" data-act="hide">${ICON_LP.hide}<span>Hide post</span></button>
      <button class="lp-act" data-act="copy">${ICON_LP.copy}<span>Copy text</span></button>
      ${isOwn ? '' : `<button class="lp-act" data-act="block">${ICON_LP.block}<span>Block user</span></button>
      <button class="lp-act lp-act-danger" data-act="report">${ICON_LP.report}<span>Report</span></button>`}
    </div>`;
  overlay.querySelector('.lp-actions').addEventListener('click', (e) => {
    const btn = e.target.closest('.lp-act');
    if (btn) handleLpAction(btn.dataset.act, postId);
  });
  document.body.classList.add('oc-sheet-open');
  lockScroll();
  requestAnimationFrame(() => overlay.classList.add('open'));
}

function closeLongPressPreview() {
  const el = document.getElementById('lp-overlay');
  if (!el || !el.classList.contains('open')) return;
  el.classList.remove('open');
  unlockScroll();
  document.body.classList.remove('oc-sheet-open');
  setTimeout(() => { el.innerHTML = ''; }, 260);
}
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeLongPressPreview(); });

function handleLpAction(action, postId) {
  closeLongPressPreview();
  if (action === 'hide') hidePost(postId);
  else if (action === 'copy') copyPostText(postId);
  else if (action === 'block') lpBlockAuthor(postId);
  else if (action === 'report') openReport(postId);
}

// ── HIDE POST — a per-browser "don't show me this again", stored in
// localStorage (no server round-trip, nothing to sync between
// devices). isPostHidden()/postCardHtml() above make sure a hidden
// post simply never renders again anywhere in the app.
function getHiddenPostIds() {
  try { return new Set(JSON.parse(localStorage.getItem('oc_hidden_posts') || '[]')); }
  catch { return new Set(); }
}
function isPostHidden(id) {
  return getHiddenPostIds().has(id);
}
function hidePost(postId) {
  const hidden = getHiddenPostIds();
  hidden.add(postId);
  localStorage.setItem('oc_hidden_posts', JSON.stringify([...hidden]));
  document.querySelectorAll(`[data-post-id="${postId}"]`).forEach(el => {
    el.classList.add('lp-hidden-out');
    setTimeout(() => el.remove(), 160);
  });
  toast("Post hidden. You won't see it again.");
}

// Copies just the post's text (no link, no metadata) to the clipboard.
function copyPostText(postId) {
  const p = postCache[postId];
  const text = (p?.body || '').trim();
  if (!text) { toast('This post has no text to copy.', 'error'); return; }
  const done = () => toast('Post text copied.');
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => prompt('Copy text:', text));
  } else {
    prompt('Copy text:', text);
  }
}

// Blocks the post's author from the long-press menu — same
// confirm-then-blockUser() flow as profile.js's profileMenuBlock(),
// just reached from a post card instead of a profile page.
async function lpBlockAuthor(postId) {
  const p = postCache[postId];
  if (!p) return;
  if (!requireLogin()) return;
  const uname = p.profile?.username;
  if (currentSession && p.author_id === currentSession.user.id) return;
  if (uname && isProtectedFollowUsername(uname)) { toast(`You can't block @${uname}.`, 'error'); return; }
  const ok = await ocConfirm({
    title: uname ? `Block @${uname}?` : 'Block this user?',
    desc: `They won't be able to follow or message you, and you'll stop following each other.`,
    confirmLabel: 'Block',
    danger: true
  });
  if (!ok) return;
  try {
    await blockUser(p.author_id);
    toast(uname ? `Blocked @${uname}.` : 'User blocked.');
    document.querySelectorAll(`[data-post-id="${postId}"]`).forEach(el => el.remove());
  } catch (e) {
    toast(e.message || 'Could not block user.', 'error');
  }
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

// Grey cat/wolf silhouette shown when a user has no avatar_url set.
const DEFAULT_AVATAR = "img/default-avatar.png";

function avatarUrl(url) {
  return url || DEFAULT_AVATAR;
}

// Renders the "author" chunk of a post/reply header: avatar + username,
// linking to that user's profile page. `profile` is the joined row from
// `profiles` (author_id -> profiles.*).
function authorHtml(profile) {
  const uname = profile?.username || 'unknown';
  return `<a class="pfl" href="${profileUrl(uname)}">` +
         `<img class="avatar pfp-sm${avSqClass(profile)}" src="${esc(avatarUrl(profile?.avatar_url))}" alt="" loading="lazy" decoding="async">` +
         `${esc(profile?.display_name || uname)}${vBadge(profile)}</a>`;
}

function esc(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}

// The verified checkmark shown right after a display name. `profile`
// is any joined `profiles` row that included the `verified` and
// `verification_type` columns in its select() — see admin.js's
// adminVerifyUserRowHtml and the admin_verify_user() RPC. Every
// name-rendering helper below (pcNameHtml, whoRowHtml, authorHtml,
// userRowHtml) calls this, so setting a verification type from the
// admin panel is enough to make the right badge show up everywhere.
//
// verification_type is 'blue' | 'gold' | 'purple'. Legacy rows that
// have verified=true but no type (set before this column existed)
// fall back to 'purple' so nothing changes visually for them.
//
// Uses the glossy 3D badge art in img/verified-badge-<type>-256.png
// as the source image — it's rendered ~4-16x larger than its
// on-screen size (16-21px) so it stays crisp at any display density
// instead of softening the way a source sized 1:1 to the CSS box
// would. All three files share the exact same crop/canvas as each
// other, so swapping the src here is the only thing that needs to
// change — no per-type CSS sizing.
function badgeType(profile) {
  if (!profile?.verified) return null;
  const t = profile.verification_type;
  return (t === 'blue' || t === 'gold' || t === 'purple') ? t : 'purple';
}

function vBadge(profile) {
  const type = badgeType(profile);
  return type
    ? `<img class="verified-badge" src="img/verified-badge-${type}-256.png" alt="Verified" title="Verified">`
    : '';
}

// Gold verification (organizations/businesses) gets a squared-off
// profile picture instead of a circle, matching X/Twitter's
// convention for gold-badge accounts — see .avatar-square in
// css/style.css. Drop this into any avatar <img>'s class list
// alongside avatarUrl(profile.avatar_url) for that same profile.
function avSqClass(profile) {
  return badgeType(profile) === 'gold' ? ' avatar-square' : '';
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

// Posts can run up to 500 characters (see the maxlength on every
// compose/reply textarea), but a card full of 500 characters of text
// makes the feed feel like a wall of text — so anything over this
// gets collapsed behind a "View more" toggle, Twitter/X-style.
const BODY_TRUNCATE_LEN = 200;

// Same job as renderBody() above, but for the "full" render spots
// (feed cards, thread detail, profile replies, lightbox caption) as
// opposed to the already-short preview snippets (board.js tsnip,
// notification snippets, quoted-post embeds) that truncate to their
// own, shorter length on purpose and don't need a toggle.
//
// Renders BOTH the short and full text up front and just flips which
// one is visible on click (see togglePostBody() below) — no need to
// track ids or re-render, and it works correctly even when the same
// post appears more than once on the page (feed + lightbox, etc.)
// since the toggle finds its own state via .closest('.pb-wrap')
// rather than matching on the post id.
function renderBodyToggle(body) {
  body = body || '';
  if (body.length <= BODY_TRUNCATE_LEN) return renderBody(body);
  // Cut on a word boundary when there's a reasonably close one, so the
  // truncated preview doesn't end mid-word.
  let cut = body.slice(0, BODY_TRUNCATE_LEN);
  const lastSpace = cut.lastIndexOf(' ');
  if (lastSpace > BODY_TRUNCATE_LEN - 40) cut = cut.slice(0, lastSpace);
  return `<span class="pb-wrap">` +
    `<span class="pb-short">${renderBody(cut)}&hellip;</span>` +
    `<span class="pb-full" hidden>${renderBody(body)}</span>` +
    `<button type="button" class="pb-toggle" onclick="event.stopPropagation();togglePostBody(this)">${t ? t('post.viewMore') : 'View more'}</button>` +
    `</span>`;
}

function togglePostBody(btn) {
  const wrap = btn.closest('.pb-wrap');
  if (!wrap) return;
  const short = wrap.querySelector('.pb-short');
  const full = wrap.querySelector('.pb-full');
  if (!short || !full) return;
  const expanding = full.hidden; // currently collapsed -> this click expands it
  short.hidden = expanding;
  full.hidden = !expanding;
  btn.textContent = (expanding ? (t ? t('post.viewLess') : 'View less') : (t ? t('post.viewMore') : 'View more'));
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
  if (file.type.startsWith('audio/')) return 'audio'; // voice notes (chat.js) — not offered in the post composer's file picker
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

// ── "I'm not a robot" CAPTCHA (homemade, not a third-party service) ──
// Gates sign up, log in, and every posting action (new post, community
// post, top-level reply, inline comment reply). Shared across all of
// them instead of duplicated per-page so there's exactly one place
// that knows how to render/verify the checkbox.
//
// This is NOT Turnstile/reCAPTCHA/hCaptcha — it's a self-hosted
// checkbox backed by api/verify-captcha.js: a signed time-trap (you
// can't have clicked a box you were shown less than ~0.7s ago) plus a
// honeypot field bots tend to fill and people never see. See that
// file for the full writeup, including its documented limits.
//
// Needs no setup/API keys — unlike the old Turnstile version this
// ships fully enabled out of the box. captchaConfigured() is kept as
// a single on/off switch in case you ever want to disable the check
// entirely (e.g. while developing locally).
function captchaConfigured() { return true; }

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
// shimmer placeholder that loadCaptchaChallenge() swaps for the
// homemade checkbox once the challenge loads (see below). Used both
// for the static containers baked into signup/login/index/community's HTML
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

const _captchaState = {}; // containerId -> { nonce, ts, sig, ticked, target }

// Client-only fallback challenge, used when api/verify-captcha.js
// can't be reached at all (no CAPTCHA_SECRET configured, or this
// project deployed somewhere with no serverless /api/* support —
// e.g. plain static hosting). It has no server signature to verify,
// so verifyHuman() below checks it entirely in the browser: the same
// slider + the same >=700ms time-trap + the same honeypot, just
// without the tamper-proof HMAC. Weaker than the real server check
// (documented in api/verify-captcha.js), but it means the "Quick
// security check" never becomes a dead end that blocks sign up/log
// in/posting just because the backend isn't wired up yet.
function makeLocalChallenge() {
  return { nonce: `local-${Math.random().toString(36).slice(2)}`, ts: Date.now(), sig: null, local: true };
}

// Fetches a fresh signed challenge from api/verify-captcha.js (GET)
// and wires up a drag-to-fit puzzle-piece slider for containerId that
// arms on a successful drag. This replaced a plain "tap this box"
// checkbox — a script can fire one click event against a selector in
// a fraction of a second, but landing a drag within a few px of a
// randomised target (never the same spot twice, generated fresh with
// every challenge) takes an actual pointer path, which is meaningfully
// more work for a basic/scripted bot to fake. Still layered on top of
// (not a replacement for) the real server-side check in
// api/verify-captcha.js — the slider is a friction/UX upgrade, the
// signed time-trap + honeypot is what actually gets verified.
async function loadCaptchaChallenge(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  // Always start from the shimmer, even on a retry — otherwise a
  // second attempt launched from the reload button would jump
  // straight from the error state to the slider with no loading cue.
  const startBody = el.querySelector('.captcha-card-body');
  if (startBody) startBody.innerHTML = '<div class="captcha-skeleton"></div>';
  try {
    const res = await fetch('/api/verify-captcha');
    let challenge;
    try { challenge = await res.json(); } catch (parseErr) { challenge = null; }
    // A misconfigured deployment (no CAPTCHA_SECRET set on Vercel) or
    // this project being served somewhere with no /api/* serverless
    // functions at all (plain static hosting, `npx serve`, opening
    // the file directly) makes this GET fail — that used to leave the
    // shimmer spinning forever with nothing on screen to tell the
    // person anything was wrong. Any failure now falls through to the
    // catch below, which no longer dead-ends: it hands the card a
    // fully client-side challenge (see makeLocalChallenge below) so
    // the check still renders and still works, just without the
    // server-signed round trip.
    if (!res.ok || !challenge?.nonce) throw new Error(challenge?.error || `verify-captcha ${res.status}`);
    // Target kept away from both edges (18%-82%) so there's always
    // real travel distance on either side of it.
    const target = 0.18 + Math.random() * 0.64;
    _captchaState[containerId] = { ...challenge, ticked: false, target };
  } catch (e) {
    console.warn('captcha: server challenge unavailable, falling back to local check —', e.message || e);
    const target = 0.18 + Math.random() * 0.64;
    _captchaState[containerId] = { ...makeLocalChallenge(), ticked: false, target };
  }
  const body = el.querySelector('.captcha-card-body');
  if (!body) return;
  body.innerHTML = `
    <div class="cs-wrap">
      <div class="cs-label" id="${containerId}-label">Drag the piece into the slot</div>
      <div class="cs-track" id="${containerId}-track">
        <div class="cs-fill" id="${containerId}-fill"></div>
        <div class="cs-target" id="${containerId}-tgt" aria-hidden="true"></div>
        <div class="cs-handle" id="${containerId}-handle" role="slider" tabindex="0"
             aria-label="Drag to complete the puzzle and confirm you're human"
             aria-valuemin="0" aria-valuemax="100" aria-valuenow="0">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
            <path d="M6 3h4a2 2 0 0 0 4 0h4a1 1 0 0 1 1 1v4a2 2 0 0 0 0 4v4a1 1 0 0 1-1 1h-4a2 2 0 0 0-4 0H6a1 1 0 0 1-1-1v-4a2 2 0 0 0 0-4V4a1 1 0 0 1 1-1Z"/>
          </svg>
        </div>
      </div>
    </div>
    <input type="text" class="captcha-hp" name="url" tabindex="-1" autocomplete="off" aria-hidden="true">
  `;
  wireCaptchaSlider(containerId, el, body);
}

// Swaps the captcha card's shimmer for an explicit "couldn't load"
// message plus a reload control, instead of the old behavior of
// leaving the shimmer running forever with no way out. The reload
// control itself always spins (a plain loading-ring look, not a
// static icon) so it reads as "tap to try loading again" at a glance.
function showCaptchaLoadError(containerId, el) {
  const body = el.querySelector('.captcha-card-body');
  if (!body) return;
  body.innerHTML = `
    <div class="captcha-load-err">
      <span class="captcha-load-err-text">Couldn't load the security check.</span>
      <button type="button" class="captcha-reload-btn" aria-label="Reload security check">
        <svg class="captcha-reload-spinner" viewBox="0 0 50 50" aria-hidden="true">
          <circle class="crs-track" cx="25" cy="25" r="18"></circle>
          <circle class="crs-arc" cx="25" cy="25" r="18"></circle>
        </svg>
      </button>
    </div>`;
  const btn = body.querySelector('.captcha-reload-btn');
  btn?.addEventListener('click', () => {
    if (btn.disabled) return;
    btn.disabled = true;
    loadCaptchaChallenge(containerId);
  });
}

// Pointer + keyboard drag logic for the puzzle slider. Kept separate
// from loadCaptchaChallenge() so the markup-building and the
// interaction wiring don't have to be re-read together.
function wireCaptchaSlider(containerId, el, body) {
  const state  = _captchaState[containerId];
  const track  = body.querySelector('.cs-track');
  const handle = body.querySelector('.cs-handle');
  const fill   = body.querySelector('.cs-fill');
  const tgt    = body.querySelector('.cs-target');
  const label  = body.querySelector('.cs-label');
  if (!state || !track || !handle) return;

  const HANDLE = 36; // must match .cs-handle width in css/style.css

  function metrics() {
    const tw = track.clientWidth || 260;
    return { tw, max: Math.max(1, tw - HANDLE) };
  }
  function placeTarget() {
    const { tw } = metrics();
    tgt.style.left = `${Math.round(state.target * tw - HANDLE / 2)}px`;
  }
  function setHandle(px) {
    const { max } = metrics();
    const clamped = Math.min(max, Math.max(0, px));
    handle.style.left = `${clamped}px`;
    fill.style.width = `${clamped + HANDLE}px`;
    handle.setAttribute('aria-valuenow', String(Math.round((clamped / max) * 100)));
    return clamped;
  }
  placeTarget();
  setHandle(0);

  function resolveAt(px) {
    if (state.ticked) return;
    const { tw, max } = metrics();
    const targetPx = Math.min(max, Math.max(0, state.target * tw - HANDLE / 2));
    const tolerance = Math.max(12, HANDLE * 0.55);
    if (Math.abs(px - targetPx) <= tolerance) {
      succeed(targetPx);
    } else {
      fail(px);
    }
  }
  function succeed(px) {
    setHandle(px);
    track.classList.add('is-checking');
    label.textContent = 'Checking…';
    setTimeout(() => {
      state.ticked = true;
      track.classList.remove('is-checking');
      track.classList.add('is-ok');
      label.textContent = "You're verified.";
      handle.setAttribute('aria-checked', 'true');
      el.classList.remove('is-error');
      el.classList.add('is-verified');
    }, 500 + Math.random() * 250);
  }
  function fail(px) {
    setHandle(px);
    track.classList.add('is-shake');
    label.textContent = 'Not quite — try again';
    setTimeout(() => {
      track.classList.remove('is-shake');
      setHandle(0);
      label.textContent = 'Drag the piece into the slot';
    }, 420);
  }

  let dragging = false;
  let originLeft = 0;
  let pointerId = null;

  function currentLeft() { return parseFloat(handle.style.left || '0') || 0; }

  function onMove(clientX) {
    if (!dragging) return;
    setHandle(originLeft + (clientX - dragging));
  }
  handle.addEventListener('pointerdown', (e) => {
    if (state.ticked) return;
    e.preventDefault();
    dragging = e.clientX;
    originLeft = currentLeft();
    pointerId = e.pointerId;
    handle.setPointerCapture(pointerId);
    handle.classList.add('dragging');
  });
  handle.addEventListener('pointermove', (e) => {
    if (!dragging || e.pointerId !== pointerId) return;
    onMove(e.clientX);
  });
  function endDrag(e) {
    if (!dragging) return;
    dragging = false;
    handle.classList.remove('dragging');
    try { handle.releasePointerCapture(pointerId); } catch (err) {}
    resolveAt(currentLeft());
  }
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);

  // Keyboard fallback: arrow keys nudge the piece freely; Enter/Space
  // commits the current position (same "did it land in the zone?"
  // check a released drag gets).
  handle.addEventListener('keydown', (e) => {
    if (state.ticked) return;
    const { max } = metrics();
    const step = Math.max(6, max * 0.06);
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') {
      e.preventDefault();
      setHandle(currentLeft() + step);
    } else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') {
      e.preventDefault();
      setHandle(currentLeft() - step);
    } else if (e.key === 'Home') {
      e.preventDefault();
      setHandle(0);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      resolveAt(currentLeft());
    }
  });

  window.addEventListener('resize', () => { placeTarget(); if (!state.ticked) setHandle(0); });
}

// Renders (once) the checkbox into the card at #<containerId> if a
// check is actually still needed right now; hides/no-ops otherwise.
// Safe to call every time a composer opens.
function renderCaptchaIfNeeded(containerId) {
  const el = document.getElementById(containerId);
  if (!el) return;
  if (!captchaConfigured() || isHumanVerified()) { el.style.display = 'none'; el.classList.remove('is-error'); return; }
  el.style.display = '';
  el.classList.remove('is-verified');
  if (_captchaState[containerId] !== undefined) return;
  _captchaState[containerId] = null; // claim it so a second call doesn't double-fetch
  loadCaptchaChallenge(containerId);
}
function initAllCaptchas() {
  // Log in / sign up no longer show a security check (removed — see
  // login.html/signup.html). Every "post/reply/publish" captcha (pf,
  // cf, rf, ea, sa, gc, rpc, qm) instead stays hidden until the
  // person actually taps Post/Reply/Publish — see
  // ensureCaptchaRevealed() — so composers open clean instead of
  // leading with a security check.
}

// First tap of Post/Reply/Publish on a form whose captcha hasn't been
// shown yet: reveals the check (loading it if needed) and scrolls it
// into view, but does NOT let that same tap go on to submit — the
// person taps again once they've ticked it. Returns true once the
// card is already visible (so the caller can proceed straight to
// verifyHuman()), false the first time (caller should stop there).
function ensureCaptchaRevealed(containerId) {
  if (!captchaConfigured() || isHumanVerified()) return true;
  const el = document.getElementById(containerId);
  const alreadyShown = !!el && el.style.display !== 'none';
  renderCaptchaIfNeeded(containerId);
  if (!alreadyShown) {
    el?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return false;
  }
  return true;
}

// Resolves true once the person is verified human (already verified
// recently, or just ticked the box in containerId and it passes
// server-side verification). Shows an error in errEl and returns
// false otherwise. Call this right before the network request a
// captcha is meant to gate (sign up, log in, submit post/reply).
async function verifyHuman(containerId, errEl) {
  if (!captchaConfigured() || isHumanVerified()) return true;
  const cardEl = document.getElementById(containerId);
  const state = _captchaState[containerId];
  const hp = cardEl?.querySelector('.captcha-hp')?.value || '';
  if (!state || !state.ticked) {
    cardEl?.classList.add('is-error');
    setTimeout(() => cardEl?.classList.remove('is-error'), 500);
    showErr(errEl, "Please check the box to confirm you're not a robot.");
    return false;
  }
  // Locally-issued challenge (see makeLocalChallenge) — no server to
  // round-trip to, so apply the same rules (honeypot empty, and the
  // tick already implies the >=700ms drag/checking delay) right here
  // instead of POSTing something api/verify-captcha.js could never
  // verify without its secret.
  if (state.local) {
    if (hp) {
      showErr(errEl, 'Bot check failed — please try again.');
      cardEl?.classList.remove('is-verified');
      cardEl?.classList.add('is-error');
      delete _captchaState[containerId];
      renderCaptchaIfNeeded(containerId);
      return false;
    }
    markHumanVerified();
    cardEl?.classList.add('is-verified');
    return true;
  }
  try {
    const res = await fetch('/api/verify-captcha', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nonce: state.nonce, ts: state.ts, sig: state.sig, hp })
    });
    const out = await res.json();
    if (!out.success) {
      showErr(errEl, 'Bot check failed — please try again.');
      cardEl?.classList.remove('is-verified');
      cardEl?.classList.add('is-error');
      delete _captchaState[containerId];
      renderCaptchaIfNeeded(containerId);
      return false;
    }
    markHumanVerified();
    cardEl?.classList.add('is-verified');
    return true;
  } catch (e) {
    // Network/parse failure hitting the server check (not a 503 from
    // GET, which is already handled above — this is the POST call
    // itself failing, e.g. the connection dropping). Fall back to the
    // same local acceptance rather than stranding a person who
    // legitimately ticked the box.
    if (hp) {
      showErr(errEl, 'Bot check failed — please try again.');
      return false;
    }
    markHumanVerified();
    cardEl?.classList.add('is-verified');
    return true;
  }
}
document.addEventListener('DOMContentLoaded', initAllCaptchas);

// ── 100s POSTING COOLDOWN — client-side spam brake shared by every
// "create a post/reply" action. Kept in localStorage (not a JS
// variable) so it survives this site's real full-page navigations —
// see supabase/post_cooldown.sql for the server-side trigger that
// actually enforces this (client-side alone can always be bypassed by
// someone calling the Supabase API directly). ──
const POST_COOLDOWN_MS = 100000;
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

// Re-encodes a still image to WebP at a high quality setting, and —
// this was the missing half — downscales it first if it's larger
// than anything the app ever actually displays an image at.
// WebP's lossy mode at this quality is visually indistinguishable
// from the source but usually runs 25–50% smaller, and it also
// strips EXIF/metadata bloat as a side effect of the canvas
// round-trip. Falls back to the original file untouched if the
// browser can't decode it, or if re-encoding somehow comes out
// larger (e.g. an already-optimized WebP/AVIF).
//
// MAX_IMAGE_DIMENSION: modern phone cameras commonly shoot
// 3000–4000px+ on the long edge. Nothing in this app ever renders an
// image larger than the user's own screen (feed thumbnails, the
// lightbox, chat attachments — none exceed a typical device's
// viewport), so shipping the original resolution just means every
// viewer's browser downloads pixels it immediately downscales for
// display. Capping the long edge at 2048px is comfortably above any
// real device viewport (including lightbox full-screen on a 4K
// monitor at 2x DPR) while cutting pixel count — and therefore file
// size and decode time — dramatically for typical camera photos.
// 0.92 → 0.85: still a very high-quality setting with no visible
// banding/artifacting on photos, but meaningfully smaller; paired
// with the dimension cap this is where most of the load-time win
// comes from.
const IMAGE_COMPRESS_QUALITY = 0.85;
const MAX_IMAGE_DIMENSION = 2048;
async function compressImageFile(file) {
  // Defensive guard: drawing a GIF to a canvas only captures its
  // first frame, which would silently kill the animation. GIFs are
  // routed to compressGifFile() instead — see uploadMedia().
  if (file.type === 'image/gif') return file;
  try {
    const bitmap = await createImageBitmap(file);
    let { width, height } = bitmap;
    if (width > MAX_IMAGE_DIMENSION || height > MAX_IMAGE_DIMENSION) {
      const scale = MAX_IMAGE_DIMENSION / Math.max(width, height);
      width = Math.round(width * scale);
      height = Math.round(height * scale);
    }
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height);
    bitmap.close?.();
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/webp', IMAGE_COMPRESS_QUALITY));
    // Deliberately NOT falling back to the original file when the
    // re-encoded version isn't smaller: the canvas round-trip is what
    // strips EXIF/GPS metadata (phones embed the exact location a photo
    // was taken at by default). Falling back to the raw original here
    // would silently re-introduce that location leak on any image that
    // was already well-optimized. A slightly larger, metadata-free file
    // is the right tradeoff.
    if (!blob) return file;
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

// ── CLIENT-SIDE NSFW DETECTION (images & video) ──
// Runs entirely in-browser via TensorFlow.js — the pixels never leave
// the device for this pass. Uses nsfwjs (MIT-licensed, open source),
// which wraps a MobileNetV2 classifier trained to score five classes:
// Drawing, Hentai, Neutral, Porn, Sexy.
//
// IMPORTANT — this is a first-pass filter, not a security boundary.
// It stops obviously explicit uploads before they ever hit the network
// (saves the person a wasted upload, saves you storage/bandwidth, and
// gives instant feedback instead of a wait), but like any client-side
// check it can be bypassed by disabling JS or calling the storage API
// directly. The actual backstop is nsfw-service/main.py's /classify
// endpoint running server-side on the uploaded file — this client pass
// complements that, it doesn't replace it. Don't remove the server-side
// check on the strength of this one.
const NSFWJS_VERSION = '4.4.0';
const TFJS_VERSION = '4.22.0';
let _nsfwModelPromise = null;
async function loadNSFWModel() {
  if (!_nsfwModelPromise) {
    _nsfwModelPromise = (async () => {
      // nsfwjs expects tf as a global (`window.tf`), so it has to land
      // first and stay attached rather than just being imported locally.
      if (!window.tf) {
        window.tf = await import(`https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@${TFJS_VERSION}/+esm`);
      }
      const nsfwjs = await import(`https://cdn.jsdelivr.net/npm/nsfwjs@${NSFWJS_VERSION}/+esm`);
      // MobileNetV2 variant: smaller download and faster inference than
      // the default InceptionV3 model — the right tradeoff for a check
      // that runs on every image/video upload in a browser tab.
      return await nsfwjs.load('MobileNetV2');
    })().catch((err) => {
      _nsfwModelPromise = null; // let the next upload retry instead of caching a permanent failure
      throw err;
    });
  }
  return _nsfwModelPromise;
}

// Combines the five class probabilities into one score. Sexy is
// weighted down relative to Porn/Hentai so borderline results (gym
// selfies, swimwear, etc.) don't get treated the same as explicit
// content — matches the intent of the severity bands in
// api/moderate-text.js (soft_flag vs. block).
function nsfwScoreFromPredictions(predictions) {
  const byClass = Object.fromEntries(predictions.map(p => [p.className, p.probability]));
  const porn = byClass.Porn || 0;
  const hentai = byClass.Hentai || 0;
  const sexy = byClass.Sexy || 0;
  return Math.max(porn, hentai, sexy * 0.6);
}

const NSFW_BLOCK_THRESHOLD = 0.85;
const NSFW_REVIEW_THRESHOLD = 0.6;

async function checkImageNSFW(file) {
  try {
    const model = await loadNSFWModel();
    const bitmap = await createImageBitmap(file);
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d').drawImage(bitmap, 0, 0);
    bitmap.close?.();
    const predictions = await model.classify(canvas);
    const score = nsfwScoreFromPredictions(predictions);
    return {
      nsfwProbability: score,
      decision: score >= NSFW_BLOCK_THRESHOLD ? 'block' : score >= NSFW_REVIEW_THRESHOLD ? 'soft_flag' : 'allow',
      predictions,
    };
  } catch {
    // Fail open: a model-load failure (offline, ad-blocker, old
    // browser, first-load-too-slow) should never stop someone from
    // posting a normal image. The server-side pass is still the real
    // backstop for anything this misses.
    return { nsfwProbability: 0, decision: 'allow', predictions: [] };
  }
}

// Video isn't decoded frame-by-frame in full (slow, memory-heavy in a
// tab) — instead it's sampled at a fixed cadence, capped at
// MAX_VIDEO_SAMPLES frames so a long video can't hang the upload flow,
// and scanning stops early the moment a clear block-level frame is
// found.
const VIDEO_SAMPLE_INTERVAL_S = 2;
const MAX_VIDEO_SAMPLES = 15;
async function checkVideoNSFW(file, onStatus) {
  const notify = onStatus || (() => {});
  let objectUrl;
  try {
    const model = await loadNSFWModel();
    const video = document.createElement('video');
    video.muted = true;
    video.playsInline = true;
    objectUrl = URL.createObjectURL(file);
    video.src = objectUrl;
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('video decode failed'));
    });

    const duration = video.duration || 0;
    const sampleCount = Math.min(MAX_VIDEO_SAMPLES, Math.max(1, Math.floor(duration / VIDEO_SAMPLE_INTERVAL_S) || 1));
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext('2d');

    let maxScore = 0;
    for (let i = 0; i < sampleCount; i++) {
      const t = sampleCount === 1 ? 0 : (duration / sampleCount) * i;
      await new Promise((resolve) => {
        video.onseeked = resolve;
        video.currentTime = t;
      });
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const predictions = await model.classify(canvas);
      maxScore = Math.max(maxScore, nsfwScoreFromPredictions(predictions));
      notify(`Checking video… (${i + 1}/${sampleCount})`);
      if (maxScore >= NSFW_BLOCK_THRESHOLD) break; // clear block already found, no need to keep scanning
    }

    return {
      nsfwProbability: maxScore,
      decision: maxScore >= NSFW_BLOCK_THRESHOLD ? 'block' : maxScore >= NSFW_REVIEW_THRESHOLD ? 'soft_flag' : 'allow',
      framesSampled: sampleCount,
    };
  } catch {
    return { nsfwProbability: 0, decision: 'allow', framesSampled: 0 }; // fail open, same reasoning as checkImageNSFW
  } finally {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}

// ── CLIENT-SIDE TEXT PRE-CHECK ──
// Runs the same doxxing/PII regexes as api/moderate-text.js locally
// (instant, free) plus an in-browser toxicity read using transformers.js
// (Xenova's WASM/ONNX port of HuggingFace transformers) running
// Xenova/toxic-bert — a quantized port of the same unitary/toxic-bert
// model the server already uses, so the two scores should track closely.
//
// The profanity wordlist is deliberately NOT duplicated here: shipping
// it in a browser-readable JS file would just hand out the exact
// evasion list to anyone who opens devtools, so that check stays
// server-only. The server call in checkTextModeration() below remains
// authoritative either way — it's the one that actually gets logged to
// the admin queue and can't be skipped by disabling JS. This local pass
// exists purely so obvious cases surface instantly instead of waiting
// on a round trip, and so text moderation still gives useful feedback
// if the moderation server is ever temporarily down.
const CLIENT_PII_PATTERNS = [
  { label: 'phone_number', pattern: /(?:\+?\d{1,3}[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}\b/g },
  { label: 'email_leak', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { label: 'ssn_like', pattern: /\b\d{3}-\d{2}-\d{4}\b/g },
];
function detectDoxxingLocal(text) {
  const hits = [];
  for (const { label, pattern } of CLIENT_PII_PATTERNS) {
    pattern.lastIndex = 0;
    if (pattern.test(text)) hits.push(label);
  }
  return hits;
}

const TRANSFORMERS_VERSION = '2.17.2';
let _toxicityPipelinePromise = null;
async function loadToxicityPipeline() {
  if (!_toxicityPipelinePromise) {
    _toxicityPipelinePromise = (async () => {
      const { pipeline, env } = await import(`https://cdn.jsdelivr.net/npm/@xenova/transformers@${TRANSFORMERS_VERSION}/+esm`);
      env.allowLocalModels = false; // always fetch the model from HF's CDN, never expect local files
      return await pipeline('text-classification', 'Xenova/toxic-bert', { quantized: true });
    })().catch((err) => {
      _toxicityPipelinePromise = null;
      throw err;
    });
  }
  return _toxicityPipelinePromise;
}
// Opportunistic background preload — starts the (one-time, then cached
// by the browser) model download on page load without blocking
// anything, so by the time someone actually submits a post the model is
// usually already warm. If it fails or is still loading, checkTextLocal
// below just falls open with no local opinion — never a blocker.
loadToxicityPipeline().catch(() => {});

const TEXT_BLOCK_THRESHOLD = 0.9;
const TEXT_REVIEW_THRESHOLD = 0.65;
const LOCAL_TOXICITY_TIMEOUT_MS = 1200;
async function checkTextLocal(text) {
  const doxHits = detectDoxxingLocal(text);
  if (doxHits.length) return { decision: 'human_review', toxicity: 0, doxHits };
  try {
    const toxic = await Promise.race([
      (async () => {
        const classify = await loadToxicityPipeline();
        const results = await classify(text.slice(0, 512));
        return Math.max(0, ...results.filter(r => !/non.?toxic/i.test(r.label)).map(r => r.score));
      })(),
      new Promise((resolve) => setTimeout(() => resolve(0), LOCAL_TOXICITY_TIMEOUT_MS)),
    ]);
    return {
      decision: toxic >= TEXT_BLOCK_THRESHOLD ? 'block' : toxic >= TEXT_REVIEW_THRESHOLD ? 'soft_flag' : 'allow',
      toxicity: toxic,
      doxHits: [],
    };
  } catch {
    return { decision: 'allow', toxicity: 0, doxHits: [] }; // fail open — server pass is still authoritative
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
  }
  // Video is intentionally NOT re-encoded client-side before upload.
  // It used to be run through ffmpeg.wasm here, but that's a full
  // software video encode running single-threaded in the browser —
  // it could take a minute or more per clip, and since it's already
  // near-lossless it frequently didn't even shrink the file (the old
  // code fell back to the original whenever the re-encode wasn't
  // smaller). That made "post a video" feel broken. Uploading the
  // original file straight away is dramatically faster and is what
  // makes video posting fast; compressVideoFile() is kept below,
  // unused, in case server-side/background transcoding is wired up
  // later.

  // Client-side NSFW pass — after compression (checking the smaller,
  // already-normalized file is faster) and before the file ever leaves
  // the device. See checkImageNSFW/checkVideoNSFW above for what this
  // does and doesn't guarantee.
  if (type === 'image') {
    notify('Checking image…');
    const nsfw = await checkImageNSFW(file);
    if (nsfw.decision === 'block') {
      throw new Error("This image looks like it may violate our content rules and can't be uploaded. If you think this is a mistake, contact support.");
    }
  } else if (type === 'video') {
    notify('Checking video…');
    const nsfw = await checkVideoNSFW(file, notify);
    if (nsfw.decision === 'block') {
      throw new Error("This video looks like it may violate our content rules and can't be uploaded. If you think this is a mistake, contact support.");
    }
  }

  notify('Uploading…');
  const ext = file.name.split('.').pop().toLowerCase();
  const path = `${crypto.randomUUID()}.${ext}`;
  // "Failed to fetch" out of storage.upload() is almost always a
  // dropped connection mid-request (flaky wifi/mobile data) rather
  // than anything wrong with the file — one silent retry clears the
  // large majority of those without bothering the person, instead of
  // failing their message on the first hiccup.
  let error;
  for (let attempt = 0; attempt < 2; attempt++) {
    ({ error } = await sb.storage.from(MEDIA_BUCKET).upload(path, file, {
      cacheControl: '3600',
      upsert: false,
      contentType: file.type
    }));
    if (!error) break;
    if (attempt === 0 && /failed to fetch/i.test(error.message || '')) {
      notify('Connection hiccup, retrying…');
      await new Promise(r => setTimeout(r, 800));
      continue;
    }
    break;
  }
  if (error) throw friendlyUploadError(error);
  const { data } = sb.storage.from(MEDIA_BUCKET).getPublicUrl(path);
  return { media_url: data.publicUrl, media_type: type };
}

// Turns raw Supabase/network errors from uploadMedia() into something
// a person can actually act on, instead of surfacing internals like
// "mime type audio/webm is not supported" or a bare "Failed to fetch"
// straight from the browser.
function friendlyUploadError(error) {
  const msg = error?.message || '';
  if (/mime type/i.test(msg)) {
    return new Error("That file type isn't supported yet. Try a JPG/PNG/GIF image, an MP4 video, or re-recording the voice note.");
  }
  if (/failed to fetch/i.test(msg)) {
    return new Error("Couldn't reach the server — check your connection and try again.");
  }
  if (/exceeded the maximum allowed size|payload too large/i.test(msg)) {
    return new Error('That file is too large to send.');
  }
  return error;
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
    return `<div class="pm">${ttvHtml(url, { postId: owner?.id || null })}</div>`;
  }
  return `<div class="pm"><img src="${esc(url)}" class="${extraClass}" alt="" onclick="openLightbox(${idx})" loading="lazy" decoding="async"></div>`;
}

// ─────────────────────────────────────────────────────────────
// LINK CARDS — Bluesky-style unfurl card for a bare URL in a post's
// body: an image on top (only when the target site actually has one
// — og:image-less sites get a text-only card, never a blank/broken
// image box) followed by title, description, and a small globe +
// domain footer.
//
// Only ever renders for the FIRST link in the body, and only when
// the post has no other embed of its own (attached photo/video,
// quote post, poll, or promoted article) — same one-embed-slot rule
// Bluesky/X use, so a post with both a pasted link and an attached
// image shows the image, not a duplicate/competing card for the link
// typed alongside it.
//
// Cards render as an empty placeholder first, then hydrate lazily
// (IntersectionObserver, same lazy-on-scroll-into-view pattern the
// view counter uses below) via the /api/link-preview proxy — see
// that file for why this can't just be a client-side fetch().
const LINK_CARD_URL_RE = /https?:\/\/[^\s<>"']+/;
function firstUrlInBody(body) {
  if (!body) return null;
  const m = LINK_CARD_URL_RE.exec(body);
  if (!m) return null;
  // Same trailing-punctuation trim linkifyText() does, so a link
  // typed at the end of a sentence ("check this out: https://x.com/y.")
  // doesn't try to unfurl "https://x.com/y." with the period attached.
  const trailing = m[0].match(/[.,!?:;]+$/);
  return trailing ? m[0].slice(0, -trailing[0].length) : m[0];
}

// hasOtherEmbed: true if the post already renders a photo/video, quote,
// poll, or promoted-article embed — see the one-embed-slot note above.
function linkCardHtml(body, hasOtherEmbed) {
  if (hasOtherEmbed) return '';
  const url = firstUrlInBody(body);
  if (!url) return '';
  const key = `lc-${Math.random().toString(36).slice(2)}`;
  return `<div class="lc-card lc-pending" id="${key}" data-lc-url="${esc(url)}" onclick="event.stopPropagation()"></div>`;
}

const _lcCache = new Map(); // url -> preview object (or a pending Promise)
async function fetchLinkPreview(url) {
  if (_lcCache.has(url)) return _lcCache.get(url);
  const p = (async () => {
    try {
      const res = await fetch(`api/link-preview?url=${encodeURIComponent(url)}`);
      if (!res.ok) return null;
      const data = await res.json();
      return (data.title || data.description || data.image) ? data : null;
    } catch {
      return null;
    }
  })();
  _lcCache.set(url, p);
  const resolved = await p;
  _lcCache.set(url, resolved); // replace the in-flight promise with its result
  return resolved;
}

function lcDomainSvg() {
  return '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" style="width:13px;height:13px;flex:none;"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>';
}

async function hydrateLinkCard(el) {
  if (!el || el.dataset.lcHydrated) return;
  el.dataset.lcHydrated = '1';
  const url = el.dataset.lcUrl;
  const preview = await fetchLinkPreview(url);
  // The card (or the whole post under it) may have been removed from
  // the DOM while the fetch was in flight — bail rather than write
  // into a detached node.
  if (!el.isConnected) return;
  if (!preview) { el.remove(); return; }
  el.classList.remove('lc-pending');
  el.innerHTML = `
    <a href="${esc(preview.url)}" target="_blank" rel="noopener noreferrer nofollow" class="lc-link">
      ${preview.image ? `<div class="lc-img"><img src="${esc(preview.image)}" alt="" loading="lazy" decoding="async" onerror="this.closest('.lc-img').remove()"></div>` : ''}
      <div class="lc-text">
        ${preview.title ? `<div class="lc-title">${esc(preview.title)}</div>` : ''}
        ${preview.description ? `<div class="lc-desc">${esc(preview.description)}</div>` : ''}
        <div class="lc-domain">${lcDomainSvg()}<span>${esc(preview.domain)}</span></div>
      </div>
    </a>`;
}

const _lcObserver = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) {
      hydrateLinkCard(entry.target);
      _lcObserver.unobserve(entry.target);
    }
  });
}, { rootMargin: '200px' }) : null;

function watchLinkCardsIn(root = document) {
  const nodes = root.matches?.('.lc-card') ? [root] : [];
  nodes.push(...root.querySelectorAll('.lc-card'));
  nodes.forEach(el => _lcObserver ? _lcObserver.observe(el) : hydrateLinkCard(el));
}

// Auto-watches any link card added anywhere on the page, same as
// trackViewsIn()'s MutationObserver above — individual pages/renders
// never have to remember to call watchLinkCardsIn() themselves.
if ('MutationObserver' in window) {
  new MutationObserver((mutations) => {
    for (const m of mutations) {
      m.addedNodes.forEach(node => {
        if (node.nodeType !== 1) return;
        watchLinkCardsIn(node);
      });
    }
  }).observe(document.documentElement, { childList: true, subtree: true });
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
        <div class="lb-bottom-dock">
          <div class="lb-caption-overlay" id="lb-caption-overlay" hidden></div>
          <div class="lb-mobile-bar" id="lb-mobile-bar"></div>
        </div>
      </div>
      <aside class="lb-sidebar" id="lb-sidebar"></aside>
    </div>`;
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
  renderLbCaptionOverlay(item.owner);
  if (!el.classList.contains('open')) {
    el.classList.add('open');
    lockScroll();
  }
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
    <div class="op-detail-body" data-pb="${owner.id}">${renderBodyToggle(owner.body || '')}</div>
    <div class="op-detail-meta"><span data-dt="${owner.id}">${fullDateTime(owner.created_at)}${editedSuffix(owner)}</span> &middot; <span class="op-detail-views">${ICON.views}<b>${fmtCount(owner.view_count)}</b> Views</span></div>
    <div class="op-detail-divider"></div>
    ${actions}
    <div class="op-detail-divider"></div>
    <a class="lb-sb-replybox" href="${href}">
      <img class="avatar pfp-sm${avSqClass(currentProfile)}" src="${esc(avatarUrl(currentProfile?.avatar_url))}" decoding="async" alt="">
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

// Floating attribution card overlaid on the media itself (mobile
// only — see .lb-caption-overlay), same idea as X's fullscreen video
// view: avatar/name/handle/Follow riding right on top of the media,
// with the post body as a short caption underneath. Follow starts
// hidden until we know the real follow state (a stale "Follow" on an
// account you already follow reads as broken), then swaps in once
// isFollowing() resolves.
async function renderLbCaptionOverlay(owner) {
  const el = document.getElementById('lb-caption-overlay');
  if (!el) return;
  if (!owner) { el.innerHTML = ''; el.hidden = true; return; }
  const uname = owner.profile?.username || 'unknown';
  const authorId = owner.author_id || owner.profile?.id;
  const isSelf = currentProfile && authorId === currentProfile.id;
  const showFollow = !isSelf && !!currentSession && !!authorId;
  el.hidden = false;
  el.innerHTML = `
    <div class="lb-cap-row">
      ${pcAvatarHtml(owner.profile)}
      <div class="lb-cap-names">
        <a class="nm" href="${profileUrl(uname)}">${esc(owner.profile?.display_name || uname)}${vBadge(owner.profile)}</a>
        <a class="handle" href="${profileUrl(uname)}">@${esc(uname)}</a>
      </div>
      ${showFollow ? `<button type="button" class="lb-cap-follow" id="lb-cap-follow-btn" onclick="lbToggleFollow('${authorId}', this)">${t('action.follow')}</button>` : ''}
    </div>
    ${owner.body ? `<div class="lb-cap-text">${esc(owner.body)}</div>` : ''}`;
  if (showFollow) {
    try {
      const following = await isFollowing(authorId);
      const btn = document.getElementById('lb-cap-follow-btn');
      if (btn && following) { btn.classList.add('following'); btn.textContent = t('action.following'); }
    } catch {}
  }
}

async function lbToggleFollow(userId, btn) {
  if (!requireLogin()) return;
  const following = btn.classList.contains('following');
  btn.disabled = true;
  try {
    if (following) {
      const { error } = await unfollowUser(userId);
      if (error) throw error;
      btn.classList.remove('following');
      btn.textContent = t('action.follow');
    } else {
      const { error } = await followUser(userId);
      if (error) throw error;
      btn.classList.add('following');
      btn.textContent = t('action.following');
    }
  } catch (e) {
    alert(e.message || 'Could not update follow status.');
  } finally {
    btn.disabled = false;
  }
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
  // Re-append every time, not just on first creation: this picker is
  // a single lazily-created element shared by every composer (home
  // inline box, global "pen" compose modal, reply modal). Whichever
  // composer opened it FIRST fixes its position in the DOM — so if
  // it was ever opened from the home composer before the pen/compose
  // modal existed, it would sit earlier in <body> than that modal and
  // render silently behind it (same z-index, DOM order decides who
  // paints on top) the next time you opened it from there. Moving it
  // to the end of <body> on every open guarantees it's always the
  // topmost layer no matter which composer asked for it or in what
  // order they were first used.
  document.body.appendChild(el);
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
  const el = emojiModalEl();
  // Same re-append-on-open fix as openGifPicker() above — guarantees
  // this shared picker always paints above whichever composer opened
  // it, regardless of which one created it first.
  document.body.appendChild(el);
  if (el.classList.contains('open') && emojiPickerTarget === prefix) { closeEmojiPicker(); return; }
  emojiPickerTarget = prefix;
  el.classList.add('open');
  lockScroll();
  const search = el.querySelector('#emoji-search');
  search.value = '';
  renderEmojiGrid('');
  setTimeout(() => search.focus(), 50);
}
function closeEmojiPicker() {
  const el = document.getElementById('emoji-modal-bg');
  if (!el || !el.classList.contains('open')) return;
  el.classList.remove('open');
  unlockScroll();
}
// Same floating centered-modal shell as the GIF picker (gifModalEl())
// instead of a small absolutely-positioned popover pinned to the
// button's coordinates — that positioning broke down on the mobile
// full-screen composer (popover anchored off-screen or clipped by
// the modal's own overflow:hidden), which is what made the emoji
// picker look "cut off." A centered modal can't clip like that.
function emojiModalEl() {
  let el = document.getElementById('emoji-modal-bg');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'emoji-modal-bg';
  el.className = 'modal-bg';
  el.addEventListener('click', e => { if (e.target === el) closeEmojiPicker(); });
  el.innerHTML = `
    <div class="modal emoji-modal">
      <a class="modal-close" href="#" onclick="closeEmojiPicker();return false;">&#10005;</a>
      <h2>Emoji</h2>
      <div class="gif-search-row cx-emoji-search-row">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
        <input type="text" id="emoji-search" placeholder="Search emoji" autocomplete="off">
      </div>
      <div class="cx-emoji-grid" id="emoji-grid"></div>
    </div>`;
  document.body.appendChild(el);
  el.querySelector('#emoji-grid').addEventListener('click', e => {
    const btn = e.target.closest('.cx-emoji-item');
    if (!btn || !emojiPickerTarget) return;
    insertAtCursor(document.getElementById(`${emojiPickerTarget}-body`), btn.dataset.e);
  });
  el.querySelector('#emoji-search').addEventListener('input', e => renderEmojiGrid(e.target.value));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && el.classList.contains('open')) closeEmojiPicker();
  });
  return el;
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
  const row = document.createElement('div');
  row.className = 'cx-poll-opt-row';
  const inp = document.createElement('input');
  inp.type = 'text'; inp.className = 'cx-poll-opt'; inp.maxLength = 25;
  inp.placeholder = `Choice ${n + 1}`;
  const rm = document.createElement('button');
  rm.type = 'button'; rm.className = 'cx-poll-opt-rm'; rm.title = 'Remove option'; rm.setAttribute('aria-label', 'Remove option');
  rm.innerHTML = '&#10005;';
  rm.onclick = () => { row.remove(); renumberPollOptions(prefix); };
  row.append(inp, rm);
  wrap.appendChild(row);
  inp.focus();
  if (wrap.querySelectorAll('.cx-poll-opt').length >= 4) {
    const addBtn = document.querySelector(`#${prefix}-poll-box .cx-poll-add`);
    if (addBtn) addBtn.disabled = true;
  }
}
// Keeps placeholders sequential ("Choice 1"/"Choice 2"/…) after an
// option in the middle gets removed, so a gap left by deleting
// Choice 2 doesn't leave the remaining option still reading "Choice 3."
function renumberPollOptions(prefix) {
  const wrap = document.getElementById(`${prefix}-poll-opts`);
  if (!wrap) return;
  wrap.querySelectorAll('.cx-poll-opt').forEach((inp, i) => { inp.placeholder = `Choice ${i + 1}`; });
  const addBtn = document.querySelector(`#${prefix}-poll-box .cx-poll-add`);
  if (addBtn) addBtn.disabled = false;
}
function removePoll(prefix) {
  if (composeExtras[prefix]) composeExtras[prefix].poll = null;
  const box = document.getElementById(`${prefix}-poll-box`);
  if (!box) return;
  box.hidden = true;
  box.querySelectorAll('.cx-poll-opt-row').forEach((row, i) => {
    const inp = row.querySelector('.cx-poll-opt');
    if (i > 1) row.remove(); else if (inp) inp.value = '';
  });
  renumberPollOptions(prefix);
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
  // Tracks the previous preview's blob: URL so it can be revoked
  // below — without this, picking a file, then picking a different
  // one (or removing it) leaked the earlier blob for the rest of the
  // page's lifetime instead of freeing it immediately.
  let previewUrl = null;
  const revokePreview = () => { if (previewUrl) { URL.revokeObjectURL(previewUrl); previewUrl = null; } };
  input.addEventListener('change', () => {
    revokePreview();
    preview.innerHTML = '';
    const file = input.files[0];
    if (!file) return;
    const errEl = errElId ? document.getElementById(errElId) : null;
    if (!validateFile(file, errEl)) { input.value = ''; return; }
    clearErr(errEl);
    if (composeExtras[prefix]) composeExtras[prefix].gifUrl = null; // file + GIF are mutually exclusive
    removePoll(prefix); // media & poll are mutually exclusive
    const url = URL.createObjectURL(file);
    previewUrl = url;
    const type = mediaTypeFor(file);
    const el = type === 'video'
      ? Object.assign(document.createElement('video'), { src: url, controls: true })
      : Object.assign(document.createElement('img'), { src: url });
    preview.appendChild(el);
    const rm = document.createElement('span');
    rm.className = 'rm-f';
    rm.textContent = 'remove file';
    rm.onclick = () => { input.value = ''; preview.innerHTML = ''; revokePreview(); };
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
    <img class="avatar pfp-md${avSqClass(profile)}" src="${esc(avatarUrl(profile?.avatar_url))}" alt="" loading="lazy" decoding="async">
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

function setReportModalTitle(text) {
  const el = document.getElementById('report-modal-title');
  if (el) el.textContent = text;
}
function openReport(postId, replyId = null) {
  if (typeof requireLogin === 'function' && !requireLogin()) return;
  reportTarget = { postId, replyId };
  setReportModalTitle(replyId ? 'Report Reply' : 'Report Post');
  document.getElementById('modal-report').classList.add('open');
}
// Reports a profile itself (the "···" menu on a profile page), rather
// than one specific post/reply of theirs.
function openReportUser(userId) {
  if (typeof requireLogin === 'function' && !requireLogin()) return;
  reportTarget = { userId };
  setReportModalTitle('Report User');
  document.getElementById('modal-report').classList.add('open');
}
// Reports a community itself (the "···" menu next to Join on a
// community page), rather than one specific post/reply/member of it.
function openReportCommunity(communityId) {
  if (typeof requireLogin === 'function' && !requireLogin()) return;
  reportTarget = { communityId };
  setReportModalTitle('Report Community');
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
      community_id: reportTarget.communityId || null,
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

// ── UPDATE CHECKER — notices when a newer deploy has gone live and
// offers a one-tap refresh, instead of leaving someone stuck on old
// code until they happen to close and reopen the tab.
//
// Why this is needed at all: pjax.js (see that file's own header
// comment) keeps the JS runtime alive across every in-app link click
// — it deliberately never re-fetches <script> tags already sitting in
// the page, that's the whole point of pjax. That's great for feel,
// but it also means a tab someone opened before you published an
// update will keep running the OLD common.js/auth.js/etc. FOREVER —
// clicking around the app never re-triggers a real page load, so it
// never has a reason to pick up the new files. This is what actually
// fixes that: a small, cheap, uncached poll that notices a new
// version exists and lets the person choose to grab it, without
// yanking the page out from under them mid-action (e.g. mid-post).
//
// version.json (see vercel.json's explicit "no-store" rule for it) is
// the one file in this project that's never cached anywhere, by
// anyone, at all — so every poll genuinely reaches the server. Bump
// its "v" value every time you publish an update; nothing else needs
// to change for this to work. (The per-file "?v=" query strings on
// <script>/<link> tags are a separate, independent mechanism — they
// control whether a *fresh page load* fetches new file contents or
// reuses the browser's long-lived cache of js/css/img. This checker
// is only about tabs that are already open and would otherwise never
// reload at all.)
const UPDATE_CHECK_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes
let _knownAppVersion = null;
let _updateBannerShown = false;

async function fetchAppVersion() {
  try {
    const res = await fetch('/version.json', { cache: 'no-store' });
    if (!res.ok) return null;
    const data = await res.json();
    return data && typeof data.v === 'string' ? data.v : null;
  } catch (e) {
    return null; // offline / blocked — just skip this round, try again next interval
  }
}

function showUpdateBanner() {
  if (_updateBannerShown) return;
  _updateBannerShown = true;
  const el = document.createElement('div');
  el.id = 'oc-update-banner';
  el.className = 'oc-update-banner';
  el.innerHTML = `
    <span class="oc-update-text">A new version of InteractInk is available.</span>
    <button type="button" class="oc-update-btn" id="oc-update-refresh">Refresh</button>
    <button type="button" class="oc-update-dismiss" id="oc-update-dismiss" aria-label="Dismiss">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>
    </button>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  document.getElementById('oc-update-refresh').addEventListener('click', () => location.reload());
  document.getElementById('oc-update-dismiss').addEventListener('click', () => {
    // Dismissing only hides the banner for the rest of this tab's
    // session — it does NOT cancel the update, and does not stop
    // future polls from firing again (so if they dismiss and keep
    // using the stale tab, they aren't left with no way back to it;
    // in practice the banner just won't re-add itself a second time —
    // see the _updateBannerShown guard above, which is intentionally
    // one-way: once shown, the person has made their choice for this
    // tab and the next real prompt is their own next full reload).
    el.classList.remove('show');
    setTimeout(() => el.remove(), 250);
  });
}

async function checkForUpdate() {
  const latest = await fetchAppVersion();
  if (!latest) return;
  if (_knownAppVersion === null) {
    // First check this tab has ever done — this is the baseline for
    // "what am I currently running", not a signal that anything
    // changed. Nothing to show yet.
    _knownAppVersion = latest;
    return;
  }
  if (latest !== _knownAppVersion) showUpdateBanner();
}

// Guarded the same way as wireLinkPrefetch/wirePageLeaveFade above:
// without this flag, pjax's synthetic DOMContentLoaded re-dispatch on
// every soft navigation was stacking another 5-minute setInterval and
// another visibilitychange listener each time — after browsing N
// pages, this tab was silently firing N concurrent version-check
// requests every 5 minutes (and N of them on every tab-refocus)
// instead of one.
let _updateCheckWired = false;
document.addEventListener('DOMContentLoaded', () => {
  checkForUpdate();
  if (_updateCheckWired) return;
  _updateCheckWired = true;
  setInterval(checkForUpdate, UPDATE_CHECK_INTERVAL_MS);
  // Also check right away whenever someone comes back to a tab
  // they'd left in the background — the common "left it open
  // overnight, came back the next morning" case, without waiting for
  // the next scheduled interval tick.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') checkForUpdate();
  });
});
