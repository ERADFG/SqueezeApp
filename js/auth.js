// ─────────────────────────────────────────────────────────────
// AUTH — accounts are required to post on InteractInk now. This file
// wires up: session state, the header's login/signup vs avatar
// dropdown, sign up / log in / log out, and avatar uploads.
// Included on every page (after supabase-config.js + common.js).
// ─────────────────────────────────────────────────────────────

let currentSession = null;
let currentProfile = null;

// Resolves once the initial session check has settled — i.e. once
// `currentSession` is safe to read (either a real session or
// definitely null, logged out). Every page's own post-loading code
// (board.js/profile.js/thread.js/bookmarks.js/search.js) awaits this
// before its first render. Without it, a page's own DOMContentLoaded
// listener can — and often does — finish its posts query before this
// file's getSession() call resolves, rendering every post card as if
// nobody were logged in. That's harmless for most of the UI (likes/
// bookmarks/reposts just get corrected the moment you interact with
// them), but "Delete" only for your own posts is baked into the menu
// HTML at render time and never gets a second pass — so it can look
// like Delete is permanently missing/broken depending on how that
// race happens to land.
let resolveAuthReady;
const authReady = new Promise(res => { resolveAuthReady = res; });

async function getProfile(userId) {
  const { data } = await sb.from('profiles').select('*').eq('id', userId).single();
  return data || null;
}

// Renders whatever should sit in the header's #auth-area — either
// [Log in] [Sign up], or the avatar + username dropdown menu.
async function renderAuthArea() {
  const el = document.getElementById('auth-area');
  renderSideNav(); renderMobileChrome(); // paint immediately with whatever we knew last; repainted below once session settles

  const { data: { session } } = await sb.auth.getSession();
  currentSession = session;
  resolveAuthReady();

  if (!session) {
    currentProfile = null;
    unreadNotifCount = 0;
    unreadChatCount = 0;
    renderSideNav(); renderMobileChrome();
    if (el) el.innerHTML = `<div class="auth-cta"><a class="cta-primary" href="signup.html">Sign up</a><a class="cta-ghost" href="login.html">Log in</a></div>`;
    refreshPostGates();
    return;
  }

  currentProfile = await getProfile(session.user.id);

  // A timed suspension (admin_suspend_user with a duration, rather
  // than permanent) lifts itself the moment its expiry has passed —
  // this is what actually applies that, right when the account next
  // loads the site, rather than waiting on the best-effort pg_cron
  // sweep. See clear_expired_suspension() in
  // supabase/admin_panel_advanced.sql.
  if (currentProfile?.banned && currentProfile?.suspended_until && new Date(currentProfile.suspended_until) <= new Date()) {
    const { data: cleared } = await sb.rpc('clear_expired_suspension');
    if (cleared) currentProfile = await getProfile(session.user.id);
  }

  // Suspended accounts get signed out the moment their profile loads,
  // wherever they are on the site — admin_suspend_user() (SQL) already
  // stops them posting/replying at the RLS level, this just kicks
  // them out of the session too instead of leaving them logged in
  // and confused. See supabase/admin_panel_advanced.sql.
  if (currentProfile?.banned) {
    const suspendedUntil = currentProfile?.suspended_until;
    await sb.auth.signOut();
    currentSession = null;
    currentProfile = null;
    unreadNotifCount = 0;
    unreadChatCount = 0;
    renderSideNav(); renderMobileChrome();
    if (el) el.innerHTML = `<div class="auth-cta"><a class="cta-primary" href="signup.html">Sign up</a><a class="cta-ghost" href="login.html">Log in</a></div>`;
    refreshPostGates();
    const until = suspendedUntil ? ` until ${new Date(suspendedUntil).toLocaleString()}` : '';
    alert(`This account has been suspended${until}.`);
    return;
  }

  const uname = currentProfile?.username || 'user';
  const avatar = avatarUrl(currentProfile?.avatar_url);
  renderSideNav(); renderMobileChrome();
  loadUnreadNotifCount();
  subscribeNotifBadge();
  loadUnreadChatCount();
  subscribeChatBadge();

  if (el) el.innerHTML = `
    <div class="acct" id="acct-wrap">
      <button class="acct-btn" id="acct-btn" onclick="toggleAcctMenu();return false;">
        <img class="avatar pfp-md" src="${esc(avatar)}" alt="">
        <span class="acct-txt">
          <span class="acct-name">${esc(currentProfile?.display_name || uname)}</span>
          <span class="acct-handle">@${esc(uname)}</span>
        </span>
        <span class="acct-dots">${NAV_ICON.dots}</span>
      </button>
      <div class="acct-menu" id="acct-menu">
        <a href="${profileUrl(uname)}">My Profile</a>
        <a href="editprofile.html">Edit Profile</a>
        <button onclick="logOut()">Log out</button>
      </div>
    </div>`;
  refreshPostGates();
}

