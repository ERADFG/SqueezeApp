// ─────────────────────────────────────────────────────────────
// ARTICLES BROWSE PAGE — /articles
// Replaces Lists as the app's second primary sidebar item (Lists
// itself moved into the "···" More menu — see renderSideNav() in
// js/common.js). Any logged-in account can write an article — see
// js/editarticle.js — there's no owner/curator distinction the way
// Lists has. Two tabs: "All Articles" (everyone's, public, no
// account needed to read) and "Your Articles" (this account's own,
// requires login).
// ─────────────────────────────────────────────────────────────
let articlesTab = 'all'; // 'all' | 'mine'
let articlesSearchQuery = '';
const ARTICLES_PAGE_SIZE = 10;
let articlesPage = { all: 1, mine: 1 };

function switchArticlesTab(tab) {
  if (tab === articlesTab) return;
  articlesTab = tab;
  articlesPage[tab] = 1;
  document.getElementById('atab-all').classList.toggle('active', tab === 'all');
  document.getElementById('atab-mine').classList.toggle('active', tab === 'mine');
  renderArticles();
}

function gotoArticlesPage(n) {
  articlesPage[articlesTab] = n;
  renderArticles();
  document.getElementById('articles-list')?.scrollIntoView({ block: 'start', behavior: 'smooth' });
}

function goWriteArticle() {
  if (!requireLogin()) return;
  location.href = 'editarticle.html';
}

async function renderArticles() {
  const listEl = document.getElementById('articles-list');
  listEl.innerHTML = skeletonFeedHtml();

  if (articlesTab === 'mine' && !currentSession) {
    listEl.innerHTML = `<div class="post-login-gate" style="border-top:none;">You need an account to write and view your own Articles. <a href="login.html">Log in</a> or <a href="signup.html">create an account</a>.</div>`;
    return;
  }

  const q = articlesSearchQuery.trim();
  const page = articlesPage[articlesTab];

  let query = sb.from('articles').select('*', { count: 'exact' }).eq('is_deleted', false);
  if (articlesTab === 'mine') query = query.eq('author_id', currentSession.user.id);
  if (q) query = query.or(`title.ilike.%${q}%,body.ilike.%${q}%`);

  const { data, error, count } = await query
    .order('created_at', { ascending: false })
    .range((page - 1) * ARTICLES_PAGE_SIZE, page * ARTICLES_PAGE_SIZE - 1);

  if (error) { listEl.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
  const rows = data || [];

  if (!rows.length) {
    listEl.innerHTML = q
      ? `<div id="feed-empty">No Articles found for &ldquo;${esc(articlesSearchQuery.trim())}&rdquo;.</div>`
      : articlesTab === 'mine'
        ? `<div id="feed-empty">You haven't written any Articles yet. Tap &ldquo;+ Write&rdquo; to publish your first one.</div>`
        : `<div id="feed-empty">No Articles have been published yet.</div>`;
    return;
  }

  const authorIds = [...new Set(rows.map(a => a.author_id))];
  const { data: authors } = await sb.from('profiles').select('id,username,display_name,avatar_url,verified,verification_type').in('id', authorIds);
  const authorById = new Map((authors || []).map(a => [a.id, a]));

  const totalPages = Math.max(1, Math.ceil((count || 0) / ARTICLES_PAGE_SIZE));
  listEl.innerHTML = `<div class="article-list">` +
    rows.map(a => articleRowHtml(a, authorById.get(a.author_id))).join('') +
    `</div>` +
    pagerHtml(page, totalPages, 'gotoArticlesPage');
}

// Debounced so every keystroke doesn't refetch.
let _articlesSearchDebounce = null;
function wireArticlesSearch() {
  const input = document.getElementById('articles-search');
  if (!input) return;
  input.addEventListener('input', () => {
    clearTimeout(_articlesSearchDebounce);
    _articlesSearchDebounce = setTimeout(() => {
      articlesSearchQuery = input.value;
      articlesPage[articlesTab] = 1;
      renderArticles();
    }, 250);
  });
}

document.addEventListener('DOMContentLoaded', async () => {
  if (document.body.dataset.page !== 'articles') return; // see js/notifications.js
  await authReady; // see auth.js — otherwise this can render before we know who's logged in
  wireArticlesSearch();
  renderArticles();
});
