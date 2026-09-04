// ─────────────────────────────────────────────────────────────
// SEARCH PAGE — /search.html?q=<term>[&t=posts|people]
// With no query, shows the Explore panel instead (see EXPLORE below).
// ─────────────────────────────────────────────────────────────

// Recomputed on every visit (see the DOMContentLoaded handler below)
// rather than frozen here at module scope — pjax (js/pjax.js) keeps
// this script loaded for the life of the tab, so a second search
// later (a new ?q=, or arriving via a community's search icon)
// would otherwise silently keep using the very first search's terms
// forever, since this file only ever gets parsed once.
let searchParams = new URLSearchParams(location.search);
let searchQuery = searchParams.get('q') || '';

// ── COMMUNITY-SCOPED SEARCH — search.html?community=<slug>, reached
// from the search icon on a community page's hero (see community.js
// renderHero()). Only scopes the Posts tab (there's no per-community
// "People" to search) — resolved once and cached, same slug→row
// lookup community.js itself does in loadCommunity(). Forces the
// People tab off since a community only has posts to search.
let searchCommunitySlug = searchParams.get('community') || '';
let searchTab = (!searchCommunitySlug && searchParams.get('t') === 'people') ? 'people' : 'posts';
let exploreTab = 'explore'; // 'explore' | 'news' | 'sports' | 'entertainment' | 'gaming' | 'technology' | 'music' | 'science'

let searchCommunity = null; // {id,name,slug} once resolved, or false if it doesn't exist
async function resolveSearchCommunity() {
  if (!searchCommunitySlug || searchCommunity) return searchCommunity;
  const { data } = await sb.from('communities').select('id,name,slug').eq('slug', searchCommunitySlug).maybeSingle();
  searchCommunity = data || false;
  return searchCommunity;
}
// Keeps the community filter attached across a re-search (typing a new
// term) or a tab switch, instead of the plain inline onsubmit in
// search.html silently dropping it.
function submitSearchForm() {
  const q = document.getElementById('sp-input').value.trim();
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (searchCommunitySlug) params.set('community', searchCommunitySlug);
  if (searchTab === 'people') params.set('t', 'people');
  location.href = 'search.html' + (params.toString() ? `?${params.toString()}` : '');
}
function renderSearchScope(root) {
  if (!searchCommunitySlug) { root.innerHTML = ''; return; }
  const name = searchCommunity ? esc(searchCommunity.name) : esc(searchCommunitySlug);
  root.innerHTML = `
    <div class="search-scope">
      Searching posts in <b>${name}</b>
      <a href="search.html${searchQuery ? `?q=${encodeURIComponent(searchQuery)}` : ''}">Search everywhere instead</a>
    </div>`;
}

// Plain-text Explore tabs — no per-tab icon (used to have one apiece,
// including a fire icon on Trending, but the icons just added visual
// noise next to a label that already says what the tab is).
function renderTabs() {
  const el = document.getElementById('search-tabs');
  if (!searchQuery.trim()) {
    el.innerHTML = ['explore', 'news', 'sports', 'entertainment', 'gaming', 'technology', 'music', 'science'].map(t => `
      <button class="xtab${exploreTab === t ? ' active' : ''}" onclick="setExploreTab('${t}')">${t[0].toUpperCase()}${t.slice(1)}</button>`).join('');
    return;
  }
  el.innerHTML = searchCommunitySlug
    ? `<button class="xtab active">Posts</button>`
    : `<button class="xtab${searchTab === 'posts' ? ' active' : ''}" onclick="setSearchTab('posts')">Posts</button>
       <button class="xtab${searchTab === 'people' ? ' active' : ''}" onclick="setSearchTab('people')">People</button>`;
}

function setSearchTab(tab) {
  if (tab === searchTab) return;
  searchTab = tab;
  renderTabs();
  runSearch();
}

function setExploreTab(tab) {
  if (tab === exploreTab) return;
  exploreTab = tab;
  renderTabs();
  runExplore();
}

