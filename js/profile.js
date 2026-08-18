// ─────────────────────────────────────────────────────────────
// PROFILE PAGE — /<username>  (also reachable via the legacy
// profile.html?u=<username> form — see currentProfileUsername() in
// common.js). Editing your own profile lives on its own page
// (editprofile.html). Followers/following lists live on their own
// page (followlist.html).
// ─────────────────────────────────────────────────────────────
const viewUsername = currentProfileUsername();
let viewedProfile = null;
let isOwnProfile = false;

const POST_SELECT = '*, profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified,verification_type)';

async function loadProfile() {
  const root = document.getElementById('profile-root');
  if (!viewUsername) {
    root.innerHTML = `<div class="errmsg">No user specified.</div>`;
    return;
  }

  const { data: { session } } = await sb.auth.getSession();

  const { data: profile, error } = await sb.from('profiles')
    .select('*').ilike('username', viewUsername).single();

  if (error || !profile) {
    root.innerHTML = `<div class="errmsg">No user found with that username.</div>`;
    return;
  }
  viewedProfile = profile;
  isOwnProfile = session && session.user.id === profile.id;
  document.title = `@${profile.username} — InteractInk`;
  setPageH1(profile.display_name ? `${profile.display_name} (@${profile.username})` : `@${profile.username}`);
  setPageDescription(profile.bio || `@${profile.username}'s posts on InteractInk.`);
  // Canonicalize casing (usernames are matched case-insensitively
  // above via ilike) and upgrade a legacy ?u= link, same idea as
  // thread.js's /i/status/ -> /<username>/status/ upgrade.
  const canonical = prettyProfileUrl(profile.username);
  if (location.pathname + location.search !== canonical) { try { history.replaceState(null, '', canonical); } catch (e) {} }
  setCanonical(canonical);
  if (profile.avatar_url) setPageImage(profile.avatar_url);
  setJsonLd({
    '@context': 'https://schema.org', '@type': 'ProfilePage',
    dateCreated: profile.created_at, url: location.origin + canonical,
    mainEntity: {
      '@type': 'Person',
      name: profile.display_name || profile.username,
      alternateName: profile.username,
      description: profile.bio || undefined,
      image: profile.avatar_url || undefined,
      url: location.origin + canonical,
    },
  });

  const flu = kind => followListUrl(profile.username, kind);
  const websiteHref = profile.website || null;
  const websiteFullLabel = websiteHref ? websiteHref.replace(/^https?:\/\//i, '').replace(/\/$/, '') : null;
  const websiteLabel = truncateLabel(websiteFullLabel);
  const locationFull = profile.location || null;
  const locationLabel = truncateLabel(locationFull);

  root.innerHTML = `
    <div class="profile-hdr" id="profile-hdr" style="${profile.banner_url ? `--banner-img:url('${esc(profile.banner_url)}')` : ''}">
      <a class="profile-back-btn" href="index.html" aria-label="Back to home">${ICON_BACK}</a>
      <div class="profile-hdr-top">
        <img class="avatar pfp-lg${avSqClass(profile)}" id="pv-avatar" src="${esc(avatarUrl(profile.avatar_url))}" alt="">
        <div class="profile-hdr-actions">
          ${!isOwnProfile && session ? `
            <a class="profile-icon-btn" href="${messagesUrl(profile.username)}" title="Message" aria-label="Message">${ICON_MESSAGE}</a>
            <div class="pc-menu-wrap" id="pmenu-profile-${profile.id}">
              <button class="pc-menu-btn profile-icon-btn" onclick="togglePostMenu('profile-${profile.id}', event)">${ICON.menu}</button>
              <div class="pc-menu-dd" id="profile-menu-dd">${profileMenuItemsHtml(profile)}</div>
            </div>` : ''}
          ${!isOwnProfile && session ? `<button class="follow-btn" id="follow-btn" onclick="toggleFollow()">${t('action.follow')}</button>` : ''}
          ${!isOwnProfile && !session ? `<a class="follow-btn" href="login.html">${t('action.follow')}</a>` : ''}
          ${isOwnProfile ? `<a class="profile-edit-btn" href="editprofile.html">Edit Profile</a>` : ''}
        </div>
      </div>
      <div class="profile-id">
        <div class="uname-row">
          <div class="uname">${esc(profile.display_name || profile.username)}${vBadge(profile)}</div>
        </div>
        <div class="handle">@${esc(profile.username)}</div>
        <div class="profile-stats">
          <a class="stat-item" href="${flu('following')}"><b id="stat-following">${fmtCount(profile.following_count)}</b> Following</a>
          <a class="stat-item" href="${flu('followers')}"><b id="stat-followers">${fmtCount(profile.followers_count)}</b> Followers</a>
          <span class="stat-item stat-static"><b id="stat-posts">${fmtCount(profile.posts_count)}</b> Posts</span>
        </div>
        <div class="bio">${esc(profile.bio || '')}</div>
        <div class="profile-meta-row">
          ${locationLabel ? `<span class="pmr-item" title="${esc(locationFull)}">${ICON_LOC}<span class="pmr-text">${esc(locationLabel)}</span></span>` : ''}
          ${websiteHref ? `<span class="pmr-item"><a href="${esc(websiteHref)}" target="_blank" rel="noopener noreferrer" title="${esc(websiteFullLabel)}" aria-label="${esc(websiteFullLabel)}">${ICON_LINK}<span class="pmr-text">${esc(websiteLabel)}</span></a></span>` : ''}
          <span class="pmr-item">${ICON_CAL}Joined ${new Date(profile.created_at).toLocaleDateString()}</span>
        </div>
        <div id="profile-followed-by"></div>
      </div>
    </div>

    <div id="profile-tabs" class="sec-bar profile-tabs" style="padding:0;">
      <div class="xtabs">
        <button class="xtab active" id="ptab-posts" onclick="switchProfileTab('posts');return false;">Posts</button>
        <button class="xtab" id="ptab-replies" onclick="switchProfileTab('replies');return false;">Replies</button>
        ${isOwnProfile ? `<button class="xtab" id="ptab-scheduled" onclick="switchProfileTab('scheduled');return false;">Scheduled</button>` : ''}
      </div>
    </div>
    <div id="profile-posts">${skeletonFeedHtml(3)}</div>
  `;

  // Bug fix: a banner URL that 404s or otherwise fails to load used to
  // just render as a solid black rectangle — CSS's var() fallback
  // (the gradient in .profile-hdr::before) only kicks in when the
  // custom property itself is unset, not when the image it points to
  // fails to load. Preload-check it and drop back to the gradient
  // fallback if it can't actually be displayed.
  if (profile.banner_url) {
    const bannerCheck = new Image();
    bannerCheck.onerror = () => {
      const hdrEl = document.getElementById('profile-hdr');
      if (hdrEl) hdrEl.style.removeProperty('--banner-img');
    };
    bannerCheck.src = profile.banner_url;
  }

  if (!isOwnProfile && session) {
    isFollowing(profile.id).then(f => setFollowBtnState(f));
    loadFollowedBy(profile.id);
    isMuted(profile.id).then(m => { const b = document.getElementById('pm-mute-btn'); if (b && m) b.textContent = 'Unmute'; });
    isBlocked(profile.id).then(b => { const btn = document.getElementById('pm-block-btn'); if (btn && b) btn.textContent = `Unblock @${profile.username}`; });
  }

  // profiles.posts_count only tracks top-level posts (see the comment
  // on confirmDeletePost() in common.js) — replies count toward the
  // "Posts" stat too (10 posts + 10 replies shows 20), so patch the
  // number in once the reply count comes back rather than blocking
  // the whole header render on an extra query.
  loadReplyCountIntoStat(profile.id, profile.posts_count || 0);

  loadUserPosts(profile.id);
}

async function loadReplyCountIntoStat(userId, basePostsCount) {
  const { count, error } = await sb.from('replies').select('id', { count: 'exact', head: true })
    .eq('author_id', userId).eq('is_deleted', false);
  if (error) return; // leave the posts-only number showing rather than a broken stat
  const el = document.getElementById('stat-posts');
  if (el) el.textContent = fmtCount(basePostsCount + (count || 0));
}

// ── HEADER ICONS used only on the profile page ──
const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M15 5 8 12l7 7"/></svg>';
const ICON_MESSAGE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="5.5" width="18" height="13" rx="2.5"/><path d="m4 7 8 6 8-6"/></svg>';
const ICON_LOC_RAW = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 21s7-6.5 7-11.5A7 7 0 0 0 5 9.5C5 14.5 12 21 12 21Z"/><circle cx="12" cy="9.5" r="2.4"/></svg>';
const ICON_LOC = `<span class="pmr-icon">${ICON_LOC_RAW}</span>`;
const ICON_LINK = '<span class="pmr-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M9.5 14.5 14.5 9.5"/><path d="M11 7.5 12.6 5.9a3.5 3.5 0 1 1 5 5L16 12.5"/><path d="M13 16.5 11.4 18.1a3.5 3.5 0 1 1-5-5L8 11.5"/></svg></span>';
const ICON_CAL = '<span class="pmr-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3.5" y="5" width="17" height="16" rx="2"/><path d="M3.5 9.5h17M8 3v4M16 3v4"/></svg></span>';

// Twitter-style truncation: "domain.com/some-long-path..." capped at
// maxLen visible characters (ellipsis included). Used for both the
// profile website link and the location field so a single absurdly
// long value can't blow out the header layout.
function truncateLabel(str, maxLen = 26) {
  if (!str) return str;
  return str.length > maxLen ? str.slice(0, maxLen - 1).trimEnd() + '\u2026' : str;
}

// The profile "···" dropdown — "Add/remove from Lists" opens the
// shared alm-modal (see common.js) pre-loaded with this profile;
// "View Lists" goes to the page showing which Lists this profile is
// a (visible) member of. Share/Copy/Mute/Block/Report are also
// fully wired.
function profileMenuItemsHtml(profile) {
  return `
    <button onclick="openAddToListModal(event, '${profile.id}', '${u_(profile.username)}')">Add/remove from Lists</button>
    <a href="${profileListsUrl(profile.username)}" onclick="closeProfileMenu(event)">View Lists</a>
    <button onclick="profileMenuShare(event, '${u_(profile.username)}')">Share @${esc(profile.username)} via&hellip;</button>
    <button onclick="profileMenuCopyLink(event, '${u_(profile.username)}')">Copy link to profile</button>
    <button id="pm-mute-btn" onclick="profileMenuMute(event, '${profile.id}')">Mute</button>
    <button id="pm-block-btn" class="pc-menu-danger" onclick="profileMenuBlock(event, '${profile.id}', '${u_(profile.username)}')">Block @${esc(profile.username)}</button>
    <button onclick="profileMenuReport(event, '${profile.id}')">Report @${esc(profile.username)}</button>`;
}

function closeProfileMenu(ev) {
  if (ev) ev.stopPropagation();
  document.querySelectorAll('.pc-menu-wrap.open').forEach(w => w.classList.remove('open'));
}

function profileMenuStub(ev, feature) {
  closeProfileMenu(ev);
  toast(`${feature} aren't available on InteractInk yet.`);
}

function profileMenuShare(ev, username) {
  closeProfileMenu(ev);
  const url = `${location.origin}${profileUrl(decodeURIComponent(username))}`;
  if (navigator.share) {
    navigator.share({ url }).catch(() => {});
  } else if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('Link copied to clipboard.')).catch(() => prompt('Copy link:', url));
  } else {
    prompt('Copy link:', url);
  }
}

