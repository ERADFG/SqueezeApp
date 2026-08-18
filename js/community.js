// ─────────────────────────────────────────────────────────────
// COMMUNITY PAGE — /communities/<slug> (also reachable as the legacy
// community.html?slug=<slug> form — see currentCommunitySlug() in
// common.js). Shows the community's header (name, description,
// member count, Join/Leave), a composer scoped to it, and a
// Latest/Trending filter over just its own posts.
// ─────────────────────────────────────────────────────────────
const POST_SELECT = '*, profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified,verification_type)';

const communitySlug = currentCommunitySlug();
let community = null;      // the loaded community row
let isMember = false;      // whether the current user has joined it
let communityTab = 'latest'; // 'top' | 'latest' | 'media' | 'about'
let communityAboutLoaded = false; // so switching back to About doesn't refetch every time
let communityRules = [];         // [{id, position, title, description}]
let communityMods = [];          // [{user_id, profile}]

async function loadCommunity() {
  const heroEl = document.getElementById('community-hero');
  if (!communitySlug) {
    heroEl.innerHTML = `<div id="feed-empty">No community specified.</div>`;
    return;
  }

  const { data, error } = await sb.from('communities').select('*').eq('slug', communitySlug).maybeSingle();
  if (error) { heroEl.innerHTML = `<div class="errmsg">Failed to load community: ${esc(error.message)}</div>`; return; }
  if (!data) { heroEl.innerHTML = `<div id="feed-empty">This community doesn't exist.</div>`; return; }
  community = data;
  document.title = `${community.name} — InteractInk`;
  setPageH1(community.name);
  setPageDescription(community.description || `${community.name} — a community on InteractInk.`);
  setCanonical(communityUrl(community.slug));
  if (community.banner_url || community.avatar_url) setPageImage(community.banner_url || community.avatar_url);
  setJsonLd({
    '@context': 'https://schema.org', '@type': 'WebPage',
    name: community.name, description: community.description || undefined,
    url: location.origin + communityUrl(community.slug),
  });

  if (currentSession) {
    const { data: mem } = await sb.from('community_members').select('user_id')
      .eq('community_id', community.id).eq('user_id', currentSession.user.id).maybeSingle();
    isMember = !!mem;
  } else {
    isMember = false;
  }

  renderHero();
  document.getElementById('board-hdr').style.display = '';
  document.getElementById('pf-wrap').style.display = '';
  document.getElementById('community-about').style.display = 'none';
  document.getElementById('feed-posts').style.display = '';
  refreshPostGates();
  updateComposerVisibility();
  wireComposer();
  loadCommunityFeed();
}

// refreshPostGates() (auth.js) only knows anon vs logged-in — it
// can't know about membership, so this layers "logged in but hasn't
// joined" on top: the join-gate wins over the real composer whenever
// there's a session but no membership row for this community.
function updateComposerVisibility() {
  const pfBox = document.getElementById('pf-box');
  const joinGate = document.getElementById('cf-join-gate');
  if (!pfBox || !joinGate) return;
  if (currentSession && !isMember) {
    pfBox.style.display = 'none';
    joinGate.style.display = '';
  } else {
    joinGate.style.display = 'none';
    if (currentSession) pfBox.style.display = '';
  }
}

// "•••" icon next to Join — opens a small dropdown (same .pc-menu-wrap
// pattern as postMenuHtml/profileMenuItemsHtml) with Share/Report,
// instead of a single hardcoded "copy link" action.
function communityMenuItemsHtml() {
  return `
    <button onclick="communityMenuShare(event)">Share community</button>
    <button onclick="communityMenuReport(event)">Report community</button>`;
}

function closeCommunityMenu(ev) {
  if (ev) ev.stopPropagation();
  document.querySelectorAll('.pc-menu-wrap.open').forEach(w => w.classList.remove('open'));
}

// Native share sheet when available (mobile), falling back to the old
// copy-link behavior everywhere else — same fallback chain profile.js
// uses for profileMenuShare().
function communityMenuShare(ev) {
  closeCommunityMenu(ev);
  if (!community) return;
  const url = location.href;
  if (navigator.share) {
    navigator.share({ title: community.name, url }).catch(() => {});
  } else if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => toast('Link copied')).catch(() => toast('Could not copy link', 'error'));
  } else {
    toast('Could not copy link', 'error');
  }
}

