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
// Belt-and-suspenders: every page's loader blocks on authReady before
// rendering anything, so if some future code path fails to call
// resolveAuthReady() (the way the unguarded getSession() call used to),
// the whole page would hang forever with nothing but its skeleton
// showing, silently. A hard timeout guarantees pages always get to
// render — worst case, briefly as if logged out.
setTimeout(() => resolveAuthReady(), 8000);

// Safe wrapper around sb.auth.getSession() for the handful of call
// sites that deliberately want a fresh check against Supabase itself
// (e.g. right before a delete/edit, to catch a session that expired or
// was signed out in another tab) rather than the cached currentSession.
// A plain sb.auth.getSession() call can hang forever if supabase-js's
// internal navigator.locks-based auth lock ever gets stuck (a known
// upstream issue, especially when multiple tabs or multiple concurrent
// auth calls are involved) — this races it against a timeout and falls
// back to the cached currentSession so a stuck lock can never wedge
// the calling action indefinitely.
async function getSessionSafe(timeoutMs = 6000) {
  try {
    const { data } = await Promise.race([
      sb.auth.getSession(),
      new Promise((_, reject) => setTimeout(() => reject(new Error('getSession timed out')), timeoutMs))
    ]);
    return data.session;
  } catch (e) {
    console.error('getSession failed/timed out, falling back to cached session:', e);
    return currentSession;
  }
}

async function getProfile(userId) {
  const { data } = await sb.from('profiles').select('*').eq('id', userId).single();
  return data || null;
}

// Calls api/ip.js, which reads the caller's real IP server-side (not
// anything the browser could fake) and checks/records it against
// supabase/ip_ban.sql's ban list. Passing an access token also
// records the IP against that account for next time an admin
// suspends it. Fails open (returns false) on any network hiccup, same
// as this app's other best-effort checks.
async function isClientIpBanned(accessToken) {
  try {
    const res = await fetch('/api/ip', {
      method: 'POST',
      headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {}
    });
    const out = await res.json();
    return out?.banned === true;
  } catch (e) {
    return false;
  }
}

// Renders whatever should sit in the header's #auth-area — either
// [Log in] [Sign up], or the avatar + username dropdown menu.
async function renderAuthArea() {
  const el = document.getElementById('auth-area');
  renderSideNav(); renderMobileChrome(); // paint immediately with whatever we knew last; repainted below once session settles

  // getSession() can throw or hang (network hiccup, an extension
  // blocking the Supabase domain, a slow/dropped connection, etc).
  // Every page's own loader (board.js/profile.js/search.js/...)
  // awaits authReady before rendering anything, so if this call
  // never settles and resolveAuthReady() is never reached, the
  // *entire page* is stuck forever showing nothing but its initial
  // skeleton/placeholder — no error, no fallback. Wrapping this in
  // try/catch/finally guarantees authReady always resolves (falling
  // back to "logged out" on failure) so a bad network never wedges
  // the whole page.
  let session = null;
  try {
    ({ data: { session } } = await sb.auth.getSession());
  } catch (e) {
    console.error('getSession failed, continuing as logged out:', e);
  } finally {
    resolveAuthReady();
  }
  currentSession = session;

  if (!session) {
    currentProfile = null;
    unreadNotifCount = 0;
    unreadChatCount = 0;
    renderSideNav(); renderMobileChrome();
    if (el) el.innerHTML = `<div class="auth-cta"><a class="cta-primary" href="start.html"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"></circle><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7"></path></svg><span>Create account</span></a></div>`;
    refreshPostGates();
    return;
  }

  currentProfile = await getProfile(session.user.id);

  // IP ban check — records this device/network's IP against the
  // account (api/ip.js reads the real IP server-side; see
  // supabase/ip_ban.sql) and signs the person out if that IP is on
  // the ban list, even if this particular account was never itself
  // suspended (e.g. it was made from the same device/network as a
  // suspended one). Best-effort: a failed/slow check never blocks
  // normal use of the site.
  if (await isClientIpBanned(session.access_token)) {
    await sb.auth.signOut();
    currentSession = null;
    currentProfile = null;
    unreadNotifCount = 0;
    unreadChatCount = 0;
    renderSideNav(); renderMobileChrome();
    if (el) el.innerHTML = `<div class="auth-cta"><a class="cta-primary" href="start.html"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"></circle><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7"></path></svg><span>Create account</span></a></div>`;
    refreshPostGates();
    alert('This device/network has been banned from InteractInk.');
    return;
  }

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
    if (el) el.innerHTML = `<div class="auth-cta"><a class="cta-primary" href="start.html"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"></circle><path d="M4 20c0-4.4 3.6-7 8-7s8 2.6 8 7"></path></svg><span>Create account</span></a></div>`;
    refreshPostGates();
    const until = suspendedUntil ? ` until ${new Date(suspendedUntil).toLocaleString()}` : '';
    alert(`This account has been suspended${until}.`);
    return;
  }

  // Remembers this account on this device for the tab bar's
  // long-press account switcher — see upsertSavedAccount() in
  // common.js. Placed here (past the IP-ban/suspension early-returns
  // above) so only accounts that actually resolved to a clean, usable
  // session ever land in the switcher.
  upsertSavedAccount(session, currentProfile);

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
        <img class="avatar pfp-md${avSqClass(currentProfile)}" src="${esc(avatar)}" decoding="async" alt="">
        <span class="acct-txt">
          <span class="acct-name">${esc(currentProfile?.display_name || uname)}</span>
          <span class="acct-handle">@${esc(uname)}</span>
        </span>
        <span class="acct-dots">${NAV_ICON.dots}</span>
      </button>
      <div class="acct-menu" id="acct-menu">
        <a href="${profileUrl(uname)}">My Profile</a>
        <a href="editprofile.html">Edit Profile</a>
        <button onclick="toggleAcctMenu();openAccountSwitchSheet();">Switch accounts</button>
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
    toast('You need an account to post. Create an account — it takes a minute.', 'error');
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
  const wasFocused = document.activeElement === input;
  const caret = input.selectionEnd != null ? input.selectionEnd : input.value.length;
  input.type = showing ? 'password' : 'text';
  btn.classList.toggle('showing', !showing);
  btn.setAttribute('aria-label', showing ? 'Show password' : 'Hide password');
  // Flipping an input's type between password/text while it's focused
  // makes some mobile keyboards (notably Android) briefly close and
  // reopen on their own — nothing to do with what else is happening on
  // the page, it's the type switch itself. Left alone, that shows up
  // as the whole layout (and the eye button along with it) jumping,
  // and often drops focus entirely so the next tap on the button
  // misses because the field/button have already resettled elsewhere.
  // Forcing focus straight back onto the field, with the caret back
  // where it was, closes that gap — done twice (immediately, and again
  // next frame in case the keyboard's own close/reopen cycle wins the
  // race) so it holds regardless of the exact timing on a given device.
  if (wasFocused) {
    const restore = () => {
      if (document.activeElement !== input) input.focus({ preventScroll: true });
      try { input.setSelectionRange(caret, caret); } catch (e) {}
    };
    restore();
    requestAnimationFrame(restore);
  }
}

