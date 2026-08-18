// ─────────────────────────────────────────────────────────────
// ADMIN PANEL — /admin (admin.html). Tabs: Users, Posts, Replies,
// Articles, Reports. Gated two ways:
//   1) Client-side here: hides the page and bounces anyone who
//      isn't an admin, so a stranger who finds the URL just sees a
//      blank "redirecting" page.
//   2) Database-side, which is the part that actually matters:
//      every action below calls an RPC (admin_verify_user /
//      admin_suspend_user / admin_unsuspend_user / admin_delete_post /
//      admin_delete_reply / admin_delete_article / admin_list_reports /
//      admin_set_report_status) that re-checks is_admin() itself
//      before doing anything — see supabase/admin_panel_advanced.sql.
//      Even if someone bypassed this file entirely and called the
//      API directly, the database would still refuse them. That's
//      the real lock; this file is just the UI in front of it.
// ─────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', async () => {
  await authReady;

  if (!currentSession) {
    location.href = 'login.html';
    return;
  }

  const { data: isAdmin, error } = await sb.rpc('is_admin');
  if (error || !isAdmin) {
    // Not an admin account — don't even hint the page exists.
    location.href = '/';
    return;
  }

  document.getElementById('admin-gate').style.display = 'none';
  document.getElementById('admin-panel').style.display = '';

  loadStats();
  wireUserSearch();
  wirePostSearch();
  wireReplySearch();
  wireArticleSearch();
  loadRecentPosts();
});

// ── STATS BAR ──

async function loadStats() {
  const box = document.getElementById('adm-stats');
  const { data, error } = await sb.rpc('admin_stats');
  if (error || !data || !data.length) return;
  const s = data[0];
  box.innerHTML = `
    <div class="adm-stat"><b>${s.total_users ?? 0}</b><span>Users</span></div>
    <div class="adm-stat adm-stat-warn"><b>${s.banned_users ?? 0}</b><span>Suspended</span></div>
    <div class="adm-stat"><b>${s.total_posts ?? 0}</b><span>Posts</span></div>
    <div class="adm-stat"><b>${s.total_articles ?? 0}</b><span>Articles</span></div>
    <div class="adm-stat ${s.open_reports ? 'adm-stat-warn' : ''}"><b>${s.open_reports ?? 0}</b><span>Open Reports</span></div>`;
  const badge = document.getElementById('adm-reports-badge');
  if (s.open_reports) { badge.textContent = s.open_reports; badge.style.display = ''; }
  else { badge.style.display = 'none'; }
}

// ── TABS ──

function switchAdminTab(tab) {
  document.querySelectorAll('.adm-tab').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.adm-panel').forEach(p => p.classList.toggle('active', p.id === `adm-panel-${tab}`));
  if (tab === 'replies' && !repliesLoadedOnce) { repliesLoadedOnce = true; loadRecentReplies(); }
  if (tab === 'articles' && !articlesLoadedOnce) { articlesLoadedOnce = true; loadRecentArticles(); }
  if (tab === 'reports' && !reportsLoadedOnce) { reportsLoadedOnce = true; loadReports(); }
}
let repliesLoadedOnce = false, articlesLoadedOnce = false, reportsLoadedOnce = false;

// ── USERS: search by username, verify/unverify, suspend/unsuspend ──

let userSearchTimer = null;
function wireUserSearch() {
  const input = document.getElementById('adm-user-q');
  input.addEventListener('input', () => {
    clearTimeout(userSearchTimer);
    userSearchTimer = setTimeout(() => runUserSearch(input.value.trim()), 300);
  });
}

