// ─────────────────────────────────────────────────────────────
// SINGLE LIST PAGE — /i/lists/<uuid> (also reachable via the legacy
// list.html?id=<uuid> form — see currentListId() in common.js).
// Shows the list's header (name, description, member/follower count,
// Edit/Delete for the owner or a Follow/Following pill for anyone
// else on a public List), a Posts tab (a timeline merged from every
// member's posts, same idea as a community's feed), a Members tab
// (who's curated onto it, with a Remove button for the owner) and a
// Followers tab (who's following it). Both people-tabs show each
// row's own personal Follow button too (follow the person, not the
// List — see listPersonRowHtml()), same as Twitter's List sub-pages.
// Adding someone to a list as a *member* happens from *their*
// profile's "···" menu (openAddToListModal() in common.js), not from
// this page — same division as Twitter, where "Add to Lists" lives
// on the profile. Following the List itself happens right here.
// ─────────────────────────────────────────────────────────────
const POST_SELECT = '*, profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified,verification_type)';

// Recomputed on every visit (see the DOMContentLoaded handler below)
// rather than frozen here — pjax (js/pjax.js) keeps this script
// loaded for the life of the tab, so visiting a *second* different
// List later would otherwise silently keep showing the very first
// one forever, since this file only ever gets parsed once.
let listId = null;
let list = null;       // the loaded list row
let isOwner = false;
let isListFollowed = false; // is the viewer following this List (non-owner only) — named to avoid colliding with common.js's isFollowing(userId) helper, which silently killed this whole script (SyntaxError: Identifier 'isFollowing' has already been declared) and left the page stuck on the initial "Loading…" spinner forever
let listTab = 'posts';   // 'posts' | 'members' | 'followers'
let listMembers = [];    // [{id, username, display_name, avatar_url}], loaded once
let listFollowers = [];  // same shape, loaded lazily on first visit to the Followers tab
let listMyFollowing = new Set(); // ids of people the *viewer* personally follows — drives each row's own Follow button

async function loadList() {
  const heroEl = document.getElementById('list-hero');
  if (!heroEl) return;
  if (!listId) {
    heroEl.innerHTML = `<div id="feed-empty">No List specified.</div>`;
    return;
  }

  const { data, error } = await sb.from('lists').select('*').eq('id', listId).maybeSingle();
  if (error) { heroEl.innerHTML = `<div class="errmsg">Failed to load List: ${esc(error.message)}</div>`; return; }
  if (!data) { heroEl.innerHTML = `<div id="feed-empty">This List doesn't exist, or is private.</div>`; return; }
  list = data;
  document.title = `${list.name} — InteractInk`;
  setPageH1(list.name);
  setPageDescription(list.description || `${list.name} — a List on InteractInk.`);
  setCanonical(listUrl(list.id));
  setJsonLd({
    '@context': 'https://schema.org', '@type': 'ItemList',
    name: list.name, description: list.description || undefined,
    url: location.origin + listUrl(list.id),
  });

  isOwner = !!(currentSession && list.owner_id === currentSession.user.id);
  if (currentSession && !isOwner) {
    const { data: fRow } = await sb.from('list_followers')
      .select('list_id').eq('list_id', list.id).eq('follower_id', currentSession.user.id).maybeSingle();
    isListFollowed = !!fRow;
  }

  const { data: owner } = await sb.from('profiles').select('username,display_name').eq('id', list.owner_id).maybeSingle();
  list._owner = owner;

  renderHero();
  document.getElementById('board-hdr').style.display = '';
  await Promise.all([loadListMembers(), loadListMyFollowing()]);
  renderTabContent();
}

// The viewer's own personal follows (not List-follows) — drives the
// per-row Follow button on the Members/Followers tabs, same as
// followlist.js's flLoadMyFollowing().
async function loadListMyFollowing() {
  listMyFollowing = new Set();
  if (!currentSession) return;
  const { data } = await sb.from('follows').select('followee_id').eq('follower_id', currentSession.user.id);
  listMyFollowing = new Set((data || []).map(r => r.followee_id));
}