function profileMenuCopyLink(ev, username) {
  closeProfileMenu(ev);
  const url = `${location.origin}${profileUrl(decodeURIComponent(username))}`;
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('Link copied to clipboard.')).catch(() => prompt('Copy link:', url));
  } else {
    prompt('Copy link:', url);
  }
}

async function profileMenuMute(ev, userId) {
  closeProfileMenu(ev);
  if (!requireLogin()) return;
  const btn = document.getElementById('pm-mute-btn');
  try {
    const muted = btn && btn.textContent === 'Unmute';
    if (muted) { await unmuteUser(userId); if (btn) btn.textContent = 'Mute'; toast(`Unmuted @${viewedProfile.username}.`); }
    else { await muteUser(userId); if (btn) btn.textContent = 'Unmute'; toast(`Muted @${viewedProfile.username}. You won't see their posts in your feeds.`); }
  } catch (e) { toast(e.message || 'Could not update mute status.', 'error'); }
}

async function profileMenuBlock(ev, userId, username) {
  closeProfileMenu(ev);
  if (!requireLogin()) return;
  const btn = document.getElementById('pm-block-btn');
  const uname = decodeURIComponent(username);
  const currentlyBlocked = btn && btn.textContent.startsWith('Unblock');
  if (!currentlyBlocked) {
    const ok = await ocConfirm({
      title: `Block @${uname}?`,
      desc: `They won't be able to follow or message you, and you'll stop following each other.`,
      confirmLabel: 'Block',
      danger: true
    });
    if (!ok) return;
  }
  try {
    if (currentlyBlocked) {
      await unblockUser(userId);
      if (btn) btn.textContent = `Block @${uname}`;
      toast(`Unblocked @${uname}.`);
    } else {
      await blockUser(userId);
      if (btn) btn.textContent = `Unblock @${uname}`;
      setFollowBtnState(false);
      toast(`Blocked @${uname}.`);
    }
  } catch (e) { toast(e.message || 'Could not update block status.', 'error'); }
}

