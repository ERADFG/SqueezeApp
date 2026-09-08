// ─────────────────────────────────────────────────────────────
// FOLLOW LIST PAGE — /<username>/followers or /<username>/following
// Also reachable via the legacy followlist.html?u=<username>&tab=...
// form — see below.
// ─────────────────────────────────────────────────────────────
// Recomputed on every visit (see loadFollowList() below) rather than
// frozen here — pjax (js/pjax.js) keeps this script loaded for the
// life of the tab, so viewing a *different* person's followers/
// following later would otherwise silently keep showing the very
// first profile's list forever, since this file only ever gets
// parsed once.
function flReadUrl() {
  // '@' is optional in the match so a legacy bare /<username>/followers
  // link (pre-@ scheme) still resolves — loadFollowList() below then
  // canonicalizes the address bar to the /@<username>/... form.
  const m = location.pathname.match(/^\/@?([^/]+)\/(followers|following)\/?$/);
  if (m) return { flUsername: decodeURIComponent(m[1]), flTab: m[2] };
  const params = new URLSearchParams(location.search);
  return { flUsername: params.get('u'), flTab: params.get('tab') === 'following' ? 'following' : 'followers' };
}
let flUsername = null;
let flTab = 'followers';
let flProfile = null;
let flMyFollowing = new Set(); // ids of people the *viewer* (logged-in user) follows
let flMyPending = new Set(); // ids of private accounts the viewer has a pending request out to

function flRenderTabs() {
  const el = document.getElementById('fl-tabs');
  el.innerHTML = `
    <div class="xtabs">
      <button class="xtab${flTab === 'followers' ? ' active' : ''}" onclick="flSetTab('followers')">Followers</button>
      <button class="xtab${flTab === 'following' ? ' active' : ''}" onclick="flSetTab('following')">Following</button>
    </div>`;
}

function flSetTab(tab) {
  if (tab === flTab) return;
  flTab = tab;
  try { history.replaceState(null, '', prettyFollowListUrl(flUsername, tab)); } catch (e) {}
  flRenderTabs();
  flLoadList();
}

function flRowHtml(profile, viewerId) {
  const uname = profile?.username || 'unknown';
  const showBtn = currentSession && profile.id !== viewerId;
  const following = flMyFollowing.has(profile.id);
  const pending = flMyPending.has(profile.id);
  return `
  <div class="fl-row">
    <a class="ulrow" style="flex:1;min-width:0;" href="${profileUrl(uname)}">
      <img class="avatar pfp-md${avSqClass(profile)}" src="${esc(avatarUrl(profile?.avatar_url))}" alt="" loading="lazy" decoding="async">
      <div class="ulrow-txt">
        <span class="ulrow-name">${esc(profile?.display_name || uname)}${vBadge(profile)}</span>
        <span class="ulrow-handle">@${esc(uname)}</span>
      </div>
    </a>
    ${showBtn ? followBtnHtml(profile, following, pending) : ''}
  </div>`;
}

async function flLoadList() {
  const root = document.getElementById('followlist-root');
  if (!flProfile) return;
  root.innerHTML = skeletonFeedHtml(3);

  const col = flTab === 'followers' ? 'followee_id' : 'follower_id';
  const wantCol = flTab === 'followers' ? 'follower_id' : 'followee_id';
  const { data, error } = await sb.from('follows')
    .select(`${wantCol}, profile:profiles!follows_${wantCol}_fkey(id,username,display_name,avatar_url,verified,verification_type)`)
    .eq(col, flProfile.id)
    .order('created_at', { ascending: false })
    .limit(200);

  if (error) { root.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
  if (!data.length) {
    root.innerHTML = `<div class="empty-note">${flTab === 'followers' ? `@${esc(flProfile.username)} has no followers yet.` : `@${esc(flProfile.username)} isn't following anyone yet.`}</div>`;
    return;
  }
  const viewerId = currentSession?.user?.id || null;
  root.innerHTML = data.map(row => flRowHtml(row.profile, viewerId)).join('');
}

async function flToggleFollow(userId, btn) {
  // Kept only so nothing breaks if some other page still calls this
  // by name — the follow buttons this file renders now go through
  // genericToggleFollow() in js/common.js instead (see flRowHtml()
  // above), since that one actually knows how to request a private
  // account instead of always following instantly.
  return genericToggleFollow(userId, btn);
}

async function flLoadMyFollowing() {
  flMyFollowing = new Set();
  flMyPending = new Set();
  // Reuses the already-resolved session from auth.js instead of calling
  // sb.auth.getSession() again — see the note in ensureLikesLoaded()
  // (js/common.js).
  await authReady;
  const session = currentSession;
  if (!session) return;
  const [{ data: followData }, { data: pendingData }] = await Promise.all([
    sb.from('follows').select('followee_id').eq('follower_id', session.user.id),
    sb.from('follow_requests').select('target_id').eq('requester_id', session.user.id)
  ]);
  flMyFollowing = new Set((followData || []).map(r => r.followee_id));
  flMyPending = new Set((pendingData || []).map(r => r.target_id));
}

async function loadFollowList() {
  // pjax guard — see js/notifications.js. Recompute everything
  // derived from the URL fresh on every visit — see the comment on
  // flReadUrl() above.
  if (document.body.dataset.page !== 'followlist') return;
  const url = flReadUrl();
  flUsername = url.flUsername;
  flTab = url.flTab;
  flProfile = null;
  flMyFollowing = new Set();

  const root = document.getElementById('followlist-root');
  if (!root) return;
  if (!flUsername) {
    root.innerHTML = `<div class="errmsg">No user specified.</div>`;
    return;
  }

  const { data: profile, error } = await sb.from('profiles').select('*').ilike('username', flUsername).single();
  if (error || !profile) {
    root.innerHTML = `<div class="errmsg">No user found with that username.</div>`;
    return;
  }
  flProfile = profile;
  document.title = `People followed by @${profile.username} — InteractInk`;
  document.getElementById('fl-name').textContent = profile.display_name || profile.username;
  document.getElementById('fl-handle').textContent = `@${profile.username}`;
  document.getElementById('fl-back').href = profileUrl(profile.username);
  const canonical = prettyFollowListUrl(profile.username, flTab);
  if (location.pathname !== canonical) { try { history.replaceState(null, '', canonical); } catch (e) {} }
  setPageDescription(`People ${flTab === 'following' ? 'followed by' : 'following'} @${profile.username} on InteractInk.`);
  setCanonical(canonical);

  flRenderTabs();
  await flLoadMyFollowing();
  flLoadList();
}

document.addEventListener('DOMContentLoaded', loadFollowList);
