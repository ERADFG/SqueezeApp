// ─────────────────────────────────────────────────────────────
// SEARCH PAGE — /search.html?q=<term>[&t=posts|people]
// With no query, shows the Explore panel instead (see EXPLORE below).
// ─────────────────────────────────────────────────────────────
const POST_SELECT = '*, profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified,verification_type)';

const searchParams = new URLSearchParams(location.search);
let searchQuery = searchParams.get('q') || '';

// ── COMMUNITY-SCOPED SEARCH — search.html?community=<slug>, reached
// from the search icon on a community page's hero (see community.js
// renderHero()). Only scopes the Posts tab (there's no per-community
// "People" to search) — resolved once and cached, same slug→row
// lookup community.js itself does in loadCommunity(). Forces the
// People tab off since a community only has posts to search.
const searchCommunitySlug = searchParams.get('community') || '';
let searchTab = (!searchCommunitySlug && searchParams.get('t') === 'people') ? 'people' : 'posts';
let exploreTab = 'explore'; // 'explore' | 'trending' | 'news' | 'sports' | 'entertainment'

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

function renderTabs() {
  const el = document.getElementById('search-tabs');
  if (!searchQuery.trim()) {
    el.innerHTML = ['explore', 'trending', 'news', 'sports', 'entertainment'].map(t => `
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
  await authReady; // see auth.js — otherwise cards can render before we know who's logged in
  renderTabs();
  runSearch();
});

// ─────────────────────────────────────────────────────────────
// EXPLORE — shown on search.html with no query, Twitter-Explore-style:
//   • "Today's Posts": the 3 most popular posts of the last 24h
//   • "Trending": words that show up across a lot of different posts
//     right now, each with how many posts mention it — same idea as
//     Twitter's trending topics, just derived straight from post text
//     instead of a curated feed.
// ─────────────────────────────────────────────────────────────

// Small, boring words that would otherwise dominate every trending
// list (function words, not topics). Not exhaustive — just enough to
// keep "the/and/that" from beating out things people are actually
// talking about.
const TREND_STOPWORDS = new Set([
  'the','and','for','are','but','not','you','your','with','this','that','have','has','had',
  'was','were','been','being','from','they','them','their','what','when','where','which','who',
  'whom','why','how','all','any','both','each','few','more','most','other','some','such','only',
  'own','same','than','too','very','just','can','will','would','could','should','about','into',
  'over','after','before','again','once','here','there','because','while','during','above','below',
  'out','off','then','once','also','get','got','let','its','it\'s','im','i\'m','dont','don\'t',
  'youre','you\'re','thats','that\'s','ive','i\'ve','theyre','they\'re','were\'re','one','two',
  'like','yeah','yes','no','okay','lol','lmao','omg','still','even','back','well','really','much',
  'many','make','made','know','think','going','gonna','want','need','say','said','see','look',
  'come','came','way','new','now','today','right','good','bad','thing','things','someone',
  'something','anything','everyone','everything','people','http','https','www','com','html',
  'was','are','has','are','did','does','doing','done','been','being','who\'s','whats','what\'s',
  'him','her','she','he\'s','she\'s','his','hers','our','ours','ourselves','myself','yourself',
]);

// True per-post tokenization: lowercase, strip punctuation, unique
// per post so a word repeated 10x in one post still only counts once
// toward "how many posts mention this" — that's the number we show.
function tokenizePostBody(body) {
  const words = (body || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || [];
  return new Set(words.filter(w => !TREND_STOPWORDS.has(w) && !/^\d+$/.test(w)));
}

async function fetchTrendingWords(limit = 8) {
  const since = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  const { data } = await sb.from('posts').select('body')
    .eq('is_deleted', false)
    .gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(300);

  const counts = new Map();
  for (const p of (data || [])) {
    for (const w of tokenizePostBody(p.body)) {
      counts.set(w, (counts.get(w) || 0) + 1);
    }
  }

  let ranked = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  // Only call something "trending" if more than one person is
  // actually posting about it — falls back to whatever exists so the
  // page isn't empty on a quiet site.
  const multi = ranked.filter(([, c]) => c >= 2);
  return (multi.length ? multi : ranked).slice(0, limit);
}

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
  const title = (p.body || '').trim().slice(0, 140) || '(no text)';
  const engagement = (p.reply_count || 0) + (p.like_count || 0);
  return `
    <a class="expl-post" href="${postUrl(p)}">
      <div class="expl-post-title">${esc(title)}</div>
      <div class="expl-post-meta">
        <img class="avatar${avSqClass(p.profile)}" src="${esc(avatarUrl(p.profile?.avatar_url))}" alt="" loading="lazy" decoding="async">
        <span>${esc(p.profile?.display_name || p.profile?.username || 'unknown')}${vBadge(p.profile)}</span>
        <span class="dot"></span>
        <span>${timeAgo(p.created_at)}</span>
        <span class="dot"></span>
        <span>${fmtCount(engagement)} posts</span>
      </div>
    </a>`;
}

function trendRowHtml([word, count], label = 'Trending') {
  return `
    <a class="trend-row" href="search.html?q=${encodeURIComponent(word)}">
      <div class="trend-row-txt">
        <span class="trend-cat">${esc(label)}</span>
        <span class="trend-word">${esc(word)}</span>
      </div>
      <span class="trend-count">${fmtCount(count)} posts</span>
    </a>`;
}

async function renderExploreTab(root) {
  const [topPosts, trending] = await Promise.all([fetchTopPostsToday(3), fetchTrendingWords(6)]);

  const postsHtml = topPosts.length
    ? topPosts.map(explorePostHtml).join('')
    : `<div class="no-t">Nothing popular yet today.</div>`;

  const trendHtml = trending.length
    ? trending.map(t => trendRowHtml(t)).join('')
    : `<div class="no-t">Nothing trending yet.</div>`;

  root.innerHTML = `
    <div class="expl-section">
      <div class="expl-hdr">Today's Posts</div>
      ${postsHtml}
    </div>
    <div class="expl-section">
      <div class="expl-hdr">Trending</div>
      ${trendHtml}
      <a class="expl-showmore" href="#" onclick="setExploreTab('trending');return false;">Show more</a>
    </div>`;
}

async function renderTrendingTab(root) {
  const trending = await fetchTrendingWords(20);
  root.innerHTML = trending.length
    ? trending.map(t => trendRowHtml(t)).join('')
    : `<div class="no-t">Nothing trending yet.</div>`;
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
  if (exploreTab === 'trending') return renderTrendingTab(root);
  return renderCategoryTab(root, exploreTab);
}