function profileMenuReport(ev, userId) {
  closeProfileMenu(ev);
  openReportUser(userId);
}

// "Followed by X and Y" — up to 3 people the *current* logged-in user
// follows who also follow this profile, same idea as Twitter's mutual-
// followers line. Runs after the header paints since it's a couple of
// extra queries nobody needs to wait on to see the profile itself.
async function loadFollowedBy(profileId) {
  const el = document.getElementById('profile-followed-by');
  if (!el || !currentSession) return;
  try {
    const { data: iFollowRows } = await sb.from('follows').select('followee_id')
      .eq('follower_id', currentSession.user.id).limit(1000);
    const iFollowIds = (iFollowRows || []).map(r => r.followee_id);
    if (!iFollowIds.length) return;
    const { data: mutualRows } = await sb.from('follows')
      .select('follower_id, profile:profiles!follows_follower_id_fkey(username,display_name)')
      .eq('followee_id', profileId).in('follower_id', iFollowIds).limit(3);
    if (!mutualRows || !mutualRows.length) return;
    const names = mutualRows.map(r => esc(r.profile?.display_name || r.profile?.username || 'someone'));
    let label;
    if (names.length === 1) label = `Followed by ${names[0]}`;
    else if (names.length === 2) label = `Followed by ${names[0]} and ${names[1]}`;
    else label = `Followed by ${names[0]}, ${names[1]} and others you follow`;
    el.innerHTML = `<div class="profile-followed-by">${label}</div>`;
  } catch (e) {
    // Non-essential — silently skip if the FK-named embed above isn't
    // available in this schema cache yet, same reasoning as the
    // plain-lookup fallback used elsewhere in this file.
  }
}