function communityMenuReport(ev) {
  closeCommunityMenu(ev);
  if (!community) return;
  openReportCommunity(community.id);
}

function renderHero() {
  const heroEl = document.getElementById('community-hero');
  const actionBtn = !currentSession
    ? `<a class="comm-join-btn" href="login.html">Join</a>`
    : isMember
      ? `<button type="button" class="comm-leave-btn" id="hero-join-btn" onclick="heroToggleJoin()">Joined</button>`
      : `<button type="button" class="comm-join-btn" id="hero-join-btn" onclick="heroToggleJoin()">Join</button>`;
  // Only the community's own creator can change its picture — same
  // "isOwner" idea as postMenuHtml's Delete button, just for the
  // community row itself instead of a post/reply row.
  const isCreator = currentSession && community.created_by === currentSession.user.id;
  const avatarInner = `
    <span class="comm-avatar comm-avatar-lg">${communityAvatarInner(community)}</span>
    ${isCreator ? `
      <label class="comm-avatar-pick" for="hero-avatar-file" title="Change community picture">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h3l2-2h6l2 2h3v12H4V7Z"/><circle cx="12" cy="13" r="3.5"/></svg>
      </label>
      <input type="file" id="hero-avatar-file" accept="image/*" style="display:none;" onchange="changeCommunityAvatar(this)">` : ''}`;
  const bannerPick = isCreator ? `
    <label class="comm-banner-pick" for="hero-banner-file" title="Change community banner">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h3l2-2h6l2 2h3v12H4V7Z"/><circle cx="12" cy="13" r="3.5"/></svg>
    </label>
    <input type="file" id="hero-banner-file" accept="image/*" style="display:none;" onchange="changeCommunityBanner(this)">` : '';

  heroEl.innerHTML = `
    <div class="community-banner-wrap" id="community-banner-wrap" style="${community.banner_url ? `--banner-img:url('${esc(community.banner_url)}')` : ''}">
      ${bannerPick}
    </div>
    <div class="community-hero">
      <div class="community-hero-top">
        <span class="comm-avatar-wrap">${avatarInner}</span>
        <div class="community-hero-actions">
          <div class="pc-menu-wrap" id="pmenu-community">
            <button type="button" class="pc-menu-btn profile-icon-btn" title="More" aria-label="More options" onclick="togglePostMenu('community', event)">${ICON.menu}</button>
            <div class="pc-menu-dd">${communityMenuItemsHtml()}</div>
          </div>
          <a class="profile-icon-btn" href="search.html?community=${encodeURIComponent(community.slug)}" title="Search posts in this community" aria-label="Search posts in this community">${NAV_ICON.search}</a>
          ${actionBtn}
        </div>
      </div>
      <div class="community-hero-body">
        <div class="community-hero-name">${esc(community.name)}</div>
        ${community.description ? `<div class="community-hero-desc">${esc(community.description)}</div>` : ''}
        <div class="community-hero-meta">
          <span><b>${fmtCount(community.member_count)}</b> Member${community.member_count === 1 ? '' : 's'}</span>
          <span><b>${fmtCount(community.post_count)}</b> Post${community.post_count === 1 ? '' : 's'}</span>
        </div>
      </div>
    </div>`;
}

// Only the creator ever sees either picker (see isCreator above), but
// the upload itself is still checked server-side too: `avatars`
// storage only allows writing inside your own <uid> folder, and the
// "creator can update own community" RLS policy only allows this
// UPDATE if auth.uid() = created_by (see
// supabase/community_creator_and_post_limit.sql).
async function changeCommunityAvatar(input) {
  const file = input.files[0];
  input.value = '';
  if (!file || !community || !currentSession) return;
  if (!requireLogin()) return;
  if (community.created_by !== currentSession.user.id) return;
  const errEl = document.getElementById('cf-err'); // reuse the composer's error slot if present
  if (!validateFile(file, errEl)) return;
  openCropModal(file, 'square', async (cropped) => {
    try {
      const avatar_url = await uploadAvatar(cropped, currentSession.user.id);
      const { error } = await sb.from('communities').update({ avatar_url }).eq('id', community.id);
      if (error) throw error;
      community.avatar_url = avatar_url;
      renderHero();
    } catch (e) {
      alert(e.message || 'Could not update the community picture.');
    }
  });
}

