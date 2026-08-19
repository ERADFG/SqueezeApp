// ─────────────────────────────────────────────────────────────
// BOARD PAGE — /index.html
// ─────────────────────────────────────────────────────────────
const POST_SELECT = '*, profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified,verification_type)';
const FEED_PAGE_SIZE = 20; // per-request page size — NOT a total-feed cap; paging can continue indefinitely

let activeTab = 'foryou'; // 'foryou' | 'following'
let pendingPosts = [];    // realtime posts held back until "Show N posts" is clicked

// ── Infinite-scroll paging state for the currently active tab ──
let followingIds = null;       // Set of author ids the viewer follows — populated on Following tab load, also used by subscribeRealtime()
let feedCursor = null;         // For You: id of the last post rendered (server re-derives its score from this)
let feedRecentAuthors = [null, null]; // For You: last two authors rendered [mostRecent, secondMostRecent] — carries the "no 2-in-a-row" rule across a page boundary
let followingCursor = null;    // Following: sort-time (created_at) of the last item rendered
let feedExhausted = false;     // true once a page comes back short — no more to load
let feedLoadingMore = false;
let feedObserver = null;

async function loadFeed() {
  const feedEl = document.getElementById('feed-posts');
  feedEl.innerHTML = skeletonFeedHtml();
  pendingPosts = [];
  hidePendingPill();
  feedCursor = null;
  feedRecentAuthors = [null, null];
  followingCursor = null;
  followingIds = null;
  feedExhausted = false;
  if (feedObserver) { feedObserver.disconnect(); feedObserver = null; }
  await ensureFeedPrereqsLoaded();

  if (activeTab === 'following') {
    if (!currentSession) {
      feedEl.innerHTML = `<div id="feed-empty">Log in and follow people to see their posts here.</div>`;
      return;
    }
    const { data: follows } = await sb.from('follows').select('followee_id').eq('follower_id', currentSession.user.id);
    followingIds = new Set((follows || []).map(f => f.followee_id));
    if (!followingIds.size) {
      feedEl.innerHTML = `<div id="feed-empty">You're not following anyone yet. Posts from people you follow will show up here.</div>`;
      return;
    }

    const page = await fetchFollowingPage(null);
    if (page.error) {
      feedEl.innerHTML = `<div class="errmsg">Failed to load posts: ${esc(page.error.message)}</div>`;
      return;
    }
    if (!page.data.length) {
      feedEl.innerHTML = `<div id="feed-empty">No posts yet. Be the first to post.</div>`;
      return;
    }
    await attachQuotedPosts(page.data);
    renderFeedPage(page.data, true);
    followingCursor = page.cursor;
    feedExhausted = page.done;
    return;
  }

  const page = await fetchForYouPage(null, null, null);
  if (page.error) {
    feedEl.innerHTML = `<div class="errmsg">Failed to load posts: ${esc(page.error.message)}</div>`;
    return;
  }
  if (!page.data.length) {
    feedEl.innerHTML = `<div id="feed-empty">No posts yet. Be the first to post.</div>`;
    return;
  }
  await attachQuotedPosts(page.data);
  renderFeedPage(page.data, true);
  updateForYouPagingState(page.data);
  feedExhausted = page.data.length < FEED_PAGE_SIZE;
}

// Called when the bottom-of-feed sentinel scrolls into view. Appends
// the next page for whichever tab is currently active — the "no
// 100-post ceiling" fix: as long as the server keeps returning a
// full page, this keeps going.
async function loadMoreFeed() {
  if (feedLoadingMore || feedExhausted) return;
  feedLoadingMore = true;
  try {
    if (activeTab === 'following') {
      if (!followingIds || !followingIds.size) { feedExhausted = true; return; }
      const page = await fetchFollowingPage(followingCursor);
      if (page.error || !page.data.length) { feedExhausted = true; return; }
      await attachQuotedPosts(page.data);
      renderFeedPage(page.data, false);
      followingCursor = page.cursor;
      feedExhausted = page.done;
    } else {
      const page = await fetchForYouPage(feedCursor, feedRecentAuthors[0], feedRecentAuthors[1]);
      if (page.error || !page.data.length) { feedExhausted = true; return; }
      await attachQuotedPosts(page.data);
      renderFeedPage(page.data, false);
      updateForYouPagingState(page.data);
      feedExhausted = page.data.length < FEED_PAGE_SIZE;
    }
  } finally {
    feedLoadingMore = false;
  }
}

