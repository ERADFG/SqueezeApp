// InteractInk routing worker.
//
// WHY THIS FILE EXISTS
// ---------------------
// This project used to rely entirely on the `_redirects` file for routing
// (see the comment at the top of `_redirects`). That works for plain
// "/segment/:placeholder" rules, but Cloudflare's `_redirects` engine only
// matches a `:placeholder` when it occupies an ENTIRE path segment — it does
// not reliably match a placeholder that's fused onto a literal character in
// the same segment, like our `/@:username` rules (literal "@" immediately
// followed by the placeholder, no "/" between them).
//
// Because every "@username" rule silently failed to match, every request to
// a profile/thread/followers/etc. link fell through to the last, most
// generic rule in the file:
//
//   /:username  /@:username  308
//
// That rule matches ANY single path segment — including one that already
// starts with "@" — and always PREPENDS another "@". So `/@alice` (which
// should have matched the profile rule two lines above it and stopped)
// instead got redirected to `/@@alice`, which again failed to match the
// profile rule, and got redirected to `/@@@alice`, forever — exactly the
// "interactink.com/@@@@@@...@InteractInk — ERR_TOO_MANY_REDIRECTS" bug.
//
// This worker reimplements the same routing table in plain JS regex (which
// has no such limitation) and is the actual routing authority now. It's
// named `_worker.js` (not "worker.js") on purpose: that's the exact
// filename Cloudflare Pages' "Advanced Mode" looks for at the root of a
// deployed project to hand it full control of every request — no dashboard
// setting or wrangler.jsonc change needed, it's picked up automatically on
// your next git push, same as every other file here. The `_redirects` file
// is left in place only as documentation; once `_worker.js` exists,
// Cloudflare stops applying `_redirects` entirely (its rules are folded
// into this file instead).

const LOCALES = ['es', 'fr', 'de', 'pt', 'ja', 'ru'];

// Exact-path -> file rewrites (clean URLs for static utility pages).
const UTILITY_PAGES = {
  '/notifications': '/notifications.html',
  '/bookmarks': '/bookmarks.html',
  '/settings': '/settings.html',
  '/insights': '/insights.html',
  // NOTE: this one was missing from _redirects entirely (present in the old
  // vercel.json but never ported), so /editprofile 404'd / fell into the
  // username catch-all on Cloudflare. Fixed here.
  '/editprofile': '/editprofile.html',
  '/achievements': '/achievements.html',
  '/search': '/search.html',
  '/rules': '/rules.html',
  '/about': '/about.html',
  '/contact': '/contact.html',
  '/privacy': '/privacy.html',
  '/terms': '/terms.html',
  '/login': '/login.html',
  '/signup': '/signup.html',
  '/start': '/start.html',
  '/communities': '/communities.html',
  '/admin': '/admin.html',
  '/home': '/index.html',
  '/lists': '/lists.html',
  '/articles': '/articles.html',
  '/messages': '/chat.html',
};

// Same utility pages, mirrored per-locale (e.g. /es/rules -> /es/rules.html).
const LOCALIZED_SUFFIX_TO_FILE = {
  '/home': 'index.html',
  '/rules': 'rules.html',
  '/about': 'about.html',
  '/contact': 'contact.html',
  '/privacy': 'privacy.html',
  '/terms': 'terms.html',
  '/login': 'login.html',
  '/signup': 'signup.html',
  '/communities': 'communities.html',
  '/articles': 'articles.html',
};

function serve(env, request, url, path) {
  const assetUrl = new URL(path, url.origin);
  assetUrl.search = url.search;
  return env.ASSETS.fetch(new Request(assetUrl.toString(), request));
}

