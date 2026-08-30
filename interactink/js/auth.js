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

  // First-time OAuth sign-ins land here with no username of their own
  // yet (Google/X/Discord don't hand over anything InteractInk can
  // safely use as a unique @handle) and profiles.onboarded still
  // false (see supabase/oauth_onboarding.sql) — send them to claim a
  // username (+ age/gender) before they can do anything else. Runs
  // past the IP-ban/suspension checks above so a banned account is
  // never sent into onboarding instead of being turned away, and is
  // skipped on onboarding.html itself to avoid a redirect loop.
  const onOnboardingPage = /(^|\/)onboarding\.html$/.test(location.pathname);
  if (currentProfile && currentProfile.onboarded === false && !onOnboardingPage) {
    location.href = 'onboarding.html';
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

// ── OAuth (Google / X / Discord) — used by the "Create account" chooser
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
    const label = OAUTH_PROVIDER_NAMES[provider] || provider;
    alert(`Couldn't continue with ${label} right now. Try a different sign-in option, or try again in a moment.`);
    if (btn) { btn.disabled = false; btn.style.opacity = ''; }
  }
}
const OAUTH_PROVIDER_NAMES = { google: 'Google', twitter: 'X', discord: 'Discord', apple: 'Apple' };

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

// ── SIGN UP / LOG IN ──
// Accounts are OAuth-only now — there is no email/password form
// anywhere in the app. This is deliberate, and stronger than the old
// email/password + verification-email approach it replaces:
//   - No password is ever created, stored, or breached on this site,
//     because this site never sees one — Google/X/Discord check the
//     person's password on their own servers and only ever hand this
//     app a signed token.
//   - Email ownership is verified for free by the provider (that's
//     what "OAuth" means here), with no per-signup email to send and
//     therefore no mailer rate limit to ever hit, unlike the
//     link/code-based verification this replaced.
//   - Bot/fake-account resistance comes from the provider's own
//     signup flow rather than a homemade captcha, on top of this
//     project's existing IP-ban check (still run below).
// See doOAuth() above for the actual sign-in call — login.html,
// signup.html and start.html all just render buttons that call it.

// ── LOG OUT ──
async function logOut() {
  await sb.auth.signOut();
  location.href = 'index.html';
}

// Uploads to avatars/<uid>/<random>.<ext> — the storage RLS policy
// only allows a user to write inside their own <uid> folder.
//
// Shared by every avatar/banner/image upload in the app (profile,
// community, list, chat-group — see the call sites in js/community.js,
// js/list.js, js/chat.js, js/editprofile.js), which is exactly why the
// moderation check lives here instead of being duplicated at each call
// site: one choke point covers all of them, including any future ones.
//
// Unlike posts/replies, there's no per-row moderation_status here (an
// avatar isn't a feed item you can hide behind RLS — hiding someone's
// whole profile because their avatar got flagged would be wrong, and
// RLS is row-level, not column-level). So enforcement works differently:
// on a 'block' verdict the just-uploaded file is deleted from storage
// before this function returns, and the caller never gets a URL to
// attach to anything. 'human_review' still logs to moderation_events
// for the admin queue but does NOT block the upload — avatars are low
// enough stakes (and reversible enough — a caller can always re-upload
// or an admin can suspend) that holding every borderline avatar for
// manual review isn't worth the friction. Tune this if you disagree.
async function uploadAvatar(file, userId) {
  const ext = file.name.split('.').pop().toLowerCase();
  const path = `${userId}/${crypto.randomUUID()}.${ext}`;
  const { error } = await sb.storage.from('avatars').upload(path, file, {
    cacheControl: '3600', upsert: false, contentType: file.type
  });
  if (error) throw error;
  const { data } = sb.storage.from('avatars').getPublicUrl(path);
  const publicUrl = data.publicUrl;

  const isVideo = file.type?.startsWith('video/');
  try {
    const res = await fetch('/api/moderate-media', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId, contentType: 'avatar', mediaUrl: publicUrl, mediaType: isVideo ? 'video' : 'image',
      }),
    });
    const mod = res.ok ? await res.json() : { decision: 'human_review' };
    if (mod.decision === 'block') {
      await sb.storage.from('avatars').remove([path]); // don't leave a rejected upload sitting in storage
      throw new Error("That image didn't pass review — please choose a different one.");
    }
  } catch (e) {
    // A network failure talking to /api/moderate-media is NOT the same
    // as a confirmed block — don't lose someone's legitimate profile
    // photo over a blip. But a thrown block-message above should
    // propagate, not be swallowed here, so re-throw anything that
    // looks like our own message rather than a fetch failure.
    if (e instanceof Error && e.message.includes("didn't pass review")) throw e;
  }

  return publicUrl;
}