// Tracks the id (paging cursor) and last-two-authors (de-clump state)
// of whatever was most recently rendered, so the next loadMoreFeed()
// call can pick up exactly where this page left off.
function updateForYouPagingState(pageData) {
  if (!pageData.length) return;
  const last = pageData[pageData.length - 1];
  feedCursor = last.id;
  const secondLast = pageData[pageData.length - 2];
  feedRecentAuthors = pageData.length >= 2
    ? [last.author_id, secondLast.author_id]
    : [last.author_id, feedRecentAuthors[0]];
}

// get_for_you_feed() does the real ranking (recency decay + engagement
// + affinity toward followed/interacted accounts) and its own same-
// author de-clumping server-side — see supabase/for_you_feed.sql.
// Paging is cursor-based: `after_id` is the last post id the client
// has already seen, and the two `recent_author_*` params carry the
// "no 2-in-a-row" state across the page boundary so a run of the same
// author can't span two pages of infinite scroll.
async function fetchForYouPage(afterId, recentAuthor1, recentAuthor2) {
  const { data, error } = await sb.rpc('get_for_you_feed', {
    viewer: currentSession?.user?.id || null,
    limit_n: FEED_PAGE_SIZE,
    after_id: afterId || null,
    recent_author_1: recentAuthor1 || null,
    recent_author_2: recentAuthor2 || null
  }).select(POST_SELECT);
  return { data: data || [], error };
}

// "Following" also pulls in reposts made by people you follow — same
// as Twitter's home timeline — each carrying a "[Name] reposted"
// banner and slotting in at repost time, not post time.
//
// Reposts are fetched as plain reposts-row + posts-by-id + profiles-
// by-id lookups, never as a `reposts.select('post:posts(...)')`
// embed — `reposts` and its foreign keys are recent additions, and
// an embed that PostgREST's schema cache hasn't picked up yet fails
// its *entire* query, not just the repost part (see the comment
// above attachQuotedPosts() in common.js for the same reasoning
// applied to quote_of).
//
// Cursor-paged on `created_at < cursor` against both sources (own
// posts and reposts) rather than one global `.limit(100)` — each
// source is re-queried with a fresh per-page limit every call, so
// there's no ceiling on how many pages deep infinite scroll can go.
async function fetchFollowingPage(cursor) {
  const ids = [...followingIds];
  let ownQuery = sb.from('posts').select(POST_SELECT).eq('is_deleted', false)
    .in('author_id', ids).order('created_at', { ascending: false }).limit(FEED_PAGE_SIZE);
  let repostQuery = sb.from('reposts').select('post_id, user_id, created_at')
    .in('user_id', ids).order('created_at', { ascending: false }).limit(FEED_PAGE_SIZE);
  if (cursor) {
    ownQuery = ownQuery.lt('created_at', cursor);
    repostQuery = repostQuery.lt('created_at', cursor);
  }

  const [ownRes, repostRowsRes] = await Promise.all([ownQuery, repostQuery]);
  if (ownRes.error) return { data: [], error: ownRes.error, done: true, cursor };

  const ownPosts = (ownRes.data || []).map(p => ({ ...p, _sortTime: p.created_at }));

  let repostedPosts = [];
  const repostRows = repostRowsRes.data || [];
  if (repostRowsRes.error) console.warn('reposts lookup failed', repostRowsRes.error);
  if (repostRows.length) {
    const postIds = [...new Set(repostRows.map(r => r.post_id))];
    const reposterIds = [...new Set(repostRows.map(r => r.user_id))];
    const [{ data: repostedPostRows, error: postsErr }, { data: reposterProfiles, error: profErr }] = await Promise.all([
      sb.from('posts').select(POST_SELECT).in('id', postIds).eq('is_deleted', false),
      sb.from('profiles').select('id,username,display_name').in('id', reposterIds)
    ]);
    if (postsErr) console.warn('reposted posts lookup failed', postsErr);
    if (profErr) console.warn('reposter profiles lookup failed', profErr);
    const postById = new Map((repostedPostRows || []).map(p => [p.id, p]));
    const profById = new Map((reposterProfiles || []).map(p => [p.id, p]));
    repostedPosts = repostRows
      .map(r => {
        const p = postById.get(r.post_id);
        const reposter = profById.get(r.user_id);
        return (p && reposter) ? { ...p, _sortTime: r.created_at, _repostedBy: reposter } : null;
      })
      .filter(Boolean);
  }

  const combined = [...ownPosts, ...repostedPosts]
    .sort((a, b) => new Date(b._sortTime) - new Date(a._sortTime));

  const page = combined.slice(0, FEED_PAGE_SIZE);
  // Only exhausted once BOTH sources stop returning a full page each —
  // one source coming up short doesn't mean the other has too.
  const done = (ownRes.data || []).length < FEED_PAGE_SIZE && repostRows.length < FEED_PAGE_SIZE;
  const nextCursor = page.length ? page[page.length - 1]._sortTime : cursor;

  return { data: page, error: null, done, cursor: nextCursor };
}