// ── POSTS / REPLIES TABS ──
// "Posts" = the existing own-posts + reposts timeline (unchanged).
// "Replies" = every reply this person has left on other posts/replies,
// each shown with a small "Replying to @x" tag and linking straight
// into the thread at that reply, same as Twitter's second profile tab.
//
// BUGFIX: both tabs render into the same #profile-posts element, so a
// "loaded once, never refetch" flag isn't enough on its own — loading
// Replies overwrites whatever Posts had rendered there, and switching
// back used to skip re-fetching (postsRendered was already true) and
// so just left the Replies markup on screen under the "Posts" tab.
// Fixed by caching each tab's rendered HTML the first time it loads
// and re-painting straight from that cache on every switch back,
// instead of only guarding the network call.
let profileTab = 'posts';
let postsHtmlCache = null;
let repliesHtmlCache = null;
let scheduledHtmlCache = null;

function switchProfileTab(tab) {
  if (tab === profileTab) return;
  profileTab = tab;
  document.getElementById('ptab-posts').classList.toggle('active', tab === 'posts');
  document.getElementById('ptab-replies').classList.toggle('active', tab === 'replies');
  document.getElementById('ptab-scheduled')?.classList.toggle('active', tab === 'scheduled');
  const el = document.getElementById('profile-posts');
  if (tab === 'posts') {
    if (postsHtmlCache !== null) el.innerHTML = postsHtmlCache;
    else loadUserPosts(viewedProfile.id);
  } else if (tab === 'replies') {
    if (repliesHtmlCache !== null) el.innerHTML = repliesHtmlCache;
    else loadUserReplies(viewedProfile.id);
  } else {
    // Always refetch scheduled posts (never cached) — they can flip
    // over to "published" or get cancelled from this same screen, so
    // a stale cache would show wrong state the next time you tab back.
    loadScheduledPosts(viewedProfile.id);
  }
}

