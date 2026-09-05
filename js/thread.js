// ─────────────────────────────────────────────────────────────
// THREAD PAGE — /<username>/status/<post_id>  (also reachable as
// /i/status/<post_id> before we know the author, or the legacy
// thread.html?id=<post_id> form — see currentStatusId() in
// common.js). Comments can reply to the post OR to another comment —
// both directions work, same as Twitter replies.
// ─────────────────────────────────────────────────────────────
// Recomputed on every page load rather than frozen at module scope —
// pjax (js/pjax.js) keeps this script loaded for the life of the
// tab, so visiting a *second* thread later would otherwise silently
// keep using the very first thread's id forever (this file only
// ever gets parsed once). Every function below that references
// `postId` reads this same outer binding, so reassigning it in the
// DOMContentLoaded handler is enough — nothing else needs to change.
let postId = null;


let allReplies = []; // flat list, kept around so inline "reply to this comment" forms can insert without a refetch
let currentPost = null; // the OP post, kept around so hash-driven re-renders don't need to refetch it
let hashChangeHandler = null; // see loadThread() below — same leak class as threadChannel/subscribeRealtime()

// Optional hook called by applyEditToDom() in common.js right after a
// successful edit — applyEditToDom() already patched every rendered
// copy of the post/reply directly, this just keeps allReplies/
// currentPost in sync so a later re-render (hash nav, changing
// comment sort) doesn't revert to the pre-edit body.
function onPostBodyEdited(id, newBody, updatedAt) {
  if (currentPost && currentPost.id === id) {
    currentPost.body = newBody;
    currentPost.updated_at = updatedAt;
  }
  const r = allReplies.find(x => x.id === id);
  if (r) { r.body = newBody; r.updated_at = updatedAt; }
}

// ── COMMENT SORT ──
// Only the top-level comment order changes — each comment's own
// children always stay in chronological order underneath it (same as
// X: sort applies to which top-level replies surface first, not to
// nested conversations).
const COMMENT_SORT_LABELS = { relevant: 'Relevant', latest: 'Latest', liked: 'Most Liked' };
let commentSort = 'relevant';

// "Relevant" = a lightweight score blending engagement (likes weighted
// above raw reply count, since a like is a lower-friction signal that
// still means something) with a recency decay so a strong older
// comment doesn't bury everything newer forever, but a comment still
// needs actual engagement to rank above simple recency — matches the
// spirit of _for_you_score in supabase/for_you_feed.sql without
// needing a DB round trip, since these are already all loaded client-side.
function relevanceScore(r) {
  const ageHours = Math.max(0, (Date.now() - new Date(r.created_at).getTime()) / 3600000);
  const recency = 100 / (1 + ageHours / 6); // ~6h half-life-ish decay
  const likes = Math.log(1 + Math.max(0, r.like_count || 0)) * 4;
  const kids = Math.log(1 + childrenOf(r.id).length) * 3;
  return recency + likes + kids;
}

function sortTopLevel(list) {
  const sorted = list.slice();
  if (commentSort === 'latest') {
    sorted.sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  } else if (commentSort === 'liked') {
    sorted.sort((a, b) => (b.like_count || 0) - (a.like_count || 0) || new Date(b.created_at) - new Date(a.created_at));
  } else {
    sorted.sort((a, b) => relevanceScore(b) - relevanceScore(a));
  }
  return sorted;
}

function setCommentSort(mode, ev) {
  if (ev) ev.preventDefault();
  closeCommentSortMenu();
  if (commentSort === mode) return;
  commentSort = mode;
  const btnLabel = document.querySelector('.op-relevant-btn span');
  if (btnLabel) btnLabel.textContent = COMMENT_SORT_LABELS[mode];
  document.querySelectorAll('.op-relevant-opt').forEach(opt => opt.classList.remove('active'));
  const menu = document.getElementById('op-relevant-menu');
  const activeOpt = menu && Array.from(menu.children).find(el => el.textContent.trim() === COMMENT_SORT_LABELS[mode]);
  if (activeOpt) activeOpt.classList.add('active');
  const list = document.getElementById('replies-list');
  if (list) list.innerHTML = renderReplyTree();
}

