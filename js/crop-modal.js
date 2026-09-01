// ─────────────────────────────────────────────────────────────
// CROP MODAL — shared "Edit media" step shown before an image is
// set as anyone's avatar or banner (profile, community, or List).
// Mirrors Twitter/X's own crop UI: the picked image sits inside a
// fixed-size frame, drag to reposition, slider to zoom, and a
// canvas-based export on Apply. Callers never touch pixels — they
// just get back a File they can hand straight to uploadAvatar().
//
// Usage:
//   openCropModal(file, 'square', (croppedFile) => { ... });
//   openCropModal(file, 'wide',   (croppedFile) => { ... });
// `shape` picks the frame's aspect ratio and output size:
//   'square' → 1:1, 400×400  (avatars — profile/community/list)
//   'wide'   → 3:1, 1500×500 (banners — profile/community/list)
// The callback only fires on Apply; Back/Escape/backdrop-click just
// close the modal and call nothing, leaving the caller's own file
// input/state untouched (so a cancelled crop is a true no-op).
// ─────────────────────────────────────────────────────────────

let cmState = null; // { img, scale, minScale, maxScale, x, y, frameW, frameH, shape, onApply, dragging, startX, startY }

function cmModalEl() {
  let el = document.getElementById('cm-modal-bg');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'cm-modal-bg';
  el.className = 'cm-modal-bg';
  el.innerHTML = `
    <div class="cm-modal">
      <div class="cm-modal-hdr">
        <button type="button" class="cm-back" onclick="closeCropModal()" aria-label="Back">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M15 6l-6 6 6 6"/></svg>
        </button>
        <span class="cm-title">Edit media</span>
        <button type="button" class="cm-apply" id="cm-apply-btn" onclick="applyCropModal()">Apply</button>
      </div>
      <div class="cm-stage" id="cm-stage">
        <img class="cm-img" id="cm-img" alt="" draggable="false">
        <div class="cm-frame" id="cm-frame"></div>
      </div>
      <div class="cm-controls">
        <svg class="cm-zoom-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="6.5"/><path d="M20 20l-4.5-4.5"/></svg>
        <input type="range" id="cm-zoom" min="0" max="100" value="0">
        <svg class="cm-zoom-ic cm-zoom-ic-lg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="10" cy="10" r="6.5"/><path d="M20 20l-4.5-4.5"/></svg>
      </div>
    </div>`;
  document.body.appendChild(el);
  el.addEventListener('click', e => { if (e.target === el) closeCropModal(); });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && el.classList.contains('open')) closeCropModal();
  });

  const stage = el.querySelector('#cm-stage');
  const img = el.querySelector('#cm-img');
  const zoom = el.querySelector('#cm-zoom');

  const onDown = (clientX, clientY) => {
    if (!cmState) return;
    cmState.dragging = true;
    cmState.startX = clientX - cmState.x;
    cmState.startY = clientY - cmState.y;
  };
  const onMove = (clientX, clientY) => {
    if (!cmState || !cmState.dragging) return;
    cmState.x = clientX - cmState.startX;
    cmState.y = clientY - cmState.startY;
    cmClamp();
    cmRender();
  };
  const onUp = () => { if (cmState) cmState.dragging = false; };

  stage.addEventListener('mousedown', e => { onDown(e.clientX, e.clientY); e.preventDefault(); });
  window.addEventListener('mousemove', e => onMove(e.clientX, e.clientY));
  window.addEventListener('mouseup', onUp);
  stage.addEventListener('touchstart', e => {
    const t = e.touches[0]; onDown(t.clientX, t.clientY);
  }, { passive: true });
  stage.addEventListener('touchmove', e => {
    const t = e.touches[0]; onMove(t.clientX, t.clientY); e.preventDefault();
  }, { passive: false });
  stage.addEventListener('touchend', onUp);

  zoom.addEventListener('input', () => {
    if (!cmState) return;
    const t = Number(zoom.value) / 100; // 0..1 across min..max scale
    cmState.scale = cmState.minScale + t * (cmState.maxScale - cmState.minScale);
    cmClamp();
    cmRender();
  });

  return el;
}

