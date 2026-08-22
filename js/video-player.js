// ─────────────────────────────────────────────────────────────
// TTV — custom video player, styled after X/Twitter's in-timeline
// player: big center play button, bottom scrub bar with buffered
// range + hover time preview, volume slider, speed menu, PiP and
// fullscreen. Fully event-delegated off `document` (play/pause/
// timeupdate/etc. don't bubble, so those are bound with capture:
// true, which still fires on the way down to the <video>) — that
// means any `.ttv` block dropped into the page via innerHTML just
// works, no per-element init call needed, matching how the rest of
// the app inserts raw HTML strings.
//
// Call ttvHtml(url, { className }) to get the markup; drop it in
// wherever a video used to be rendered.
// ─────────────────────────────────────────────────────────────

const TTV_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function ttvHtml(url, opts = {}) {
  const cls = opts.className ? ` ${opts.className}` : '';
  const extraAttrs = opts.videoAttrs || '';
  return `
<div class="ttv${cls}" tabindex="0">
  <video class="ttv-video" src="${esc(url)}" preload="metadata" playsinline webkit-playsinline disablepictureinpicture disableremoteplayback controlslist="nofullscreen noremoteplayback nodownload noplaybackrate" x-webkit-airplay="deny" ${extraAttrs}></video>
  <div class="ttv-overlay">
    <div class="ttv-spinner" hidden></div>
    <button type="button" class="ttv-big-play" aria-label="Play"><span class="ttv-play-tri"></span></button>
  </div>
  <div class="ttv-controls">
    <div class="ttv-progress">
      <div class="ttv-progress-preview">0:00</div>
      <div class="ttv-progress-track">
        <div class="ttv-progress-buffered"></div>
        <div class="ttv-progress-played"></div>
        <div class="ttv-progress-handle"></div>
      </div>
    </div>
    <div class="ttv-row">
      <button type="button" class="ttv-btn ttv-play" aria-label="Play">${TTV_ICON.play}</button>
      <span class="ttv-time"><span class="ttv-remain">-0:00</span></span>
      <span class="ttv-spacer"></span>
      <button type="button" class="ttv-btn ttv-speed" aria-label="Playback speed">1x</button>
      <div class="ttv-vol-wrap">
        <button type="button" class="ttv-btn ttv-mute" aria-label="Mute">${TTV_ICON.volHigh}</button>
        <input type="range" class="ttv-vol-slider" min="0" max="1" step="0.05" value="1" aria-label="Volume">
      </div>
      <button type="button" class="ttv-btn ttv-fs" aria-label="Fullscreen">${TTV_ICON.fsEnter}</button>
      <button type="button" class="ttv-btn ttv-pip" aria-label="Picture in picture">${TTV_ICON.pip}</button>
    </div>
    <div class="ttv-menu">
      ${TTV_SPEEDS.map(s => `<button type="button" class="ttv-menu-opt${s === 1 ? ' active' : ''}" data-speed="${s}">${TTV_ICON.check}<span>${s === 1 ? 'Normal' : s + 'x'}</span></button>`).join('')}
    </div>
  </div>
</div>`.trim();
}