async function changeCommunityBanner(input) {
  const file = input.files[0];
  input.value = '';
  if (!file || !community || !currentSession) return;
  if (!requireLogin()) return;
  if (community.created_by !== currentSession.user.id) return;
  const errEl = document.getElementById('cf-err');
  if (!validateFile(file, errEl)) return;
  openCropModal(file, 'wide', async (cropped) => {
    try {
      const banner_url = await uploadAvatar(cropped, currentSession.user.id);
      const { error } = await sb.from('communities').update({ banner_url }).eq('id', community.id);
      if (error) throw error;
      community.banner_url = banner_url;
      renderHero();
    } catch (e) {
      alert(e.message || 'Could not update the community banner.');
    }
  });
}

async function heroToggleJoin() {
  if (!requireLogin()) return;
  const btn = document.getElementById('hero-join-btn');
  btn.disabled = true;
  try {
    const { error } = isMember ? await leaveCommunity(community.id) : await joinCommunity(community.id);
    if (error) throw error;
    isMember = !isMember;
    community.member_count = Math.max(0, community.member_count + (isMember ? 1 : -1));
    renderHero();
    refreshPostGates();
    updateComposerVisibility();
    wireComposer();
  } catch (e) {
    alert(e.message || 'Failed to update membership.');
    btn.disabled = false;
  }
}

// Called whenever the sidebar "My communities" box (common.js) or any
// other join/leave control changes membership for this community, so
// the hero button and post gate never go stale.
function onCommunityMembershipChanged(communityId, joined) {
  if (!community || communityId !== community.id) return;
  isMember = joined;
  community.member_count = Math.max(0, community.member_count + (joined ? 1 : -1));
  renderHero();
  updateComposerVisibility();
  wireComposer();
}

function switchCommunityTab(tab) {
  if (tab === communityTab) return;
  communityTab = tab;
  ['top', 'latest', 'media', 'about'].forEach(t =>
    document.getElementById(`tab-${t}`).classList.toggle('active', t === tab));
  window.scrollTo({ top: 0, behavior: 'smooth' });

  const feedEl = document.getElementById('feed-posts');
  const aboutEl = document.getElementById('community-about');
  const pfWrap = document.getElementById('pf-wrap');
  if (tab === 'about') {
    feedEl.style.display = 'none';
    pfWrap.style.display = 'none';
    aboutEl.style.display = '';
    loadCommunityAbout();
  } else {
    feedEl.style.display = '';
    pfWrap.style.display = '';
    aboutEl.style.display = 'none';
    loadCommunityFeed();
  }
}

async function loadCommunityFeed() {
  const feedEl = document.getElementById('feed-posts');
  feedEl.innerHTML = skeletonFeedHtml();
  await ensureFeedPrereqsLoaded();

  let query = sb.from('posts').select(POST_SELECT).eq('is_deleted', false).eq('community_id', community.id);
  if (communityTab === 'top') {
    query = query.order('like_count', { ascending: false }).order('created_at', { ascending: false }).limit(100);
  } else if (communityTab === 'media') {
    query = query.not('media_url', 'is', null).order('created_at', { ascending: false }).limit(100);
  } else {
    query = query.order('created_at', { ascending: false }).limit(100);
  }

  const { data, error } = await query;
  if (error) { feedEl.innerHTML = `<div class="errmsg">Failed to load posts: ${esc(error.message)}</div>`; return; }
  if (!data.length) {
    const emptyMsg = communityTab === 'top' ? 'Nothing trending here yet.'
      : communityTab === 'media' ? 'No photos or videos posted here yet.'
      : `No posts yet. Be the first to post in ${esc(community.name)}.`;
    feedEl.innerHTML = `<div id="feed-empty">${emptyMsg}</div>`;
    return;
  }
  await attachQuotedPosts(data);
  feedEl.innerHTML = data.map(p => postCardHtml(p)).join('');
}