// shape: 'square' (avatars, 1:1, 400×400 output) or 'wide' (banners,
// 3:1, 1500×500 output). onApply(File) fires only when the user hits
// Apply — Back/Escape/backdrop just close with no callback.
function openCropModal(file, shape, onApply) {
  // shape === 'square' is always an avatar (profile/community/list —
  // see the shape comment atop this file); 'wide' banners aren't
  // covered by this cap. Callers already run the file through
  // validateFile()'s general MAX_FILE_MB check before reaching here,
  // but that's the *upload* limit for any file type — this is the
  // avatar-specific cap (AVATAR_MAX_MB, js/supabase-config.js), kept
  // as its own constant so the two can diverge later without this
  // check silently drifting out of sync with the general one.
  if (shape === 'square' && file.size > AVATAR_MAX_MB * 1024 * 1024) {
    showErr(null, `File too large. Max ${AVATAR_MAX_MB}MB.`);
    return;
  }

  const el = cmModalEl();
  const stage = document.getElementById('cm-stage');
  const frame = document.getElementById('cm-frame');
  const imgEl = document.getElementById('cm-img');

  const isSquare = shape === 'square';
  frame.className = 'cm-frame' + (isSquare ? ' cm-frame-square' : ' cm-frame-wide');

  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      el.classList.add('open');
      lockScroll();
      // Measure the stage only once it's actually laid out (the
      // modal was just made visible), so the frame fits narrow
      // mobile viewports instead of a fixed desktop-sized box.
      requestAnimationFrame(() => {
        const stageW = stage.clientWidth - 32; // leave a little margin either side
        const base = isSquare ? Math.min(280, stageW) : Math.min(420, stageW);
        const frameW = base;
        const frameH = isSquare ? base : Math.round(base / 3);
        stage.style.setProperty('--cm-frame-w', frameW + 'px');
        stage.style.setProperty('--cm-frame-h', frameH + 'px');

        const minScale = Math.max(frameW / img.width, frameH / img.height);
        cmState = {
          img, shape, onApply,
          srcName: file.name || 'image.jpg',
          scale: minScale, minScale, maxScale: minScale * 4,
          x: 0, y: 0, frameW, frameH, dragging: false, startX: 0, startY: 0
        };
        imgEl.src = img.src;
        document.getElementById('cm-zoom').value = 0;
        cmRender();
      });
    };
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}

function cmClamp() {
  const s = cmState;
  const w = s.img.width * s.scale;
  const h = s.img.height * s.scale;
  const maxX = (w - s.frameW) / 2;
  const maxY = (h - s.frameH) / 2;
  s.x = Math.max(-maxX, Math.min(maxX, s.x));
  s.y = Math.max(-maxY, Math.min(maxY, s.y));
}

function cmRender() {
  const s = cmState;
  const imgEl = document.getElementById('cm-img');
  const w = s.img.width * s.scale;
  const h = s.img.height * s.scale;
  imgEl.style.width = w + 'px';
  imgEl.style.height = h + 'px';
  imgEl.style.transform = `translate(calc(-50% + ${s.x}px), calc(-50% + ${s.y}px))`;
}

function closeCropModal() {
  const el = document.getElementById('cm-modal-bg');
  if (el?.classList.contains('open')) { el.classList.remove('open'); unlockScroll(); }
  cmState = null;
}

function applyCropModal() {
  const s = cmState;
  if (!s) return;
  const outW = s.shape === 'square' ? 400 : 1500;
  const outH = s.shape === 'square' ? 400 : 500;
  const canvas = document.createElement('canvas');
  canvas.width = outW; canvas.height = outH;
  const ctx = canvas.getContext('2d');

  // Map the visible frame (in on-screen px, centered on the image)
  // back to source-image pixels, then draw just that region scaled
  // up to the fixed output size.
  const srcScale = 1 / s.scale;
  const visW = s.frameW * srcScale;
  const visH = s.frameH * srcScale;
  const srcCx = s.img.width / 2 - s.x * srcScale;
  const srcCy = s.img.height / 2 - s.y * srcScale;
  const sx = srcCx - visW / 2;
  const sy = srcCy - visH / 2;

  ctx.drawImage(s.img, sx, sy, visW, visH, 0, 0, outW, outH);

  const ext = (s.srcName.split('.').pop() || 'jpg').toLowerCase();
  const mime = ext === 'png' ? 'image/png' : 'image/jpeg';
  canvas.toBlob(blob => {
    if (!blob) return;
    const outName = `crop.${mime === 'image/png' ? 'png' : 'jpg'}`;
    const outFile = new File([blob], outName, { type: mime });
    const cb = s.onApply;
    closeCropModal();
    cb(outFile);
  }, mime, 0.92);
}
