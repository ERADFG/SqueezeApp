// ─────────────────────────────────────────────────────────────
// SINGLE ARTICLE PAGE — /i/articles/<uuid> (also reachable via the
// legacy article.html?id=<uuid> form — see currentArticleId() in
// common.js). Shows the article's cover image (if any), title,
// author byline, full body, and Edit/Delete actions for the author
// only — same shape as list.html's hero, minus members/followers
// (an article has exactly one author, nothing to curate or follow).
// ─────────────────────────────────────────────────────────────
const articleId = currentArticleId();
let article = null; // the loaded article row
let isArticleAuthor = false;

async function loadArticle() {
  const contentEl = document.getElementById('article-content');
  if (!articleId) {
    contentEl.innerHTML = `<div id="feed-empty">No Article specified.</div>`;
    return;
  }

  const { data, error } = await sb.from('articles').select('*')
    .eq('id', articleId).eq('is_deleted', false).maybeSingle();
  if (error) { contentEl.innerHTML = `<div class="errmsg">Failed to load Article: ${esc(error.message)}</div>`; return; }
  if (!data) { contentEl.innerHTML = `<div id="feed-empty">This Article doesn't exist, or was deleted.</div>`; return; }
  article = data;

  document.title = `${article.title} — InteractInk`;
  setPageH1(article.title);
  setPageDescription(articleExcerpt(article.body, 200));
  setCanonical(articleUrl(article.id));
  if (article.cover_url) setPageImage(article.cover_url);
  setJsonLd({
    '@context': 'https://schema.org', '@type': 'Article',
    headline: article.title,
    articleBody: article.body,
    datePublished: article.created_at,
    dateModified: article.updated_at,
    url: location.origin + articleUrl(article.id),
    image: article.cover_url || undefined,
  });

  isArticleAuthor = !!(currentSession && article.author_id === currentSession.user.id);

  const { data: author } = await sb.from('profiles')
    .select('username,display_name,avatar_url,verified,verification_type').eq('id', article.author_id).maybeSingle();
  article._author = author;

  renderArticle();
}

function renderArticle() {
  const contentEl = document.getElementById('article-content');
  const authorActions = isArticleAuthor ? `
    <button type="button" class="list-edit-btn" onclick="location.href='editarticle.html?id=${encodeURIComponent(article.id)}'">Edit</button>
    <button type="button" class="list-delete-btn" onclick="deleteArticleConfirm(article.id, article.title)">Delete</button>` : '';
  const shareBtn = currentSession
    ? `<button type="button" class="list-edit-btn" onclick="openShareArticleModal()">Post</button>` : '';

  contentEl.innerHTML = `
    <div class="article-hero">
      ${article.cover_url ? `<img class="article-hero-cover" src="${esc(article.cover_url)}" alt="">` : ''}
      <div class="article-hero-title">${esc(article.title)}</div>
      <div style="display:flex;align-items:flex-start;gap:10px;">
        <div style="flex:1;min-width:0;">
          ${article._author ? `
          <div class="article-hero-byline">
            <a class="who-row" style="padding:0;" href="${profileUrl(article._author.username)}">
              <img class="avatar${avSqClass(article._author)}" style="width:32px;height:32px;" src="${esc(avatarUrl(article._author.avatar_url))}" alt="">
              <span class="who-row-txt">
                <span class="who-row-name">${esc(article._author.display_name || article._author.username)}${vBadge(article._author)}</span>
              </span>
            </a>
          </div>
          <div class="article-hero-meta">${fullDateTime(article.created_at)}${article.updated_at && article.updated_at !== article.created_at ? ' · Edited' : ''}</div>
          ` : ''}
        </div>
        <div class="article-hero-actions">${shareBtn}${authorActions}</div>
      </div>
    </div>
    <div class="article-body">${renderArticleContent(article)}</div>`;
}

// ── SHARE-AS-POST MODAL — lets anyone logged in (not just the
// author) post this Article to their own followers, same idea as
// Quote Post (js/common.js's openQuoteModal()) but embedding an
// Article card (articleCardHtml()) instead of another post. ──
function openShareArticleModal() {
  if (!requireLogin() || !article) return;
  const modal = document.getElementById('modal-share-article');
  if (!modal) return;
  const bodyEl = document.getElementById('sa-body');
  bodyEl.value = '';
  bodyEl.oninput = saUpdateCount;
  saUpdateCount();
  document.getElementById('sa-err').style.display = 'none';
  document.getElementById('sa-preview').innerHTML = articleCardHtml(article);
  const avEl = document.getElementById('sa-avatar');
  if (avEl) avEl.innerHTML = `<img src="${esc(avatarUrl(currentProfile?.avatar_url))}" alt="">`;
  modal.classList.add('open');
  bodyEl.focus();
}
function closeShareArticleModal() {
  document.getElementById('modal-share-article')?.classList.remove('open');
}
function saUpdateCount() {
  const bodyEl = document.getElementById('sa-body');
  const countEl = document.getElementById('sa-count');
  if (!bodyEl || !countEl) return;
  const left = 250 - bodyEl.value.length;
  countEl.textContent = left;
  countEl.classList.toggle('qm-count-warn', left <= 20 && left >= 0);
  countEl.classList.toggle('qm-count-over', left < 0);
}
async function submitShareArticle() {
  if (!article || !requireLogin()) return;
  const bodyEl = document.getElementById('sa-body');
  const errEl = document.getElementById('sa-err');
  const btn = document.getElementById('sa-btn');
  const body = bodyEl.value.trim();
  if (body.length > 250) { showErr(errEl, 'Comment too long (max 250 chars).'); return; }
  if (!ensureCaptchaRevealed('sa-captcha')) return;
  if (!(await verifyHuman('sa-captcha', errEl))) return;
  btn.disabled = true;
  try {
    const { error } = await sb.from('posts').insert({
      author_id: currentSession.user.id,
      body,
      article_id: article.id
    });
    if (error) throw error;
    closeShareArticleModal();
    toast('Posted.');
  } catch (e) {
    showErr(errEl, e.message || 'Could not post this Article.');
  } finally {
    btn.disabled = false;
  }
}
wireStaticModalDismiss('modal-share-article', closeShareArticleModal);

document.addEventListener('DOMContentLoaded', async () => {
  await authReady; // see auth.js — otherwise isArticleAuthor can't be known yet
  loadArticle();
});
