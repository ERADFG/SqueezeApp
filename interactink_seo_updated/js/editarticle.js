// ─────────────────────────────────────────────────────────────
// WRITE / EDIT ARTICLE PAGE — /editarticle.html (create) or
// /editarticle.html?id=<uuid> (edit an existing one you own). Any
// logged-in account can create an article; editing requires being
// its author — enforced both here (redirect if not) and by RLS
// (supabase/articles.sql's articles_update_own policy) as the real
// backstop. Same "?id=" query-param pattern editprofile.html and
// the create-list modal use for reusing one form as both create
// and edit.
//
// The body field is a contenteditable div driven by
// document.execCommand — good enough for the handful of formats
// (bold/italic/underline/headings/quote/lists/links/inline images)
// the toolbar exposes, without pulling in a full editor framework.
// Whatever it produces is treated as untrusted HTML: it's run
// through sanitizeArticleHtml() (js/common.js) before it's saved,
// and again every time it's rendered — see renderArticleContent().
// ─────────────────────────────────────────────────────────────
let eaEditingId = null;
let eaOriginal = null;
let eaSavedRange = null; // selection snapshot, so an async image upload can still insert where the cursor was

function eaGetEditId() {
  return new URLSearchParams(location.search).get('id');
}

// Plain-text article body (old rows, written before content_html
// existed) rendered back into the editor as one <p> per line, so
// editing one doesn't collapse all its line breaks into a single
// paragraph.
function eaPlainTextToHtml(text) {
  const lines = String(text || '').split('\n');
  return lines.map(line => `<p>${esc(line) || '<br>'}</p>`).join('');
}

async function initEditArticle() {
  if (!requireLogin()) return;
  eaWireToolbar();
  eaWireCoverUpload();
  eaEditingId = eaGetEditId();
  if (!eaEditingId) return; // fresh create — form starts blank

  const { data, error } = await sb.from('articles').select('*')
    .eq('id', eaEditingId).eq('is_deleted', false).maybeSingle();
  if (error || !data) {
    toast('Could not load that Article to edit.', 'error');
    location.href = 'articles.html';
    return;
  }
  if (data.author_id !== currentSession.user.id) {
    toast("You can only edit your own Articles.", 'error');
    location.href = articleUrl(data.id);
    return;
  }
  eaOriginal = data;
  document.getElementById('ea-title-hdr').textContent = 'Edit Article';
  document.title = 'Edit Article — InteractInk';
  document.getElementById('ea-title').value = data.title;
  document.getElementById('ea-cover').value = data.cover_url || '';
  document.getElementById('ea-editor').innerHTML = data.content_html && data.content_html.trim()
    ? sanitizeArticleHtml(data.content_html)
    : eaPlainTextToHtml(data.body);
  document.getElementById('ea-submit').textContent = 'Save';
  // Re-sharing on every edit would spam a new post per typo fix —
  // the share option only applies the first time an article is
  // published, from a blank form.
  const shareWrap = document.getElementById('ea-share-wrap');
  if (shareWrap) shareWrap.remove();
  // The bot check gates *publishing new* content, same as every other
  // posting surface — saving edits to an article you already own and
  // already passed the check for isn't a fresh piece of content a bot
  // would be spamming, so don't make an owner re-solve it just to fix a typo.
  const captchaWrap = document.getElementById('ea-captcha-wrap');
  if (captchaWrap) captchaWrap.remove();
}

// ── TOOLBAR ──────────────────────────────────────────────────
function eaWireToolbar() {
  const toolbar = document.getElementById('ea-toolbar');
  const editor = document.getElementById('ea-editor');
  if (!toolbar || !editor) return;

  toolbar.addEventListener('mousedown', e => {
    // Keep focus/selection inside the editor instead of the button
    // stealing it, for every command except "image" (which needs
    // the file dialog, so losing focus there is fine).
    const btn = e.target.closest('.ea-tb-btn');
    if (btn && btn.dataset.cmd !== 'image') e.preventDefault();
  });

  toolbar.addEventListener('click', e => {
    const btn = e.target.closest('.ea-tb-btn');
    if (!btn) return;
    editor.focus();
    eaRunCmd(btn.dataset.cmd);
    eaUpdateToolbarState();
  });

  editor.addEventListener('keyup', eaUpdateToolbarState);
  editor.addEventListener('mouseup', eaUpdateToolbarState);
  document.addEventListener('selectionchange', () => {
    if (document.activeElement === editor) eaUpdateToolbarState();
  });

  const fileInput = document.getElementById('ea-body-img-file');
  fileInput.addEventListener('change', () => eaInsertImageFromFile(fileInput.files[0], fileInput));
}