// Renders a page of posts: replaces the feed (reset) or appends
// (infinite scroll), then (re)attaches the bottom sentinel so the
// IntersectionObserver below has something to watch for the next page.
function renderFeedPage(posts, replace) {
  const feedEl = document.getElementById('feed-posts');
  const sentinel = document.getElementById('feed-sentinel');
  if (sentinel) sentinel.remove();
  const html = posts.map(p => postCardHtml(p)).join('');
  if (replace) feedEl.innerHTML = html;
  else feedEl.insertAdjacentHTML('beforeend', html);
  feedEl.insertAdjacentHTML('beforeend', '<div id="feed-sentinel" class="feed-sentinel"></div>');
  setupFeedObserver();
}

function setupFeedObserver() {
  if (feedObserver) { feedObserver.disconnect(); feedObserver = null; }
  const sentinel = document.getElementById('feed-sentinel');
  if (!sentinel) return;
  feedObserver = new IntersectionObserver(entries => {
    if (entries.some(e => e.isIntersecting)) loadMoreFeed();
  }, { rootMargin: '600px' });
  feedObserver.observe(sentinel);
}

// Moves/resizes the sliding-pill indicator (see .xtabs-indicator in
// style.css) to sit exactly behind whichever .xtab is active, measured
// off the real button geometry so it stays correct regardless of label
// width, font, or viewport size instead of a hardcoded 50%.
function positionTabIndicator(skipAnim) {
  const track = document.getElementById('xtabs');
  const indicator = document.getElementById('xtabs-indicator');
  const activeBtn = track?.querySelector('.xtab.active');
  if (!track || !indicator || !activeBtn) return;
  const trackRect = track.getBoundingClientRect();
  const btnRect = activeBtn.getBoundingClientRect();
  indicator.classList.toggle('no-anim', !!skipAnim);
  indicator.style.width = btnRect.width + 'px';
  indicator.style.transform = `translateX(${btnRect.left - trackRect.left}px)`;
  if (skipAnim) {
    // Force layout so the next (animated) move doesn't inherit this
    // one's no-transition state.
    void indicator.offsetWidth;
    indicator.classList.remove('no-anim');
  }
}
window.addEventListener('resize', () => positionTabIndicator(true));
// Fonts/webfonts can finish loading after DOMContentLoaded and nudge
// button widths a few px — resync once everything (including fonts)
// has actually settled so the pill isn't left a hair off on first paint.
window.addEventListener('load', () => positionTabIndicator(true));

function switchTab(tab) {
  if (tab === activeTab) return;
  activeTab = tab;
  document.getElementById('tab-foryou').classList.toggle('active', tab === 'foryou');
  document.getElementById('tab-following').classList.toggle('active', tab === 'following');
  positionTabIndicator();
  window.scrollTo({ top: 0, behavior: 'smooth' });
  loadFeed();
}

