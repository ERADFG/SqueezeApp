// ─────────────────────────────────────────────────────────────
// SETTINGS PAGE — /settings.html (requires login)
// Notification toggles + DM privacy read/write against
// public.user_settings (see supabase/settings.sql). Every account
// always has exactly one row there (auto-created on signup), so
// this never has to handle a "missing settings" case.
// ─────────────────────────────────────────────────────────────
function toggleRowHtml(id, label, sub, checked) {
  return `
    <div class="settings-row">
      <div>
        <div class="lbl">${label}</div>
        <div class="pf-note" style="margin-top:2px;">${sub}</div>
      </div>
      <label class="toggle">
        <input type="checkbox" id="${id}" ${checked ? 'checked' : ''} onchange="saveNotifSetting('${id}')">
        <span class="toggle-track"></span>
      </label>
    </div>`;
}

function themeSwatchHtml(id, label, active) {
  return `
    <button type="button" class="theme-swatch${active ? ' active' : ''}" data-theme-opt="${id}" onclick="chooseTheme('${id}')">
      <span class="ts-preview"><span></span></span>
      <span class="ts-label">${label}</span>
    </button>`;
}

function accentSwatchHtml(id, label, active) {
  return `
    <button type="button" class="accent-swatch${active ? ' active' : ''}" data-accent-opt="${id}" title="${label}" aria-label="${label}" onclick="chooseAccent('${id}')"></button>`;
}

async function loadSettings() {
  const root = document.getElementById('settings-root');
  const { data: { session } } = await sb.auth.getSession();

  if (!session) {
    root.innerHTML = `<div class="post-login-gate" style="border-top:none;">Log in to manage your settings. <a href="login.html">Log in</a> or <a href="signup.html">sign up</a>.</div>`;
    return;
  }

  const profile = await getProfile(session.user.id);
  const uname = profile?.username || 'user';
  const curTheme = getTheme();
  const curAccent = getAccent();

  const { data: settings } = await sb.from('user_settings').select('*').eq('user_id', session.user.id).single();
  const s = settings || { notify_likes: true, notify_replies: true, notify_follows: true, notify_mentions: true, dm_privacy: 'everyone' };

  root.innerHTML = `
    <div class="settings-section">
      <h2>${t('settings.profile')}</h2>
      <p class="sub">${t('settings.profileSub')}</p>
      <a class="profile-edit-btn" href="editprofile.html">${t('settings.editProfile')}</a>
    </div>

    <div class="settings-section">
      <h2>${t('settings.appearance')}</h2>
      <p class="sub">${t('settings.appearanceSub')}</p>
      <div class="theme-picker" id="theme-picker">
        ${themeSwatchHtml('auto', 'Match device', !getStoredTheme())}
        ${themeSwatchHtml('light', 'Default', curTheme === 'light' && !!getStoredTheme())}
        ${themeSwatchHtml('dim', 'Dim', curTheme === 'dim' && !!getStoredTheme())}
        ${themeSwatchHtml('dark', 'Lights out', curTheme === 'dark' && !!getStoredTheme())}
      </div>
      <p class="pf-note" style="margin-top:8px;">"Match device" follows your phone or browser's light/dark setting automatically.</p>
      <p class="sub" style="margin-top:16px;">Pick an accent color for buttons and links.</p>
      <div class="accent-picker" id="accent-picker">
        ${ACCENT_OPTIONS.map(a => accentSwatchHtml(a.id, a.label, curAccent === a.id)).join('')}
      </div>
    </div>

    <div class="settings-section">
      <h2>${t('settings.language')}</h2>
      <p class="sub">${t('settings.languageSub')}</p>
      <div class="settings-row">
        <div><div class="lbl">${t('settings.language')}</div></div>
        ${langSelectHtml('set-lang')}
      </div>
    </div>

    <div class="settings-section">
      <h2>${t('settings.notifications')}</h2>
      <p class="sub">Choose what shows up on your Notifications page.</p>
      ${toggleRowHtml('notify_likes', 'Likes', 'When someone likes your post', s.notify_likes)}
      ${toggleRowHtml('notify_replies', 'Replies', 'When someone replies to your post', s.notify_replies)}
      ${toggleRowHtml('notify_mentions', 'Mentions', 'When someone tags you with @', s.notify_mentions)}
      ${toggleRowHtml('notify_follows', 'New followers', 'When someone follows you', s.notify_follows)}
    </div>

    <div class="settings-section">
      <h2>${t('settings.privacy')}</h2>
      <div class="settings-row">
        <div>
          <div class="lbl">Who can message you</div>
          <div class="pf-note" style="margin-top:2px;">Applies to new conversations only.</div>
        </div>
        <select id="dm-privacy" onchange="saveDmPrivacy()" style="width:auto;">
          <option value="everyone" ${s.dm_privacy === 'everyone' ? 'selected' : ''}>Everyone</option>
          <option value="following" ${s.dm_privacy === 'following' ? 'selected' : ''}>People you follow</option>
        </select>
      </div>
      <span id="dm-privacy-st" style="font-size:11px;color:var(--muted);"></span>
    </div>

    <div class="settings-section">
      <h2>${t('settings.account')}</h2>
      <div class="errmsg" id="set-uname-err" style="display:none;"></div>
      <label style="display:block;font-size:12px;font-weight:700;color:var(--muted);margin:0 0 4px;">Username</label>
      <input type="text" id="set-uname" value="${esc(uname)}" maxlength="20">
      <span class="auth-hint">3–20 characters: letters, numbers, and underscores only.</span>
      <div style="margin-top:8px;">
        <input type="submit" class="pf-btn" value="Update Username" onclick="updateUsername();return false;">
        <span id="set-uname-st" style="font-size:11px;color:var(--muted);margin-left:8px;"></span>
      </div>

      <div class="settings-row" style="margin-top:16px;">
        <span class="lbl">Email</span>
        <span class="val">${esc(session.user.email || '')}</span>
      </div>
      <div class="errmsg" id="set-email-err" style="display:none;"></div>
      <label style="display:block;font-size:12px;font-weight:700;color:var(--muted);margin:10px 0 4px;">Change email</label>
      <input type="email" id="set-email" placeholder="new@email.com">
      <div style="margin-top:8px;">
        <input type="submit" class="pf-btn" value="Update Email" onclick="updateEmail();return false;">
        <span id="set-email-st" style="font-size:11px;color:var(--muted);margin-left:8px;"></span>
      </div>
    </div>

    <div class="settings-section">
      <h2>${t('settings.password')}</h2>
      <div class="errmsg" id="set-pw-err" style="display:none;"></div>
      <label style="display:block;font-size:12px;font-weight:700;color:var(--muted);margin:0 0 4px;">New password</label>
      <input type="password" id="set-pw" minlength="8" autocomplete="new-password">
      <span class="auth-hint">At least 8 characters.</span>
      <div style="margin-top:8px;">
        <input type="submit" class="pf-btn" value="Update Password" onclick="updatePassword();return false;">
        <span id="set-pw-st" style="font-size:11px;color:var(--muted);margin-left:8px;"></span>
      </div>
    </div>

    <div class="settings-section">
      <h2>${t('settings.session')}</h2>
      <button class="pf-btn" style="background:var(--like);" onclick="logOut()">${t('nav.logOut')}</button>
    </div>
  `;
}