async function runSearch() {
  document.getElementById('sp-input').value = searchQuery;
  const scopeEl = document.getElementById('search-scope');
  const root = document.getElementById('search-root');

  if (searchCommunitySlug) {
    const comm = await resolveSearchCommunity();
    if (scopeEl) renderSearchScope(scopeEl);
    if (comm === false) { root.innerHTML = `<div id="feed-empty">This community doesn't exist.</div>`; return; }
    document.title = `${searchQuery ? `${searchQuery} — ` : ''}${comm.name} — Search — InteractInk`;
    setPageH1(`Search ${comm.name}`);
    if (!searchQuery.trim()) { root.innerHTML = `<div id="feed-empty">Type something to search posts in ${esc(comm.name)}.</div>`; return; }
    root.innerHTML = skeletonFeedHtml();
    return searchPosts(root);
  }
  if (scopeEl) scopeEl.innerHTML = '';

  if (!searchQuery.trim()) {
    document.title = 'Explore — InteractInk';
    setPageH1('Explore InteractInk');
    return runExplore();
  }
  document.title = `${searchQuery} — Search — InteractInk`;
  setPageH1(`Search: ${searchQuery}`);
  root.innerHTML = skeletonFeedHtml();
  if (searchTab === 'people') return searchPeople(root);
  return searchPosts(root);
}