const TTV_ICON = {
  play: '<svg viewBox="2.03 0 24 24" fill="currentColor"><path d="M8 5.14v13.72c0 .6.66.96 1.17.65l10.9-6.86a.75.75 0 000-1.28L9.17 4.49A.75.75 0 008 5.14z"/></svg>',
  pause: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5.5A1.5 1.5 0 018.5 4h1A1.5 1.5 0 0111 5.5v13a1.5 1.5 0 01-1.5 1.5h-1A1.5 1.5 0 017 18.5v-13zM13 5.5A1.5 1.5 0 0114.5 4h1A1.5 1.5 0 0117 5.5v13a1.5 1.5 0 01-1.5 1.5h-1A1.5 1.5 0 0113 18.5v-13z"/></svg>',
  volHigh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h4l5 4v-13l-5 4H4z"/><path d="M16.3 8.5a5 5 0 010 7"/><path d="M18.8 6a8.5 8.5 0 010 12"/></svg>',
  volMuted: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.5v5h4l5 4v-13l-5 4H4z"/><path d="M16.5 9.5l4.5 5m0-5l-4.5 5"/></svg>',
  pip: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"><path d="M13.5 4 5.5 12"/><path d="M5.5 6.3V12H11.2"/><path d="M13 11 17 11A2 2 0 0 1 19 13L19 18A2 2 0 0 1 17 20L11 20A2 2 0 0 1 9 18L9 14"/></svg>',
  fsEnter: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 14.5 4 20M4 20v-4.2M4 20h4.2"/><path d="M14.5 9.5 20 4M20 4v4.2M20 4h-4.2"/></svg>',
  fsExit: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 9.7 9.5 4.2M9.5 4.2v4.2M9.5 4.2h-4.2"/><path d="M20 14.3 14.5 19.8M14.5 19.8v-4.2M14.5 19.8h4.2"/></svg>',
  check: '<svg class="ck" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 13l4 4L19 7"/></svg>'
};

function ttvFmt(t) {
  if (!isFinite(t) || t < 0) t = 0;
  t = Math.floor(t);
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
  const ss = String(s).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
}

function ttvRoot(el) { return el?.closest ? el.closest('.ttv') : null; }
function ttvVideo(root) { return root?.querySelector('.ttv-video'); }

function ttvSetIcon(btn, svg) { if (btn) btn.innerHTML = svg; }

function ttvUpdatePlayIcon(root) {
  const v = ttvVideo(root);
  const icon = v.paused || v.ended ? TTV_ICON.play : TTV_ICON.pause;
  ttvSetIcon(root.querySelector('.ttv-play'), icon);
  root.classList.toggle('ttv-playing', !v.paused && !v.ended);
}

function ttvUpdateVolIcon(root) {
  const v = ttvVideo(root);
  ttvSetIcon(root.querySelector('.ttv-mute'), (v.muted || v.volume === 0) ? TTV_ICON.volMuted : TTV_ICON.volHigh);
  const slider = root.querySelector('.ttv-vol-slider');
  if (slider && document.activeElement !== slider) slider.value = v.muted ? 0 : v.volume;
}

function ttvUpdateProgress(root, previewFrac = null) {
  const v = ttvVideo(root);
  const dur = v.duration || 0;
  const frac = dur ? v.currentTime / dur : 0;
  root.querySelector('.ttv-progress-played').style.width = `${frac * 100}%`;
  root.querySelector('.ttv-progress-handle').style.left = `${frac * 100}%`;
  const remainEl = root.querySelector('.ttv-remain');
  if (remainEl) remainEl.textContent = dur ? `-${ttvFmt(Math.max(0, dur - v.currentTime))}` : '-0:00';
  try {
    if (v.buffered.length) {
      const end = v.buffered.end(v.buffered.length - 1);
      root.querySelector('.ttv-progress-buffered').style.width = `${dur ? (end / dur) * 100 : 0}%`;
    }
  } catch {}
}

function ttvSeekFromEvent(root, ev) {
  const track = root.querySelector('.ttv-progress');
  const rect = track.getBoundingClientRect();
  const x = (ev.touches ? ev.touches[0].clientX : ev.clientX) - rect.left;
  return Math.min(1, Math.max(0, x / rect.width));
}

// ── idle/auto-hide timer, per-instance ──
const ttvHideTimers = new WeakMap();
function ttvKickIdle(root) {
  root.classList.remove('ttv-idle');
  clearTimeout(ttvHideTimers.get(root));
  const v = ttvVideo(root);
  if (v && !v.paused) {
    ttvHideTimers.set(root, setTimeout(() => root.classList.add('ttv-idle'), 2200));
  }
}