// ── ABOUT TAB — Community Info, visibility notes, Rules, Moderators.
// Mirrors an X Community's About panel. Loaded once per page visit
// (communityAboutLoaded) since rules/moderators rarely change while
// someone's browsing; add/remove actions below patch the cached
// arrays in place and re-render rather than refetching.
async function loadCommunityAbout() {
  const aboutEl = document.getElementById('community-about');
  if (communityAboutLoaded) { renderCommunityAbout(); return; }
  aboutEl.innerHTML = `<span class="spinner">Loading&hellip;</span>`;

  const [rulesRes, modsRes, creatorRes] = await Promise.all([
    sb.from('community_rules').select('*').eq('community_id', community.id).order('position', { ascending: true }),
    sb.from('community_moderators').select('user_id, profile:profiles!community_moderators_user_id_fkey(id,username,display_name,avatar_url,verified,verification_type)').eq('community_id', community.id).order('added_at', { ascending: true }),
    sb.from('profiles').select('id,username,display_name,avatar_url,verified,verification_type').eq('id', community.created_by).maybeSingle()
  ]);

  if (rulesRes.error) { aboutEl.innerHTML = `<div class="errmsg">Failed to load About: ${esc(rulesRes.error.message)}</div>`; return; }
  communityRules = rulesRes.data || [];
  communityMods = (modsRes.data || []).filter(m => m.profile);
  community.creatorProfile = creatorRes.data || null;
  communityAboutLoaded = true;
  renderCommunityAbout();
}

function isCommunityCreator() {
  return !!(currentSession && community && community.created_by === currentSession.user.id);
}