async function searchPosts(root) {
  await ensureFeedPrereqsLoaded();
  let query = sb.from('posts').select(POST_SELECT).eq('is_deleted', false);
  if (searchCommunitySlug && searchCommunity) query = query.eq('community_id', searchCommunity.id);
  if (searchQuery.trim()) query = query.ilike('body', `%${searchQuery}%`);
  const { data, error } = await query.order('created_at', { ascending: false }).limit(50);

  if (error) { root.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
  if (!data.length) { root.innerHTML = `<div id="feed-empty">No posts found${searchQuery ? ` for &ldquo;${esc(searchQuery)}&rdquo;` : ''}.</div>`; return; }
  await attachQuotedPosts(data);
  root.innerHTML = data.map(p => postCardHtml(p)).join('');
}

async function searchPeople(root) {
  const { data, error } = await sb.from('profiles').select('*')
    .or(`username.ilike.%${searchQuery}%,display_name.ilike.%${searchQuery}%`)
    .order('followers_count', { ascending: false })
    .limit(50);

  if (error) { root.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
  if (!data.length) { root.innerHTML = `<div id="feed-empty">No users found for &ldquo;${esc(searchQuery)}&rdquo;.</div>`; return; }
  root.innerHTML = data.map(profile => `
    <a class="ulrow" style="padding:12px 16px;border-bottom:1px solid var(--line);border-radius:0;" href="${profileUrl(profile.username)}">
      <img class="avatar pfp-md${avSqClass(profile)}" src="${esc(avatarUrl(profile.avatar_url))}" alt="" loading="lazy" decoding="async">
      <div class="ulrow-txt">
        <span class="ulrow-name">${esc(profile.display_name || profile.username)}${vBadge(profile)}</span>
        <span class="ulrow-handle">@${esc(profile.username)}</span>
      </div>
    </a>`).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
  if (document.body.dataset.page !== 'search') return; // see js/notifications.js
  // Recompute everything derived from the URL fresh on every visit —
  // see the comment on searchParams's declaration above.
  searchParams = new URLSearchParams(location.search);
  searchQuery = searchParams.get('q') || '';
  searchCommunitySlug = searchParams.get('community') || '';
  searchTab = (!searchCommunitySlug && searchParams.get('t') === 'people') ? 'people' : 'posts';
  searchCommunity = null;
  exploreJoinedIds = null;
  await authReady; // see auth.js — otherwise cards can render before we know who's logged in
  renderTabs();
  runSearch();
});

// ─────────────────────────────────────────────────────────────
// EXPLORE — shown on search.html with no query, Twitter-Explore-style:
//   • "Today's Posts": the 3 most popular posts of the last 24h,
//     each badged Hot / New / age — see postBadgeHtml() below.
// ─────────────────────────────────────────────────────────────

async function fetchTopPostsToday(limit = 3) {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  const { data } = await sb.from('posts').select(POST_SELECT)
    .eq('is_deleted', false)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(100);

  return (data || [])
    .map(p => ({ ...p, _score: (p.like_count || 0) * 3 + (p.reply_count || 0) * 2 + (p.view_count || 0) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, limit);
}

function explorePostHtml(p) {
  const title = (p.body || '').trim().slice(0, 140) || (p.media_url ? '' : '(no text)');
  const engagement = (p.reply_count || 0) + (p.like_count || 0) + (p.repost_count || 0) + (p.bookmark_count || 0);
  return `
    <a class="expl-post" href="${postUrl(p)}">
      <div class="expl-post-top">
        ${title ? `<div class="expl-post-title">${esc(title)}</div>` : '<span></span>'}
        ${postBadgeHtml(p)}
      </div>
      ${explorePostThumbHtml(p)}
      <div class="expl-post-meta">
        <img class="avatar${avSqClass(p.profile)}" src="${esc(avatarUrl(p.profile?.avatar_url))}" alt="" loading="lazy" decoding="async">
        <span>${esc(p.profile?.display_name || p.profile?.username || 'unknown')}${vBadge(p.profile)}</span>
        <span class="dot"></span>
        <span>${timeAgo(p.created_at)}</span>
        <span class="dot"></span>
        <span>${fmtCount(engagement)} interactions</span>
      </div>
    </a>`;
}

// Compact, non-interactive thumbnail for a post's attached media on
// the Explore page's "Today's Posts" cards. Deliberately NOT
// the full renderMedia()/ttvHtml() treatment used in the feed — that
// wires up its own click-to-play and lightbox handlers, which would
// fight with the fact that the whole card here is already one big
// <a> navigating to the post. A video gets a muted, non-interactive
// <video> (renders its first frame same as a poster image would,
// without needing a separately-stored poster URL) with a small play
// badge so it doesn't look static, an image/gif gets a plain <img>.
function explorePostThumbHtml(p) {
  if (!p.media_url) return '';
  if (p.media_type === 'video') {
    return `<div class="expl-post-thumb expl-post-thumb-video">
      <video src="${esc(p.media_url)}" muted playsinline preload="metadata"></video>
      <span class="expl-post-thumb-play">${ICON_PLAY_MINI}</span>
    </div>`;
  }
  return `<div class="expl-post-thumb"><img src="${esc(p.media_url)}" alt="" loading="lazy" decoding="async"></div>`;
}
const ICON_PLAY_MINI = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72c0 .6.66.96 1.17.65l10.9-6.86a.75.75 0 000-1.28L9.17 4.49A.75.75 0 008 5.14z"/></svg>';

// A post only earns "Hot" from real engagement — views, likes,
// replies, reposts (shares) and bookmarks (saves) it has actually
// gathered — never just from being newest or from being #1 in a
// short "Today's Posts" list (that used to say Hot even for a post
// with zero engagement, just for landing first). Reposts and
// bookmarks count for the most since sharing or saving something is
// a stronger signal that it resonated than a quick like; a view
// counts for the least since it costs the reader nothing. Tune
// VIRAL_THRESHOLD if Hot ends up feeling too common or too rare for
// how much traffic the site actually gets.
const VIRAL_THRESHOLD = 60;
function engagementScore(p) {
  return (p.view_count || 0)
    + (p.like_count || 0) * 8
    + (p.reply_count || 0) * 8
    + (p.repost_count || 0) * 12
    + (p.bookmark_count || 0) * 12;
}
function isViralPost(p) {
  return engagementScore(p) >= VIRAL_THRESHOLD;
}

// Hot when the numbers back it up (see isViralPost above), New for
// anything posted within the last hour that hasn't earned Hot yet,
// and otherwise just how long ago it went up.
function postBadgeHtml(p) {
  if (isViralPost(p)) return `<span class="trend-badge trend-badge-hot">${ICON_FIRE} Hot</span>`;
  const ageMs = Date.now() - new Date(p.created_at).getTime();
  if (ageMs < 3600 * 1000) return `<span class="trend-badge trend-badge-new">${ICON_UP} New</span>`;
  return `<span class="trend-badge trend-badge-time">${timeAgo(p.created_at)}</span>`;
}
const ICON_FIRE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 2c1 3-2 4.5-2 7.5a2 2 0 0 0 4 0c0-1-.5-1.5-.5-1.5 2 1 3.5 3.5 3.5 6a5 5 0 0 1-10 0c0-4 2.5-5.5 5-12Z"/></svg>';
const ICON_UP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="m17 7-10 10"/><path d="M9 7h8v8"/></svg>';

// Local, search-page-only "which communities am I already in" lookup
// — communities.js (and its own `joinedIds`) isn't loaded on this
// page, so this can't reuse that global; a small self-contained
// fetch keeps the Discover Communities section from suggesting
// communities the person has already joined.
let exploreJoinedIds = null; // Set, resolved once per page load
async function getExploreJoinedIds() {
  if (exploreJoinedIds) return exploreJoinedIds;
  if (!currentSession) return (exploreJoinedIds = new Set());
  const { data } = await sb.from('community_members').select('community_id').eq('user_id', currentSession.user.id);
  return (exploreJoinedIds = new Set((data || []).map(r => r.community_id)));
}

async function fetchDiscoverCommunities(limit = 3) {
  const joined = await getExploreJoinedIds();
  const { data } = await sb.from('communities').select('id,name,slug,avatar_url,member_count')
    .order('member_count', { ascending: false })
    .limit(limit + joined.size); // overfetch a bit so filtering out joined ones still leaves enough
  const list = (data || []).filter(c => !joined.has(c.id));
  return list.slice(0, limit);
}

async function renderExploreTab(root) {
  const [topPosts, communities] = await Promise.all([
    fetchTopPostsToday(3), fetchDiscoverCommunities(3)
  ]);

  const postsHtml = topPosts.length
    ? topPosts.map(p => explorePostHtml(p)).join('')
    : `<div class="no-t">Nothing popular yet today.</div>`;

  const commHtml = communities.length
    ? communities.map(c => communityRowHtml(c, false)).join('')
    : '';

  root.innerHTML = `
    <div class="expl-section">
      <div class="expl-hdr">Today's Posts</div>
      ${postsHtml}
    </div>
    ${commHtml ? `
    <div class="expl-section">
      <div class="expl-hdr">Discover Communities</div>
      ${commHtml}
      <a class="expl-showmore" href="communities.html">Browse all communities</a>
    </div>` : ''}`;
}

// News / Sports / Entertainment: best-effort — shows the latest posts
// from any community whose name matches that topic. InteractInk doesn't
// have a built-in post-classification system, so this is approximate
// rather than curated, and just says so plainly when nothing matches.
async function renderCategoryTab(root, category) {
  const { data: comms } = await sb.from('communities').select('id,name').ilike('name', `%${category}%`).limit(10);
  const ids = (comms || []).map(c => c.id);
  if (!ids.length) {
    root.innerHTML = `<div id="feed-empty">No ${esc(category)} communities yet — <a href="communities.html">start one</a>?</div>`;
    return;
  }
  await ensureFeedPrereqsLoaded();
  const { data, error } = await sb.from('posts').select(POST_SELECT)
    .eq('is_deleted', false)
    .in('community_id', ids)
    .order('created_at', { ascending: false })
    .limit(30);

  if (error) { root.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
  if (!data.length) { root.innerHTML = `<div id="feed-empty">No ${esc(category)} posts yet.</div>`; return; }
  await attachQuotedPosts(data);
  root.innerHTML = data.map(p => postCardHtml(p)).join('');
}

async function runExplore() {
  const root = document.getElementById('search-root');
  root.innerHTML = skeletonFeedHtml(3);
  if (exploreTab === 'explore') return renderExploreTab(root);
  return renderCategoryTab(root, exploreTab);
}