async function runUserSearch(q) {
  const box = document.getElementById('adm-user-results');
  if (!q) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="no-t">Searching&hellip;</div>`;

  const { data, error } = await sb.from('profiles')
    .select('id,username,display_name,avatar_url,verified,verification_type,banned,suspend_reason,suspended_until')
    .or(`username.ilike.%${q}%,display_name.ilike.%${q}%`)
    .limit(15);

  if (error) { box.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
  if (!data || !data.length) { box.innerHTML = `<div class="no-t">No users found.</div>`; return; }

  box.innerHTML = data.map(adminUserRowHtml).join('');
}

function suspendMetaHtml(p) {
  if (!p.banned) return '';
  const until = p.suspended_until ? `until ${new Date(p.suspended_until).toLocaleString()}` : 'permanently';
  const reason = p.suspend_reason ? ` &mdash; ${esc(p.suspend_reason)}` : '';
  return `<span class="adm-row-meta">Suspended ${until}${reason}</span>`;
}

// Badge type picker shown per user row. "" = not verified; otherwise
// one of the verification_type values the DB constraint allows
// (see admin_verify_user() in supabase/admin_panel_advanced.sql).
// Selecting a value calls adminSetVerification() directly from the
// <select>'s onchange — no separate confirm step, mirroring how the
// old single Verify/Unverify button worked.
const VERIFY_TYPES = [
  { value: '', label: 'Not verified' },
  { value: 'blue', label: 'Blue' },
  { value: 'gold', label: 'Gold' },
  { value: 'purple', label: 'Purple' },
];

function verifySelectHtml(p) {
  const current = p.verified ? (p.verification_type || 'purple') : '';
  const opts = VERIFY_TYPES.map(t =>
    `<option value="${t.value}" ${t.value === current ? 'selected' : ''}>${t.label}</option>`
  ).join('');
  return `<select class="adm-verify-select" aria-label="Verification badge" onchange="adminSetVerification('${p.id}', this.value)">${opts}</select>`;
}

function adminUserRowHtml(p) {
  const uname = p.username || 'unknown';
  const name = esc(p.display_name || uname);
  return `
  <div class="adm-row" id="adm-user-${p.id}">
    <a href="${profileUrl(uname)}" target="_blank" rel="noopener">
      <img class="avatar pfp-md${avSqClass(p)}" src="${esc(avatarUrl(p.avatar_url))}" alt="">
    </a>
    <div class="adm-row-txt">
      <span class="adm-row-name">${name}${vBadge(p)}${p.banned ? '<span class="adm-tag adm-tag-banned">Suspended</span>' : ''}</span>
      <span class="adm-row-handle">@${esc(uname)}</span>
      ${suspendMetaHtml(p)}
    </div>
    <div class="adm-row-acts">
      ${verifySelectHtml(p)}
      ${p.banned
        ? `<button class="adm-btn adm-btn-danger adm-btn-active" onclick="adminUnsuspend('${p.id}', '${esc(uname)}')">Unsuspend</button>`
        : `<button class="adm-btn adm-btn-danger" onclick="openSuspendModal('${p.id}', '${esc(uname)}')">Suspend</button>`}
    </div>
  </div>`;
}

async function adminSetVerification(userId, type) {
  const makeVerified = !!type;
  try {
    const { error } = await sb.rpc('admin_verify_user', {
      target_user_id: userId,
      make_verified: makeVerified,
      p_verification_type: makeVerified ? type : null,
    });
    if (error) throw error;
    toast(makeVerified ? `User verified (${type}).` : 'Verification removed.');
    runUserSearch(document.getElementById('adm-user-q').value.trim());
  } catch (e) {
    toast(e.message || 'Could not update that user.', 'error');
  }
}

// ── SUSPEND MODAL — shared by every tab (Users list, Reports queue) ──

let suspendTarget = null; // { userId, uname }

function openSuspendModal(userId, uname) {
  suspendTarget = { userId, uname };
  document.getElementById('adm-suspend-title').textContent = `Suspend @${uname}?`;
  document.getElementById('adm-suspend-duration').value = 'permanent';
  document.getElementById('adm-suspend-reason').value = '';
  document.getElementById('adm-suspend-bg').classList.add('open');
  lockScroll();
}
function closeSuspendModal() {
  document.getElementById('adm-suspend-bg').classList.remove('open');
  unlockScroll();
  suspendTarget = null;
}

async function confirmSuspend() {
  if (!suspendTarget) return;
  const { userId, uname } = suspendTarget;
  const durationVal = document.getElementById('adm-suspend-duration').value;
  const reason = document.getElementById('adm-suspend-reason').value.trim().slice(0, 500);
  const until = durationVal === 'permanent'
    ? null
    : new Date(Date.now() + Number(durationVal) * 24 * 60 * 60 * 1000).toISOString();

  const btn = document.getElementById('adm-suspend-confirm');
  btn.disabled = true; btn.textContent = 'Suspending…';
  try {
    const { error } = await sb.rpc('admin_suspend_user', { target_user_id: userId, reason: reason || null, until });
    if (error) throw error;
    toast(`@${uname} suspended.`);
    closeSuspendModal();
    runUserSearch(document.getElementById('adm-user-q').value.trim());
    if (document.getElementById('adm-panel-reports').classList.contains('active')) loadReports();
    loadStats();
  } catch (e) {
    toast(e.message || 'Could not suspend that user.', 'error');
  } finally {
    btn.disabled = false; btn.textContent = 'Suspend';
  }
}

async function adminUnsuspend(userId, uname) {
  const ok = await ocConfirm({
    title: `Unsuspend @${uname}?`,
    desc: 'They will immediately be able to log in, post, and reply again.',
    confirmLabel: 'Unsuspend',
    danger: false,
  });
  if (!ok) return;
  try {
    const { error } = await sb.rpc('admin_unsuspend_user', { target_user_id: userId });
    if (error) throw error;
    toast(`@${uname} unsuspended.`);
    runUserSearch(document.getElementById('adm-user-q').value.trim());
    if (document.getElementById('adm-panel-reports').classList.contains('active')) loadReports();
    loadStats();
  } catch (e) {
    toast(e.message || 'Could not unsuspend that user.', 'error');
  }
}

// ── POSTS: recent feed by default, or search by body text / @username ──

let postSearchTimer = null;
function wirePostSearch() {
  const input = document.getElementById('adm-post-q');
  input.addEventListener('input', () => {
    clearTimeout(postSearchTimer);
    postSearchTimer = setTimeout(() => {
      const q = input.value.trim();
      q ? runPostSearch(q) : loadRecentPosts();
    }, 300);
  });
}

let postShowDeleted = false;
function togglePostShowDeleted() {
  postShowDeleted = document.getElementById('adm-post-showdel').checked;
  const q = document.getElementById('adm-post-q').value.trim();
  q ? runPostSearch(q) : loadRecentPosts();
}

async function loadRecentPosts() {
  const box = document.getElementById('adm-post-results');
  box.innerHTML = `<div class="no-t">Loading&hellip;</div>`;
  let query = sb.from('posts')
    .select('id,body,created_at,author_id,is_deleted,profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified,verification_type)')
    .order('created_at', { ascending: false })
    .limit(20);
  if (!postShowDeleted) query = query.eq('is_deleted', false);
  const { data, error } = await query;
  if (error) { box.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
  box.innerHTML = (data || []).map(adminPostRowHtml).join('') || `<div class="no-t">No posts yet.</div>`;
}

async function runPostSearch(q) {
  const box = document.getElementById('adm-post-results');
  box.innerHTML = `<div class="no-t">Searching&hellip;</div>`;
  let query = sb.from('posts')
    .select('id,body,created_at,author_id,is_deleted,profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified,verification_type)')
    .order('created_at', { ascending: false })
    .limit(30);
  if (!postShowDeleted) query = query.eq('is_deleted', false);

  query = q.startsWith('@')
    ? query.ilike('profile.username', `%${q.slice(1)}%`)
    : query.ilike('body', `%${q}%`);

  const { data, error } = await query;
  if (error) { box.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
  const rows = (data || []).filter(p => p.profile); // ilike on a joined column can return null-joins; drop those
  box.innerHTML = rows.map(adminPostRowHtml).join('') || `<div class="no-t">No matching posts.</div>`;
}

function adminPostRowHtml(p) {
  const uname = p.profile?.username || 'unknown';
  const name = esc(p.profile?.display_name || uname);
  return `
  <div class="adm-row adm-post-row${p.is_deleted ? ' adm-row-deleted' : ''}" id="adm-post-${p.id}">
    <img class="avatar pfp-md${avSqClass(p.profile)}" src="${esc(avatarUrl(p.profile?.avatar_url))}" alt="">
    <div class="adm-row-txt">
      <span class="adm-row-name">${name}${vBadge(p.profile)} <span class="adm-row-handle">@${esc(uname)}</span> &middot; <span class="adm-row-dt">${timeAgo(p.created_at)}</span>${p.is_deleted ? '<span class="adm-tag adm-tag-banned">Deleted</span>' : ''}</span>
      <a class="adm-post-body" href="${postUrl(p)}" target="_blank" rel="noopener">${esc((p.body || '').slice(0, 200))}</a>
    </div>
    <div class="adm-row-acts">
      ${p.is_deleted
        ? `<button class="adm-btn adm-btn-primary" onclick="adminRestorePost('${p.id}')">Restore</button>`
        : `<button class="adm-btn adm-btn-danger" onclick="adminDeletePost('${p.id}')">Delete</button>`}
    </div>
  </div>`;
}

async function adminDeletePost(postId) {
  const ok = await ocConfirm({
    title: 'Delete this post?',
    desc: 'This removes it from the site. This cannot be undone from here.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    const { error } = await sb.rpc('admin_delete_post', { post_id: postId });
    if (error) throw error;
    if (postShowDeleted) {
      const q = document.getElementById('adm-post-q').value.trim();
      q ? runPostSearch(q) : loadRecentPosts();
    } else {
      document.getElementById(`adm-post-${postId}`)?.remove();
    }
    toast('Post deleted.');
    loadStats();
  } catch (e) {
    toast(e.message || 'Could not delete that post.', 'error');
  }
}

async function adminRestorePost(postId) {
  try {
    const { error } = await sb.rpc('admin_restore_post', { post_id: postId });
    if (error) throw error;
    const q = document.getElementById('adm-post-q').value.trim();
    q ? runPostSearch(q) : loadRecentPosts();
    toast('Post restored.');
    loadStats();
  } catch (e) {
    toast(e.message || 'Could not restore that post.', 'error');
  }
}

// ── REPLIES (comments): recent feed by default, or search by body / @username ──

let replySearchTimer = null;
function wireReplySearch() {
  const input = document.getElementById('adm-reply-q');
  input.addEventListener('input', () => {
    clearTimeout(replySearchTimer);
    replySearchTimer = setTimeout(() => {
      const q = input.value.trim();
      q ? runReplySearch(q) : loadRecentReplies();
    }, 300);
  });
}

let replyShowDeleted = false;
function toggleReplyShowDeleted() {
  replyShowDeleted = document.getElementById('adm-reply-showdel').checked;
  const q = document.getElementById('adm-reply-q').value.trim();
  q ? runReplySearch(q) : loadRecentReplies();
}

async function loadRecentReplies() {
  const box = document.getElementById('adm-reply-results');
  box.innerHTML = `<div class="no-t">Loading&hellip;</div>`;
  let query = sb.from('replies')
    .select('id,body,created_at,post_id,author_id,is_deleted,profile:profiles(username,display_name,avatar_url,verified,verification_type)')
    .order('created_at', { ascending: false })
    .limit(20);
  if (!replyShowDeleted) query = query.eq('is_deleted', false);
  const { data, error } = await query;
  if (error) { box.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
  box.innerHTML = (data || []).map(adminReplyRowHtml).join('') || `<div class="no-t">No replies yet.</div>`;
}

async function runReplySearch(q) {
  const box = document.getElementById('adm-reply-results');
  box.innerHTML = `<div class="no-t">Searching&hellip;</div>`;
  let query = sb.from('replies')
    .select('id,body,created_at,post_id,author_id,is_deleted,profile:profiles(username,display_name,avatar_url,verified,verification_type)')
    .order('created_at', { ascending: false })
    .limit(30);
  if (!replyShowDeleted) query = query.eq('is_deleted', false);

  query = q.startsWith('@')
    ? query.ilike('profile.username', `%${q.slice(1)}%`)
    : query.ilike('body', `%${q}%`);

  const { data, error } = await query;
  if (error) { box.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
  const rows = (data || []).filter(r => r.profile);
  box.innerHTML = rows.map(adminReplyRowHtml).join('') || `<div class="no-t">No matching replies.</div>`;
}

function adminReplyRowHtml(r) {
  const uname = r.profile?.username || 'unknown';
  const name = esc(r.profile?.display_name || uname);
  return `
  <div class="adm-row adm-post-row${r.is_deleted ? ' adm-row-deleted' : ''}" id="adm-reply-${r.id}">
    <img class="avatar pfp-md${avSqClass(r.profile)}" src="${esc(avatarUrl(r.profile?.avatar_url))}" alt="">
    <div class="adm-row-txt">
      <span class="adm-row-name">${name}${vBadge(r.profile)} <span class="adm-row-handle">@${esc(uname)}</span> &middot; <span class="adm-row-dt">${timeAgo(r.created_at)}</span>${r.is_deleted ? '<span class="adm-tag adm-tag-banned">Deleted</span>' : ''}</span>
      <a class="adm-post-body" href="${postUrlById(r.post_id)}" target="_blank" rel="noopener">${esc((r.body || '').slice(0, 200))}</a>
    </div>
    <div class="adm-row-acts">
      ${r.is_deleted
        ? `<button class="adm-btn adm-btn-primary" onclick="adminRestoreReply('${r.id}')">Restore</button>`
        : `<button class="adm-btn adm-btn-danger" onclick="adminDeleteReply('${r.id}')">Delete</button>`}
    </div>
  </div>`;
}

async function adminDeleteReply(replyId) {
  const ok = await ocConfirm({
    title: 'Delete this reply?',
    desc: 'This removes it from the site. This cannot be undone from here.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    const { error } = await sb.rpc('admin_delete_reply', { reply_id: replyId });
    if (error) throw error;
    if (replyShowDeleted) {
      const q = document.getElementById('adm-reply-q').value.trim();
      q ? runReplySearch(q) : loadRecentReplies();
    } else {
      document.getElementById(`adm-reply-${replyId}`)?.remove();
    }
    toast('Reply deleted.');
    loadStats();
  } catch (e) {
    toast(e.message || 'Could not delete that reply.', 'error');
  }
}

async function adminRestoreReply(replyId) {
  try {
    const { error } = await sb.rpc('admin_restore_reply', { reply_id: replyId });
    if (error) throw error;
    const q = document.getElementById('adm-reply-q').value.trim();
    q ? runReplySearch(q) : loadRecentReplies();
    toast('Reply restored.');
    loadStats();
  } catch (e) {
    toast(e.message || 'Could not restore that reply.', 'error');
  }
}

// ── ARTICLES: recent feed by default, or search by title/body / @username ──

let articleSearchTimer = null;
function wireArticleSearch() {
  const input = document.getElementById('adm-article-q');
  input.addEventListener('input', () => {
    clearTimeout(articleSearchTimer);
    articleSearchTimer = setTimeout(() => {
      const q = input.value.trim();
      q ? runArticleSearch(q) : loadRecentArticles();
    }, 300);
  });
}

let articleShowDeleted = false;
function toggleArticleShowDeleted() {
  articleShowDeleted = document.getElementById('adm-article-showdel').checked;
  const q = document.getElementById('adm-article-q').value.trim();
  q ? runArticleSearch(q) : loadRecentArticles();
}

async function loadRecentArticles() {
  const box = document.getElementById('adm-article-results');
  box.innerHTML = `<div class="no-t">Loading&hellip;</div>`;
  let query = sb.from('articles')
    .select('id,title,created_at,author_id,is_deleted,profile:profiles!articles_author_id_fkey(username,display_name,avatar_url,verified,verification_type)')
    .order('created_at', { ascending: false })
    .limit(20);
  if (!articleShowDeleted) query = query.eq('is_deleted', false);
  const { data, error } = await query;
  if (error) { box.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
  box.innerHTML = (data || []).map(adminArticleRowHtml).join('') || `<div class="no-t">No articles yet.</div>`;
}

async function runArticleSearch(q) {
  const box = document.getElementById('adm-article-results');
  box.innerHTML = `<div class="no-t">Searching&hellip;</div>`;
  let query = sb.from('articles')
    .select('id,title,created_at,author_id,is_deleted,profile:profiles!articles_author_id_fkey(username,display_name,avatar_url,verified,verification_type)')
    .order('created_at', { ascending: false })
    .limit(30);
  if (!articleShowDeleted) query = query.eq('is_deleted', false);

  query = q.startsWith('@')
    ? query.ilike('profile.username', `%${q.slice(1)}%`)
    : query.or(`title.ilike.%${q}%,body.ilike.%${q}%`);

  const { data, error } = await query;
  if (error) { box.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
  const rows = (data || []).filter(a => a.profile);
  box.innerHTML = rows.map(adminArticleRowHtml).join('') || `<div class="no-t">No matching articles.</div>`;
}

function adminArticleRowHtml(a) {
  const uname = a.profile?.username || 'unknown';
  const name = esc(a.profile?.display_name || uname);
  return `
  <div class="adm-row adm-post-row${a.is_deleted ? ' adm-row-deleted' : ''}" id="adm-article-${a.id}">
    <img class="avatar pfp-md${avSqClass(a.profile)}" src="${esc(avatarUrl(a.profile?.avatar_url))}" alt="">
    <div class="adm-row-txt">
      <span class="adm-row-name">${name}${vBadge(a.profile)} <span class="adm-row-handle">@${esc(uname)}</span> &middot; <span class="adm-row-dt">${timeAgo(a.created_at)}</span>${a.is_deleted ? '<span class="adm-tag adm-tag-banned">Deleted</span>' : ''}</span>
      <a class="adm-post-body" href="${articleUrl(a.id)}" target="_blank" rel="noopener">${esc(a.title || '(untitled)')}</a>
    </div>
    <div class="adm-row-acts">
      ${a.is_deleted
        ? `<button class="adm-btn adm-btn-primary" onclick="adminRestoreArticle('${a.id}')">Restore</button>`
        : `<button class="adm-btn adm-btn-danger" onclick="adminDeleteArticle('${a.id}')">Delete</button>`}
    </div>
  </div>`;
}

async function adminDeleteArticle(articleId) {
  const ok = await ocConfirm({
    title: 'Delete this article?',
    desc: 'This removes it from the site. This cannot be undone from here.',
    confirmLabel: 'Delete',
    danger: true,
  });
  if (!ok) return;
  try {
    const { error } = await sb.rpc('admin_delete_article', { article_id: articleId });
    if (error) throw error;
    if (articleShowDeleted) {
      const q = document.getElementById('adm-article-q').value.trim();
      q ? runArticleSearch(q) : loadRecentArticles();
    } else {
      document.getElementById(`adm-article-${articleId}`)?.remove();
    }
    toast('Article deleted.');
    loadStats();
  } catch (e) {
    toast(e.message || 'Could not delete that article.', 'error');
  }
}

async function adminRestoreArticle(articleId) {
  try {
    const { error } = await sb.rpc('admin_restore_article', { article_id: articleId });
    if (error) throw error;
    const q = document.getElementById('adm-article-q').value.trim();
    q ? runArticleSearch(q) : loadRecentArticles();
    toast('Article restored.');
    loadStats();
  } catch (e) {
    toast(e.message || 'Could not restore that article.', 'error');
  }
}

// ── REPORTS: the moderation queue — read/resolved via SECURITY DEFINER RPCs ──

let currentReportFilter = 'open';
function setReportFilter(status) {
  currentReportFilter = status;
  document.querySelectorAll('#adm-report-filters .adm-btn').forEach(b => b.classList.toggle('adm-btn-active', b.dataset.status === status));
  loadReports();
}

async function loadReports() {
  const box = document.getElementById('adm-report-results');
  box.innerHTML = `<div class="no-t">Loading&hellip;</div>`;
  const { data, error } = await sb.rpc('admin_list_reports', { status_filter: currentReportFilter });
  if (error) { box.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
  box.innerHTML = (data || []).map(adminReportRowHtml).join('') || `<div class="no-t">No reports here.</div>`;
}

function adminReportRowHtml(r) {
  // Whoever's actually responsible: a direct user report, or the
  // author of the reported post/reply. A community report has no
  // single person behind it, so targetId stays unset for those (no
  // Suspend button — see below).
  const targetId = r.reported_user_id || r.post_author_id || r.reply_author_id;
  const targetUname = r.reported_username || r.post_author_username || r.reply_author_username || (r.community_id ? null : 'unknown');
  const reportedLabel = r.community_id ? `Reported: ${esc(r.community_name || 'a community')}` : `Reported: @${esc(targetUname)}`;

  let contentLine = '';
  if (r.post_id) {
    contentLine = `<a class="adm-post-body" href="${postUrlById(r.post_id, r.post_author_username)}" target="_blank" rel="noopener">Post: ${esc((r.post_body || '').slice(0, 160))}</a>`;
  } else if (r.reply_id) {
    contentLine = `<a class="adm-post-body" href="${postUrlById(r.reply_id)}" target="_blank" rel="noopener">Reply: ${esc((r.reply_body || '').slice(0, 160))}</a>`;
  } else if (r.community_id) {
    contentLine = `<a class="adm-post-body" href="${communityUrl(r.community_slug || '')}" target="_blank" rel="noopener">Community: ${esc(r.community_name || 'unknown')}</a>`;
  }

  const tagClass = r.status === 'open' ? 'adm-tag-open' : r.status === 'actioned' ? 'adm-tag-actioned' : 'adm-tag-dismissed';

  return `
  <div class="adm-row adm-post-row" id="adm-report-${r.id}">
    <div class="adm-row-txt">
      <span class="adm-row-name">${reportedLabel}<span class="adm-tag ${tagClass}">${esc(r.status)}</span></span>
      <span class="adm-row-meta">Reason: ${esc(r.reason || '(none given)')}${r.details ? ' &mdash; ' + esc(r.details) : ''}</span>
      <span class="adm-row-meta">Reported by @${esc(r.reporter_username || 'unknown')} &middot; ${timeAgo(r.created_at)}</span>
      ${contentLine}
    </div>
    <div class="adm-row-acts">
      ${targetId ? `<button class="adm-btn adm-btn-danger" onclick="openSuspendModal('${targetId}', '${esc(targetUname)}')">Suspend</button>` : ''}
      ${r.status !== 'actioned' ? `<button class="adm-btn adm-btn-primary" onclick="resolveReport('${r.id}', 'actioned')">Mark actioned</button>` : ''}
      ${r.status !== 'dismissed' ? `<button class="adm-btn" onclick="resolveReport('${r.id}', 'dismissed')">Dismiss</button>` : ''}
    </div>
  </div>`;
}

async function resolveReport(reportId, status) {
  try {
    const { error } = await sb.rpc('admin_set_report_status', { report_id: reportId, new_status: status });
    if (error) throw error;
    toast(status === 'actioned' ? 'Report marked actioned.' : 'Report dismissed.');
    loadReports();
    loadStats();
  } catch (e) {
    toast(e.message || 'Could not update that report.', 'error');
  }
}