function renderCommunityAbout() {
  const aboutEl = document.getElementById('community-about');
  const isCreator = isCommunityCreator();
  const created = new Date(community.created_at);
  const createdStr = created.toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' });
  const creator = community.creatorProfile;

  const infoSection = `
    <div class="comm-about-section">
      <div class="comm-about-section-hdr">
        <h3>Community Info</h3>
        ${isCreator ? `<button type="button" class="comm-about-add" onclick="openEditCommunityForm()">Edit</button>` : ''}
      </div>
      <div id="comm-edit-form"></div>
      <p class="comm-about-desc" id="comm-about-desc-text">${community.description ? esc(community.description) : 'This community hasn\'t added a description yet.'}</p>
      <div class="comm-about-fact">
        ${PEOPLE_ICON}
        <span>Only members can post.</span>
      </div>
      <div class="comm-about-fact">
        ${GLOBE_ICON}
        <div>
          <strong>All Communities are publicly visible.</strong>
          <span class="comm-about-fact-sub">Anyone can join this Community.</span>
        </div>
      </div>
      <div class="comm-about-fact">
        ${CAL_ICON}
        <span>Created ${createdStr}${creator ? ` by <a href="${profileUrl(creator.username)}">@${esc(creator.username)}</a>` : ''}</span>
      </div>
    </div>`;

  // Creator-only — mirrors the Rules/Moderators sections above, just
  // for the community row itself (name + description) and, below it,
  // a separate destructive section for deleting the whole community.
  // Both are gated the same way as everything else in isCreator: RLS
  // (community_delete.sql / "creator can update own community") is
  // the real enforcement, this is just so non-creators never see the
  // controls in the first place.
  const dangerSection = isCreator ? `
    <div class="comm-about-section comm-danger-section">
      <h3>Danger Zone</h3>
      <p class="comm-about-fact-sub">Deleting this community permanently removes it — and every post in it — for everyone. This can't be undone.</p>
      <button type="button" class="dc-btn dc-btn-delete" style="width:auto;padding:9px 18px;" onclick="deleteCommunityPrompt()">Delete community</button>
    </div>` : '';

  const rulesSection = `
    <div class="comm-about-section">
      <div class="comm-about-section-hdr">
        <h3>Rules</h3>
        ${isCreator ? `<button type="button" class="comm-about-add" onclick="openAddRuleForm()">+ Add rule</button>` : ''}
      </div>
      <div id="comm-add-rule-form"></div>
      ${communityRules.length
        ? `<ol class="comm-rules-list">${communityRules.map(r => ruleRowHtml(r, isCreator)).join('')}</ol>`
        : `<p class="comm-about-empty">This community hasn't posted any rules yet.</p>`}
    </div>`;

  const modsSection = `
    <div class="comm-about-section">
      <div class="comm-about-section-hdr">
        <h3>Moderators</h3>
        ${isCreator ? `<button type="button" class="comm-about-add" onclick="openAddModForm()">+ Add moderator</button>` : ''}
      </div>
      <div id="comm-add-mod-form"></div>
      <div class="comm-mods-list">
        ${creator ? modRowHtml(creator, true, isCreator) : ''}
        ${communityMods.map(m => modRowHtml(m.profile, false, isCreator)).join('')}
      </div>
    </div>`;

  aboutEl.innerHTML = infoSection + rulesSection + modsSection + dangerSection;
}

// ── EDIT COMMUNITY (creator only) — name + description, same
// toggle-open inline-form pattern as openAddRuleForm() below. Picture
// and banner already have their own pickers on the hero (see
// changeCommunityAvatar/changeCommunityBanner above); this just adds
// the two text fields that were missing an editing UI. Slug is
// intentionally not editable here — the community's URL stays stable
// even if its display name changes, same as usernames vs display
// names elsewhere in the app. ──
function openEditCommunityForm() {
  if (!isCommunityCreator()) return;
  const holder = document.getElementById('comm-edit-form');
  if (!holder) return;
  if (holder.innerHTML) { holder.innerHTML = ''; return; } // toggle closed if already open
  holder.innerHTML = `
    <div class="comm-inline-form">
      <div class="errmsg" id="cef-err" style="display:none;"></div>
      <input type="text" id="cef-name" maxlength="50" placeholder="Community name" value="${esc(community.name)}">
      <textarea id="cef-desc" rows="3" maxlength="300" placeholder="Description (optional)">${esc(community.description || '')}</textarea>
      <div class="comm-inline-form-actions">
        <button type="button" class="modal-btn" style="margin:0;width:auto;padding:7px 16px;" onclick="submitEditCommunity()">Save</button>
      </div>
    </div>`;
  document.getElementById('cef-name')?.focus();
}

async function submitEditCommunity() {
  if (!isCommunityCreator()) return;
  const nameEl = document.getElementById('cef-name');
  const descEl = document.getElementById('cef-desc');
  const errEl = document.getElementById('cef-err');
  if (!nameEl) return;
  clearErr(errEl);
  const name = nameEl.value.trim();
  const description = descEl.value.trim();
  if (name.length < 3 || name.length > 50) { showErr(errEl, 'Name must be between 3 and 50 characters.'); return; }
  try {
    const { error } = await sb.from('communities').update({ name, description: description || null }).eq('id', community.id);
    if (error) throw error;
    community.name = name;
    community.description = description || null;
    document.getElementById('comm-edit-form').innerHTML = '';
    document.title = `${community.name} — InteractInk`;
    setPageH1(community.name);
    renderHero();
    renderCommunityAbout();
    toast('Community updated.');
  } catch (e) {
    showErr(errEl, e.message || 'Failed to update community.');
  }
}

// ── DELETE COMMUNITY (creator only) — own confirm modal, same shape
// as dcModalEl()/deletePost() in common.js (clear warning, filled red
// destructive action on top, plain Cancel underneath) but kept local
// to this page and its own element ids so it doesn't collide with the
// post-delete modal's pendingDeletePostId state. Actual permission is
// enforced server-side by the "creator can delete own community" RLS
// policy (supabase/community_delete.sql) — this is just the UI. ──
function ccdModalEl() {
  let el = document.getElementById('ccd-modal-bg');
  if (el) return el;
  el = document.createElement('div');
  el.id = 'ccd-modal-bg';
  el.className = 'modal-bg';
  el.addEventListener('click', e => { if (e.target === el) closeDeleteCommunityConfirm(); });
  el.innerHTML = `
    <div class="modal dc-modal">
      <h2 class="dc-title">Delete community?</h2>
      <p class="dc-desc" id="ccd-desc">This can't be undone. It will be permanently removed, along with every post in it, for everyone.</p>
      <div class="dc-actions">
        <button type="button" class="dc-btn dc-btn-delete" id="ccd-confirm-btn" onclick="confirmDeleteCommunity()">Delete community</button>
        <button type="button" class="dc-btn dc-btn-cancel" onclick="closeDeleteCommunityConfirm()">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && el.classList.contains('open')) closeDeleteCommunityConfirm();
  });
  return el;
}