// ── playback controls ──
function ttvTogglePlay(root) {
  const v = ttvVideo(root);
  if (!v) return;
  if (v.paused || v.ended) v.play().catch(() => {});
  else v.pause();
}
function ttvToggleMute(root) {
  const v = ttvVideo(root);
  v.muted = !v.muted;
  if (!v.muted && v.volume === 0) v.volume = 1;
  ttvUpdateVolIcon(root);
}
function ttvCloseMenu(root) { root?.classList.remove('ttv-menu-open'); }
function ttvToggleFullscreen(root) {
  if (document.fullscreenElement === root) document.exitFullscreen?.();
  else root.requestFullscreen?.().catch(() => {});
}
function ttvTogglePiP(root) {
  const v = ttvVideo(root);
  if (document.pictureInPictureElement) document.exitPictureInPicture?.().catch(() => {});
  else v.requestPictureInPicture?.().catch(() => {});
}

// ── document-level click delegation ──
document.addEventListener('click', (e) => {
  const menuOpt = e.target.closest('.ttv-menu-opt');
  if (menuOpt) {
    const root = ttvRoot(menuOpt);
    const v = ttvVideo(root);
    v.playbackRate = parseFloat(menuOpt.dataset.speed);
    root.querySelectorAll('.ttv-menu-opt').forEach(o => o.classList.toggle('active', o === menuOpt));
    root.querySelector('.ttv-speed').textContent = v.playbackRate === 1 ? '1x' : `${v.playbackRate}x`;
    ttvCloseMenu(root);
    return;
  }
  const speedBtn = e.target.closest('.ttv-speed');
  if (speedBtn) {
    const root = ttvRoot(speedBtn);
    root.classList.toggle('ttv-menu-open');
    return;
  }
  // clicking outside an open menu closes it
  document.querySelectorAll('.ttv.ttv-menu-open').forEach(r => { if (!r.contains(e.target)) ttvCloseMenu(r); });

  const playBtn = e.target.closest('.ttv-play, .ttv-big-play');
  if (playBtn) { ttvTogglePlay(ttvRoot(playBtn)); return; }
  const muteBtn = e.target.closest('.ttv-mute');
  if (muteBtn) { ttvToggleMute(ttvRoot(muteBtn)); return; }
  const fsBtn = e.target.closest('.ttv-fs');
  if (fsBtn) { ttvToggleFullscreen(ttvRoot(fsBtn)); return; }
  const pipBtn = e.target.closest('.ttv-pip');
  if (pipBtn) { ttvTogglePiP(ttvRoot(pipBtn)); return; }
  const overlay = e.target.closest('.ttv-overlay');
  if (overlay) { ttvTogglePlay(ttvRoot(overlay)); return; }
});

document.addEventListener('input', (e) => {
  if (e.target.classList?.contains('ttv-vol-slider')) {
    const root = ttvRoot(e.target);
    const v = ttvVideo(root);
    v.volume = parseFloat(e.target.value);
    v.muted = v.volume === 0;
    ttvUpdateVolIcon(root);
  }
});

