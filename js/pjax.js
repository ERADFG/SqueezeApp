// ─────────────────────────────────────────────────────────────
// PJAX NAVIGATION — turns internal same-origin link clicks into a
// fetch + DOM swap instead of a real browser navigation, so the JS
// runtime (Supabase client, in-memory state, already-loaded
// scripts) stays alive across pages the way x.com's client router
// does, instead of every click tearing the page down and rebuilding
// it from scratch. Every page still works completely on its own if
// this file fails to load (progressive enhancement, not a rewrite):
// clicking a link with JS disabled, or before this script has run,
// just does a normal navigation.
//
// This does NOT touch <head> (styles, theme/accent attrs on <html>,
// the shared <script src> tags already sitting at the bottom of
// every page) — only the .xshell wrapper's content gets replaced,
// which is where every page's actual header + body lives (see the
// <body><div class="xshell"> pattern shared by every page in this
// app). That's also why dark/dim theme never flickers on navigate:
// it's set on <html> before the swap and is simply never touched.
// ─────────────────────────────────────────────────────────────
(function () {
  if (window.__pjaxInit) return;
  window.__pjaxInit = true;

  const SHELL_SEL = '.xshell';
  const NON_PAGE_EXT = /\.(png|jpe?g|gif|svg|webp|avif|ico|pdf|zip|mp4|mp3|webm|css|js|json|xml|txt|csv|woff2?|ttf)$/i;

  // Every <script src="...">  already sitting in the initial page's
  // <head>/<body> is "loaded" from pjax's point of view — re-adding
  // those on every navigation would re-run their top-level setup
  // code (event listeners, speculation rules, etc.) a second time.
  // Page-specific bundles (board.js, chat.js, editprofile.js, ...)
  // that aren't on every page get added to this set the first time
  // pjax loads them, so navigating back to that page type later
  // doesn't reload the bundle either.
  const loadedScripts = new Set(
    Array.from(document.scripts).map(s => s.src).filter(Boolean)
  );

  let inFlightAbort = null;
  let navToken = 0;

  function isSameOrigin(url) {
    try { return new URL(url, location.href).origin === location.origin; }
    catch (e) { return false; }
  }

  function isPjaxLink(a) {
    if (!a || !a.hasAttribute('href')) return false;
    if (a.dataset.noPjax !== undefined) return false;
    if (a.target && a.target !== '_self') return false;
    if (a.hasAttribute('download')) return false;
    const rel = (a.getAttribute('rel') || '');
    if (rel.split(/\s+/).includes('external')) return false;
    const href = a.getAttribute('href') || '';
    if (!href || href.startsWith('#') || href.startsWith('mailto:') || href.startsWith('tel:') || href.startsWith('javascript:')) return false;
    if (!isSameOrigin(href)) return false;
    let url;
    try { url = new URL(href, location.href); } catch (e) { return false; }
    if (NON_PAGE_EXT.test(url.pathname)) return false;
    return true;
  }

  // ── Thin top-of-page progress bar — same idea as YouTube/GitHub's
  // nav indicator, gives instant feedback that a click registered
  // even before the fetch resolves, so nothing ever feels stuck. ──
  let bar = null;
  function ensureBar() {
    if (bar) return bar;
    bar = document.createElement('div');
    bar.id = 'pjax-bar';
    bar.style.cssText = 'position:fixed;top:0;left:0;height:2px;width:0;background:var(--maroon,#0B6FE0);z-index:9999;transition:width .2s ease,opacity .2s ease;opacity:0;pointer-events:none;';
    document.body.appendChild(bar);
    return bar;
  }
  function barStart() {
    const b = ensureBar();
    b.style.transition = 'none';
    b.style.width = '0%';
    b.style.opacity = '1';
    void b.offsetHeight;
    b.style.transition = 'width .4s ease,opacity .2s ease';
    b.style.width = '70%';
  }
  function barDone() {
    if (!bar) return;
    bar.style.width = '100%';
    setTimeout(() => { if (bar) { bar.style.opacity = '0'; } }, 150);
    setTimeout(() => { if (bar) { bar.style.width = '0%'; } }, 400);
  }

  // Re-runs every inline <script> found in freshly-swapped content
  // (assigning innerHTML never executes embedded <script> tags —
  // browsers only run scripts the parser itself encounters), and
  // loads any page-specific <script src> bundle that isn't already
  // on the page. Runs scripts in document order, each one after the
  // previous finishes, so load-order dependencies (config -> i18n ->
  // common -> auth -> page bundle) still hold even though these are
  // being inserted well after the initial parse.
  function runScripts(container) {
    const scripts = Array.from(container.querySelectorAll('script'));
    let chain = Promise.resolve();
    scripts.forEach(old => {
      chain = chain.then(() => new Promise(resolve => {
        const s = document.createElement('script');
        for (const attr of old.attributes) {
          if (attr.name === 'defer' || attr.name === 'async') continue;
          s.setAttribute(attr.name, attr.value);
        }
        if (old.src) {
          const abs = new URL(old.src, location.href).href;
          if (loadedScripts.has(abs)) { resolve(); return; }
          loadedScripts.add(abs);
          s.src = old.src;
          s.onload = () => resolve();
          s.onerror = () => resolve();
          old.replaceWith(s);
        } else {
          s.textContent = old.textContent;
          old.replaceWith(s);
          resolve();
        }
      }));
    });
    return chain;
  }

  function clearTransientState() {
    // Per-page-instance UI states that must never leak into the next
    // page (an open chat thread, an open bottom sheet, mid-fade class
    // from wirePageLeaveFade in common.js).
    document.body.classList.remove('oc-sheet-open', 'chat-thread-open', 'oc-page-leaving', 'pf-expanded');
    document.documentElement.classList.remove('oc-page-leaving');
    if (typeof unlockScroll === 'function') {
      try { while (document.documentElement.style.overflow === 'hidden') unlockScroll(); } catch (e) {}
    }
    document.documentElement.style.overflow = '';
    document.body.style.overflow = '';
  }

  async function navigate(url, { push = true, scroll = true } = {}) {
    const myToken = ++navToken;
    if (inFlightAbort) inFlightAbort.abort();
    const controller = new AbortController();
    inFlightAbort = controller;

    barStart();
    let res, html;
    try {
      res = await fetch(url, { headers: { 'X-Pjax': '1' }, signal: controller.signal, credentials: 'same-origin' });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      html = await res.text();
    } catch (e) {
      if (e.name === 'AbortError') return; // superseded by a newer navigation
      location.href = url; // network hiccup or non-html response — fall back to a real navigation
      return;
    }
    if (myToken !== navToken) return; // a newer navigation started while we were fetching

    const doc = new DOMParser().parseFromString(html, 'text/html');
    const newShell = doc.querySelector(SHELL_SEL);
    const curShell = document.querySelector(SHELL_SEL);
    if (!newShell || !curShell) { location.href = url; return; }

    if (push) history.pushState({ pjax: true }, '', url);
    document.title = doc.title || document.title;

    clearTransientState();
    curShell.innerHTML = newShell.innerHTML;

    const newBody = doc.body;
    if (newBody && newBody.dataset.page) document.body.dataset.page = newBody.dataset.page;
    else delete document.body.dataset.page;

    await runScripts(curShell);

    // common.js renders #auth-area, the mobile tab bar, sidebar
    // search, captchas, etc. from listeners registered on the
    // browser's real (one-time) DOMContentLoaded event — which
    // already fired during the initial page load and never fires
    // again. Re-dispatching it as a synthetic event is what makes
    // those already-loaded listeners re-run and repopulate the
    // header/chrome we just replaced, and also runs any
    // newly-loaded page bundle's own init the same way.
    document.dispatchEvent(new Event('DOMContentLoaded', { bubbles: true, cancelable: true }));
    document.dispatchEvent(new CustomEvent('pjax:load', { detail: { url } }));

    if (scroll) {
      const hash = new URL(url, location.href).hash;
      const target = hash && document.getElementById(hash.slice(1));
      if (target) target.scrollIntoView();
      else window.scrollTo(0, 0);
    }
    barDone();
  }

  document.addEventListener('click', (e) => {
    if (e.defaultPrevented || e.button !== 0) return;
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest('a');
    if (!isPjaxLink(a)) return;
    e.preventDefault();
    if (a.href === location.href && !new URL(a.href).hash) return; // already here
    navigate(a.href);
  });

  window.addEventListener('popstate', () => {
    navigate(location.href, { push: false });
  });

  // Expose a manual entry point for JS-driven navigation (e.g. code
  // that currently does `location.href = someUrl`) to opt into the
  // same no-reload path — safe to adopt incrementally.
  window.pjaxNavigate = (url) => navigate(url);
})();