function renderHero() {
  const heroEl = document.getElementById('list-hero');
  const privacyTag = list.is_private ? `<span class="list-privacy-tag">${ICON_LOCK}Private</span>` : '';
  const actions = isOwner ? `
    <div class="list-hero-actions">
      <button type="button" class="list-edit-btn" onclick="openCreateListModal(list)">Edit</button>
      <button type="button" class="list-delete-btn" onclick="deleteListConfirm(list.id, list.name)">Delete</button>
    </div>`
    : (currentSession && !list.is_private) ? `
    <div class="list-hero-actions">
      ${listShareMenuHtml(list)}
      ${listOptionsMenuHtml(list)}
      <button type="button" class="${isListFollowed ? 'list-following-pill' : 'list-follow-pill'}" onclick="listToggleFollow('${list.id}', this, ${isListFollowed})">${isListFollowed ? 'Following' : 'Follow'}</button>
    </div>` : '';
  const bannerPick = isOwner ? `
    <label class="list-banner-pick" for="list-banner-file" title="Change List banner">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h3l2-2h6l2 2h3v12H4V7Z"/><circle cx="12" cy="13" r="3.5"/></svg>
    </label>
    <input type="file" id="list-banner-file" accept="image/*" style="display:none;" onchange="changeListBanner(this)">` : '';
  const avatarPick = isOwner ? `
    <label class="list-avatar-pick" for="list-avatar-file" title="Change List picture">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h3l2-2h6l2 2h3v12H4V7Z"/><circle cx="12" cy="13" r="3.5"/></svg>
    </label>
    <input type="file" id="list-avatar-file" accept="image/*" style="display:none;" onchange="changeListAvatar(this)">` : '';

  heroEl.innerHTML = `
    <div class="list-banner-wrap" id="list-banner-wrap" style="${list.banner_url ? `--banner-img:url('${esc(list.banner_url)}')` : ''}">
      ${bannerPick}
    </div>
    <div class="list-hero">
      <span class="list-avatar-wrap">
        <span class="list-avatar list-avatar-lg">${listAvatarInner(list)}</span>
        ${avatarPick}
      </span>
      <div class="list-hero-body">
        <div class="list-hero-name">${esc(list.name)} ${privacyTag}</div>
        ${list._owner ? `<div class="list-hero-owner">by <a href="${profileUrl(list._owner.username)}">@${esc(list._owner.username)}</a></div>` : ''}
        ${list.description ? `<div class="list-hero-desc">${esc(list.description)}</div>` : ''}
        <div class="list-hero-meta">${fmtCount(list.member_count)} member${list.member_count === 1 ? '' : 's'} &middot; ${fmtCount(list.follower_count || 0)} follower${(list.follower_count || 0) === 1 ? '' : 's'}</div>
      </div>
      ${actions}
    </div>`;

  if (!isOwner && currentSession) {
    isBlocked(list.owner_id).then(b => {
      const btn = document.getElementById('list-block-btn');
      if (btn && b) btn.textContent = `Unblock @${list._owner?.username || 'user'}`;
    });
  }
}

// ── "···" (list options) and share-icon menus in the hero — mirrors
// X's own List page: the share icon (left) opens Post this / Send via
// Chat / Copy link / Share List, and "···" (right) opens Report List /
// Block the owner / hide this List's posts from For You. Both reuse
// the same .pc-menu-wrap/togglePostMenu() component post cards and the
// profile page already use — see profileMenuItemsHtml() in profile.js
// for the near-identical profile-page version of this pattern.
function listShareMenuHtml(l) {
  // togglePostMenu() (common.js) looks the wrap up by id `pmenu-${key}` —
  // same convention postMenuHtml()/profileMenuItemsHtml() use — so the
  // key passed to it ('list-share-<id>') must match this element's id
  // minus that prefix.
  return `
    <div class="pc-menu-wrap" id="pmenu-list-share-${l.id}">
      <button class="pc-menu-btn" onclick="togglePostMenu('list-share-${l.id}', event)" aria-label="Share this List" title="Share">${ICON.share}</button>
      <div class="pc-menu-dd">
        <button onclick="listMenuPostThis(event)">Post this</button>
        <button onclick="listMenuSendChat(event)">${esc(t('chat.sendViaChat'))}</button>
        <button onclick="listMenuCopyLink(event)">Copy link to List</button>
        <button onclick="listMenuShareList(event)">Share List</button>
      </div>
    </div>`;
}
function listOptionsMenuHtml(l) {
  const uname = l._owner?.username || '';
  return `
    <div class="pc-menu-wrap" id="pmenu-list-opts-${l.id}">
      <button class="pc-menu-btn" onclick="togglePostMenu('list-opts-${l.id}', event)" aria-label="More options" title="More">${ICON.menu}</button>
      <div class="pc-menu-dd">
        <button onclick="listMenuReport(event)">Report List</button>
        <button id="list-block-btn" class="pc-menu-danger" onclick="listMenuBlockOwner(event)">Block @${esc(uname)}</button>
        <button onclick="listMenuHideForYou(event)">Don&rsquo;t show these posts in For you</button>
      </div>
    </div>`;
}