// ── SCHEDULED POSTS — own-profile-only tab. A scheduled post is a
// normal posts row with scheduled_at in the future; RLS lets its
// author read it early (see supabase/gifs_polls_scheduling.sql), but
// it's deliberately excluded from loadUserPosts()'s normal timeline
// query below so it doesn't look like it silently posted already.
// This tab is the only place you can see and manage it before then.
async function loadScheduledPosts(userId) {
  const el = document.getElementById('profile-posts');
  el.innerHTML = `<span class="spinner">Loading scheduled posts&hellip;</span>`;

  const { data, error } = await sb.from('posts').select(POST_SELECT)
    .eq('author_id', userId).eq('is_deleted', false)
    .gt('scheduled_at', new Date().toISOString())
    .order('scheduled_at', { ascending: true }).limit(50);

  if (error) {
    el.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`;
    return;
  }
  if (!data.length) {
    el.innerHTML = `<div class="empty-note">Nothing scheduled. Posts you schedule for later show up here until they go live.</div>`;
    return;
  }

  el.innerHTML = data.map(p => `
    <div class="sched-item" id="sched-${p.id}">
      <div class="sched-item-when">Scheduled for ${new Date(p.scheduled_at).toLocaleString()}</div>
      <div class="sched-item-body">${esc(p.body)}</div>
      <div class="sched-item-actions">
        <button class="cx-poll-add" onclick="postScheduledNow('${p.id}')">Post now</button>
        <button class="cx-sched-remove-btn" onclick="cancelScheduledPost('${p.id}')">Cancel</button>
      </div>
    </div>
  `).join('');
}

// Clears scheduled_at so the post publishes immediately (it's already
// a normal row — RLS's public read policy just starts matching it the
// instant scheduled_at is null or in the past).
async function postScheduledNow(postId) {
  try {
    const { error } = await sb.from('posts').update({ scheduled_at: null }).eq('id', postId);
    if (error) throw error;
    toast('Posted.', 'success');
    postsHtmlCache = null; // next visit to Posts should include it
    loadScheduledPosts(viewedProfile.id);
  } catch (e) {
    toast(e.message || 'Could not post it now.', 'error');
  }
}

// Deletes a scheduled post outright (same as canceling — it never
// went live, so there's nothing to "unpublish", just remove the row).
async function cancelScheduledPost(postId) {
  if (!confirm('Cancel this scheduled post? This can\'t be undone.')) return;
  try {
    const { error } = await sb.from('posts').update({ is_deleted: true }).eq('id', postId);
    if (error) throw error;
    document.getElementById(`sched-${postId}`)?.remove();
    toast('Scheduled post cancelled.', 'success');
  } catch (e) {
    toast(e.message || 'Could not cancel it.', 'error');
  }
}

const REPLY_SELECT = '*, profile:profiles(username,display_name,avatar_url,verified,verification_type)';

async function loadUserReplies(userId) {
  const el = document.getElementById('profile-posts');
  el.innerHTML = `<span class="spinner">Loading replies&hellip;</span>`;

  const { data: replies, error } = await sb.from('replies').select(REPLY_SELECT)
    .eq('author_id', userId).eq('is_deleted', false)
    .order('created_at', { ascending: false }).limit(50);

  if (error) {
    el.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`;
    return;
  }
  if (!replies.length) {
    el.innerHTML = repliesHtmlCache = `<div class="empty-note">No replies yet.</div>`;
    return;
  }

  // Same reasoning as loadUserPosts()/attachQuotedPosts(): plain
  // by-id lookups instead of a nested `post:posts(...)` embed, so a
  // schema-cache-lagged FK can't fail the whole query.
  const postIds = [...new Set(replies.map(r => r.post_id))];
  const parentIds = [...new Set(replies.filter(r => r.parent_reply_id).map(r => r.parent_reply_id))];
  const [postsRes, parentsRes] = await Promise.all([
    sb.from('posts').select('id,author_id,profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified,verification_type)').in('id', postIds),
    parentIds.length
      ? sb.from('replies').select('id,profile:profiles(username,display_name,avatar_url,verified,verification_type)').in('id', parentIds)
      : Promise.resolve({ data: [] })
  ]);
  const postById = new Map((postsRes.data || []).map(p => [p.id, p]));
  const parentById = new Map((parentsRes.data || []).map(r => [r.id, r]));

  el.innerHTML = repliesHtmlCache = replies.map(r => {
    const post = postById.get(r.post_id);
    const parent = r.parent_reply_id ? parentById.get(r.parent_reply_id) : null;
    const replyingToProfile = parent ? parent.profile : post?.profile;
    return replyCardHtml(r, replyingToProfile, post?.profile?.username);
  }).join('');
}

