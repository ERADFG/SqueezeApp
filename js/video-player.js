// ─────────────────────────────────────────────────────────────
// TTV — custom video player, "reel rail" layout: a hairline
// progress track flush along the top edge, a bare (no backdrop
// circle) center play/pause triangle you can tap anywhere on the
// video to toggle, a small time readout bottom-left, and a
// vertical rail of icon buttons (mute, speed, fullscreen, PiP)
// docked to the right edge. Buffered range + hover/drag scrub,
// speed menu, idle auto-hide all carry over unchanged. Fully
// event-delegated off `document` (play/pause/timeupdate/etc.
// don't bubble, so those are bound with capture: true, which
// still fires on the way down to the <video>) — that means any
// `.ttv` block dropped into the page via innerHTML just works, no
// per-element init call needed, matching how the rest of the app
// inserts raw HTML strings.
//
// Call ttvHtml(url, { className }) to get the markup; drop it in
// wherever a video used to be rendered.
// ─────────────────────────────────────────────────────────────

const TTV_SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2];

function ttvHtml(url, opts = {}) {
  const cls = opts.className ? ` ${opts.className}` : '';
  const extraAttrs = opts.videoAttrs || '';
  // opts.postId links this player back to the feed card it was
  // rendered inside (see renderMedia() in common.js). It's what lets
  // ttvEnterShorts() below find the real like/reply/share/bookmark
  // buttons for that post — the shorts rail never re-implements that
  // logic, it just forwards taps to the buttons that already exist.
  const postAttr = opts.postId ? ` data-post-id="${esc(opts.postId)}"` : '';
  return `
<div class="ttv${cls}" tabindex="0"${postAttr}>
  <video class="ttv-video" src="${esc(url)}" data-src="${esc(url)}" preload="metadata" playsinline webkit-playsinline disableremoteplayback controlslist="nofullscreen noremoteplayback nodownload noplaybackrate" x-webkit-airplay="deny" ${extraAttrs}></video>
  <div class="ttv-overlay">
    <div class="ttv-spinner" hidden></div>
    <button type="button" class="ttv-big-play" aria-label="Play">${TTV_ICON.playBig}</button>
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
    <span class="ttv-time"><span class="ttv-remain">-0:00</span></span>
    <div class="ttv-rail">
      <button type="button" class="ttv-btn ttv-mute" aria-label="Mute">${TTV_ICON.volHigh}</button>
      <button type="button" class="ttv-btn ttv-speed" aria-label="Playback speed">1x</button>
      <button type="button" class="ttv-btn ttv-fs" aria-label="Fullscreen">${TTV_ICON.fsEnter}</button>
      <button type="button" class="ttv-btn ttv-pip" aria-label="Picture in picture">${TTV_ICON.pip}</button>
    </div>
    <div class="ttv-menu">
      ${TTV_SPEEDS.map(s => `<button type="button" class="ttv-menu-opt${s === 1 ? ' active' : ''}" data-speed="${s}">${TTV_ICON.check}<span>${s === 1 ? 'Normal' : s + 'x'}</span></button>`).join('')}
    </div>
  </div>
  <!-- SHORTS OVERLAY — stays display:none (see CSS) until this .ttv
       is the browser-fullscreened element. ttvEnterShorts() populates
       it from the post card and wires swipe-to-next-video. -->
  <div class="ttv-shorts">
    <div class="ttv-shorts-rail">
      <a class="ttv-shorts-avatar" href="#"><img src="" alt=""></a>
      <button type="button" class="ttv-shorts-btn ttv-shorts-like" aria-label="Like">${SHORTS_ICON.heart}<span class="ttv-shorts-count">0</span></button>
      <button type="button" class="ttv-shorts-btn ttv-shorts-reply" aria-label="Comment">${SHORTS_ICON.reply}<span class="ttv-shorts-count">0</span></button>
      <button type="button" class="ttv-shorts-btn ttv-shorts-share" aria-label="Share">${SHORTS_ICON.share}<span class="ttv-shorts-count">Share</span></button>
      <button type="button" class="ttv-shorts-btn ttv-shorts-bookmark" aria-label="Save">${SHORTS_ICON.bookmark}<span class="ttv-shorts-count">Save</span></button>
    </div>
    <div class="ttv-shorts-meta">
      <a class="ttv-shorts-handle" href="#"></a>
      <p class="ttv-shorts-caption"></p>
    </div>
  </div>
</div>`.trim();
}