function redirect(url, location, code = 308) {
  const dest = new URL(location, url.origin);
  dest.search = url.search;
  return Response.redirect(dest.toString(), code);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // --- self-heal any already-broken multi-"@" links (old bookmarks,
    // cached redirects, or anyone mid-loop when this deploys) ---
    if (/^\/@{2,}/.test(path)) {
      return redirect(url, '/@' + path.replace(/^\/@+/, ''));
    }

    if (path === '/') return serve(env, request, url, '/index.html');

    if (Object.prototype.hasOwnProperty.call(UTILITY_PAGES, path)) {
      return serve(env, request, url, UTILITY_PAGES[path]);
    }

    // --- help + blog ---
    if (path === '/help') return serve(env, request, url, '/help/index.html');
    let m = path.match(/^\/help\/([^/]+)$/);
    if (m) return serve(env, request, url, `/help/${m[1]}/index.html`);

    if (path === '/blog') return serve(env, request, url, '/blog/index.html');
    m = path.match(/^\/blog\/([^/]+)$/);
    if (m) return serve(env, request, url, `/blog/${m[1]}.html`);

    // --- messages ---
    m = path.match(/^\/messages\/g\/([^/]+)$/);
    if (m) return serve(env, request, url, '/chat.html');
    m = path.match(/^\/messages\/([^/]+)$/);
    if (m) return serve(env, request, url, '/chat.html');

    // --- localized pages ---
    for (const loc of LOCALES) {
      const prefix = `/${loc}`;
      if (path === prefix || path === `${prefix}/`) {
        return serve(env, request, url, `/${loc}/index.html`);
      }
      for (const suffix of Object.keys(LOCALIZED_SUFFIX_TO_FILE)) {
        if (path === `${prefix}${suffix}`) {
          return serve(env, request, url, `/${loc}/${LOCALIZED_SUFFIX_TO_FILE[suffix]}`);
        }
      }
    }

    // --- dynamic content shells ---
    m = path.match(/^\/communities\/([^/]+)$/);
    if (m) return serve(env, request, url, '/community.html');
    m = path.match(/^\/i\/lists\/([^/]+)$/);
    if (m) return serve(env, request, url, '/list.html');
    m = path.match(/^\/i\/articles\/([^/]+)$/);
    if (m) return serve(env, request, url, '/article.html');
    m = path.match(/^\/i\/status\/([^/]+)$/);
    if (m) return serve(env, request, url, '/thread.html');

    // --- username-scoped routes: /@username/... (must come before the
    // legacy bare-username rules and the generic catch-all below) ---
    m = path.match(/^\/@([^/@]+)\/status\/([^/]+)$/);
    if (m) return serve(env, request, url, '/thread.html');
    m = path.match(/^\/@([^/@]+)\/followers$/);
    if (m) return serve(env, request, url, '/followlist.html');
    m = path.match(/^\/@([^/@]+)\/following$/);
    if (m) return serve(env, request, url, '/followlist.html');
    m = path.match(/^\/@([^/@]+)\/lists$/);
    if (m) return serve(env, request, url, '/profilelists.html');

    // --- legacy bare-username links (pre-@ scheme): 308 to the /@ form ---
    m = path.match(/^\/([^/@]+)\/status\/([^/]+)$/);
    if (m) return redirect(url, `/@${m[1]}/status/${m[2]}`);
    m = path.match(/^\/([^/@]+)\/followers$/);
    if (m) return redirect(url, `/@${m[1]}/followers`);
    m = path.match(/^\/([^/@]+)\/following$/);
    if (m) return redirect(url, `/@${m[1]}/following`);
    m = path.match(/^\/([^/@]+)\/lists$/);
    if (m) return redirect(url, `/@${m[1]}/lists`);

    // --- generic profile page: /@username ---
    m = path.match(/^\/@([^/@]+)$/);
    if (m) return serve(env, request, url, '/profile.html');

    // --- generic bare-username catch-all: /username -> /@username ---
    // THE FIX: only fires for a single clean segment that does NOT already
    // start with "@" (that guard is what stops the infinite-redirect loop)
    // and does not contain a "." (so real static-file requests like
    // /favicon.ico, /robots.txt, /sitemap.xml, /ads.txt never get
    // mistaken for a username).
    if (!path.startsWith('/@')) {
      m = path.match(/^\/([^/.]+)$/);
      if (m) return redirect(url, `/@${m[1]}`);
    }

    // --- everything else: a real static file (css/js/img/html/etc.) ---
    return serve(env, request, url, path);
  },
};