// ── scrub bar: hover preview + drag-to-seek ──
let ttvDragRoot = null;
document.addEventListener('mousemove', (e) => {
  const track = e.target.closest('.ttv-progress');
  if (track && !ttvDragRoot) {
    const root = ttvRoot(track);
    const v = ttvVideo(root);
    const frac = ttvSeekFromEvent(root, e);
    const preview = root.querySelector('.ttv-progress-preview');
    preview.textContent = ttvFmt(frac * (v.duration || 0));
    preview.style.left = `${frac * 100}%`;
  }
  if (ttvDragRoot) {
    const v = ttvVideo(ttvDragRoot);
    const frac = ttvSeekFromEvent(ttvDragRoot, e);
    v.currentTime = frac * (v.duration || 0);
    const preview = ttvDragRoot.querySelector('.ttv-progress-preview');
    preview.textContent = ttvFmt(v.currentTime);
    preview.style.left = `${frac * 100}%`;
    ttvUpdateProgress(ttvDragRoot);
  }
});
document.addEventListener('mousedown', (e) => {
  const track = e.target.closest('.ttv-progress');
  if (!track) return;
  const root = ttvRoot(track);
  const v = ttvVideo(root);
  ttvDragRoot = root;
  track.classList.add('ttv-dragging');
  ttvDragRoot._wasPlaying = !v.paused;
  v.pause();
  v.currentTime = ttvSeekFromEvent(root, e) * (v.duration || 0);
  ttvUpdateProgress(root);
});
document.addEventListener('mouseup', () => {
  if (!ttvDragRoot) return;
  ttvDragRoot.querySelector('.ttv-progress').classList.remove('ttv-dragging');
  if (ttvDragRoot._wasPlaying) ttvVideo(ttvDragRoot).play().catch(() => {});
  ttvDragRoot = null;
});
// touch support mirrors mouse handlers above
document.addEventListener('touchstart', (e) => {
  const track = e.target.closest('.ttv-progress');
  if (!track) return;
  const root = ttvRoot(track);
  const v = ttvVideo(root);
  ttvDragRoot = root;
  track.classList.add('ttv-dragging');
  ttvDragRoot._wasPlaying = !v.paused;
  v.pause();
  v.currentTime = ttvSeekFromEvent(root, e) * (v.duration || 0);
  ttvUpdateProgress(root);
}, { passive: true });
document.addEventListener('touchmove', (e) => {
  if (!ttvDragRoot) return;
  const v = ttvVideo(ttvDragRoot);
  const frac = ttvSeekFromEvent(ttvDragRoot, e);
  v.currentTime = frac * (v.duration || 0);
  ttvUpdateProgress(ttvDragRoot);
}, { passive: true });
document.addEventListener('touchend', () => {
  if (!ttvDragRoot) return;
  ttvDragRoot.querySelector('.ttv-progress').classList.remove('ttv-dragging');
  if (ttvDragRoot._wasPlaying) ttvVideo(ttvDragRoot).play().catch(() => {});
  ttvDragRoot = null;
});

// ── keyboard, when a player has focus ──
document.addEventListener('keydown', (e) => {
  const root = document.activeElement?.closest?.('.ttv');
  if (!root) return;
  const v = ttvVideo(root);
  if (e.key === ' ' || e.key === 'k') { e.preventDefault(); ttvTogglePlay(root); }
  else if (e.key === 'ArrowRight') { v.currentTime = Math.min(v.duration || 0, v.currentTime + 5); }
  else if (e.key === 'ArrowLeft') { v.currentTime = Math.max(0, v.currentTime - 5); }
  else if (e.key === 'ArrowUp') { e.preventDefault(); v.volume = Math.min(1, v.volume + 0.1); v.muted = false; ttvUpdateVolIcon(root); }
  else if (e.key === 'ArrowDown') { e.preventDefault(); v.volume = Math.max(0, v.volume - 0.1); ttvUpdateVolIcon(root); }
  else if (e.key === 'm') { ttvToggleMute(root); }
  else if (e.key === 'f') { ttvToggleFullscreen(root); }
});

// ── idle/auto-hide on hover/move ──
document.addEventListener('mousemove', (e) => {
  const root = ttvRoot(e.target);
  if (root) ttvKickIdle(root);
});

// ── media events (capture:true — these don't bubble) ──
['play', 'pause', 'ended'].forEach(type => {
  document.addEventListener(type, (e) => {
    if (!e.target.classList?.contains('ttv-video')) return;
    const root = ttvRoot(e.target);
    ttvUpdatePlayIcon(root);
    ttvKickIdle(root);
    if (type === 'ended') root.classList.remove('ttv-playing');
  }, true);
});
document.addEventListener('timeupdate', (e) => {
  if (!e.target.classList?.contains('ttv-video')) return;
  ttvUpdateProgress(ttvRoot(e.target));
}, true);
document.addEventListener('progress', (e) => {
  if (!e.target.classList?.contains('ttv-video')) return;
  ttvUpdateProgress(ttvRoot(e.target));
}, true);
document.addEventListener('loadedmetadata', (e) => {
  if (!e.target.classList?.contains('ttv-video')) return;
  const root = ttvRoot(e.target);
  ttvUpdateProgress(root);
  ttvUpdateVolIcon(root);
}, true);