// Unread notification count for the sidebar bell badge.
async function loadUnreadNotifCount() {
  if (!currentSession) { unreadNotifCount = 0; renderSideNav(); renderMobileChrome(); return; }
  const { count } = await sb.from('notifications').select('id', { count: 'exact', head: true })
    .eq('user_id', currentSession.user.id).eq('read', false);
  unreadNotifCount = count || 0;
  renderSideNav(); renderMobileChrome();
}

// Live-bump the bell badge the moment a new notification lands,
// without needing to be on the notifications page.
let notifBadgeChannel = null;
function subscribeNotifBadge() {
  if (notifBadgeChannel || !currentSession) return;
  notifBadgeChannel = sb.channel(`notif-badge-${currentSession.user.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications', filter: `user_id=eq.${currentSession.user.id}` }, () => {
      unreadNotifCount++;
      renderSideNav(); renderMobileChrome();
    })
    .subscribe();
}

// Unread DM count for the sidebar/tab-bar chat badge — counts unread
// messages, same shape as loadUnreadNotifCount() above.
async function loadUnreadChatCount() {
  if (!currentSession) { unreadChatCount = 0; renderSideNav(); renderMobileChrome(); return; }
  const { count } = await sb.from('messages').select('id', { count: 'exact', head: true })
    .eq('recipient_id', currentSession.user.id).eq('read', false);
  unreadChatCount = count || 0;
  renderSideNav(); renderMobileChrome();
}

// Live-bump the chat badge the moment a new message lands, without
// needing to be on the chat page (mirrors subscribeNotifBadge()).
let chatBadgeChannel = null;
function subscribeChatBadge() {
  if (chatBadgeChannel || !currentSession) return;
  chatBadgeChannel = sb.channel(`chat-badge-${currentSession.user.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient_id=eq.${currentSession.user.id}` }, () => {
      unreadChatCount++;
      renderSideNav(); renderMobileChrome();
    })
    .subscribe();
}

function toggleAcctMenu() {
  document.getElementById('acct-wrap')?.classList.toggle('open');
}
// Shared close-on-outside-click for every .acct flyout (the bottom
// account card AND the sidebar's More menu use the same .acct/.acct-menu
// pattern, so one listener covers both).
document.addEventListener('click', (e) => {
  document.querySelectorAll('.acct.open').forEach(wrap => {
    if (!wrap.contains(e.target)) wrap.classList.remove('open');
  });
});

// Board/thread pages call this to show either the real post form or a
// "log in to post" gate, depending on session state.
function refreshPostGates() {
  document.querySelectorAll('[data-requires-auth]').forEach(elm => {
    elm.style.display = currentSession ? '' : 'none';
  });
  document.querySelectorAll('[data-requires-anon]').forEach(elm => {
    elm.style.display = currentSession ? 'none' : '';
  });
  // The board page's composer shows the logged-in user's avatar next
  // to the textarea, Twitter-style — repaint it whenever auth state
  // settles or changes. No-op on pages without a composer.
  if (typeof renderComposerAvatar === 'function') renderComposerAvatar();
}

function requireLogin() {
  if (!currentSession) {
    toast('You need an account to do that. Log in or sign up first.', 'error');
    return false;
  }
  return true;
}

// ── PASSWORD VISIBILITY TOGGLE — used by login.html / signup.html's
// eye-icon button next to the password field. Purely a display
// affordance (input type text/password), no auth logic involved. ──
function togglePwVis(inputId, btn) {
  const input = document.getElementById(inputId);
  if (!input) return;
  const showing = input.type === 'text';
  input.type = showing ? 'password' : 'text';
  btn.classList.toggle('showing', !showing);
  btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
}

// ── SIGN UP ──
// No email verification step at all — signUp() creates the auth.users
// row (and, via the DB trigger, the profiles row + auto-follow of
// @marpe) and hands back a real session in the same call, so the
// person is fully signed up and logged in the moment they submit the
// form. This is deliberate: email-based verification (link or code)
// means every signup sends an email, and Supabase's built-in mailer
// caps out at a handful of emails per hour — fine for a few test
// signups, but it falls over completely the moment real traffic shows
// up (e.g. 100 signups in an hour). Skipping email verification
// removes that bottleneck entirely: nothing external is involved, so
// there's no rate limit to hit no matter how many people sign up.
// This requires "Confirm email" to be OFF in the Supabase dashboard
// (Authentication → Providers → Email) — see the README.
async function doSignUp(e) {
  e?.preventDefault();
  const email    = document.getElementById('su-email').value.trim();
  const username = document.getElementById('su-username').value.trim();
  const password = document.getElementById('su-password').value;
  const btn = document.getElementById('su-btn');
  const errEl = document.getElementById('su-err');
  clearErr(errEl);

  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    showErr(errEl, 'Username must be 3–20 characters: letters, numbers, underscore only.');
    return;
  }
  if (password.length < 8) {
    showErr(errEl, 'Password must be at least 8 characters.');
    return;
  }
  if (!(await verifyHuman('su-captcha', errEl))) return;

  btn.disabled = true; btn.value = 'Creating account…';
  try {
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { username } }
    });
    if (error) throw error;

    if (data.session) {
      // The normal, expected path — account created and logged in
      // immediately, nothing further needed.
      location.href = 'index.html';
      return;
    }

    // No session came back. Supabase collapses two very different
    // situations into this same "success, no session" shape, so they
    // need to be told apart instead of showing one generic error for
    // both:
    //
    // 1) The email is already registered. To avoid leaking which
    //    emails exist on the site, Supabase doesn't return a
    //    "duplicate" error here — it silently returns a fake user
    //    object with an *empty* identities array and no session. This
    //    is almost always what actually happened when this code path
    //    is hit (e.g. re-submitting the form, or testing with the
    //    same address twice) — not a broken project setting.
    // 2) "Confirm email" is genuinely ON for this project, and this
    //    really is a brand-new signup pending a confirmation email —
    //    data.user exists with a non-empty identities array.
    if (data.user && Array.isArray(data.user.identities) && data.user.identities.length === 0) {
      throw new Error('That email is already registered — try logging in instead.');
    }
    if (data.user) {
      showErr(errEl, 'Account created! Check your email to confirm it, then log in.');
      errEl.classList.add('auth-ok');
      btn.value = 'Check your email';
      return;
    }
    // Neither shape matched (data.user missing entirely) — the one
    // remaining explanation is the project setting itself.
    throw new Error('Account created, but no session came back. If this keeps happening, check that "Confirm email" is turned OFF in the Supabase dashboard (Authentication → Providers → Email).');
  } catch (err) {
    showErr(errEl, err.message?.includes('duplicate') || err.message?.includes('unique')
      ? 'That username or email is already taken.'
      : (err.message || 'Sign up failed.'));
    btn.disabled = false; btn.value = 'Sign Up';
  }
}

// ── LOG IN ──
async function doLogIn(e) {
  e?.preventDefault();
  const email    = document.getElementById('li-email').value.trim();
  const password = document.getElementById('li-password').value;
  const btn = document.getElementById('li-btn');
  const errEl = document.getElementById('li-err');
  clearErr(errEl);

  if (!(await verifyHuman('li-captcha', errEl))) return;

  btn.disabled = true; btn.value = 'Logging in…';
  try {
    const { error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;
    location.href = 'index.html';
  } catch (err) {
    showErr(errEl, err.message === 'Invalid login credentials'
      ? 'Incorrect email or password.'
      : (err.message || 'Log in failed.'));
    btn.disabled = false; btn.value = 'Log In';
  }
}

// ── LOG OUT ──
async function logOut() {
  await sb.auth.signOut();
  location.href = 'index.html';
}

// Uploads to avatars/<uid>/<random>.<ext> — the storage RLS policy
// only allows a user to write inside their own <uid> folder.
async function uploadAvatar(file, userId) {
  const ext = file.name.split('.').pop().toLowerCase();
  const path = `${userId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from('avatars').upload(path, file, {
    cacheControl: '3600', upsert: false, contentType: file.type
  });
  if (error) throw error;
  const { data } = sb.storage.from('avatars').getPublicUrl(path);
  return data.publicUrl;
}

document.addEventListener('DOMContentLoaded', () => {
  renderAuthArea();
  sb.auth.onAuthStateChange((_event, _session) => {
    renderAuthArea();
  });
  // Only one of these containers exists per page (signup vs login);
  // renderCaptchaIfNeeded() no-ops for whichever id isn't present.
  renderCaptchaIfNeeded('su-captcha');
  renderCaptchaIfNeeded('li-captcha');
});
