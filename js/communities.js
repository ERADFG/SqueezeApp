// ─────────────────────────────────────────────────────────────
// COMMUNITIES BROWSE PAGE — /communities
// "All" lists every community (newest first); "Joined" lists just
// the current user's own. Join/leave happens inline via the shared
// joinCommunity()/leaveCommunity() helpers in common.js.
// ─────────────────────────────────────────────────────────────
let communitiesTab = 'all'; // 'all' | 'mine'
let joinedIds = new Set();  // populated once, used to render the right Join/Joined pill on the "All" list too
let communitySearch = '';   // current text in #comm-search, applied to both tabs
const COMMUNITIES_PAGE_SIZE = 10;
let communitiesPage = { all: 1, mine: 1 }; // each tab tracks its own page independently

async function loadJoinedIds() {
  if (!currentSession) { joinedIds = new Set(); return; }
  const { data } = await sb.from('community_members').select('community_id').eq('user_id', currentSession.user.id);
  joinedIds = new Set((data || []).map(r => r.community_id));
}

function switchCommunitiesTab(tab) {
  if (tab === communitiesTab) return;
  communitiesTab = tab;
  communitiesPage[tab] = 1; // switching to a tab always starts it back at page 1
  document.getElementById('ctab-all').classList.toggle('active', tab === 'all');
  document.getElementById('ctab-mine').classList.toggle('active', tab === 'mine');
  renderList();
}

function gotoCommunitiesPage(n) {
  communitiesPage[communitiesTab] = n;
  renderList();
  document.getElementById('communities-list')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

async function renderList() {
  const listEl = document.getElementById('communities-list');
  listEl.innerHTML = skeletonFeedHtml();

  if (communitiesTab === 'mine' && !currentSession) {
    listEl.innerHTML = `<div class="post-login-gate" style="border-top:none;">You need an account to post. <a href="signup.html">Create an account</a> — it takes a minute.</div>`;
    return;
  }

  const q = communitySearch.trim();
  const page = communitiesPage[communitiesTab];

  let list, totalCount;
  if (communitiesTab === 'mine') {
    // "Joined" is always a short, already-loaded-ish list — filtering
    // client-side after the fetch avoids a second round-trip shape
    // (embedded select can't ilike the nested community row directly),
    // and paginating client-side after that keeps this in line with
    // the "All" tab's 10-per-page without a second query shape to
    // maintain just for this tab.
    const { data, error } = await sb.from('community_members')
      .select('community:communities(*)')
      .eq('user_id', currentSession.user.id)
      .order('joined_at', { ascending: false });
    if (error) { listEl.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
    let all = (data || []).map(r => r.community).filter(Boolean);
    if (q) {
      const needle = q.toLowerCase();
      all = all.filter(c => c.name.toLowerCase().includes(needle) || (c.description || '').toLowerCase().includes(needle));
    }
    totalCount = all.length;
    list = all.slice((page - 1) * COMMUNITIES_PAGE_SIZE, page * COMMUNITIES_PAGE_SIZE);
  } else {
    let query = sb.from('communities').select('*', { count: 'exact' });
    if (q) query = query.or(`name.ilike.%${q}%,description.ilike.%${q}%`);
    const { data, error, count } = await query
      .order('member_count', { ascending: false })
      .order('created_at', { ascending: false })
      .range((page - 1) * COMMUNITIES_PAGE_SIZE, page * COMMUNITIES_PAGE_SIZE - 1);
    if (error) { listEl.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
    list = data || [];
    totalCount = count || 0;
  }

  if (!list.length) {
    listEl.innerHTML = q
      ? `<div id="feed-empty">No communities found for &ldquo;${esc(q)}&rdquo;.</div>`
      : communitiesTab === 'mine'
        ? `<div id="feed-empty">You haven't joined any communities yet.</div>`
        : `<div id="feed-empty">No communities yet. Be the first to create one.</div>`;
    return;
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / COMMUNITIES_PAGE_SIZE));
  listEl.innerHTML = `<div class="comm-list">` +
    list.map(c => communityRowHtml(c, communitiesTab === 'mine' || joinedIds.has(c.id))).join('') +
    `</div>` +
    pagerHtml(page, totalPages, 'gotoCommunitiesPage');
}

// Overrides the compact sidebar-box version from common.js with a
// slightly richer row for this full-page browse list — same markup
// shape (so communityToggleJoin()'s .comm-row lookups still work),
// plus the description line, which the sidebar box has no room for.
function communityRowHtml(c, joined) {
  const btn = joined
    ? `<button class="who-follow-btn comm-joined-btn" onclick="event.preventDefault();communityToggleJoin('${c.id}', this, true)">Joined</button>`
    : `<button class="who-follow-btn" onclick="event.preventDefault();communityToggleJoin('${c.id}', this, false)">Join</button>`;
  return `
    <a class="who-row comm-row" href="${communityUrl(c.slug)}">
      <span class="comm-avatar">${communityAvatarInner(c)}</span>
      <span class="who-row-txt">
        <span class="who-row-name">${esc(c.name)}</span>
        ${c.description ? `<span class="comm-desc">${esc(c.description)}</span>` : ''}
        <span class="who-row-handle">${fmtCount(c.member_count)} member${c.member_count === 1 ? '' : 's'}</span>
      </span>
      ${btn}
    </a>`;
}

// Keeps this page's own list (and its Join/Joined pills) in sync
// whenever a join/leave happens anywhere on the page — including via
// the shared sidebar box if it's ever added here too.
function onCommunityMembershipChanged(communityId, joined) {
  if (joined) joinedIds.add(communityId); else joinedIds.delete(communityId);
  if (communitiesTab === 'mine') renderList(); // the row needs to appear/disappear entirely
}

// Debounced so every keystroke doesn't fire its own query — 250ms
// feels instant without hammering Supabase while someone's still typing.
let _searchDebounce = null;
function wireCommunitySearch() {
  const input = document.getElementById('comm-search');
  if (!input) return;
  input.addEventListener('input', () => {
    clearTimeout(_searchDebounce);
    _searchDebounce = setTimeout(() => {
      communitySearch = input.value;
      communitiesPage[communitiesTab] = 1; // new search — start the current tab back at page 1, leave the other tab's page alone
      renderList();
    }, 250);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  if (document.body.dataset.page !== 'communities') return; // see js/notifications.js
  await authReady; // see auth.js — otherwise the join state can render before we know who's logged in
  wireCommunitySearch();
  await loadJoinedIds();
  renderList();
});
