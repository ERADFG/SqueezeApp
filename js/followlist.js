// ─────────────────────────────────────────────────────────────
// FOLLOW LIST PAGE — /<username>/followers or /<username>/following
// Also reachable via the legacy followlist.html?u=<username>&tab=...
// form — see below.
// ─────────────────────────────────────────────────────────────
const { flUsername, flTab: flTabFromUrl } = (() => {
  const m = location.pathname.match(/^\/([^/]+)\/(followers|following)\/?$/);
  if (m) return { flUsername: decodeURIComponent(m[1]), flTab: m[2] };
  const params = new URLSearchParams(location.search);
  return { flUsername: params.get('u'), flTab: params.get('tab') === 'following' ? 'following' : 'followers' };
})();
let flTab = flTabFromUrl;
let flProfile = null;
let flMyFollowing = new Set(); // ids of people the *viewer* (logged-in user) follows

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
  const locked = showBtn && following && isProtectedFollowUsername(uname);
  const btnHtml = locked
    ? `<button class="follow-btn following locked" disabled title="You can't unfollow this account." aria-label="You can't unfollow this account.">${ICON_LOCK_SM}${t('action.following')}</button>`
    : `<button class="follow-btn${following ? ' following' : ''}" onclick="flToggleFollow('${profile.id}', this)">${following ? t('action.following') : t('action.follow')}</button>`;
  return `
  <div class="fl-row">
    <a class="ulrow" style="flex:1;min-width:0;" href="${profileUrl(uname)}">
      <img class="avatar pfp-md${avSqClass(profile)}" src="${esc(avatarUrl(profile?.avatar_url))}" alt="" loading="lazy" decoding="async">
      <div class="ulrow-txt">
        <span class="ulrow-name">${esc(profile?.display_name || uname)}${vBadge(profile)}</span>
        <span class="ulrow-handle">@${esc(uname)}</span>
      </div>
    </a>
    ${showBtn ? btnHtml : ''}
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
  if (!requireLogin()) return;
  const following = btn.classList.contains('following');
  btn.disabled = true;
  try {
    if (following) {
      const { error } = await unfollowUser(userId);
      if (error) throw error;
      flMyFollowing.delete(userId);
      btn.classList.remove('following');
      btn.textContent = t('action.follow');
    } else {
      const { error } = await followUser(userId);
      if (error) throw error;
      flMyFollowing.add(userId);
      btn.classList.add('following');
      btn.textContent = t('action.following');
    }
  } catch (e) {
    alert(e.message || 'Could not update follow status.');
  } finally {
    btn.disabled = false;
  }
}

async function flLoadMyFollowing() {
  flMyFollowing = new Set();
  const { data: { session } } = await sb.auth.getSession();
  if (!session) return;
  const { data } = await sb.from('follows').select('followee_id').eq('follower_id', session.user.id);
  flMyFollowing = new Set((data || []).map(r => r.followee_id));
}

async function loadFollowList() {
  const root = document.getElementById('followlist-root');
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