async function saveNotifSetting(id) {
  const checked = document.getElementById(id).checked;
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  const { error } = await sb.from('user_settings').update({ [id]: checked }).eq('user_id', session.user.id);
  if (error) {
    document.getElementById(id).checked = !checked; // revert on failure
    alert(error.message || 'Could not save that setting.');
  }
}

async function saveDmPrivacy() {
  const stEl = document.getElementById('dm-privacy-st');
  const value = document.getElementById('dm-privacy').value;
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  stEl.textContent = 'Saving…';
  const { error } = await sb.from('user_settings').update({ dm_privacy: value }).eq('user_id', session.user.id);
  stEl.textContent = error ? '' : 'Saved.';
  if (error) alert(error.message || 'Could not save that setting.');
  setTimeout(() => { stEl.textContent = ''; }, 1500);
}

function chooseTheme(id) {
  applyTheme(id);
  document.querySelectorAll('#theme-picker .theme-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.themeOpt === id);
  });
}

function chooseAccent(id) {
  applyAccent(id);
  document.querySelectorAll('#accent-picker .accent-swatch').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.accentOpt === id);
  });
}

async function updateUsername() {
  const input = document.getElementById('set-uname');
  const errEl = document.getElementById('set-uname-err');
  const stEl = document.getElementById('set-uname-st');
  clearErr(errEl);
  const username = input.value.trim();
  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    showErr(errEl, 'Usernames are 3–20 characters: letters, numbers, and underscores only.');
    return;
  }
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  if (currentProfile && username === currentProfile.username) return;
  stEl.textContent = 'Saving…';
  const { error } = await sb.from('profiles').update({ username }).eq('id', session.user.id);
  if (error) {
    stEl.textContent = '';
    const taken = error.code === '23505' || /duplicate/i.test(error.message || '');
    showErr(errEl, taken ? 'That username is already taken.' : (error.message || 'Could not update username.'));
    return;
  }
  await renderAuthArea(); // repaints the sidebar/account card with the new username
  stEl.textContent = '';
  alert('Username updated.');
}

async function updateEmail() {
  const input = document.getElementById('set-email');
  const errEl = document.getElementById('set-email-err');
  const stEl = document.getElementById('set-email-st');
  clearErr(errEl);
  const email = input.value.trim();
  if (!email) { showErr(errEl, 'Enter a new email address.'); return; }
  stEl.textContent = 'Saving…';
  try {
    const { error } = await sb.auth.updateUser({ email });
    if (error) throw error;
    stEl.textContent = '';
    input.value = '';
    alert('Check both your old and new inbox to confirm this change.');
  } catch (e) {
    showErr(errEl, e.message || 'Could not update email.');
    stEl.textContent = '';
  }
}

async function updatePassword() {
  const input = document.getElementById('set-pw');
  const errEl = document.getElementById('set-pw-err');
  const stEl = document.getElementById('set-pw-st');
  clearErr(errEl);
  const password = input.value;
  if (password.length < 8) { showErr(errEl, 'Password must be at least 8 characters.'); return; }
  stEl.textContent = 'Saving…';
  try {
    const { error } = await sb.auth.updateUser({ password });
    if (error) throw error;
    stEl.textContent = '';
    input.value = '';
    alert('Password updated.');
  } catch (e) {
    showErr(errEl, e.message || 'Could not update password.');
    stEl.textContent = '';
  }
}

document.addEventListener('DOMContentLoaded', loadSettings);