// Adds a single post to the top of the feed, but only if it isn't
// already there. Both the "just posted it myself" path and the
// realtime subscription funnel through this, so a post can never
// be rendered twice no matter which one fires first.
function addPostToFeed(p, flash = false) {
  const feedEl = document.getElementById('feed-posts');
  if (!feedEl) return;
  if (document.getElementById(`post-${p.id}`)) return; // already on screen
  const empty = document.getElementById('feed-empty');
  if (empty) feedEl.innerHTML = '';
  feedEl.insertAdjacentHTML('afterbegin', postCardHtml(p, flash));
  const ctEl = document.getElementById('feed-ct');
  if (ctEl) ctEl.textContent = `(${feedEl.querySelectorAll('.pc').length})`;
}

// ── "SHOW N POSTS" PILL — Twitter doesn't insert other people's new
// posts into the feed under your nose; it queues them behind a pill
// at the top and lets you pull them in on click. ──
function showPendingPill() {
  const pill = document.getElementById('show-new-pill');
  if (!pill) return;
  pill.textContent = `Show ${pendingPosts.length} post${pendingPosts.length === 1 ? '' : 's'}`;
  pill.style.display = 'block';
}
function hidePendingPill() {
  const pill = document.getElementById('show-new-pill');
  if (pill) pill.style.display = 'none';
  pendingPosts = [];
}
function flushPendingPosts() {
  if (!pendingPosts.length) return;
  pendingPosts.slice().reverse().forEach(p => addPostToFeed(p, true));
  pendingPosts = [];
  hidePendingPill();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

// postCardHtml() now lives in common.js (shared with profile.js).

// ── NEW POST (Twitter calls this "posting", never "starting a thread") ──
async function submitPost() {
  if (!requireLogin()) return;
  const bodyEl = document.getElementById('pf-body');
  const fileEl = document.getElementById('pf-file');
  const btn    = document.getElementById('pf-btn');
  const stEl   = document.getElementById('pf-st');
  const errEl  = document.getElementById('pf-err');
  clearErr(errEl);

  const body = bodyEl.value.trim();
  if (!body) { showErr(errEl, "Comment can't be empty."); return; }
  if (body.length > 500) { showErr(errEl, 'Comment too long (max 500 chars).'); return; }
  if (!validatePollAndSchedule('pf', errEl)) return;
  if (!enforceCooldown(errEl)) return;
  if (!ensureCaptchaRevealed('pf-captcha')) return;
  if (!(await verifyHuman('pf-captcha', errEl))) return;

  btn.disabled = true;
  stEl.textContent = 'Posting…';
  try {
    let media_url = null, media_type = null;
    const gifUrl = composeExtras.pf?.gifUrl;
    const file = fileEl.files[0];
    if (gifUrl) {
      media_url = gifUrl; media_type = 'gif';
    } else if (file) {
      if (!validateFile(file, errEl)) { btn.disabled = false; stEl.textContent = ''; return; }
      stEl.textContent = 'Uploading file…';
      ({ media_url, media_type } = await uploadMedia(file, msg => stEl.textContent = msg));
    }
    const poll = collectPoll('pf');
    const scheduled_at = collectSchedule('pf');
    const { data, error } = await sb.from('posts').insert({
      author_id: currentSession.user.id,
      body,
      media_url,
      media_type,
      poll_options: poll?.poll_options || null,
      poll_ends_at: poll?.poll_ends_at || null,
      scheduled_at,
      reply_audience: getReplyAudience('pf')
    }).select(POST_SELECT).single();
    if (error) throw error;
    bodyEl.value = '';
    bodyEl.style.height = '';
    fileEl.value = ''; document.getElementById('pf-fp').innerHTML = '';
    resetComposeExtras('pf');
    stEl.textContent = '';
    // Render it immediately — addPostToFeed() is dedup-safe, so if the
    // realtime INSERT event for this same row arrives a moment later
    // it will just no-op instead of adding a second copy. A scheduled
    // post isn't published yet (RLS hides it from everyone but its
    // author until scheduled_at passes), so it doesn't belong in the
    // live feed — just confirm it was queued.
    if (scheduled_at) {
      alert(`Post scheduled for ${new Date(scheduled_at).toLocaleString()}.`);
    } else if (activeTab === 'foryou') {
      addPostToFeed(data, true);
    }
    markPosted();
    startCooldownCountdown(btn, 'Post');
  } catch (e) {
    showErr(errEl, e.message || 'Failed to post.');
    stEl.textContent = '';
  } finally {
    updatePostBtnState();
  }
}

function updatePostBtnState() {
  const bodyEl = document.getElementById('pf-body');
  const btn = document.getElementById('pf-btn');
  if (!bodyEl || !btn) return;
  if (postCooldownRemainingMs() > 0) return; // cooldown countdown owns disabled/label right now
  btn.disabled = bodyEl.value.trim().length === 0;
}

// Fills in the composer's avatar once we know who's logged in
// (called by auth.js's refreshPostGates whenever session state settles).
function renderComposerAvatar() {
  const el = document.getElementById('pf-avatar');
  if (!el) return;
  const url = currentSession ? avatarUrl(currentProfile?.avatar_url) : DEFAULT_AVATAR;
  el.innerHTML = `<img src="${esc(url)}" alt="">`;
}

// ── TRENDING SIDEBAR — one list, ranked by overall engagement,
// top 3 only (likes weighted highest, then replies, then views). ──
async function loadTrending() {
  const since = new Date(Date.now() - 24 * 3600 * 1000).toISOString();

  const { data } = await sb.from('posts').select(POST_SELECT)
    .eq('is_deleted', false).gte('created_at', since)
    .order('created_at', { ascending: false })
    .limit(50);

  const ranked = (data || [])
    .map(p => ({ ...p, _score: (p.like_count || 0) * 3 + (p.reply_count || 0) * 2 + (p.view_count || 0) }))
    .sort((a, b) => b._score - a._score)
    .slice(0, 3);

  document.getElementById('t-trending').innerHTML = trendListHtml(ranked);
}

function trendListHtml(list) {
  if (!list || !list.length) return `<div class="no-t">Nothing trending yet.</div>`;
  return list.map(p => {
    const uname = p.profile?.username || 'unknown';
    return `
    <a class="tcard" href="${postUrl(p)}">
      <div class="tcard-row">
        <img class="avatar tcard-avatar${avSqClass(p.profile)}" src="${esc(avatarUrl(p.profile?.avatar_url))}" alt="" loading="lazy" decoding="async">
        <div class="tcard-body">
          <div class="tcard-head">
            <span class="tcard-name">${esc(p.profile?.display_name || uname)}${vBadge(p.profile)}</span>
            <span class="tcard-handle">@${esc(uname)}</span>
            <span class="tcard-dt">${timeAgo(p.created_at)}</span>
          </div>
          <div class="tsnip">${renderBody((p.body || '').slice(0, 140))}</div>
          <div class="tmeta">
            <span class="tmeta-item">${ICON.heart}${fmtCount(p.like_count)}</span>
            <span class="tmeta-item">${ICON.reply}${fmtCount(p.reply_count)}</span>
            <span class="tmeta-item">${ICON.views}${fmtCount(p.view_count)}</span>
          </div>
        </div>
      </div>
    </a>`;
  }).join('');
}

// ── REALTIME: new posts (and, on the Following tab, new reposts)
// appear live, queued behind the "Show N posts" pill above. ──
//
// Subscribed ONCE, at page load — not re-subscribed on every
// switchTab(), so tab switches can never stack duplicate channels.
// Instead each handler reads the live `activeTab`/`followingIds`
// module state at event time, so a single channel naturally tracks
// whichever tab happens to be active when the event arrives.
let feedChannel = null;

// De-dupes against posts already queued in the pill (not just posts
// already on screen) — needed now that a post can be queued twice:
// once from its own INSERT, once from a repost-of-it INSERT arriving
// moments later.
function queuePendingPost(p) {
  if (document.getElementById(`post-${p.id}`)) return;
  if (pendingPosts.some(x => x.id === p.id)) return;
  pendingPosts.push(p);
  showPendingPill();
}

async function handleRealtimePostInsert(payload) {
  const p = payload.new;
  if (p.is_deleted) return;
  // BUGFIX: Realtime's postgres_changes broadcast goes out to every
  // subscribed client the instant a row is inserted, regardless of
  // RLS — so without this check, a post scheduled for later would
  // still pop up as a "Show 1 post" pill for everyone right away,
  // fully readable once clicked, well before its scheduled time.
  if (p.scheduled_at && new Date(p.scheduled_at).getTime() > Date.now()) return;

  if (activeTab === 'following') {
    // Following tab only ever shows people the viewer follows — same
    // filter loadFeed() applies, just re-checked live per event.
    if (!followingIds || !followingIds.has(p.author_id)) return;
  }
  // 'foryou' tab: no author filter, matching what get_for_you_feed()
  // itself is willing to rank in (anyone not blocked/muted).

  p.profile = await getProfile(p.author_id);
  await attachQuotedPosts([p]);
  queuePendingPost(p);
}

async function handleRealtimeRepostInsert(payload) {
  // Reposts only ever show up as feed items on the Following tab
  // (that's the only place loadFeed() surfaces them at all — see
  // fetchFollowingPage()), and only when they're reposts BY someone
  // the viewer follows.
  if (activeTab !== 'following') return;
  if (!followingIds || !followingIds.size) return;
  const r = payload.new;
  if (!followingIds.has(r.user_id)) return;
  if (document.getElementById(`post-${r.post_id}`)) return;

  const [{ data: postRow, error: postErr }, reposterProfile] = await Promise.all([
    sb.from('posts').select(POST_SELECT).eq('id', r.post_id).eq('is_deleted', false).maybeSingle(),
    getProfile(r.user_id)
  ]);
  if (postErr || !postRow || !reposterProfile) return;
  postRow._repostedBy = reposterProfile;
  await attachQuotedPosts([postRow]);
  queuePendingPost(postRow);
}

// Fields whose change means the card's actual rendered content is
// stale and needs a full rebuild (edited body, media swap, a
// scheduled post going live, deletion, reply-audience change, etc).
// Deliberately NOT in this list: like_count, bookmark_count,
// repost_count, view_count, reply_count — those bump on essentially
// every like/bookmark/view/repost anywhere, which is by far the most
// common reason this UPDATE event fires at all (including the echo
// of the viewer's own optimistic tap on their own like/bookmark).
const POST_STRUCTURAL_FIELDS = ['body', 'media_url', 'media_type', 'is_deleted', 'reply_audience', 'scheduled_at', 'community_id'];

// Patches just the count numbers on an already-rendered card in
// place — no DOM teardown, so the avatar/media never reloads and the
// card doesn't visibly blink. Doesn't touch the liked/bookmarked/
// reposted *state* (the filled-in heart, etc.) since that's derived
// from this viewer's own `liked`/`bookmarked`/`reposted` Sets, not
// from anything in the row itself.
function patchPostCounters(card, p) {
  const likeBtn = card.querySelector('.act.like');
  if (likeBtn) {
    likeBtn.dataset.count = p.like_count || 0;
    const lc = likeBtn.querySelector('.lc');
    if (lc) lc.textContent = fmtCount(p.like_count);
  }
  const bookmarkBtn = card.querySelector('.act.bookmark');
  if (bookmarkBtn) {
    bookmarkBtn.dataset.count = p.bookmark_count || 0;
    const bc = bookmarkBtn.querySelector('.bc');
    if (bc) bc.textContent = fmtCount(p.bookmark_count);
  }
  const repostBtn = card.querySelector('.act.repost');
  if (repostBtn) {
    repostBtn.dataset.count = p.repost_count || 0;
    const rLabel = repostBtn.querySelector('.act-label');
    if (rLabel) rLabel.textContent = fmtCount(p.repost_count);
  }
  const replyLabel = card.querySelector('.act.reply .act-label');
  if (replyLabel) replyLabel.textContent = fmtCount(p.reply_count);
  const viewsEl = card.querySelector('.act.views');
  if (viewsEl) {
    viewsEl.title = `${p.view_count || 0} views`;
    const vLabel = viewsEl.querySelector('.act-label');
    if (vLabel) vLabel.textContent = fmtCount(p.view_count);
  }
}

async function handleRealtimePostUpdate(payload) {
  const p = payload.new;
  const card = document.getElementById(`post-${p.id}`);
  if (!card) return;
  // This UPDATE fires on ANY change to the row — a like, a
  // bookmark, a view bump, a repost, all of it — since they're
  // all just counter columns on `posts`. Only rebuild the card
  // (which reloads its avatar/media and is what caused the visible
  // blink on every like/bookmark) when something structural about
  // it actually changed; otherwise just patch the numbers.
  const prev = postCache[p.id];
  const structural = !prev || POST_STRUCTURAL_FIELDS.some(f => prev[f] !== p[f]);
  if (!structural) {
    patchPostCounters(card, p);
    cachePost({ ...prev, ...p });
    return;
  }
  p.profile = await getProfile(p.author_id);
  // `payload.new` is the raw row, so a quote post needs its embedded
  // original re-attached here too, or postCardHtml() renders it as if
  // the original had been deleted. (Same reasoning as the INSERT
  // handler above.)
  await attachQuotedPosts([p]);
  card.outerHTML = postCardHtml(p);
}

function subscribeRealtime() {
  // Defensive: if this ever does get called twice, tear down the old
  // channel first rather than stacking a second one on top of it.
  if (feedChannel) {
    sb.removeChannel(feedChannel);
    feedChannel = null;
  }
  feedChannel = sb.channel('posts-feed')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'posts' }, handleRealtimePostInsert)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'reposts' }, handleRealtimeRepostInsert)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'posts' }, handleRealtimePostUpdate)
    .subscribe();
}