// Same "click the card, not an interactive bit inside it" behavior
// as cardClick() in common.js, just landing on the reply's spot in
// the thread instead of the top of it.
function replyCardClick(ev, postId, replyId, opUsername) {
  if (ev.target.closest('a, button, input, textarea, .pc-menu-wrap, .rp-menu-wrap, .pm')) return;
  location.href = postUrlById(postId, opUsername) + `#reply-${replyId}`;
}

// A reply rendered on the Replies tab — a normal post-card layout
// plus the "Replying to @x" tag, linking into the thread at that
// specific reply. Bookmark/repost are left off, same as a reply card
// on the thread page itself (see replyHtml() in thread.js). `opUsername`
// is the username of the post's original author (needed to build the
// pretty /<username>/status/<id> link — the reply itself may be by
// someone else).
function replyCardHtml(r, replyingToProfile, opUsername = null) {
  cachePost(r);
  const uname = replyingToProfile?.username;
  const threadHref = postUrlById(r.post_id, opUsername) + `#reply-${r.id}`;
  return `
  <div class="pc" data-post-id="${r.id}" onclick="replyCardClick(event, '${r.post_id}', '${r.id}', ${opUsername ? `'${u_(opUsername)}'` : 'null'})">
    <div class="pc-row">
      ${pcAvatarHtml(r.profile)}
      <div class="pc-main">
        ${uname ? `<div class="rc-reply-tag">Replying to <a href="${profileUrl(uname)}" onclick="event.stopPropagation()">@${esc(uname)}</a></div>` : ''}
        <div class="ph">
          ${pcNameHtml(r.profile)}
          <span class="dt" data-dt="${r.id}">${timeAgo(r.created_at)}${editedSuffix(r)}</span>
          ${postMenuHtml(r.post_id, r.id, r.author_id, null, r.created_at)}
        </div>
        <div class="pb" data-pb="${r.id}">${renderBody(r.body)}</div>
        ${renderMedia(r.media_url, r.media_type, '', r)}
        ${postActionsHtml(r, { replyHref: threadHref, bookmarkable: false, repostable: false, isReply: true })}
      </div>
    </div>
  </div>`;
}

// ── FOLLOW BUTTON ──
let followBusy = false;
function setFollowBtnState(following) {
  const btn = document.getElementById('follow-btn');
  if (!btn) return;
  if (isProtectedFollowUsername(viewedProfile?.username)) {
    btn.innerHTML = `${ICON_LOCK_SM}${t('action.following')}`;
    btn.classList.add('following', 'locked');
    btn.disabled = true;
    btn.title = "You can't unfollow this account.";
    return;
  }
  btn.textContent = following ? t('action.following') : t('action.follow');
  btn.classList.toggle('following', following);
}

async function toggleFollow() {
  if (!requireLogin() || followBusy || !viewedProfile) return;
  if (isProtectedFollowUsername(viewedProfile.username)) return;
  const btn = document.getElementById('follow-btn');
  const following = btn.classList.contains('following');
  followBusy = true;
  btn.disabled = true;
  try {
    if (following) {
      const { error } = await unfollowUser(viewedProfile.id);
      if (error) throw error;
      setFollowBtnState(false);
      bumpStat('stat-followers', -1);
    } else {
      const { error } = await followUser(viewedProfile.id);
      if (error) throw error;
      setFollowBtnState(true);
      bumpStat('stat-followers', 1);
    }
  } catch (e) {
    toast(e.message || 'Could not update follow status.', 'error');
  } finally {
    followBusy = false;
    btn.disabled = false;
  }
}