// ── ONBOARDING (username + age/gender for first-time OAuth sign-ins) ──
// Called by onboarding.html's form. Age/gender are optional here
// (nullable columns — see supabase/add_age_gender.sql) since some
// providers/regions make them awkward to ask twice; username is the
// one thing every profile still needs, since it's how @handles,
// mentions, and profile URLs work across the whole site.
const ONBOARD_GENDER_VALUES = ['male', 'female', 'other', 'not_specified'];

async function completeOnboarding(e) {
  e?.preventDefault();
  if (!currentSession) { location.href = 'start.html'; return; }

  const username = document.getElementById('ob-username').value.trim();
  const ageEl    = document.getElementById('ob-age');
  const genderEl = document.getElementById('ob-gender');
  const ageRaw   = ageEl ? ageEl.value.trim() : '';
  const age      = ageRaw === '' ? null : Number(ageRaw);
  const gender   = genderEl && genderEl.value ? genderEl.value : null;
  const btn = document.getElementById('ob-btn');
  const errEl = document.getElementById('ob-err');
  clearErr(errEl);

  if (!/^[a-zA-Z0-9_]{3,20}$/.test(username)) {
    showErr(errEl, 'Username must be 3–20 characters: letters, numbers, underscore only.');
    return;
  }
  if (ageEl && ageRaw !== '' && (!Number.isInteger(age) || age < 13 || age > 120)) {
    showErr(errEl, 'Enter a valid age between 13 and 120.');
    return;
  }
  if (genderEl && genderEl.value && !ONBOARD_GENDER_VALUES.includes(gender)) {
    showErr(errEl, 'Please select a gender option.');
    return;
  }

  btn.disabled = true; btn.value = 'Saving…';
  const patch = { username, onboarded: true };
  if (ageEl) patch.age = age;
  if (genderEl) patch.gender = gender;

  const { error } = await sb.from('profiles').update(patch).eq('id', currentSession.user.id);
  if (error) {
    showErr(errEl, (error.code === '23505' || /duplicate/i.test(error.message || ''))
      ? 'That username is already taken.'
      : (error.message || 'Could not save your profile.'));
    btn.disabled = false; btn.value = 'Continue';
    return;
  }
  location.href = 'index.html';
}

// Guarded against pjax.js's synthetic DOMContentLoaded re-dispatch on
// every soft navigation (see its navigate()): auth.js itself is only
// ever loaded once (it's a shared trailing script, outside the
// .xshell pjax swaps), but without this flag this handler was still
// re-running on every navigation and calling sb.auth.onAuthStateChange()
// again each time — Supabase never dedupes subscriptions, so after
// browsing N pages in one session, this tab had N separate listeners
// all alive at once. Each one holds its closure in memory for good
// (a real leak over a long session), and the next login/logout/token
// refresh would call renderAuthArea() N times in a row instead of
// once.
let _authAreaWired = false;
document.addEventListener('DOMContentLoaded', () => {
  renderAuthArea();
  if (_authAreaWired) return;
  _authAreaWired = true;
  sb.auth.onAuthStateChange((_event, _session) => {
    renderAuthArea();
  });
});
