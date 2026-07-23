/* =========================================================================
   InteractInk — Enhancements Layer (behavior)
   Shared, site-wide script loaded on every page via
   <script src="enhancements.js" defer></script>

   Provides:
   1. Bounce animation on click for every button / button-like control,
      including elements created dynamically after page load (delegated).
   2. A smooth fade transition between pages, plus a slim top progress
      bar, for ordinary same-origin link clicks.

   Designed to be non-invasive: if a page already has its own click
   handling (e.g. interactink.html's board/thread SPA routing which
   calls preventDefault()), this script defers to it and does nothing
   extra for that click.
   ========================================================================= */

(function () {
  'use strict';

  var reduceMotion = window.matchMedia &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /* -----------------------------------------------------------------
     1. Bounce-on-click for every button-like element
     ----------------------------------------------------------------- */
  var BOUNCE_SELECTOR = [
    'button',
    'input[type="submit"]',
    'input[type="button"]',
    '[role="button"]',
    '.nav-item',
    '.post-button',
    '.footer-link',
    '.widget-link',
    '.bottom-tab',
    '.board-grid-card',
    '.board-switcher-btn',
    '.bookmark-btn',
    '.report-btn',
    '.search-trigger-btn',
    '.thread-back-btn',
    '.back-link',
    '.inline-link',
    '[data-bounce]'
  ].join(',');

  // Capture phase so the flourish always fires, even if a page-specific
  // handler later calls stopPropagation() on the same click.
  document.addEventListener('click', function (e) {
    if (reduceMotion) return;
    var el = e.target && e.target.closest ? e.target.closest(BOUNCE_SELECTOR) : null;
    if (!el || el.hasAttribute('data-no-bounce')) return;

    el.classList.remove('ink-bounce');

    // Apply the bounce class on the next frame, not synchronously here.
    // This listener runs in the capture phase, i.e. BEFORE the element's
    // own click handler (target phase) and any bubble-phase listeners.
    // Pages like interactink.html read anchorEl.getBoundingClientRect()
    // in their own click handlers (e.g. to position the share menu), and
    // getBoundingClientRect() reflects live CSS transforms — so adding
    // the scale/translate bounce class synchronously here would make
    // those position reads land mid-animation and throw off the result.
    // Deferring by a frame keeps the click handler's layout read accurate
    // while still starting the bounce essentially instantly.
    requestAnimationFrame(function () {
      // Force reflow so the animation restarts if clicked again quickly.
      void el.offsetWidth;
      el.classList.add('ink-bounce');

      el.addEventListener('animationend', function handler() {
        el.classList.remove('ink-bounce');
        el.removeEventListener('animationend', handler);
      });
    });
  }, true);

  /* -----------------------------------------------------------------
     2. Smooth cross-page navigation
     ----------------------------------------------------------------- */
  var NAV_DELAY_MS = reduceMotion ? 0 : 190;

  function isPlainLeftClick(e) {
    return e.button === 0 && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey;
  }

  function isInternalPageLink(a) {
    if (!a || !a.getAttribute) return false;
    var rawHref = a.getAttribute('href');
    if (!rawHref) return false;
    if (rawHref.charAt(0) === '#') return false;
    if (/^(mailto:|tel:|javascript:)/i.test(rawHref)) return false;
    if (a.hasAttribute('download')) return false;
    var target = a.getAttribute('target');
    if (target && target !== '_self') return false;

    var url;
    try {
      url = new URL(rawHref, window.location.href);
    } catch (err) {
      return false;
    }
    if (url.origin !== window.location.origin) return false;
    if (url.href === window.location.href) return false; // link to current page/hash-less self

    return true;
  }

  function showProgressBar() {
    var bar = document.getElementById('ink-progress-bar');
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'ink-progress-bar';
      bar.className = 'ink-progress';
      document.body.appendChild(bar);
    }
    bar.style.opacity = '1';
    bar.style.width = '0%';
    void bar.offsetWidth;
    requestAnimationFrame(function () {
      bar.style.width = '75%';
    });
  }

  // Bubble phase, runs after any page-specific handler on the link itself
  // (which fires during the target phase, before this document listener).
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented) return;
    if (!isPlainLeftClick(e)) return;

    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a || !isInternalPageLink(a)) return;

    var destination = a.href;
    e.preventDefault();
    showProgressBar();
    document.body.classList.add('ink-page-exit');

    window.setTimeout(function () {
      window.location.href = destination;
    }, NAV_DELAY_MS);
  }, false);

  // If a user navigates back into a bfcache'd page mid-transition,
  // make sure it isn't stuck faded out.
  window.addEventListener('pageshow', function () {
    document.body.classList.remove('ink-page-exit');
    var bar = document.getElementById('ink-progress-bar');
    if (bar) {
      bar.style.width = '100%';
      bar.style.opacity = '0';
    }
  });
})();