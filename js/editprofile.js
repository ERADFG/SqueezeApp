// ─────────────────────────────────────────────────────────────
// EDIT PROFILE PAGE — /editprofile.html (requires login)
// Always edits the current session's own profile — there is no
// ?u= param, unlike profile.html/followlist.html, since you can
// only ever edit your own account.
// ─────────────────────────────────────────────────────────────
let epProfile = null;
let epAvatarFile = null;
let epBannerFile = null;

async function loadEditProfile() {
  const root = document.getElementById('editprofile-root');
  const { data: { session } } = await sb.auth.getSession();

  if (!session) {
    root.innerHTML = `<div class="post-login-gate" style="border-top:none;">Log in to edit your profile. <a href="login.html">Log in</a> or <a href="signup.html">sign up</a>.</div>`;
    return;
  }

  epProfile = await getProfile(session.user.id);
  if (!epProfile) {
    root.innerHTML = `<div class="errmsg">Could not load your profile.</div>`;
    return;
  }

  document.getElementById('ep-back').href = profileUrl(epProfile.username);
  document.title = `Edit profile — InteractInk`;

  root.innerHTML = `
    <div class="ep-banner-wrap" id="ep-banner-wrap" style="${epProfile.banner_url ? `--banner-img:url('${esc(epProfile.banner_url)}')` : ''}">
      <label class="ep-banner-pick" for="ep-banner-file">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h3l2-2h6l2 2h3v12H4V7Z"/><circle cx="12" cy="13" r="3.5"/></svg>
      </label>
      <input type="file" id="ep-banner-file" accept="image/*" style="display:none;">
      <img class="avatar ep-avatar${avSqClass(epProfile)}" id="ep-avatar-preview" src="${esc(avatarUrl(epProfile.avatar_url))}" alt="">
      <label class="ep-avatar-pick" for="ep-avatar-file">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h3l2-2h6l2 2h3v12H4V7Z"/><circle cx="12" cy="13" r="3.5"/></svg>
      </label>
      <input type="file" id="ep-avatar-file" accept="image/*" style="display:none;">
    </div>

    <div class="ep-form">
      <div class="errmsg" id="ep-err" style="display:none;"></div>

      <label>Display name</label>
      <input type="text" id="ep-display" maxlength="50" value="${esc(epProfile.display_name || '')}" placeholder="${esc(epProfile.username)}">

      <label>Bio</label>
      <textarea id="ep-bio" maxlength="200" placeholder="Tell people about yourself&hellip;">${esc(epProfile.bio || '')}</textarea>
      <span class="pf-note" id="ep-bio-count">${(epProfile.bio || '').length}/200</span>

      <label>Location</label>
      <input type="text" id="ep-location" maxlength="30" value="${esc(epProfile.location || '')}" placeholder="Where are you based?">

      <label>Website</label>
      <input type="text" id="ep-website" maxlength="100" value="${esc(epProfile.website || '')}" placeholder="yourlink.com">

      <div class="edit-row">
        <input type="submit" class="pf-btn" value="Save" onclick="saveEditProfile();return false;">
        <a class="profile-edit-btn" href="${profileUrl(epProfile.username)}">Cancel</a>
        <span id="ep-st" style="font-size:11px;color:var(--muted);"></span>
      </div>
    </div>
  `;

  document.getElementById('ep-avatar-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    const errEl = document.getElementById('ep-err');
    e.target.value = '';
    if (!file) return;
    if (!validateFile(file, errEl)) return;
    clearErr(errEl);
    openCropModal(file, 'square', (cropped) => {
      epAvatarFile = cropped;
      document.getElementById('ep-avatar-preview').src = URL.createObjectURL(cropped);
    });
  });

  document.getElementById('ep-banner-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    const errEl = document.getElementById('ep-err');
    e.target.value = '';
    if (!file) return;
    if (!validateFile(file, errEl)) return;
    clearErr(errEl);
    openCropModal(file, 'wide', (cropped) => {
      epBannerFile = cropped;
      document.getElementById('ep-banner-wrap').style.setProperty('--banner-img', `url('${URL.createObjectURL(cropped)}')`);
    });
  });

  document.getElementById('ep-bio').addEventListener('input', (e) => {
    document.getElementById('ep-bio-count').textContent = `${e.target.value.length}/200`;
  });
}

async function saveEditProfile() {
  const errEl = document.getElementById('ep-err');
  const stEl  = document.getElementById('ep-st');
  clearErr(errEl);
  stEl.textContent = 'Saving…';
  try {
    const updates = {
      display_name: document.getElementById('ep-display').value.trim().slice(0, 50) || null,
      bio: document.getElementById('ep-bio').value.trim().slice(0, 200) || null,
      location: document.getElementById('ep-location').value.trim().slice(0, 30) || null,
      website: normalizeWebsite(document.getElementById('ep-website').value.trim())
    };
    if (epAvatarFile) {
      stEl.textContent = 'Uploading avatar…';
      updates.avatar_url = await uploadAvatar(epAvatarFile, epProfile.id);
    }
    if (epBannerFile) {
      stEl.textContent = 'Uploading banner…';
      updates.banner_url = await uploadAvatar(epBannerFile, epProfile.id);
    }
    const { error } = await sb.from('profiles').update(updates).eq('id', epProfile.id);
    if (error) throw error;
    stEl.textContent = '';
    location.href = profileUrl(epProfile.username);
  } catch (e) {
    showErr(errEl, e.message || 'Could not save changes.');
    stEl.textContent = '';
  }
}

// Twitter-style link field: users type "example.com" without a
// scheme, but the profile page needs a real absolute href, so a
// missing http(s):// is added on save rather than on every render.
function normalizeWebsite(raw) {
  if (!raw) return null;
  const trimmed = raw.slice(0, 100);
  return /^https?:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
}

document.addEventListener('DOMContentLoaded', loadEditProfile);
