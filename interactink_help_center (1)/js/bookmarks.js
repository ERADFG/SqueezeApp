// ─────────────────────────────────────────────────────────────
// BOOKMARKS PAGE — /bookmarks.html (requires login)
// ─────────────────────────────────────────────────────────────
async function loadBookmarks() {
  const feedEl = document.getElementById('feed-posts');
  const { data: { session } } = await sb.auth.getSession();

  if (!session) {
    feedEl.innerHTML = `<div class="post-login-gate" style="border-top:none;">You need an account to save bookmarks. <a href="login.html">Log in</a> or <a href="signup.html">sign up</a>.</div>`;
    return;
  }

  await ensureFeedPrereqsLoaded();

  const { data, error } = await sb.from('bookmarks')
    .select('post:posts(*, profile:profiles!posts_author_id_fkey(username,display_name,avatar_url,verified,verification_type))')
    .eq('user_id', session.user.id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) { feedEl.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }

  const posts = (data || []).map(row => row.post).filter(p => p && !p.is_deleted);
  if (!posts.length) {
    feedEl.innerHTML = `<div id="feed-empty">No bookmarks yet. Tap the bookmark icon on any post to save it here.</div>`;
    return;
  }
  await attachQuotedPosts(posts);
  feedEl.innerHTML = posts.map(p => postCardHtml(p)).join('');
}

document.addEventListener('DOMContentLoaded', async () => {
  await authReady; // see auth.js — otherwise cards can render before we know who's logged in
  loadBookmarks();
});