// Same glyphs as ICON.heart/reply/share/bookmark in common.js — kept
// as a separate copy (rather than referencing ICON directly) so this
// file has no load-order dependency on common.js, but the paths are
// identical on purpose: the shorts rail should look exactly like the
// like/comment/share/save icons everywhere else on the site.
const SHORTS_ICON = {
  heart:    '<svg viewBox="0 0 24 24"><path d="M12 6.24C10.4 4.4 7.85 3.9 5.8 5.1 3.4 6.5 2.66 9.6 4.24 12.15c1.9 3.06 4.9 5.5 7.76 7.6 2.86-2.1 5.86-4.54 7.76-7.6 1.58-2.55.84-5.65-1.56-7.05-2.05-1.2-4.6-.7-6.2 1.14z" stroke-linejoin="round"/></svg>',
  reply:    '<svg viewBox="0 0 24 24"><path d="M1.75 10.1C1.75 5.68 5.33 2.1 9.75 2.1h4.4c4.5 0 8.15 3.64 8.15 8.15 0 2.97-1.61 5.7-4.2 7.13l-8.06 4.47v-3.7h-.07c-4.5.1-8.22-3.53-8.22-8.05Z" stroke-linejoin="round"/></svg>',
  share:    '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M13.5 4.6a1.15 1.15 0 0 1 1.94-.86l6.3 5.75a1.15 1.15 0 0 1 0 1.7l-6.3 5.75a1.15 1.15 0 0 1-1.94-.86v-2.72c-5.02.22-8.2 2.1-10.02 5.9a1.05 1.05 0 0 1-1.99-.5C1.9 11.6 6.2 7.36 13.5 7.03V4.6Z"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24"><path d="M6.25 6.4A2.65 2.65 0 0 1 8.9 3.75h6.2A2.65 2.65 0 0 1 17.75 6.4v13.2a.85.85 0 0 1-1.36.68L12 16.9l-4.39 3.38a.85.85 0 0 1-1.36-.68V6.4Z" stroke-linejoin="round"/></svg>'
};

const TTV_ICON = {
  play: '<svg viewBox="2.03 0 24 24" fill="currentColor"><path d="M8 5.14v13.72c0 .6.66.96 1.17.65l10.9-6.86a.75.75 0 000-1.28L9.17 4.49A.75.75 0 008 5.14z"/></svg>',
  // Rounded-corner triangle (vs. the feed's sharp-cornered clip-path
  // one) — softer, more modern silhouette for the big center button.
  playBig: '<svg class="ttv-big-play-icon" viewBox="0 0 24 24" fill="currentColor"><path d="M9.5 6.4c0-1.2 1.32-1.93 2.34-1.28l8.51 5.6c.95.6.95 2 0 2.6l-8.51 5.6c-1.02.65-2.34-.08-2.34-1.28V6.4z" stroke="currentColor" stroke-width=".4" stroke-linejoin="round"/></svg>',
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
  // The center button is .ttv-big-play (the current "reel rail" markup
  // has no separate .ttv-play element — that was left over from an
  // earlier player layout). It's fully hidden via CSS while playing
  // (.ttv.ttv-playing .ttv-big-play { display:none }), so nothing here
  // needs to swap its icon — it only ever shows the play triangle,
  // for when playback is paused/ended.
  root.classList.toggle('ttv-playing', !v.paused && !v.ended);
}