// Tapping the eye button used to steal focus away from the password
// input a split second before the click handler ran. That blurred the
// input, which dismissed the on-screen keyboard, which resized the
// page — so the button visually "jumped" right as you tapped it, and
// the first tap or two would land on its old position instead of the
// new one (hence needing several taps to actually toggle visibility).
// Both mouse taps and touch taps fire a real "mousedown" event before
// "click" (touch devices synthesize one), and that's the event whose
// default action focuses the tapped element — so blocking just that
// default keeps focus on the input the whole time. The keyboard never
// closes, the layout never reflows, and "click" still fires normally
// right after, so the toggle itself is untouched and fires on the
// very first tap. (Deliberately not touching touchstart/touchend here
// — preventing those can suppress the click entirely on some mobile
// browsers, which would break the toggle instead of fixing it.)
document.addEventListener('mousedown', e => {
  if (e.target.closest('.pw-toggle')) e.preventDefault();
});

// ── OAuth (Google / Apple) — used by the "Create account" chooser
// (start.html) and the Log In page's "Continue with Google" button.
// Supabase handles the actual redirect/callback; this just kicks it
// off and comes back to the current site (so a person starting from
// start.html or login.html lands back on the home feed once the
// provider round-trip finishes and a session exists).
// NOTE: this only works once Google/Apple are turned on as providers
// in the Supabase dashboard (Authentication → Providers), each with
// its own client ID/secret — the button itself doesn't need any
// setup beyond that.
async function doOAuth(provider, btn) {
  if (btn) { btn.disabled = true; btn.style.opacity = '.6'; }
  try {
    const { error } = await sb.auth.signInWithOAuth({
      provider,
      options: { redirectTo: location.origin + '/' }
    });
    if (error) throw error;
    // On success the browser navigates away to the provider — nothing
    // else to do here. Only reachable on failure (provider not
    // enabled, network error, popup blocked, etc).
  } catch (err) {
    console.error('OAuth sign-in failed:', err);
    alert(`Couldn't continue with ${provider === 'google' ? 'Google' : 'Apple'} right now. Try email instead, or try again in a moment.`);
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}

// signInWithOAuth() only ever resolves on failure (see comment above)
// — on success the whole page navigates away to the provider, so the
// button is deliberately left disabled and never re-enabled by the
// function itself. The gap: if the person backs out of Google/Apple
// instead of completing sign-in, mobile browsers commonly restore
// this exact page (including its JS state) from the back-forward
// cache rather than reloading it — so the button comes back on
// screen still disabled from before they left, with no error ever
// having fired to reset it. `pageshow`'s `event.persisted` flag is
// true specifically for that bfcache-restore case, so re-enable every
// OAuth button then. Harmless to also run on a normal fresh load,
// since the buttons already start enabled at that point.
window.addEventListener('pageshow', function (event) {
  if (!event.persisted) return;
  document.querySelectorAll('.auth-social-full, .auth-social-btn').forEach(function (btn) {
    btn.disabled = false;
    btn.style.opacity = '';
  });
});

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
const GENDER_VALUES = ['male', 'female', 'other', 'not_specified'];

async function doSignUp(e) {
  e?.preventDefault();
  const email    = document.getElementById('su-email').value.trim();
  const username = document.getElementById('su-username').value.trim();
  const password = document.getElementById('su-password').value;
  // Age/gender fields only exist on the signup form (not shared with
  // login.html), so guard for their absence rather than assuming.
  const ageEl    = document.getElementById('su-age');
  const genderEl = document.getElementById('su-gender');
  const ageRaw   = ageEl ? ageEl.value.trim() : '';
  const age      = ageRaw === '' ? NaN : Number(ageRaw);
  const gender   = genderEl ? genderEl.value : '';
  const btn = document.getElementById('su-btn');
  const errEl = document.getElementById('su-err');
  clearErr(errEl);

  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    showErr(errEl, 'Username must be 3–20 characters: letters, numbers, underscore only.');
    return;
  }
  if (ageEl) {
    // Number.isInteger rejects "18.5" etc; the range check keeps age
    // sane (120 is the stated hard cap, 13 rejects 0/negative/typo'd
    // values) even though a select/number spinner mostly self-limits.
    if (!Number.isInteger(age) || age < 13 || age > 120) {
      showErr(errEl, 'Enter a valid age between 13 and 120.');
      return;
    }
  }
  if (genderEl && !GENDER_VALUES.includes(gender)) {
    showErr(errEl, 'Please select a gender option.');
    return;
  }
  if (password.length < 8) {
    showErr(errEl, 'Password must be at least 8 characters.');
    return;
  }

  if (await isClientIpBanned()) {
    showErr(errEl, 'This device/network has been banned from InteractInk.');
    return;
  }

  if (!ensureCaptchaRevealed('su-captcha')) return;
  if (!(await verifyHuman('su-captcha', errEl))) return;

  btn.disabled = true; btn.value = 'Creating account…';
  try {
    const { data, error } = await sb.auth.signUp({
      email, password,
      options: { data: { username } }
    });
    if (error) throw error;

    if (data.session) {
      // Record this IP against the brand-new account right away, so
      // it's already on file the moment an admin ever needs to
      // suspend them (see supabase/ip_ban.sql).
      isClientIpBanned(data.session.access_token);
      // The normal, expected path — account created and logged in
      // immediately. The handle_new_user() DB trigger has already
      // created the profiles row by this point (that's how the
      // session/profile exist at all), so age/gender go on as a
      // follow-up UPDATE rather than at insert time — this also
      // means it's covered by the ordinary "update your own profile"
      // RLS policy instead of needing a new one. Best-effort: a
      // failure here shouldn't block the person from being signed up
      // and logged in, so it's logged, not surfaced as an error.
      if (ageEl || genderEl) {
        const patch = {};
        if (ageEl) patch.age = age;
        if (genderEl) patch.gender = gender;
        const { error: profileErr } = await sb.from('profiles').update(patch).eq('id', data.user.id);
        if (profileErr) console.error('Failed to save age/gender:', profileErr);
      }
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
    btn.disabled = false; btn.value = 'Create Account';
  }
}

// ── LOG IN ──
// The identifier field (#li-email) accepts either an email address or
// a username — Supabase Auth itself only ever signs in by email, so a
// username has to be resolved to its account's email first. That
// lookup is done server-side by the email_for_login() RPC (see
// supabase/username_login.sql): it's a SECURITY DEFINER function
// because the browser's anon key has no read access to auth.users
// directly (profiles doesn't store email at all — see
// add_age_gender.sql's neighbor comments on that). Simple '@' check
// mirrors how every "username or email" login field decides which
// one it's looking at — usernames are validated elsewhere (signup) to
// disallow '@' entirely, so this is unambiguous.
async function resolveLoginEmail(identifier) {
  if (identifier.includes('@')) return identifier;
  const { data, error } = await sb.rpc('email_for_login', { p_username: identifier });
  if (error || !data) throw new Error('Incorrect username or password.');
  return data;
}

async function doLogIn(e) {
  e?.preventDefault();
  const identifier = document.getElementById('li-email').value.trim();
  const password    = document.getElementById('li-password').value;
  const btn = document.getElementById('li-btn');
  const errEl = document.getElementById('li-err');
  clearErr(errEl);

  if (!ensureCaptchaRevealed('li-captcha')) return;
  if (!(await verifyHuman('li-captcha', errEl))) return;

  btn.disabled = true; btn.value = 'Logging in…';
  try {
    const email = await resolveLoginEmail(identifier);
    const { data, error } = await sb.auth.signInWithPassword({ email, password });
    if (error) throw error;

    // Same IP-ban check renderAuthArea() does on every load, but here
    // so a banned device/network is refused right at the login form
    // instead of bouncing them straight back out after a flash of
    // being signed in.
    if (await isClientIpBanned(data.session?.access_token)) {
      await sb.auth.signOut();
      showErr(errEl, 'This device/network has been banned from InteractInk.');
      btn.disabled = false; btn.value = 'Log In';
      return;
    }
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
});