function closeListMenus(ev) {
  if (ev) ev.stopPropagation();
  document.querySelectorAll('.pc-menu-wrap.open').forEach(w => w.classList.remove('open'));
  document.body.classList.remove('oc-sheet-open');
}

// "Post this" — drops the List's link straight into the global
// composer, same idea as X attaching the List card to a new Tweet
// (this app's composer doesn't support embedding a List card, so the
// link stands in for it, same as how a quoted post's link works).
function listMenuPostThis(ev) {
  closeListMenus(ev);
  if (!requireLogin()) return;
  openGlobalCompose(`${location.origin}${listUrl(list.id)}`);
}

// "Send via Chat" — no in-app recipient picker exists yet, so this
// stashes the link for chat.js's applyChatPrefill() to pick up the
// moment a thread (existing or newly started) actually opens.
function listMenuSendChat(ev) {
  closeListMenus(ev);
  if (!requireLogin()) return;
  try { sessionStorage.setItem('oc-chat-prefill', `${location.origin}${listUrl(list.id)}`); } catch (e) {}
  location.href = 'chat.html';
}

function listMenuCopyLink(ev) {
  closeListMenus(ev);
  const url = `${location.origin}${listUrl(list.id)}`;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('Link copied to clipboard.')).catch(() => prompt('Copy link:', url));
  } else {
    prompt('Copy link:', url);
  }
}

function listMenuShareList(ev) {
  closeListMenus(ev);
  const url = `${location.origin}${listUrl(list.id)}`;
  if (navigator.share) {
    navigator.share({ url, title: list.name }).catch(() => {});
  } else if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('Link copied to clipboard.')).catch(() => prompt('Copy link:', url));
  } else {
    prompt('Copy link:', url);
  }
}

function listMenuReport(ev) {
  closeListMenus(ev);
  openReportUser(list.owner_id);
}

async function listMenuBlockOwner(ev) {
  closeListMenus(ev);
  if (!requireLogin()) return;
  const btn = document.getElementById('list-block-btn');
  const uname = list._owner?.username || 'user';
  // @marpe can't be blocked by anyone — see the matching guard in
  // js/profile.js and the DB trigger in supabase/profile_extras.sql.
  if (isProtectedFollowUsername(uname)) { toast(`You can't block @${uname}.`, 'error'); return; }
  const currentlyBlocked = btn && btn.textContent.startsWith('Unblock');
  if (!currentlyBlocked) {
    const ok = await ocConfirm({
      title: `Block @${uname}?`,
      desc: `This prevents @${uname} from including you in any of their Lists, including this one. They won't be able to follow or message you, and you'll stop following each other.`,
      confirmLabel: 'Block',
      danger: true
    });
    if (!ok) return;
  }
  try {
    if (currentlyBlocked) {
      await unblockUser(list.owner_id);
      if (btn) btn.textContent = `Block @${uname}`;
      toast(`Unblocked @${uname}.`);
    } else {
      await blockUser(list.owner_id);
      if (btn) btn.textContent = `Unblock @${uname}`;
      toast(`Blocked @${uname}.`);
    }
  } catch (e) { toast(e.message || 'Could not update block status.', 'error'); }
}

// Hiding one List's posts from your own For You feed would need the
// get_for_you_feed RPC (server-side) to accept a per-viewer excluded-
// Lists set, which isn't part of this build yet — same "not available
// yet" honesty as the Mute/Report stubs elsewhere rather than a button
// that looks like it works but silently does nothing.
function listMenuHideForYou(ev) {
  closeListMenus(ev);
  toast(`Hiding a List's posts from For you isn't available on InteractInk yet.`);
}

// Called by listToggleFollow() (common.js) after a follow/unfollow of
// this List completes — keeps the hero's follower count and pill in
// sync without a full reload.
function onListFollowChanged(id, following) {
  if (!list || id !== list.id) return;
  isListFollowed = following;
  list.follower_count = Math.max(0, (list.follower_count || 0) + (following ? 1 : -1));
  renderHero();
  if (listTab === 'followers') loadListFollowers().then(renderFollowers);
}