function ttvUpdateVolIcon(root) {
  const v = ttvVideo(root);
  // .ttv-vol-slider doesn't exist in this player's markup (the "reel
  // rail" design only has a mute toggle button, no drag slider) — that
  // lookup used to silently no-op every time this ran.
  ttvSetIcon(root.querySelector('.ttv-mute'), (v.muted || v.volume === 0) ? TTV_ICON.volMuted : TTV_ICON.volHigh);
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
// Pulls the same handle/caption/avatar a Shorts-mode player reads off
// the real post card (see ttvShortsSync below) — used to label the
// floating PiP window so it's not just a bare, anonymous video.
function ttvPostMetaFor(root) {
  const pc = root.closest('.pc, .op-detail, .rc');
  if (!pc) return null;
  const handleEl = pc.querySelector('.pc-handle');
  const bodyEl = pc.querySelector('.pb, .op-detail-body');
  const avatarImg = pc.querySelector('.pc-avatar-lnk img');
  return {
    handle: handleEl?.textContent || '',
    caption: bodyEl?.textContent || '',
    avatar: avatarImg?.getAttribute('src') || ''
  };
}

function ttvTogglePiP(root) {
  const v = ttvVideo(root);
  if (document.pictureInPictureElement) { document.exitPictureInPicture?.().catch(() => {}); return; }
  // Desktop Chrome renders MediaSession title/artist right on the
  // floating PiP window's chrome — that's the only place a username +
  // description actually has room to show once the video pops out to
  // the side, so this is desktop-only; phone/tablet PiP overlays don't
  // have (or reliably honor) that space.
  if (window.matchMedia('(min-width:701px)').matches && 'mediaSession' in navigator) {
    const meta = ttvPostMetaFor(root);
    if (meta) {
      try {
        navigator.mediaSession.metadata = new MediaMetadata({
          title: meta.handle,
          artist: meta.caption,
          artwork: meta.avatar ? [{ src: meta.avatar, sizes: '256x256', type: 'image/png' }] : []
        });
      } catch {}
    }
  }
  v.requestPictureInPicture?.().catch(() => {});
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

  const playBtn = e.target.closest('.ttv-big-play');
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

// Belt-and-suspenders against the browser's own floating remote-
// playback bubble (some Chromium-based mobile browsers, Samsung
// Internet in particular, inject their own round overlay buttons on
// top of an HTML5 <video> once it starts playing — separate from and
// on top of our custom .ttv-rail controls). This used to also set
// disablePictureInPicture=true here, which — on top of the
// `disablepictureinpicture` attribute already in ttvHtml() — was
// what made the .ttv-pip button's requestPictureInPicture() call
// silently fail every time (both are removed now so the button
// actually works).
new MutationObserver((mutations) => {
  for (const m of mutations) {
    m.addedNodes.forEach(node => {
      if (node.nodeType !== 1) return;
      const vids = node.matches?.('.ttv-video') ? [node] : Array.from(node.querySelectorAll?.('.ttv-video') || []);
      vids.forEach(v => { try { v.disableRemotePlayback = true; } catch {} });
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
    if (btn) ttvSetIcon(btn, document.fullscreenElement === root ? TTV_ICON.fsExit : TTV_ICON.fsEnter);
    ttvSyncFullscreenLayout(root);
    if (document.fullscreenElement === root) ttvEnterShorts(root);
    else if (root.classList.contains('ttv-shorts-active')) ttvExitShorts(root);
  });
});

// ─────────────────────────────────────────────────────────────
// SHORTS MODE — going fullscreen on a feed video turns it into a
// TikTok/Shorts-style vertical player: a right-side rail (avatar,
// like, comment, share, save) and a bottom caption, plus swipe-up/
// down (touch or wheel) to move to the next/previous video already
// in the feed. It only activates for players rendered with a
// data-post-id (i.e. actual feed posts, via renderMedia() in
// common.js) — a video with no post context just gets plain
// fullscreen playback, unchanged.
//
// The rail is deliberately dumb: it never reimplements like/comment/
// share/save. Every tap finds the real .act button already rendered
// in that post's card (postActionsHtml() in common.js) and clicks
// it, then copies that button's resulting state back onto the rail.
// That keeps counts, optimistic UI, and the actual Supabase calls
// coming from exactly one place.
// ─────────────────────────────────────────────────────────────

let ttvShortsQueue = [];   // ordered list of .pc elements currently in the DOM that have a video
let ttvShortsIndex = -1;   // index of the post currently showing in the fullscreened player
let ttvShortsPc = null;    // the .pc backing whatever is currently showing
let ttvShortsOrigSrc = null;
let ttvShortsLoadingMore = false;

// Feed cards use .pc, but a post opened in its own page (thread.html)
// renders the OP in .op-detail and replies in .rc instead — neither
// of those is a .pc. Those were never recognized as "post context" by
// this queue, so tapping a post, then fullscreening its video, always
// fell through to a plain, un-styled browser fullscreen (the old
// pre-Shorts player) instead of the same rail+caption UI the feed
// gets. Matching on whichever of the three card types actually
// wraps a given .ttv-video fixes that for the post-detail page too.
function ttvShortsBuildQueue() {
  return Array.from(document.querySelectorAll('.ttv-video'))
    .map(v => v.closest('.pc, .op-detail, .rc'))
    .filter(Boolean);
}

function ttvEnterShorts(root) {
  if (!root.dataset.postId) return; // no post context — leave as plain fullscreen video
  const pc = root.closest('.pc, .op-detail, .rc');
  if (!pc) return;
  ttvShortsQueue = ttvShortsBuildQueue();
  ttvShortsIndex = ttvShortsQueue.indexOf(pc);
  if (ttvShortsIndex === -1) { ttvShortsQueue.unshift(pc); ttvShortsIndex = 0; }
  ttvShortsPc = pc;
  ttvShortsOrigSrc = ttvVideo(root)?.getAttribute('src') || null;
  root.classList.add('ttv-shorts-active');
  ttvShortsSync(root, pc);
  root.addEventListener('wheel', ttvShortsOnWheel, { passive: false });
  root.addEventListener('touchstart', ttvShortsOnTouchStart, { passive: true });
  root.addEventListener('touchend', ttvShortsOnTouchEnd, { passive: true });
}

function ttvExitShorts(root) {
  root.classList.remove('ttv-shorts-active');
  root.removeEventListener('wheel', ttvShortsOnWheel);
  root.removeEventListener('touchstart', ttvShortsOnTouchStart);
  root.removeEventListener('touchend', ttvShortsOnTouchEnd);
  // Put the player back to whatever it was actually embedded with —
  // swiping in shorts mode only changes what's showing fullscreen,
  // it never edits the underlying feed.
  const v = ttvVideo(root);
  if (v && ttvShortsOrigSrc && v.getAttribute('src') !== ttvShortsOrigSrc) {
    v.pause();
    v.setAttribute('src', ttvShortsOrigSrc);
    v.load();
  }
  ttvShortsQueue = [];
  ttvShortsIndex = -1;
  ttvShortsPc = null;
  ttvShortsOrigSrc = null;
}

// Pulls avatar/handle/caption/like/reply/bookmark state straight off
// the real post card and paints the rail with it.
function ttvShortsSync(root, pc) {
  const shorts = root.querySelector('.ttv-shorts');
  if (!shorts) return;

  const avatarLnk = pc.querySelector('.pc-avatar-lnk');
  const avatarImg = avatarLnk?.querySelector('img');
  const avA = shorts.querySelector('.ttv-shorts-avatar');
  if (avA) {
    avA.href = avatarLnk?.getAttribute('href') || '#';
    avA.querySelector('img').src = avatarImg?.getAttribute('src') || '';
  }

  const handleEl = pc.querySelector('.pc-handle');
  const nameLnk = pc.querySelector('.nm');
  const handleA = shorts.querySelector('.ttv-shorts-handle');
  if (handleA) {
    handleA.href = nameLnk?.getAttribute('href') || '#';
    handleA.textContent = handleEl?.textContent || '';
  }

  // Feed/reply cards use .pb for the post body; the post-detail page's
  // OP (and a focused-reply's detail view) use .op-detail-body instead
  // — same text, different class, so both need checking here now that
  // this rail can sync from either card shape (see ttvShortsBuildQueue).
  const bodyEl = pc.querySelector('.pb, .op-detail-body');
  const captionEl = shorts.querySelector('.ttv-shorts-caption');
  if (captionEl) captionEl.textContent = bodyEl?.textContent || '';

  ttvShortsSyncActions(root, pc);
}

// Just the like/reply/share/bookmark button *state* — split out from
// ttvShortsSync so a tap on the rail can resync immediately after
// forwarding a click, without re-reading avatar/caption too.
function ttvShortsSyncActions(root, pc) {
  const shorts = root.querySelector('.ttv-shorts');
  if (!shorts) return;

  const likeBtn = pc.querySelector('.act.like');
  const likeRail = shorts.querySelector('.ttv-shorts-like');
  if (likeRail) {
    likeRail.classList.toggle('active', !!likeBtn?.classList.contains('liked'));
    likeRail.querySelector('.ttv-shorts-count').textContent = likeBtn?.querySelector('.act-label')?.textContent || '0';
    likeRail.style.display = likeBtn ? '' : 'none';
  }

  const replyBtn = pc.querySelector('.act.reply');
  const replyRail = shorts.querySelector('.ttv-shorts-reply');
  if (replyRail) {
    replyRail.querySelector('.ttv-shorts-count').textContent = replyBtn?.querySelector('.act-label')?.textContent || '0';
    replyRail.style.display = replyBtn ? '' : 'none';
  }

  const bookmarkBtn = pc.querySelector('.act.bookmark');
  const bookmarkRail = shorts.querySelector('.ttv-shorts-bookmark');
  if (bookmarkRail) {
    bookmarkRail.classList.toggle('active', !!bookmarkBtn?.classList.contains('bookmarked'));
    bookmarkRail.style.display = bookmarkBtn ? '' : 'none';
  }
}

function ttvShortsForward(root, selector) {
  if (!ttvShortsPc) return;
  const realBtn = ttvShortsPc.querySelector(selector);
  if (!realBtn) return;
  realBtn.click();
  // toggleLike/toggleBookmark/sharePost all update their button's own
  // DOM synchronously (optimistic UI) before their network call
  // resolves, so re-reading state right after click() already
  // reflects the new state.
  ttvShortsSyncActions(root, ttvShortsPc);
}

// Swipes to the next (dir=1) or previous (dir=-1) video post already
// loaded in the feed. Reuses the SAME fullscreened .ttv element and
// just swaps its video src + rail content — matches how a real Shorts
// feed feels (one persistent player, content changes underneath it)
// without needing to fullscreen a different DOM node each swipe.
async function ttvShortsSwap(root, dir) {
  if (ttvShortsIndex === -1) return;
  let nextIndex = ttvShortsIndex + dir;

  if (nextIndex >= ttvShortsQueue.length - 2 && !ttvShortsLoadingMore && typeof loadMoreFeed === 'function') {
    ttvShortsLoadingMore = true;
    try { await loadMoreFeed(); } catch {}
    ttvShortsLoadingMore = false;
    ttvShortsQueue = ttvShortsBuildQueue();
  }

  if (nextIndex < 0 || nextIndex >= ttvShortsQueue.length) return; // nothing further that way
  ttvShortsIndex = nextIndex;
  ttvShortsPc = ttvShortsQueue[ttvShortsIndex];

  const v = ttvVideo(root);
  // Read the stable data-src, not the live src attribute: the single
  // fullscreened <video> element physically still lives inside its
  // original post's card, so once we've swapped it to show a
  // different post's clip, that original card's own .ttv-video (the
  // same DOM node) would report the *new* src if we read `src` here —
  // swiping back to it looked like a no-op because we'd just be
  // reading back what we ourselves overwrote a moment ago.
  const newSrc = ttvShortsPc.querySelector('.ttv-video')?.dataset.src;
  if (v && newSrc) {
    v.pause();
    v.setAttribute('src', newSrc);
    v.currentTime = 0;
    v.load();
    v.play().catch(() => {});
  }
  ttvShortsSync(root, ttvShortsPc);
}

let ttvShortsTouchY = null;
function ttvShortsOnTouchStart(e) {
  ttvShortsTouchY = e.touches?.[0]?.clientY ?? null;
}
function ttvShortsOnTouchEnd(e) {
  if (ttvShortsTouchY === null) return;
  const endY = e.changedTouches?.[0]?.clientY ?? ttvShortsTouchY;
  const dy = ttvShortsTouchY - endY;
  ttvShortsTouchY = null;
  if (Math.abs(dy) < 60) return; // not a deliberate swipe
  ttvShortsSwap(ttvRoot(e.target), dy > 0 ? 1 : -1);
}

let ttvShortsWheelLock = false;
function ttvShortsOnWheel(e) {
  e.preventDefault();
  if (ttvShortsWheelLock) return;
  if (Math.abs(e.deltaY) < 12) return;
  ttvShortsWheelLock = true;
  ttvShortsSwap(ttvRoot(e.target), e.deltaY > 0 ? 1 : -1).finally(() => {
    setTimeout(() => { ttvShortsWheelLock = false; }, 350);
  });
}

// ── rail click delegation ──
document.addEventListener('click', (e) => {
  const shortsBtn = e.target.closest('.ttv-shorts-btn');
  if (!shortsBtn) return;
  const root = ttvRoot(shortsBtn);
  if (!root) return;
  if (shortsBtn.classList.contains('ttv-shorts-like')) ttvShortsForward(root, '.act.like');
  else if (shortsBtn.classList.contains('ttv-shorts-reply')) {
    // The reply popup renders outside .ttv, so it can't show while
    // still browser-fullscreened — drop out of fullscreen first, then
    // open it normally, same as tapping a comment icon anywhere else.
    const pc = ttvShortsPc;
    (document.exitFullscreen ? document.exitFullscreen() : Promise.resolve()).catch(() => {}).finally(() => {
      pc?.querySelector('.act.reply')?.click();
    });
  }
  else if (shortsBtn.classList.contains('ttv-shorts-share')) ttvShortsForward(root, '.act.share');
  else if (shortsBtn.classList.contains('ttv-shorts-bookmark')) ttvShortsForward(root, '.act.bookmark');
});
// FULLSCREEN LAYOUT SYNC — the browser only ever resizes the .ttv
// wrapper itself to fill the screen; the <video> inside it still uses
// object-fit:contain to preserve its own aspect ratio, so on any
// screen whose aspect ratio doesn't match the video's there are black
// letterbox/pillarbox bars on two edges. .ttv-controls used to be
// positioned with inset:0 against the *wrapper* (the full screen),
// not against the video's actual rendered box — so the button rail,
// scrub bar, and time readout all ended up floating out in the empty
// letterbox space instead of hugging the visible video, and at a
// size/position that had nothing to do with where the video actually
// was. This measures the video's real on-screen rect every time it
// can change (entering/leaving fullscreen, window resize, rotating
// the device, and once metadata loads if that's still pending) and
// pins .ttv-controls + .ttv-overlay to exactly that rect instead.
function ttvSyncFullscreenLayout(root) {
  const isFs = document.fullscreenElement === root || document.webkitFullscreenElement === root;
  const controls = root.querySelector('.ttv-controls');
  const overlay = root.querySelector('.ttv-overlay');
  const shorts = root.querySelector('.ttv-shorts');
  if (!isFs) {
    // Back to normal layout — drop the inline override so the regular
    // (non-fullscreen) `inset:0` CSS rule takes over again.
    if (controls) controls.style.cssText = '';
    if (overlay) overlay.style.cssText = '';
    if (shorts) shorts.style.cssText = '';
    return;
  }
  const video = root.querySelector('.ttv-video');
  if (!video) return;
  // The Shorts rail/caption (avatar, like/reply/share/save, handle +
  // caption — see .ttv-shorts-rail/.ttv-shorts-meta in style.css) only
  // needs the same rect-pinning treatment on desktop. A portrait video
  // fullscreened on a phone already fills the screen edge-to-edge, so
  // the rail sits right against it for free. On a wide desktop monitor
  // that same portrait video pillarboxes with big black bars on both
  // sides, and the rail — CSS-anchored to the *screen's* right edge —
  // ends up stranded out in that empty space instead of next to the
  // video. Leave phones exactly as they were.
  const pinShorts = shorts && window.matchMedia('(min-width:701px)').matches;
  if (shorts && !pinShorts) shorts.style.cssText = '';
  const place = () => {
    const vr = video.getBoundingClientRect();
    const rr = root.getBoundingClientRect();
    if (!vr.width || !vr.height) return; // metadata not loaded yet — nothing to measure
    const css = `position:absolute; inset:auto; left:${vr.left - rr.left}px; top:${vr.top - rr.top}px; width:${vr.width}px; height:${vr.height}px;`;
    if (controls) controls.style.cssText = css;
    if (overlay) overlay.style.cssText = css;
    if (pinShorts) shorts.style.cssText = css;
  };
  // Fullscreen resize is applied by the browser over a frame or two,
  // so measuring immediately can catch the wrapper mid-transition —
  // a rAF (post-layout) plus a follow-up next frame covers that.
  requestAnimationFrame(() => { place(); requestAnimationFrame(place); });
}
window.addEventListener('resize', () => {
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  if (fs && fs.classList?.contains('ttv')) ttvSyncFullscreenLayout(fs);
});
document.addEventListener('loadedmetadata', (e) => {
  if (!e.target.classList?.contains('ttv-video')) return;
  const fs = document.fullscreenElement || document.webkitFullscreenElement;
  const root = ttvRoot(e.target);
  if (fs && fs === root) ttvSyncFullscreenLayout(root);
}, true);

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