function bumpStat(elId, delta) {
  const el = document.getElementById(elId);
  if (!el) return;
  const raw = parseInt((el.textContent || '0').replace(/[^\d]/g, ''), 10) || 0;
  el.textContent = fmtCount(Math.max(raw + delta, 0));
}

// Profile timeline = this user's own posts + posts they've reposted,
// merged and sorted like Twitter does — a repost slots in at the time
// it was reposted, not the original post's time, and carries a
// "You reposted" / "[Name] reposted" banner (see repostBannerHtml in
// common.js).
//
// Reposts are fetched as a plain reposts row lookup + a separate
// posts-by-id lookup, rather than one query with a `post:posts(...)`
// embed — same reasoning as attachQuotedPosts() below: `reposts` and
// its FK to `posts` are recent additions, and until PostgREST's schema
// cache has definitely picked them up, an embed that can't resolve
// fails its *entire* query rather than just that part of it. Two
// plain queries can't do that.
async function loadUserPosts(userId) {
  const el = document.getElementById('profile-posts');
  await ensureFeedPrereqsLoaded();

  const nowIso = new Date().toISOString();
  const [ownRes, repostRowsRes] = await Promise.all([
    sb.from('posts').select(POST_SELECT)
      .eq('author_id', userId).eq('is_deleted', false)
      // Exclude posts scheduled for the future — RLS lets the author
      // read their own scheduled rows early (so the Scheduled tab
      // above can show them), but that means without this filter a
      // scheduled post would show up on your own profile immediately,
      // looking exactly like it already went live. Everyone else
      // never sees it here at all; RLS blocks it for them outright.
      .or(`scheduled_at.is.null,scheduled_at.lte.${nowIso}`)
      .order('created_at', { ascending: false }).limit(50),
    sb.from('reposts').select('post_id, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false }).limit(50)
  ]);

  if (ownRes.error) {
    el.innerHTML = `<div class="errmsg">${esc(ownRes.error.message)}</div>`;
    return;
  }

  const ownPosts = (ownRes.data || []).map(p => ({ ...p, _sortTime: p.created_at }));

  let repostedPosts = [];
  const repostRows = repostRowsRes.data || [];
  if (repostRowsRes.error) console.warn('reposts lookup failed', repostRowsRes.error);
  if (repostRows.length) {
    const postIds = [...new Set(repostRows.map(r => r.post_id))];
    const { data: repostedPostRows, error: postsErr } = await sb.from('posts').select(POST_SELECT)
      .in('id', postIds).eq('is_deleted', false);
    if (postsErr) console.warn('reposted posts lookup failed', postsErr);
    const postById = new Map((repostedPostRows || []).map(p => [p.id, p]));
    const reposterInfo = { id: viewedProfile.id, username: viewedProfile.username, display_name: viewedProfile.display_name };
    repostedPosts = repostRows
      .map(r => {
        const p = postById.get(r.post_id);
        return p ? { ...p, _sortTime: r.created_at, _repostedBy: reposterInfo } : null;
      })
      .filter(Boolean);
  }

  let combined = [...ownPosts, ...repostedPosts]
    .sort((a, b) => new Date(b._sortTime) - new Date(a._sortTime));

  // Pinned post — pulled out of its chronological spot and shown
  // first, tagged like Twitter's own pinned-post banner. Only ever
  // one of this user's own posts (not a repost) can be pinned.
  const pinnedId = viewedProfile.pinned_post_id;
  if (pinnedId) {
    const idx = combined.findIndex(p => p.id === pinnedId && !p._repostedBy);
    if (idx > -1) {
      const [pinned] = combined.splice(idx, 1);
      pinned._pinned = true;
      combined = [pinned, ...combined];
    }
  }

  if (!combined.length) {
    el.innerHTML = postsHtmlCache = `<div class="empty-note">No posts yet.</div>`;
    return;
  }
  await attachQuotedPosts(combined);
  el.innerHTML = postsHtmlCache = combined.map(p => postCardHtml(p)).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
  await authReady; // see auth.js — otherwise cards can render before we know who's logged in
  loadProfile();
});