document.addEventListener('DOMContentLoaded', async () => {
  await authReady; // see auth.js — otherwise cards can render before we know who's logged in
  positionTabIndicator(true);
  loadFeed();
  loadTrending();
  subscribeRealtime();
  wireFilePreview('pf-file', 'pf-fp', 'pf-err');
  injectReplyAudienceUi('pf');
  const pfBody = document.getElementById('pf-body');
  const pfBox = document.getElementById('pf-box');
  // Compact "What's up?" bar by default (see #pf-box CSS) — expands to
  // the full toolbar/audience-picker on focus or the first keystroke,
  // and collapses back once you click away with nothing typed/attached
  // and no poll/schedule in progress, same idea as Bluesky's composer.
  const pfHasContent = () => {
    if (pfBody.value.trim()) return true;
    const fp = document.getElementById('pf-fp');
    if (fp && fp.innerHTML.trim()) return true;
    const pollBox = document.getElementById('pf-poll-box');
    if (pollBox && !pollBox.hidden) return true;
    const schedBox = document.getElementById('pf-sched-box');
    if (schedBox && !schedBox.hidden) return true;
    return false;
  };
  const pfExpand = () => pfBox && pfBox.classList.add('pf-expanded');
  // Any composer popup/subpanel that should keep the composer expanded
  // even though the textarea itself just lost focus — the GIF and
  // emoji pickers are separate floating panels (not children of
  // #pf-box), so tapping into either one blurs #pf-body first.
  const pfPopupOpen = () => {
    const gifEl = document.getElementById('gif-modal-bg');
    if (gifEl && gifEl.classList.contains('open') && gifPickerTarget === 'pf') return true;
    const emojiEl = document.getElementById('emoji-modal-bg');
    if (emojiEl && emojiEl.classList.contains('open') && emojiPickerTarget === 'pf') return true;
    return false;
  };
  const pfCollapseIfEmpty = () => {
    // Deferred one tick: blur fires on mousedown, a beat before the
    // toolbar button's click — collapsing synchronously here would
    // hide the toolbar (display:none outside .pf-expanded) out from
    // under that click before it ever runs, which is why tapping
    // Media/GIF/Poll/Emoji/Schedule with an empty textarea looked
    // like the buttons "didn't work." Waiting a tick lets the click
    // land (opening the poll box, a popup, etc.) before we decide.
    setTimeout(() => {
      if (!pfBox) return;
      if (pfBox.contains(document.activeElement)) return;
      if (pfPopupOpen()) return;
      if (!pfHasContent()) {
        pfBox.classList.remove('pf-expanded');
        pfBody.style.height = '';
      }
    }, 150);
  };
  if (pfBody) {
    pfBody.addEventListener('focus', pfExpand);
    pfBody.addEventListener('blur', pfCollapseIfEmpty);
    pfBody.addEventListener('input', () => {
      pfExpand();
      updatePostBtnState();
      pfBody.style.height = 'auto';
      pfBody.style.height = Math.max(56, pfBody.scrollHeight) + 'px';
    });
  }
  setInterval(loadTrending, 60000);
});