function eaRunCmd(cmd) {
  switch (cmd) {
    case 'bold': case 'italic': case 'underline':
      document.execCommand(cmd, false, null);
      break;
    case 'h2': eaToggleBlock('H2'); break;
    case 'h3': eaToggleBlock('H3'); break;
    case 'quote': eaToggleBlock('BLOCKQUOTE'); break;
    case 'ul': document.execCommand('insertUnorderedList', false, null); break;
    case 'ol': document.execCommand('insertOrderedList', false, null); break;
    case 'link': eaInsertLink(); break;
    case 'image': eaSaveSelection(); document.getElementById('ea-body-img-file').click(); break;
  }
}

// document.execCommand('formatBlock', ...) toggles awkwardly (it
// only ever sets, never un-sets) — this makes H2/H3/quote behave
// like real toggle buttons: press again on an already-formatted
// block to turn it back into a plain paragraph.
function eaToggleBlock(tag) {
  const sel = window.getSelection();
  const node = sel.anchorNode;
  const block = node && (node.nodeType === 1 ? node : node.parentElement)?.closest('h2,h3,blockquote,p,div');
  const isSame = block && block.tagName === tag;
  document.execCommand('formatBlock', false, isSame ? 'P' : tag);
}

function eaInsertLink() {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed) { toast('Select some text first to turn it into a link.', 'error'); return; }
  const url = prompt('Link URL:', 'https://');
  if (!url) return;
  if (!/^https?:\/\//i.test(url.trim())) { toast('Links need to start with http:// or https://', 'error'); return; }
  document.execCommand('createLink', false, url.trim());
}

function eaUpdateToolbarState() {
  const map = { bold: 'bold', italic: 'italic', underline: 'underline', ul: 'insertUnorderedList', ol: 'insertOrderedList' };
  Object.entries(map).forEach(([cmd, q]) => {
    const btn = document.querySelector(`.ea-tb-btn[data-cmd="${cmd}"]`);
    if (btn) btn.classList.toggle('active', document.queryCommandState(q));
  });
}

function eaSaveSelection() {
  const sel = window.getSelection();
  if (sel && sel.rangeCount) eaSavedRange = sel.getRangeAt(0).cloneRange();
}
function eaRestoreSelection() {
  const editor = document.getElementById('ea-editor');
  const sel = window.getSelection();
  sel.removeAllRanges();
  if (eaSavedRange && editor.contains(eaSavedRange.startContainer)) {
    sel.addRange(eaSavedRange);
  } else {
    // Selection was lost (e.g. editor was empty) — fall back to the end of the editor.
    const r = document.createRange();
    r.selectNodeContents(editor);
    r.collapse(false);
    sel.addRange(r);
  }
}

// Inserts the image at the cursor immediately as a placeholder
// (so the writer sees exactly where it landed) then swaps in the
// uploaded URL once it finishes — this is what makes images
// insertable "anywhere" in the piece rather than only appended at
// the end.
async function eaInsertImageFromFile(file, fileInput) {
  if (!file) return;
  const errEl = document.getElementById('ea-err');
  clearErr(errEl);
  if (!validateFile(file, errEl)) { fileInput.value = ''; return; }

  const editor = document.getElementById('ea-editor');
  editor.focus();
  eaRestoreSelection();

  const placeholderId = `ea-img-${crypto.randomUUID()}`;
  document.execCommand('insertHTML', false,
    `<img id="${placeholderId}" class="ea-img-uploading" src="${URL.createObjectURL(file)}" alt="">`);

  try {
    const { media_url } = await uploadMedia(file);
    const img = document.getElementById(placeholderId);
    if (img) { img.src = media_url; img.classList.remove('ea-img-uploading'); img.removeAttribute('id'); }
  } catch (e) {
    document.getElementById(placeholderId)?.remove();
    toast(e.message || 'Image upload failed.', 'error');
  } finally {
    fileInput.value = '';
  }
}

