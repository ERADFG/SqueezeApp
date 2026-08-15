-- ============================================================
-- ARTICLES — rich content + "post to promote" support.
-- Run after supabase/articles.sql (and after schema.sql, since
-- this also touches public.posts). Additive/idempotent — safe
-- to re-run.
--
-- Two independent additions:
--
-- 1. articles.content_html — the rich-text body written by the
--    editarticle.html editor (bold/italic/headings/quotes/links
--    and inline images, anywhere in the piece). articles.body
--    stays as a plain-text mirror (editor's innerText) purely so
--    the existing trigram search index and articleExcerpt() row
--    previews keep working unchanged — it is never shown as the
--    actual article content once content_html is set. Nullable:
--    older rows written before this migration have no
--    content_html, and js/common.js's renderArticleContent()
--    falls back to rendering `body` as plain text for those.
--
-- 2. posts.article_id — set when a post is "sharing" an article
--    (either automatically at publish time, or later via the
--    Article page's Post button). The post renders through the
--    exact same postCardHtml() path as any other post, with an
--    X-style article card embedded in place of/alongside its own
--    body — see attachQuotedPosts()'s article-batch-fetch and
--    articleCardHtml() in js/common.js. on delete set null (not
--    cascade): deleting the article shouldn't delete someone's
--    post, just drop the dead embed.
-- ============================================================

alter table public.articles add column if not exists content_html text;

alter table public.posts
  add column if not exists article_id uuid references public.articles(id) on delete set null;

create index if not exists posts_article_idx on public.posts(article_id) where article_id is not null;