function toggleCommentSortMenu(ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  const menu = document.getElementById('op-relevant-menu');
  if (!menu) return;
  const willOpen = menu.hidden;
  closeCommentSortMenu();
  if (willOpen) {
    menu.hidden = false;
    document.addEventListener('click', commentSortOutsideClick);
  }
}
function closeCommentSortMenu() {
  const menu = document.getElementById('op-relevant-menu');
  if (menu) menu.hidden = true;
  document.removeEventListener('click', commentSortOutsideClick);
}
function commentSortOutsideClick(ev) {
  if (!ev.target.closest('.op-relevant')) closeCommentSortMenu();
}

// ── FOCUSED-REPLY VIEW ──
// Clicking any comment opens a Twitter-style "detail" view of just
// that comment: the OP and the chain of ancestors above it (compact),
// the comment itself enlarged with its own reply composer, and its
// own children below — same idea as tapping a reply on Twitter/X.
// Driven entirely by the #reply-<id> URL hash so back/forward and
// shared links (see profile.js) all work, and switching focus never
// needs a refetch — it just re-renders from the already-loaded
// `allReplies` list.
function currentFocusedReplyId() {
  const m = location.hash.match(/^#reply-(.+)$/);
  return m ? decodeURIComponent(m[1]) : null;
}
function focusReply(replyId) {
  if (currentFocusedReplyId() === replyId) return;
  location.hash = 'reply-' + replyId;
}
// Shared "did this click land on something interactive" guard, same
// list cardClick() uses for post cards in the feed.
function rcClick(ev, replyId) {
  if (ev.target.closest('a, button, input, textarea, .pc-menu-wrap, .rp-menu-wrap, .pm')) return;
  focusReply(replyId);
}

async function loadThread() {
  const wrap = document.getElementById('thread-root');
  if (!wrap) return;
  if (!postId) { wrap.innerHTML = `<div class="errmsg">No post specified.</div>`; return; }
  wrap.innerHTML = skeletonThreadHtml();

  await ensureFeedPrereqsLoaded();
  const { data: p, error } = await sb.from('posts').select(POST_SELECT).eq('id', postId).eq('is_deleted', false).single();
  if (error || !p) {
    wrap.innerHTML = `<div class="errmsg">Post not found or has been removed.</div>`;
    return;
  }
  currentPost = p;
  cachePost(p);
  await attachQuotedPosts([p]);
  document.title = (p.body ? p.body.slice(0, 60) : 'Post') + ' — InteractInk';
  setPageH1(p.body ? p.body.slice(0, 140) : 'Post');
  setPageDescription(p.body || 'A post on InteractInk.');
  // Now that we know who posted it, upgrade a generic /i/status/<id>
  // (or a legacy ?id= link) to the canonical /<username>/status/<id>
  // address, same as x.com does — no reload, just a clean URL bar.
  if (p.profile?.username) {
    const canonical = prettyPostUrl(p);
    if (location.pathname + location.search !== canonical) { try { history.replaceState(null, '', canonical + location.hash); } catch (e) {} }
    setCanonical(canonical);
  }
  if (p.media_url) setPageImage(p.media_url);
  else if (p.profile?.avatar_url) setPageImage(p.profile.avatar_url);
  setJsonLd({
    '@context': 'https://schema.org', '@type': 'SocialMediaPosting',
    url: location.origin + prettyPostUrl(p),
    datePublished: p.created_at,
    text: p.body,
    author: {
      '@type': 'Person',
      name: p.profile?.display_name || p.profile?.username || 'unknown',
      url: p.profile?.username ? location.origin + prettyProfileUrl(p.profile.username) : undefined,
    },
    interactionStatistic: [
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/LikeAction', userInteractionCount: p.like_count || 0 },
      { '@type': 'InteractionCounter', interactionType: 'https://schema.org/ReplyAction', userInteractionCount: p.reply_count || 0 },
    ],
  });

  const { data: replies } = await sb.from('replies').select(REPLY_SELECT)
    .eq('post_id', postId).eq('is_deleted', false)
    .order('created_at', { ascending: true });

  allReplies = replies || [];

  renderConversation();
  afterRender();
  loadQuoteCount(p.id);

  // Re-render (from the already-fetched data — no refetch) whenever
  // the #reply-<id> focus hash changes: a comment being clicked (see
  // rcClick/focusReply above), the browser's back/forward buttons, or
  // a direct link landing straight on a specific comment.
  //
  // window persists across pjax navigations, so without removing the
  // previous thread page's listener first, visiting a second (or
  // third, or Nth) thread page in the same tab stacked another
  // 'hashchange' listener on top of the last — every old one closing
  // over its own thread's stale allReplies/currentPost and still
  // firing (re-rendering the wrong thread's data into whatever
  // .xshell currently holds) on every future hash change. Same leak
  // class as threadChannel below, just missing this guard.
  if (hashChangeHandler) window.removeEventListener('hashchange', hashChangeHandler);
  hashChangeHandler = () => {
    renderConversation();
    afterRender();
    document.getElementById('main')?.scrollIntoView({ behavior: 'instant', block: 'start' });
  };
  window.addEventListener('hashchange', hashChangeHandler);

  // The OP itself counts as viewed the moment its thread is opened
  // (see common.js — this still respects the once-per-session dedup,
  // so it won't double-count if it was already counted by scrolling
  // past it in a feed). Replies are counted individually as each one
  // actually scrolls into view — see the data-view attribute on the
  // .rc card above and the shared observer in common.js — rather than
  // all being bumped at once just because the thread loaded.
  bumpPostView(p.id);
}

// Re-wires everything that lives inside #thread-root and gets thrown
// away/rebuilt on every render (the reply composer's file-picker,
// autosize, and login/logout gating) — called once after the initial
// load and again after every hash-driven re-render, since the actual
// DOM nodes (e.g. #rf-body) are fresh each time.
function afterRender() {
  if (document.getElementById('rf-file')) wireFilePreview('rf-file', 'rf-fp', 'rf-err');
  refreshPostGates();
  const rfBody = document.getElementById('rf-body');
  if (rfBody) {
    const resize = () => {
      rfBody.style.height = 'auto';
      rfBody.style.height = Math.max(40, rfBody.scrollHeight) + 'px';
    };
    resize(); // run once immediately — otherwise the box sits at its
              // unresized CSS height (previously too short and cut off
              // the "Post your reply" placeholder) until the first keystroke
    rfBody.addEventListener('input', resize);
  }
}

// The composer markup is identical whether it's replying to the OP
// (default view) or to whichever comment is currently focused — only
// what submitReply() ends up targeting changes (see its default
// parameter below). Kept as one template so both call sites stay in
// sync.
function replyComposerHtml() {
  // The whole post disallows replies — same as X, where a
  // reply-restricted Tweet's thread shows a locked message instead of
  // a composer (and, since nothing could ever have been posted into
  // it, there's nothing further down to reply to either).
  if (currentPost?.reply_audience === 'none') {
    return `
    <div class="rfm rfm-locked">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7.5a4 4 0 0 1 8 0V11"/></svg>
      <span>Replies are turned off for this post.</span>
    </div>`;
  }
  return `
    <div class="rfm" data-requires-auth style="display:none;">
      <span class="pf-avatar" id="rf-avatar"></span>
      <div class="rfm-col">
        <div class="errmsg" id="rf-err" style="display:none;"></div>
        <textarea id="rf-body" maxlength="500" placeholder="${t('compose.reply')}" rows="1"></textarea>
        <div id="rf-fp" class="fp"></div>
        ${captchaCardHtml('rf-captcha')}
        <div class="rfm-row">
          <button type="button" class="pf-ic" title="Media" aria-label="Media" onclick="document.getElementById('rf-file').click();return false;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.5 3.6h8.4a2 2 0 0 1 2 2v8.4"/><rect x="4.1" y="8.1" width="11.8" height="12.3" rx="2.3"/><circle cx="8.1" cy="12.1" r="1.15" fill="currentColor" stroke="none"/><path d="M6 17.9l3-3 1.9 1.9 2.5-2.5 2.4 2.4"/></svg>
          </button>
          <button type="button" class="pf-ic" title="GIF" aria-label="GIF" onclick="openGifPicker('rf');return false;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="3" y="5" width="18" height="14" rx="3.5"/><text x="12" y="15.2" font-family="Arial,Helvetica,sans-serif" font-size="7.3" font-weight="700" letter-spacing="0.3" text-anchor="middle" fill="currentColor" stroke="none">GIF</text></svg>
          </button>
          <button type="button" class="pf-ic" title="Emoji" aria-label="Emoji" onclick="toggleEmojiPicker('rf', this);return false;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><circle cx="9" cy="10" r="1.1" fill="currentColor" stroke="none"/><circle cx="15" cy="10" r="1.1" fill="currentColor" stroke="none"/><path d="M8.3 14c.9 1.3 2.1 2 3.7 2s2.8-.7 3.7-2" stroke-linecap="round"/></svg>
          </button>
          <input type="file" id="rf-file" accept="image/*,video/*" style="display:none;">
          <span id="rf-st" style="font-size:11px;color:var(--muted);"></span>
          <input type="submit" id="rf-btn" class="pf-btn" value="Reply" onclick="submitReply();return false;">
        </div>
      </div>
    </div>
    <div class="post-login-gate" data-requires-anon style="display:none;">
      You need an account to post. <a href="signup.html">Create an account</a> — it takes a minute.
    </div>`;
}

function opBlockHtml(p) {
  return `
    <div class="op-detail" id="op-post">
      <div class="op-detail-head">
        ${pcAvatarHtml(p.profile)}
        <div class="op-detail-names">
          <span class="op-name-line"><a class="nm" href="${profileUrl(p.profile?.username || 'unknown')}">${esc(p.profile?.display_name || p.profile?.username || 'unknown')}</a>${vBadge(p.profile)}</span>
          <span class="pc-handle">@${esc(p.profile?.username || 'unknown')}</span>
        </div>
        ${postMenuHtml(p.id, null, p.author_id, p.community_id, p.created_at)}
      </div>
      <div class="op-detail-body" data-pb="${p.id}">${renderBodyToggle(p.body)}</div>
      ${p.quote_of ? quotedPostHtml(p.quoted) : ''}
      ${p.article_id ? articleCardHtml(p._promoArticle) : ''}
      ${renderMedia(p.media_url, p.media_type, '', p)}
      ${pollHtml(p)}
      ${linkCardHtml(p.body, !!(p.media_url || p.quote_of || p.article_id || p.poll_options?.length))}
      <div class="op-detail-meta"><span data-dt="${p.id}">${fullDateTime(p.created_at)}${editedSuffix(p)}</span> &middot; <span class="op-detail-views">${ICON.views}<b>${fmtCount(p.view_count)}</b> Views</span></div>
      <div class="op-detail-divider"></div>
      ${opDetailActionsHtml(p, "document.getElementById('rf-body')?.scrollIntoView({behavior:'smooth',block:'center'});document.getElementById('rf-body')?.focus();")}
      <div class="op-detail-divider"></div>
      <div class="op-relevant">
        <div class="op-relevant-wrap">
          <button type="button" class="op-relevant-btn" onclick="toggleCommentSortMenu(event)"><span>${COMMENT_SORT_LABELS[commentSort]}</span><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg></button>
          <div class="op-relevant-menu" id="op-relevant-menu" hidden>
            ${Object.entries(COMMENT_SORT_LABELS).map(([mode, label]) => `
              <button type="button" class="op-relevant-opt${commentSort === mode ? ' active' : ''}" onclick="setCommentSort('${mode}', event)">${label}</button>
            `).join('')}
          </div>
        </div>
        <a href="#" id="op-quotes-toggle" hidden onclick="toggleQuotesList(event)">View quotes &rsaquo;</a>
      </div>
      <div class="op-quotes-list" id="op-quotes-list" hidden></div>
    </div>`;
}

// Compact context row for an ancestor comment sitting between the OP
// and the focused comment — same look as a normal comment card but
// no actions row, since it's here for context, not interaction.
// Clicking one re-focuses on IT instead, same as X does when you tap
// an ancestor tweet in a reply's detail view.
function ancestorRowHtml(r) {
  return `
  <div class="rc has-children" onclick="rcClick(event,'${r.id}')">
    <div class="pc-row">
      ${pcAvatarHtml(r.profile)}
      <div class="pc-main">
        <div class="ph">${pcNameHtml(r.profile)}<span class="dt" data-dt="${r.id}">${timeAgo(r.created_at)}${editedSuffix(r)}</span></div>
        <div class="pb" data-pb="${r.id}">${renderBodyToggle(r.body)}</div>
        ${renderMedia(r.media_url, r.media_type, '', r)}
        ${linkCardHtml(r.body, !!r.media_url)}
      </div>
    </div>
  </div>`;
}

// Walks parent_reply_id up from `replyId`, returning ancestors ordered
// top-down (closest to the OP first, immediate parent last) — NOT
// including `replyId` itself. Empty when the comment replies directly
// to the OP.
function ancestorChain(replyId) {
  const chain = [];
  let cur = allReplies.find(r => r.id === replyId);
  while (cur && cur.parent_reply_id) {
    const parent = allReplies.find(x => x.id === cur.parent_reply_id);
    if (!parent) break;
    chain.unshift(parent);
    cur = parent;
  }
  return chain;
}

// Builds everything under #thread-root: the default full-thread view,
// or — when the URL carries a #reply-<id> hash — a focused "detail"
// view of that one comment (ancestor chain above, the comment itself
// enlarged with its own composer, its own children below), exactly
// like tapping a reply on Twitter/X opens that reply's own page.
function renderConversation() {
  const wrap = document.getElementById('thread-root');
  if (!wrap || !currentPost) return;
  const p = currentPost;
  const focusedId = currentFocusedReplyId();
  const focused = focusedId ? allReplies.find(r => r.id === focusedId) : null;

  if (!focused) {
    wrap.innerHTML = `
      ${opBlockHtml(p)}
      ${replyComposerHtml()}
      <div class="rw" id="replies-list">
        ${renderReplyTree()}
      </div>`;
    return;
  }

  const ancestors = ancestorChain(focusedId);
  const kids = childrenOf(focusedId);
  wrap.innerHTML = `
    ${opBlockHtml(p)}
    <div class="thread-focus-bar"><a href="#" onclick="event.preventDefault();location.hash='';">&larr; Back to full conversation</a></div>
    ${ancestors.map(ancestorRowHtml).join('')}
    <div class="op-detail" id="focused-reply">
      <div class="op-detail-head">
        ${pcAvatarHtml(focused.profile)}
        <div class="op-detail-names">
          <span class="op-name-line"><a class="nm" href="${profileUrl(focused.profile?.username || 'unknown')}">${esc(focused.profile?.display_name || focused.profile?.username || 'unknown')}</a>${vBadge(focused.profile)}</span>
          <span class="pc-handle">@${esc(focused.profile?.username || 'unknown')}</span>
        </div>
        ${postMenuHtml(postId, focused.id, focused.author_id, null, focused.created_at)}
      </div>
      <div class="op-detail-body" data-pb="${focused.id}">${renderBodyToggle(focused.body)}</div>
      ${renderMedia(focused.media_url, focused.media_type, '', focused)}
      ${linkCardHtml(focused.body, !!focused.media_url)}
      <div class="op-detail-meta"><span data-dt="${focused.id}">${fullDateTime(focused.created_at)}${editedSuffix(focused)}</span></div>
      <div class="op-detail-divider"></div>
      ${postActionsHtml(focused, {
        replyOnclick: "document.getElementById('rf-body')?.scrollIntoView({behavior:'smooth',block:'center'});document.getElementById('rf-body')?.focus();",
        replyCount: kids.length, bookmarkable: false, repostable: false, isReply: true
      })}
      <div class="op-detail-divider"></div>
    </div>
    ${replyComposerHtml()}
    <div class="rw" id="replies-list">
      ${kids.length ? kids.map(k => replyHtml(k, 0)).join('') : '<div class="no-t">No replies yet. Be the first to reply.</div>'}
    </div>`;
}

// Fills in the reply composer's avatar once we know who's logged in
// (called by auth.js's refreshPostGates whenever session state settles).
function renderComposerAvatar() {
  const el = document.getElementById('rf-avatar');
  if (!el) return;
  const url = currentSession ? avatarUrl(currentProfile?.avatar_url) : DEFAULT_AVATAR;
  el.innerHTML = `<img src="${esc(url)}" alt="">`;
}

// Shows the "View quotes ›" link only when at least one exists — same
// as Twitter hides it entirely on a post nobody's quoted. Wrapped in
// try/catch since quote_of only exists once quotes_and_reposts.sql
// has been run (see attachQuotedPosts() above for the same reasoning).
async function loadQuoteCount(id) {
  try {
    const { count } = await sb.from('posts').select('id', { count: 'exact', head: true })
      .eq('quote_of', id).eq('is_deleted', false);
    const link = document.getElementById('op-quotes-toggle');
    if (link && count) link.hidden = false;
  } catch (e) { /* quotes_and_reposts.sql not run yet — leave it hidden */ }
}

// Lazily fetches and toggles the list of posts quoting this one,
// inline under the "View quotes ›" row — reuses postCardHtml() so a
// quote in the list behaves exactly like any other post card.
async function toggleQuotesList(ev) {
  ev.preventDefault();
  const box = document.getElementById('op-quotes-list');
  if (!box) return;
  const willOpen = box.hidden;
  if (willOpen && !box.dataset.loaded) {
    box.hidden = false;
    box.innerHTML = `<span class="spinner">Loading&hellip;</span>`;
    try {
      const { data } = await sb.from('posts').select(POST_SELECT)
        .eq('quote_of', postId).eq('is_deleted', false)
        .order('created_at', { ascending: false });
      await attachQuotedPosts(data || []);
      box.innerHTML = (data && data.length) ? data.map(qp => postCardHtml(qp)).join('') : '<div class="no-t">No quotes yet.</div>';
    } catch (e) {
      box.innerHTML = `<div class="errmsg">Could not load quotes.</div>`;
    }
    box.dataset.loaded = '1';
    return;
  }
  box.hidden = !willOpen;
}

// Builds the nested tree (top-level replies to the post, each with
// its own children replying to it) out of the flat `allReplies` list.
function renderReplyTree() {
  if (!allReplies.length) return '<div class="no-t">No replies yet. Be the first to reply.</div>';
  const topLevel = sortTopLevel(allReplies.filter(r => !r.parent_reply_id));
  return topLevel.map(r => replyHtml(r, 0)).join('') || '<div class="no-t">No replies yet. Be the first to reply.</div>';
}

function childrenOf(replyId) {
  return allReplies.filter(r => r.parent_reply_id === replyId);
}

function replyHtml(r, depth) {
  const kids = childrenOf(r.id);
  const parent = r.parent_reply_id ? allReplies.find(x => x.id === r.parent_reply_id) : null;
  return `
  <div class="rc${kids.length ? ' has-children' : ''}" id="reply-${r.id}" data-view="reply:${r.id}" onclick="rcClick(event,'${r.id}')">
    <div class="pc-row">
      ${pcAvatarHtml(r.profile)}
      <div class="pc-main">
        ${parent ? `<div class="rc-reply-tag">Replying to ${pcNameHtml(parent.profile)}</div>` : ''}
        <div class="ph">
          ${pcNameHtml(r.profile)}
          <span class="dt" data-dt="${r.id}">${timeAgo(r.created_at)}${editedSuffix(r)}</span>
          ${postMenuHtml(postId, r.id, r.author_id, null, r.created_at)}
        </div>
        <div class="pb" data-pb="${r.id}">${renderBodyToggle(r.body)}</div>
        ${renderMedia(r.media_url, r.media_type, '', r)}
        ${postActionsHtml(r, { replyOnclick: `toggleReplyBox('${r.id}')`, replyCount: kids.length, bookmarkable: false, repostable: false, isReply: true })}
      </div>
    </div>
  </div>
  <div class="rc-inline-compose" id="rf-inline-${r.id}" data-requires-auth style="display:none;">
    <div class="rc-parent-tag">Replying to ${pcNameHtml(r.profile)}</div>
    <textarea id="rf-inline-body-${r.id}" maxlength="500" placeholder="${t('compose.reply')}"></textarea>
    <input type="file" id="rf-inline-file-${r.id}" accept="image/*,video/*">
    <div id="rf-inline-fp-${r.id}" class="fp"></div>
    ${captchaCardHtml(`rf-inline-captcha-${r.id}`)}
    <div class="rfm-row">
      <input type="submit" value="Reply" onclick="submitReply('${r.id}');return false;">
      <span id="rf-inline-st-${r.id}" style="font-size:11px;color:var(--muted);"></span>
    </div>
  </div>
  <div class="rc-children" id="rc-children-${r.id}">
    ${kids.map(k => replyHtml(k, depth + 1)).join('')}
  </div>`;
}

// Toggles the small inline "reply to this comment" composer under a
// given reply. Only one is kept open at a time, mirroring the main
// reply box's collapse behaviour.
function toggleReplyBox(replyId) {
  if (!requireLogin()) return;
  const box = document.getElementById(`rf-inline-${replyId}`);
  if (!box) return;
  const willOpen = !box.classList.contains('open');
  document.querySelectorAll('.rc-inline-compose.open').forEach(b => b.classList.remove('open'));
  if (willOpen) {
    box.classList.add('open');
    if (!box.dataset.wired) {
      wireFilePreview(`rf-inline-file-${replyId}`, `rf-inline-fp-${replyId}`, null);
      box.dataset.wired = '1';
    }
    box.querySelector('textarea')?.focus();
  }
}

async function submitReply(parentReplyId = currentFocusedReplyId()) {
  if (!requireLogin()) return;
  if (currentPost?.reply_audience === 'none') {
    toast('Replies are turned off for this post.', 'error');
    return;
  }
  const suffix   = parentReplyId ? `-${parentReplyId}` : '';
  const bodyEl   = parentReplyId ? document.getElementById(`rf-inline-body-${parentReplyId}`) : document.getElementById('rf-body');
  const fileEl   = parentReplyId ? document.getElementById(`rf-inline-file-${parentReplyId}`) : document.getElementById('rf-file');
  const btn      = parentReplyId ? document.querySelector(`#rf-inline-${parentReplyId} input[type=submit]`) : document.getElementById('rf-btn');
  const stEl     = parentReplyId ? document.getElementById(`rf-inline-st-${parentReplyId}`) : document.getElementById('rf-st');
  const fpEl     = parentReplyId ? document.getElementById(`rf-inline-fp-${parentReplyId}`) : document.getElementById('rf-fp');
  const errEl    = parentReplyId ? null : document.getElementById('rf-err');
  if (errEl) clearErr(errEl);

  const body = (bodyEl?.value || '').trim();
  if (!body) { showErr(errEl, 'Reply cannot be empty.'); return; }
  if (body.length > 500) { showErr(errEl, 'Reply too long (max 500 chars).'); return; }
  if (!enforceCooldown(errEl)) return;
  const captchaId = parentReplyId ? `rf-inline-captcha-${parentReplyId}` : 'rf-captcha';
  if (!ensureCaptchaRevealed(captchaId)) return;
  if (!(await verifyHuman(captchaId, errEl))) return;
  // Text moderation gate — was missing here entirely. This is the same
  // checkTextModeration() call every other composer (global compose,
  // the reply popup in common.js) makes; without it, replies posted
  // from a thread page skipped doxxing/toxicity/spam/drug-weapon-
  // language checks completely.
  if (!(await checkTextModeration('chat', body, postId, errEl))) return;

  btn.disabled = true;
  stEl.textContent = 'Posting…';
  try {
    let media_url = null, media_type = null;
    const gifUrl = !parentReplyId ? composeExtras.rf?.gifUrl : null;
    const file = fileEl?.files[0];
    if (gifUrl) {
      media_url = gifUrl; media_type = 'gif';
    } else if (file) {
      if (!validateFile(file, errEl)) { btn.disabled = false; stEl.textContent = ''; return; }
      stEl.textContent = 'Uploading file…';
      ({ media_url, media_type } = await uploadMedia(file, msg => stEl.textContent = msg));
    }
    // media_url present -> insert hidden ('pending') until
    // checkMediaModeration() below flips it, same pattern as
    // submitGlobalCompose()/submitReplyPopup() in common.js. This was
    // missing here, so media posted from a thread page's reply box
    // (main or inline) went straight to 'visible' with NO server-side
    // NSFW/category/CSAM check ever running — the single biggest gap
    // in the whole moderation pipeline, since this is the most-used
    // reply entry point on the site.
    const { data, error } = await sb.from('replies').insert({
      post_id: postId,
      parent_reply_id: parentReplyId,
      author_id: currentSession.user.id,
      body,
      media_url,
      media_type,
      ...(media_url ? { moderation_status: 'pending' } : {}),
    }).select(REPLY_SELECT).single();
    if (error) throw error;

    if (media_url) {
      stEl.textContent = 'Checking upload…';
      const transcript = media_type === 'video' && file ? await transcribeVideoForModeration(file) : '';
      const mod = await checkMediaModeration('replies', data.id, 'reply', media_url, media_type, transcript);
      if (mod.decision === 'block') {
        stEl.textContent = '';
        showErr(errEl, "Your reply was posted but the media didn't pass review, so it's hidden from others.");
      } else if (mod.decision === 'human_review') {
        // Visible already — moderation_media_pipeline.sql's RESTRICTIVE
        // policy deliberately keeps human_review rows public while
        // pending review (only 'blocked'/unchecked 'pending' are
        // actually hidden), so no "wait for review" toast here; it
        // would just be inaccurate. Deploy nsfw-service (see
        // MODERATION_SETUP.md) so most uploads get a real allow/block
        // decision instead of falling back to human_review.
        stEl.textContent = '';
      }
    }

    bodyEl.value = ''; if (fileEl) fileEl.value = '';
    if (fpEl) fpEl.innerHTML = '';
    if (!parentReplyId) resetComposeExtras('rf');
    stEl.textContent = '';
    insertReplyIntoTree(data);
    if (parentReplyId) {
      document.getElementById(`rf-inline-${parentReplyId}`)?.classList.remove('open');
    }
    markPosted();
    startCooldownCountdown(btn, 'Reply');
  } catch (e) {
    showErr(errEl, e.message || 'Failed to post reply.');
    stEl.textContent = '';
  } finally {
    if (postCooldownRemainingMs() <= 0) btn.disabled = false;
  }
}

// Inserts a newly-created reply into both the in-memory tree and the
// DOM, without needing to refetch/re-render everything.
function insertReplyIntoTree(r) {
  if (allReplies.some(x => x.id === r.id)) return; // already there (e.g. our own realtime echo)
  allReplies.push(r);

  const html = replyHtml(r, 0);
  if (r.parent_reply_id) {
    const container = document.getElementById(`rc-children-${r.parent_reply_id}`);
    if (container) { container.insertAdjacentHTML('beforeend', html); return; }
  }

  // No matching parent container on screen right now — either it's a
  // top-level reply to the OP (only relevant in the full-thread view)
  // or a reply to a comment that isn't the one currently focused. In
  // either case it's already saved in `allReplies` above, so it'll
  // show up correctly the moment the view it belongs in is rendered;
  // don't force it into whatever's on screen right now.
  const focusedId = currentFocusedReplyId();
  const belongsHere = focusedId ? r.parent_reply_id === focusedId : !r.parent_reply_id;
  if (!belongsHere) return;

  const list = document.getElementById('replies-list');
  if (!list) return;
  const emptyMsg = list.querySelector(':scope > .no-t');
  if (emptyMsg) emptyMsg.remove();
  list.insertAdjacentHTML('beforeend', html);
}

let threadChannel = null; // see subscribeRealtime() below

function subscribeRealtime() {
  // Without this, every pjax navigation back to a/any thread page
  // (see the DOMContentLoaded handler below) opened one more
  // `thread-<id>` realtime subscription on top of every one already
  // open, forever — each duplicate re-firing its handlers on every
  // new reply/like anywhere in the app. That accumulation is exactly
  // the kind of thing that makes an app feel like it's slowing down
  // the longer you use it. Same fix as board.js's feedChannel.
  if (threadChannel) { sb.removeChannel(threadChannel); threadChannel = null; }
  threadChannel = sb.channel(`thread-${postId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'replies', filter: `post_id=eq.${postId}` }, async payload => {
      if (document.getElementById(`reply-${payload.new.id}`)) return;
      const r = payload.new;
      r.profile = await getProfile(r.author_id);
      insertReplyIntoTree(r);
    })
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'posts', filter: `id=eq.${postId}` }, payload => {
      const p = payload.new;
      const opPost = document.getElementById('op-post');
      if (!opPost) return;
      const lc = opPost.querySelector('.lc');
      if (lc) lc.textContent = fmtCount(p.like_count);
      const bc = opPost.querySelector('.bc');
      if (bc) bc.textContent = fmtCount(p.bookmark_count);
      const repostBtn = opPost.querySelector('.act.repost .act-label');
      if (repostBtn) repostBtn.textContent = fmtCount(p.repost_count);
      const replyLabel = opPost.querySelector('.act.reply .act-label');
      if (replyLabel) replyLabel.textContent = fmtCount(p.reply_count);
    })
    .subscribe();
}

document.addEventListener('DOMContentLoaded', async () => {
  // pjax guard — see the identical comment in js/notifications.js.
  // Recompute postId fresh on every visit (see the comment on its
  // declaration above) instead of trusting whatever it was the first
  // time this file loaded.
  if (document.body.dataset.page !== 'thread') return;
  postId = currentStatusId();
  await authReady; // see auth.js — otherwise cards can render before we know who's logged in
  await loadThread();
  if (postId) subscribeRealtime();
});