// ── COVER IMAGE UPLOAD ──────────────────────────────────────
function eaWireCoverUpload() {
  const fileInput = document.getElementById('ea-cover-file');
  fileInput?.addEventListener('change', async () => {
    const file = fileInput.files[0];
    if (!file) return;
    const errEl = document.getElementById('ea-err');
    clearErr(errEl);
    if (!validateFile(file, errEl)) { fileInput.value = ''; return; }
    const btn = document.querySelector('.ea-cover-upload-btn');
    const prevLabel = btn.textContent;
    btn.disabled = true; btn.textContent = 'Uploading…';
    try {
      const { media_url } = await uploadMedia(file);
      document.getElementById('ea-cover').value = media_url;
    } catch (e) {
      showErr(errEl, e.message || 'Cover image upload failed.');
    } finally {
      btn.disabled = false; btn.textContent = prevLabel;
      fileInput.value = '';
    }
  });
}

// ── SUBMIT ───────────────────────────────────────────────────
async function submitArticle() {
  if (!requireLogin()) return;
  const titleEl = document.getElementById('ea-title');
  const coverEl = document.getElementById('ea-cover');
  const editor = document.getElementById('ea-editor');
  const shareEl = document.getElementById('ea-share');
  const shareBodyEl = document.getElementById('ea-share-body');
  const errEl = document.getElementById('ea-err');
  const btn = document.getElementById('ea-submit');
  clearErr(errEl);

  const title = titleEl.value.trim();
  const cover_url = coverEl.value.trim();
  const content_html = sanitizeArticleHtml(editor.innerHTML);
  const body = editor.innerText.replace(/\n{3,}/g, '\n\n').trim();
  const shouldShare = !eaEditingId && !!shareEl && shareEl.checked;

  if (!title) { showErr(errEl, 'Give your article a title.'); return; }
  if (title.length > 120) { showErr(errEl, 'Title is too long (max 120 characters).'); return; }
  if (!body) { showErr(errEl, 'Your article needs some body text.'); return; }
  if (cover_url && !/^https?:\/\//i.test(cover_url)) { showErr(errEl, 'Cover image must be a valid https:// URL.'); return; }
  if (!eaEditingId && !ensureCaptchaRevealed('ea-captcha')) return;
  if (!eaEditingId && !(await verifyHuman('ea-captcha', errEl))) return;

  btn.disabled = true;
  btn.textContent = eaEditingId ? 'Saving…' : 'Publishing…';
  try {
    let articleId;
    if (eaEditingId) {
      const { error } = await sb.from('articles')
        .update({ title, body, content_html, cover_url: cover_url || null })
        .eq('id', eaEditingId);
      if (error) throw error;
      articleId = eaEditingId;
      toast('Article updated.');
    } else {
      const { data, error } = await sb.from('articles').insert({
        title, body, content_html, cover_url: cover_url || null, author_id: currentSession.user.id
      }).select('*').single();
      if (error) throw error;
      articleId = data.id;
      toast('Article published.');
    }

    if (shouldShare) {
      const shareBody = (shareBodyEl?.value || '').trim();
      const { data: post, error: postErr } = await sb.from('posts').insert({
        author_id: currentSession.user.id,
        body: shareBody,
        article_id: articleId
      }).select('*, profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified,verification_type)').single();
      if (!postErr && post) {
        location.href = postUrl(post);
        return;
      }
      // Article itself saved fine even if the share-post failed — don't block on it, just fall through to the article page.
    }
    location.href = articleUrl(articleId);
  } catch (e) {
    showErr(errEl, e.message || 'Failed to save that Article.');
    btn.disabled = false;
    btn.textContent = eaEditingId ? 'Save' : 'Publish';
  }
}

document.addEventListener('DOMContentLoaded', async () => {
  await authReady; // see auth.js — otherwise requireLogin() below can misfire before session is known
  initEditArticle();
});