// Belt-and-suspenders against the browser's own floating PiP/expand
// bubble (some Chromium-based mobile browsers, Samsung Internet in
// particular, inject their own round overlay buttons on top of an
// HTML5 <video> once it starts playing — separate from and on top of
// our custom .ttv-row controls). The `disablepictureinpicture`
// attribute set in ttvHtml() above covers most cases, but setting the
// IDL property directly here catches browsers that only respect it
// post-load rather than as a static attribute.
new MutationObserver((mutations) => {
  for (const m of mutations) {
    m.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return;
      const vids = node.matches?.('.ttv-video') ? [node] : Array.from(node.querySelectorAll?.('.ttv-video') || []);
      vids.forEach(v => { try { v.disablePictureInPicture = true; v.disableRemotePlayback = true; } catch {} });
    });
  }
}).observe(document.body, { childList: true, subtree: true });
document.addEventListener('volumechange', (e) => {
  if (!e.target.classList?.contains('ttv-video')) return;
  ttvUpdateVolIcon(ttvRoot(e.target));
}, true);
['waiting', 'seeking'].forEach(type => {
  document.addEventListener(type, (e) => {
    if (!e.target.classList?.contains('ttv-video')) return;
    const root = ttvRoot(e.target);
    root.classList.add('ttv-buffering');
    root.querySelector('.ttv-spinner').hidden = false;
  }, true);
});
['playing', 'canplay', 'seeked'].forEach(type => {
  document.addEventListener(type, (e) => {
    if (!e.target.classList?.contains('ttv-video')) return;
    const root = ttvRoot(e.target);
    root.classList.remove('ttv-buffering');
    root.querySelector('.ttv-spinner').hidden = true;
  }, true);
});

document.addEventListener('fullscreenchange', () => {
  document.querySelectorAll('.ttv').forEach(root => {
    const btn = root.querySelector('.ttv-fs');
    if (!btn) return;
    ttvSetIcon(btn, document.fullscreenElement === root ? TTV_ICON.fsExit : TTV_ICON.fsEnter);
  });
});

// pause any player that scrolls fully out of view (saves bandwidth,
// matches X pausing timeline video once it's off-screen)
const ttvViewportObserver = new IntersectionObserver((entries) => {
  entries.forEach(entry => {
    if (entry.isIntersecting) return;
    const v = entry.target.querySelector('.ttv-video');
    if (v && !v.paused) v.pause();
  });
}, { threshold: 0 });
// Bug fix: this MutationObserver was only ever adding `.ttv` players to
// ttvViewportObserver as they appeared (infinite-scroll feed, quote
// posts, thread replies) and never removing them once their DOM nodes
// were gone — e.g. switching feed tabs replaces #feed-posts wholesale
// (renderFeedPage's `feedEl.innerHTML = html` path). Every old player
// stayed registered with the observer *and* kept its <video> element's
// decoder/buffer alive in memory (IntersectionObserver holds a strong
// reference to observed targets), since nothing ever paused + released
// them. On a session with a lot of scrolling through video posts this
// leaked one full video decoder per post, unbounded — exactly the kind
// of slow memory growth that ends in a mobile Chrome tab renderer OOM
// ("Aw, Snap!"). Now every removal is mirrored: unobserve the player
// and drop the <video>'s source so the decoder can actually be freed,
// not just visually removed from the page.
function ttvReleasePlayer(root) {
  ttvViewportObserver.unobserve(root);
  const v = root.querySelector?.('.ttv-video');
  if (!v) return;
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch (e) {}
}
new MutationObserver((mutations) => {
  for (const m of mutations) {
    m.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return;
      if (node.matches?.('.ttv')) ttvViewportObserver.observe(node);
      node.querySelectorAll?.('.ttv').forEach(el => ttvViewportObserver.observe(el));
    });
    m.removedNodes.forEach(node => {
      if (node.nodeType !== 1) return;
      if (node.matches?.('.ttv')) ttvReleasePlayer(node);
      node.querySelectorAll?.('.ttv').forEach(ttvReleasePlayer);
    });
  }
}).observe(document.body, { childList: true, subtree: true });