// Owner-only, same pattern as changeCommunityAvatar/Banner: crop
// first, then upload straight to `avatars` storage (still scoped to
// the acting user's own <uid> folder — see uploadAvatar()) and
// update the row. RLS's "owner can update their own list" policy is
// what actually enforces this server-side.
async function changeListAvatar(input) {
  const file = input.files[0];
  input.value = '';
  if (!file || !list || !currentSession) return;
  if (!requireLogin()) return;
  if (list.owner_id !== currentSession.user.id) return;
  if (!validateFile(file)) return;
  openCropModal(file, 'square', async (cropped) => {
    try {
      const avatar_url = await uploadAvatar(cropped, currentSession.user.id);
      const { error } = await sb.from('lists').update({ avatar_url }).eq('id', list.id);
      if (error) throw error;
      list.avatar_url = avatar_url;
      renderHero();
    } catch (e) {
      toast(e.message || 'Could not update the List picture.', 'error');
    }
  });
}

async function changeListBanner(input) {
  const file = input.files[0];
  input.value = '';
  if (!file || !list || !currentSession) return;
  if (!requireLogin()) return;
  if (list.owner_id !== currentSession.user.id) return;
  if (!validateFile(file)) return;
  openCropModal(file, 'wide', async (cropped) => {
    try {
      const banner_url = await uploadAvatar(cropped, currentSession.user.id);
      const { error } = await sb.from('lists').update({ banner_url }).eq('id', list.id);
      if (error) throw error;
      list.banner_url = banner_url;
      renderHero();
    } catch (e) {
      toast(e.message || 'Could not update the List banner.', 'error');
    }
  });
}

// Called by submitList() in common.js after a successful edit, so
// this page's header reflects the change without a full reload.
function onListUpdated(id, changes) {
  if (!list || id !== list.id) return;
  Object.assign(list, changes);
  renderHero();
}

function switchListTab(tab) {
  if (tab === listTab) return;
  listTab = tab;
  document.getElementById('tab-posts').classList.toggle('active', tab === 'posts');
  document.getElementById('tab-members').classList.toggle('active', tab === 'members');
  document.getElementById('tab-followers').classList.toggle('active', tab === 'followers');
  window.scrollTo({ top: 0, behavior: 'smooth' });
  renderTabContent();
}

async function loadListMembers() {
  const { data: memberRows, error } = await sb.from('list_members')
    .select('member_id, added_at').eq('list_id', list.id).order('added_at', { ascending: false });
  if (error) { listMembers = []; return; }
  const memberIds = (memberRows || []).map(r => r.member_id);
  if (!memberIds.length) { listMembers = []; return; }
  const { data: profiles } = await sb.from('profiles')
    .select('id,username,display_name,avatar_url,verified,verification_type').in('id', memberIds);
  const byId = new Map((profiles || []).map(p => [p.id, p]));
  listMembers = memberRows.map(r => byId.get(r.member_id)).filter(Boolean);
}

function renderTabContent() {
  if (listTab === 'posts') loadListFeed();
  else if (listTab === 'followers') { loadListFollowers().then(renderFollowers); document.getElementById('list-content').innerHTML = skeletonFeedHtml(); }
  else renderMembers();
}

async function loadListFollowers() {
  const { data: rows, error } = await sb.from('list_followers')
    .select('follower_id, followed_at').eq('list_id', list.id).order('followed_at', { ascending: false });
  if (error) { listFollowers = []; return; }
  const ids = (rows || []).map(r => r.follower_id);
  if (!ids.length) { listFollowers = []; return; }
  const { data: profiles } = await sb.from('profiles')
    .select('id,username,display_name,avatar_url,verified,verification_type').in('id', ids);
  const byId = new Map((profiles || []).map(p => [p.id, p]));
  listFollowers = rows.map(r => byId.get(r.follower_id)).filter(Boolean);
}

async function loadListFeed() {
  const el = document.getElementById('list-content');
  el.innerHTML = skeletonFeedHtml();
  await ensureFeedPrereqsLoaded();

  if (!listMembers.length) {
    el.innerHTML = `<div id="feed-empty">No one's on this List yet. Add people from their profile's &ldquo;&middot;&middot;&middot;&rdquo; menu.</div>`;
    return;
  }

  const { data, error } = await sb.from('posts').select(POST_SELECT)
    .eq('is_deleted', false).in('author_id', listMembers.map(m => m.id))
    .order('created_at', { ascending: false }).limit(100);
  if (error) { el.innerHTML = `<div class="errmsg">Failed to load posts: ${esc(error.message)}</div>`; return; }
  if (!data.length) {
    el.innerHTML = `<div id="feed-empty">No posts yet from anyone on this List.</div>`;
    return;
  }
  await attachQuotedPosts(data);
  el.innerHTML = data.map(p => postCardHtml(p)).join('');
}