function deleteCommunityPrompt() {
  if (!isCommunityCreator()) return;
  const el = ccdModalEl();
  const descEl = document.getElementById('ccd-desc');
  if (descEl) descEl.textContent = `This can't be undone. "${community.name}" and every post in it will be permanently removed for everyone.`;
  if (el.classList.contains('open')) return;
  el.classList.add('open');
  lockScroll();
}

function closeDeleteCommunityConfirm() {
  const el = document.getElementById('ccd-modal-bg');
  if (el?.classList.contains('open')) { el.classList.remove('open'); unlockScroll(); }
}

async function confirmDeleteCommunity() {
  if (!isCommunityCreator()) return;
  const btn = document.getElementById('ccd-confirm-btn');
  if (btn) { btn.disabled = true; btn.textContent = 'Deleting…'; }
  try {
    const { error } = await sb.from('communities').delete().eq('id', community.id);
    if (error) throw error;
    closeDeleteCommunityConfirm();
    location.href = 'communities.html';
  } catch (e) {
    alert(e.message || 'Failed to delete community.');
    if (btn) { btn.disabled = false; btn.textContent = 'Delete community'; }
  }
}

const PEOPLE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="8" cy="8" r="3"/><path d="M2 20c0-3.3 2.7-6 6-6s6 2.7 6 6"/><circle cx="17" cy="9" r="2.6"/><path d="M14.5 20c.3-2.6 2.1-4.6 4.5-4.6 2.6 0 4.7 2.2 5 5"/></svg>`;
const GLOBE_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`;
const CAL_ICON = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="16" rx="2"/><path d="M3 10h18M8 3v4M16 3v4"/></svg>`;

function ruleRowHtml(r, isCreator) {
  return `
    <li class="comm-rule-row" data-rule-id="${r.id}">
      <span class="comm-rule-num"></span>
      <div class="comm-rule-body">
        <div class="comm-rule-title">${esc(r.title)}</div>
        ${r.description ? `<div class="comm-rule-desc">${esc(r.description)}</div>` : ''}
      </div>
      ${isCreator ? `<button type="button" class="comm-row-remove" title="Remove rule" onclick="removeCommunityRule('${r.id}')">&#10005;</button>` : ''}
    </li>`;
}

function modRowHtml(profile, isOwner, canManage) {
  const uname = profile.username || 'unknown';
  const isSelf = currentSession && profile.id === currentSession.user.id;
  return `
    <div class="who-row comm-mod-row">
      <a href="${profileUrl(uname)}">
        <img class="avatar pfp-md${avSqClass(profile)}" src="${esc(avatarUrl(profile.avatar_url))}" alt="" loading="lazy" decoding="async">
      </a>
      <a class="who-row-txt" href="${profileUrl(uname)}">
        <span class="who-row-name">${esc(profile.display_name || uname)}${vBadge(profile)}</span>
        <span class="who-row-handle">@${esc(uname)} &middot; ${isOwner ? 'Creator' : 'Moderator'}</span>
      </a>
      ${isOwner
        ? ''
        : (canManage
          ? `<button type="button" class="comm-row-remove" title="Remove moderator" onclick="removeCommunityModerator('${profile.id}')">&#10005;</button>`
          : (isSelf ? '' : `<button class="who-follow-btn" onclick="whoToggleFollow('${profile.id}', this)">${t('action.follow')}</button>`))}
    </div>`;
}

// ── ADD RULE (creator only) ──
function openAddRuleForm() {
  const holder = document.getElementById('comm-add-rule-form');
  if (!holder) return;
  if (holder.innerHTML) { holder.innerHTML = ''; return; } // toggle closed if already open
  holder.innerHTML = `
    <div class="comm-inline-form">
      <div class="errmsg" id="car-err" style="display:none;"></div>
      <input type="text" id="car-title" maxlength="100" placeholder="Rule title, e.g. Stay on topic">
      <textarea id="car-desc" rows="2" maxlength="300" placeholder="Description (optional)"></textarea>
      <div class="comm-inline-form-actions">
        <button type="button" class="modal-btn" style="margin:0;width:auto;padding:7px 16px;" onclick="submitAddRule()">Add rule</button>
      </div>
    </div>`;
  document.getElementById('car-title')?.focus();
}

async function submitAddRule() {
  const titleEl = document.getElementById('car-title');
  const descEl = document.getElementById('car-desc');
  const errEl = document.getElementById('car-err');
  if (!titleEl) return;
  clearErr(errEl);
  const title = titleEl.value.trim();
  const description = descEl.value.trim();
  if (!title) { showErr(errEl, 'Give the rule a short title.'); return; }
  if (communityRules.length >= 20) { showErr(errEl, 'This community already has the maximum number of rules.'); return; }
  try {
    const { data, error } = await sb.from('community_rules').insert({
      community_id: community.id, position: communityRules.length, title, description: description || null
    }).select('*').single();
    if (error) throw error;
    communityRules.push(data);
    document.getElementById('comm-add-rule-form').innerHTML = '';
    renderCommunityAbout();
  } catch (e) {
    showErr(errEl, e.message || 'Failed to add rule.');
  }
}

async function removeCommunityRule(ruleId) {
  if (!isCommunityCreator()) return;
  try {
    const { error } = await sb.from('community_rules').delete().eq('id', ruleId);
    if (error) throw error;
    communityRules = communityRules.filter(r => r.id !== ruleId);
    renderCommunityAbout();
  } catch (e) {
    alert(e.message || 'Failed to remove rule.');
  }
}

// ── ADD MODERATOR (creator only) — small username search scoped to
// this modal-less inline form, same debounce idea as communities.js's
// search box. ──
let _modSearchDebounce = null;
function openAddModForm() {
  const holder = document.getElementById('comm-add-mod-form');
  if (!holder) return;
  if (holder.innerHTML) { holder.innerHTML = ''; return; }
  holder.innerHTML = `
    <div class="comm-inline-form">
      <div class="errmsg" id="cam-err" style="display:none;"></div>
      <input type="text" id="cam-search" placeholder="Search by username" autocomplete="off">
      <div id="cam-results"></div>
    </div>`;
  const input = document.getElementById('cam-search');
  input.focus();
  input.addEventListener('input', () => {
    clearTimeout(_modSearchDebounce);
    _modSearchDebounce = setTimeout(() => runModSearch(input.value), 250);
  });
}

async function runModSearch(q) {
  const resultsEl = document.getElementById('cam-results');
  if (!resultsEl) return;
  q = q.trim();
  if (!q) { resultsEl.innerHTML = ''; return; }
  const takenIds = new Set([community.created_by, ...communityMods.map(m => m.user_id)]);
  const { data, error } = await sb.from('profiles').select('id,username,display_name,avatar_url,verified,verification_type')
    .ilike('username', `%${q}%`).limit(6);
  if (error || !data) { resultsEl.innerHTML = ''; return; }
  const candidates = data.filter(p => !takenIds.has(p.id));
  if (!candidates.length) { resultsEl.innerHTML = `<div class="comm-about-empty">No matching members found.</div>`; return; }
  resultsEl.innerHTML = candidates.map(p => `
    <div class="who-row comm-mod-search-row">
      <img class="avatar pfp-md${avSqClass(p)}" src="${esc(avatarUrl(p.avatar_url))}" alt="">
      <span class="who-row-txt">
        <span class="who-row-name">${esc(p.display_name || p.username)}${vBadge(p)}</span>
        <span class="who-row-handle">@${esc(p.username)}</span>
      </span>
      <button type="button" class="who-follow-btn" onclick="addCommunityModerator('${p.id}', this)">Add</button>
    </div>`).join('');
}

async function addCommunityModerator(userId, btn) {
  if (!isCommunityCreator()) return;
  if (btn) btn.disabled = true;
  try {
    const { data, error } = await sb.from('community_moderators').insert({
      community_id: community.id, user_id: userId, added_by: currentSession.user.id
    }).select('user_id, profile:profiles!community_moderators_user_id_fkey(id,username,display_name,avatar_url,verified,verification_type)').single();
    if (error) throw error;
    communityMods.push(data);
    document.getElementById('comm-add-mod-form').innerHTML = '';
    renderCommunityAbout();
  } catch (e) {
    alert(e.message || 'Failed to add moderator.');
    if (btn) btn.disabled = false;
  }
}

async function removeCommunityModerator(userId) {
  if (!isCommunityCreator()) return;
  try {
    const { error } = await sb.from('community_moderators').delete()
      .eq('community_id', community.id).eq('user_id', userId);
    if (error) throw error;
    communityMods = communityMods.filter(m => m.user_id !== userId);
    renderCommunityAbout();
  } catch (e) {
    alert(e.message || 'Failed to remove moderator.');
  }
}

// ── COMPOSER — same shape as board.js's submitPost(), minus poll/
// schedule (kept out to keep a community post the simple case), plus
// community_id set so it lands only in this community's feed. ──
async function submitCommunityPost() {
  if (!requireLogin()) return;
  if (!isMember) { alert('Join this community to post in it.'); return; }
  const bodyEl = document.getElementById('cf-body');
  const fileEl = document.getElementById('cf-file');
  const btn    = document.getElementById('cf-btn');
  const stEl   = document.getElementById('cf-st');
  const errEl  = document.getElementById('cf-err');
  clearErr(errEl);

  const body = bodyEl.value.trim();
  if (!body) { showErr(errEl, "Comment can't be empty."); return; }
  if (body.length > 500) { showErr(errEl, 'Comment too long (max 500 chars).'); return; }
  if (!enforceCooldown(errEl)) return;
  if (!(await verifyHuman('cf-captcha', errEl))) return;

  btn.disabled = true;
  stEl.textContent = 'Posting…';
  try {
    let media_url = null, media_type = null;
    const gifUrl = composeExtras.cf?.gifUrl;
    const file = fileEl.files[0];
    if (gifUrl) {
      media_url = gifUrl; media_type = 'gif';
    } else if (file) {
      if (!validateFile(file, errEl)) { btn.disabled = false; stEl.textContent = ''; return; }
      stEl.textContent = 'Uploading file…';
      ({ media_url, media_type } = await uploadMedia(file, msg => stEl.textContent = msg));
    }
    const { data, error } = await sb.from('posts').insert({
      author_id: currentSession.user.id,
      body,
      media_url,
      media_type,
      community_id: community.id,
      reply_audience: getReplyAudience('cf')
    }).select(POST_SELECT).single();
    if (error) throw error;
    bodyEl.value = '';
    bodyEl.style.height = '';
    fileEl.value = ''; document.getElementById('cf-fp').innerHTML = '';
    resetComposeExtras('cf');
    stEl.textContent = '';
    community.post_count = (community.post_count || 0) + 1;
    renderHero();
    if (communityTab === 'latest') {
      const feedEl = document.getElementById('feed-posts');
      const empty = document.getElementById('feed-empty');
      if (empty) feedEl.innerHTML = '';
      feedEl.insertAdjacentHTML('afterbegin', postCardHtml(data, true));
    }
    markPosted();
    startCooldownCountdown(btn, 'Post');
  } catch (e) {
    showErr(errEl, e.message || 'Failed to post.');
    stEl.textContent = '';
  } finally {
    updateCommunityPostBtnState();
  }
}

function updateCommunityPostBtnState() {
  const bodyEl = document.getElementById('cf-body');
  const btn = document.getElementById('cf-btn');
  if (!bodyEl || !btn) return;
  if (postCooldownRemainingMs() > 0) return; // cooldown countdown owns disabled/label right now
  btn.disabled = bodyEl.value.trim().length === 0;
}

function renderComposerAvatar() {
  const el = document.getElementById('cf-avatar');
  if (!el) return;
  const url = currentSession ? avatarUrl(currentProfile?.avatar_url) : DEFAULT_AVATAR;
  el.innerHTML = `<img src="${esc(url)}" alt="">`;
}

let composerWired = false;
function wireComposer() {
  if (composerWired) return;
  composerWired = true;
  injectReplyAudienceUi('cf');
  wireFilePreview('cf-file', 'cf-fp', 'cf-err');
  const cfBody = document.getElementById('cf-body');
  if (cfBody) {
    cfBody.addEventListener('input', () => {
      updateCommunityPostBtnState();
      cfBody.style.height = 'auto';
      cfBody.style.height = Math.max(56, cfBody.scrollHeight) + 'px';
    });
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await authReady; // see auth.js — otherwise the hero/composer can render before we know who's logged in
  loadCommunity();
});