// Shared row for both the Members and Followers tabs — a person's
// avatar/name/handle plus their OWN personal Follow button (follow
// that person, not the List — see followlist.js's near-identical
// flRowHtml()), and optionally a Remove button for the List owner.
function listPersonRowHtml(profile, removable) {
  const uname = profile?.username || 'unknown';
  const viewerIsThem = currentSession && profile.id === currentSession.user.id;
  const following = listMyFollowing.has(profile.id);
  const locked = following && isProtectedFollowUsername(uname);
  const followBtn = (!currentSession || viewerIsThem) ? '' : locked
    ? `<button class="follow-btn following locked" disabled title="You can't unfollow this account." aria-label="You can't unfollow this account.">${ICON_LOCK_SM}${t('action.following')}</button>`
    : `<button class="follow-btn${following ? ' following' : ''}" onclick="listPersonToggleFollow('${profile.id}', this)">${following ? t('action.following') : t('action.follow')}</button>`;
  const removeBtn = removable
    ? `<button type="button" class="list-member-remove" onclick="event.preventDefault();removeListMember('${profile.id}', '${u_(uname)}')">Remove</button>`
    : '';
  return `
  <div class="fl-row">
    <a class="ulrow" style="flex:1;min-width:0;" href="${profileUrl(uname)}">
      <img class="avatar pfp-md${avSqClass(profile)}" src="${esc(avatarUrl(profile?.avatar_url))}" alt="" loading="lazy" decoding="async">
      <div class="ulrow-txt">
        <span class="ulrow-name">${esc(profile?.display_name || uname)}${vBadge(profile)}</span>
        <span class="ulrow-handle">@${esc(uname)}</span>
      </div>
    </a>
    ${followBtn}
    ${removeBtn}
  </div>`;
}

async function listPersonToggleFollow(userId, btn) {
  if (!requireLogin()) return;
  const following = btn.classList.contains('following');
  btn.disabled = true;
  try {
    const { error } = following ? await unfollowUser(userId) : await followUser(userId);
    if (error) throw error;
    if (following) { listMyFollowing.delete(userId); btn.classList.remove('following'); btn.textContent = t('action.follow'); }
    else { listMyFollowing.add(userId); btn.classList.add('following'); btn.textContent = t('action.following'); }
  } catch (e) {
    toast(e.message || 'Could not update follow status.', 'error');
  } finally {
    btn.disabled = false;
  }
}

function renderMembers() {
  const el = document.getElementById('list-content');
  if (!listMembers.length) {
    el.innerHTML = `<div id="feed-empty">No one's on this List yet. Add people from their profile's &ldquo;&middot;&middot;&middot;&rdquo; menu.</div>`;
    return;
  }
  el.innerHTML = listMembers.map(m => listPersonRowHtml(m, isOwner)).join('');
}

function renderFollowers() {
  const el = document.getElementById('list-content');
  if (!listFollowers.length) {
    el.innerHTML = `<div id="feed-empty">No one's following this List yet.</div>`;
    return;
  }
  el.innerHTML = listFollowers.map(f => listPersonRowHtml(f, false)).join('');
}

async function removeListMember(memberId, username) {
  const uname = decodeURIComponent(username);
  const ok = await ocConfirm({
    title: `Remove @${uname} from this List?`,
    confirmLabel: 'Remove',
    danger: true
  });
  if (!ok) return;
  try {
    const { error } = await sb.from('list_members').delete().eq('list_id', list.id).eq('member_id', memberId);
    if (error) throw error;
    list.member_count = Math.max(0, list.member_count - 1);
    renderHero();
    listMembers = listMembers.filter(m => m.id !== memberId);
    renderMembers();
    toast(`Removed @${uname} from the List.`);
  } catch (e) {
    toast(e.message || 'Could not remove that member.', 'error');
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  if (document.body.dataset.page !== 'list') return; // see js/notifications.js
  // Recompute the id + reset every cached bit of the previous List
  // fresh on every visit — see the comment on listId's declaration
  // above.
  listId = currentListId();
  list = null;
  isOwner = false;
  isListFollowed = false;
  listTab = 'posts';
  listMembers = [];
  listFollowers = [];
  listMyFollowing = new Set();
  await authReady; // see auth.js — otherwise isOwner/Edit-Delete can render before we know who's logged in
  loadList();
});
