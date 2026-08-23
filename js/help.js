// ─────────────────────────────────────────────────────────────
// HELP CENTER — search typeahead, in-article "On this page" nav,
// reading time, and the "Was this helpful?" widget. Loaded on every
// page under /help/. Pure progressive enhancement: every page works
// fine with this script absent, it just adds polish.
// ─────────────────────────────────────────────────────────────

const HELP_ARTICLES = [
{"title":"Changing your username","desc":"How to update the @handle attached to your InteractInk account, and what happens to your old one.","url":"/help/managing-your-account/change-your-username.html","cat":"account","catLabel":"Managing your account"},
{"title":"Changing your display language","desc":"How to switch which language InteractInk's interface is shown in.","url":"/help/managing-your-account/changing-your-language.html","cat":"account","catLabel":"Managing your account"},
{"title":"Creating an InteractInk account","desc":"How to sign up for InteractInk with an email address, username, and password.","url":"/help/managing-your-account/create-an-account.html","cat":"account","catLabel":"Managing your account"},
{"title":"Deactivating your account","desc":"What happens when you deactivate your InteractInk account, and how to come back.","url":"/help/managing-your-account/deactivating-your-account.html","cat":"account","catLabel":"Managing your account"},
{"title":"Downloading your data","desc":"How to request and download an archive of your InteractInk account data.","url":"/help/managing-your-account/downloading-your-data.html","cat":"account","catLabel":"Managing your account"},
{"title":"Customizing your profile","desc":"How to update your display name, bio, avatar, banner, and profile links.","url":"/help/managing-your-account/how-to-customize-your-profile.html","cat":"account","catLabel":"Managing your account"},
{"title":"Fixing login issues","desc":"What to try if you can't sign in to your InteractInk account.","url":"/help/managing-your-account/login-issues.html","cat":"account","catLabel":"Managing your account"},
{"title":"Notification settings","desc":"How to control which notifications you receive and where.","url":"/help/managing-your-account/notification-settings.html","cat":"account","catLabel":"Managing your account"},
{"title":"Resetting a forgotten password","desc":"How to reset your password if you can't remember it.","url":"/help/managing-your-account/resetting-a-forgotten-password.html","cat":"account","catLabel":"Managing your account"},
{"title":"Updating your email address","desc":"How to change the email address associated with your account.","url":"/help/managing-your-account/update-your-email-address.html","cat":"account","catLabel":"Managing your account"},
{"title":"Accessibility features","desc":"Accessibility tools built into InteractInk, including screen reader support and alt text.","url":"/help/resources/accessibility-features.html","cat":"resources","catLabel":"Resources"},
{"title":"Contacting support","desc":"How to get in touch with InteractInk support when the Help Center doesn't answer your question.","url":"/help/resources/contacting-support.html","cat":"resources","catLabel":"Resources"},
{"title":"Glossary","desc":"Definitions of common terms used across InteractInk.","url":"/help/resources/glossary.html","cat":"resources","catLabel":"Resources"},
{"title":"How recommendations work","desc":"An overview of how InteractInk decides what to show you in your feeds.","url":"/help/resources/how-recommendations-work.html","cat":"resources","catLabel":"Resources"},
{"title":"Keeping InteractInk safe","desc":"An overview of the tools and teams that keep InteractInk safe.","url":"/help/resources/keeping-interactink-safe.html","cat":"resources","catLabel":"Resources"},
{"title":"New user guide","desc":"A quick-start guide for people who are new to InteractInk.","url":"/help/resources/new-user-guide.html","cat":"resources","catLabel":"Resources"},
{"title":"Spam and platform manipulation","desc":"What counts as spam or platform manipulation on InteractInk, and how it's enforced.","url":"/help/rules-and-policies/spam-and-platform-manipulation.html","cat":"rules","catLabel":"Rules and policies"},
{"title":"Abusive behavior and harassment policy","desc":"What InteractInk considers abusive behavior and harassment, and how reports are handled.","url":"/help/rules-and-policies/abusive-behavior-and-harassment-policy.html","cat":"rules","catLabel":"Rules and policies"},
{"title":"Impersonation policy","desc":"What counts as impersonation on InteractInk and how to report it.","url":"/help/rules-and-policies/impersonation-policy.html","cat":"rules","catLabel":"Rules and policies"},
{"title":"Copyright and DMCA policy","desc":"How InteractInk handles copyright complaints and DMCA takedown requests.","url":"/help/rules-and-policies/copyright-and-dmca-policy.html","cat":"rules","catLabel":"Rules and policies"},
{"title":"Appealing a suspension","desc":"How to appeal an account suspension or enforcement action on InteractInk.","url":"/help/rules-and-policies/appealing-a-suspension.html","cat":"rules","catLabel":"Rules and policies"},
{"title":"Intellectual property and trademark","desc":"How InteractInk handles trademark complaints and intellectual property claims.","url":"/help/rules-and-policies/intellectual-property-and-trademark.html","cat":"rules","catLabel":"Rules and policies"},
{"title":"Child sexual exploitation policy","desc":"InteractInk's zero-tolerance policy on child sexual exploitation and how to report it.","url":"/help/rules-and-policies/child-sexual-exploitation-policy.html","cat":"rules","catLabel":"Rules and policies"},
{"title":"Hateful conduct policy","desc":"What InteractInk considers hateful conduct and how it's enforced.","url":"/help/rules-and-policies/hateful-conduct-policy.html","cat":"rules","catLabel":"Rules and policies"},
{"title":"Community rules overview","desc":"A summary of the core rules that apply everywhere on InteractInk.","url":"/help/rules-and-policies/community-rules-overview.html","cat":"rules","catLabel":"Rules and policies"},
{"title":"Enforcement and suspensions","desc":"How InteractInk enforces its rules, from warnings to permanent suspension.","url":"/help/rules-and-policies/enforcement-and-suspensions.html","cat":"rules","catLabel":"Rules and policies"},
{"title":"Account security tips","desc":"Steps you can take to keep your InteractInk account secure.","url":"/help/safety-and-security/account-security-tips.html","cat":"safety","catLabel":"Safety and security"},
{"title":"Blocking accounts","desc":"How blocking works on InteractInk and what a blocked account can and can't see.","url":"/help/safety-and-security/blocking-accounts.html","cat":"safety","catLabel":"Safety and security"},
{"title":"Child safety","desc":"How InteractInk approaches child safety and where to report concerns.","url":"/help/safety-and-security/child-safety.html","cat":"safety","catLabel":"Safety and security"},
{"title":"Muting accounts","desc":"How muting works on InteractInk and how it's different from blocking.","url":"/help/safety-and-security/muting-accounts.html","cat":"safety","catLabel":"Safety and security"},
{"title":"Public and private accounts","desc":"The difference between a public and a private account on InteractInk.","url":"/help/safety-and-security/public-and-private-accounts.html","cat":"safety","catLabel":"Safety and security"},
{"title":"Recognizing phishing and fake emails","desc":"How to spot emails that aren't really from InteractInk.","url":"/help/safety-and-security/recognizing-phishing-and-fake-emails.html","cat":"safety","catLabel":"Safety and security"},
{"title":"Reporting a post","desc":"How to report a post that breaks InteractInk's rules.","url":"/help/safety-and-security/reporting-a-post.html","cat":"safety","catLabel":"Safety and security"},
{"title":"Reporting an account or impersonation","desc":"How to report an account, including one impersonating you or someone else.","url":"/help/safety-and-security/reporting-an-account-or-impersonation.html","cat":"safety","catLabel":"Safety and security"},
{"title":"Self-harm and suicide resources","desc":"Resources and how InteractInk handles posts related to self-harm and suicide.","url":"/help/safety-and-security/self-harm-and-suicide-resources.html","cat":"safety","catLabel":"Safety and security"},
{"title":"Sensitive media settings","desc":"How to control whether sensitive media is shown to you, and how to mark your own media as sensitive.","url":"/help/safety-and-security/sensitive-media-settings.html","cat":"safety","catLabel":"Safety and security"},
{"title":"Writing and reading Articles","desc":"How the long-form Articles feature works on InteractInk.","url":"/help/using-interactink/articles-feature.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"Saving posts with Bookmarks","desc":"How to save a post to look at later using Bookmarks.","url":"/help/using-interactink/bookmarks.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"About Communities","desc":"What Communities are on InteractInk and how to join one.","url":"/help/using-interactink/communities.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"Creating and managing a Community","desc":"How to create your own Community on InteractInk and manage its members.","url":"/help/using-interactink/creating-a-community.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"How to delete a post","desc":"How to permanently remove a post you've published.","url":"/help/using-interactink/delete-a-post.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"Sending Direct Messages","desc":"How to send a private Direct Message to another InteractInk user.","url":"/help/using-interactink/direct-messages.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"Editing a post and the undo timer","desc":"How to edit a post after publishing, and how the short undo window works.","url":"/help/using-interactink/edit-post-and-undo.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"About end-to-end encrypted messages","desc":"How end-to-end encryption protects your Direct Messages on InteractInk.","url":"/help/using-interactink/encrypted-messages.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"About your For You and Following feeds","desc":"The difference between the For You and Following feeds on your Home timeline.","url":"/help/using-interactink/for-you-and-following-feed.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"Group chats and channels","desc":"How group chats and broadcast channels work on InteractInk.","url":"/help/using-interactink/group-chats-and-channels.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"How to follow and unfollow someone","desc":"How to follow, unfollow, and manage who you follow on InteractInk.","url":"/help/using-interactink/how-to-follow-and-unfollow.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"How to post on InteractInk","desc":"Learn how to write and publish a post on InteractInk, from your home feed or your profile.","url":"/help/using-interactink/how-to-post.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"Liking posts","desc":"How to like a post and see who's liked yours.","url":"/help/using-interactink/liking-posts.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"About Lists","desc":"How to create and use Lists to organize accounts you follow.","url":"/help/using-interactink/lists.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"Mentions and @replies","desc":"How mentioning someone with @ works, and how to manage who can reply to you.","url":"/help/using-interactink/mentions-and-replies.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"Understanding your notifications","desc":"A guide to the different kinds of notifications InteractInk sends you.","url":"/help/using-interactink/notifications-overview.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"Creating and voting in polls","desc":"How to attach a poll to a post and how voting works.","url":"/help/using-interactink/polls.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"Posting GIFs, images, and video","desc":"How to attach GIFs, images, and video to a post.","url":"/help/using-interactink/posting-gifs-images-and-video.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"Read receipts and typing indicators","desc":"How read receipts and typing indicators work in chats on InteractInk.","url":"/help/using-interactink/read-receipts-and-typing-indicators.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"Replying and creating threads","desc":"How to reply to a post and how threads are displayed.","url":"/help/using-interactink/replying-and-threads.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"Reposts and quote posts","desc":"The difference between a repost and a quote post, and how to do each.","url":"/help/using-interactink/reposts-and-quote-posts.html","cat":"using","catLabel":"Using InteractInk"},
{"title":"Searching InteractInk","desc":"How to search for people, posts, and communities on InteractInk.","url":"/help/using-interactink/search.html","cat":"using","catLabel":"Using InteractInk"}
];

(function () {
  'use strict';

  function escapeHtml(s) {
    return s.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  // ── search typeahead (Help Center home) ──────────────────────────
  function initSearch() {
    const input = document.getElementById('help-search-input');
    if (!input) return;
    const box = input.closest('.help-search-box');
    const results = document.getElementById('help-search-results');
    const clearBtn = document.getElementById('help-search-clear');
    let activeIndex = -1;
    let currentMatches = [];

    function score(article, q) {
      const t = article.title.toLowerCase();
      const d = article.desc.toLowerCase();
      if (t.startsWith(q)) return 100;
      if (t.includes(q)) return 70;
      if (d.includes(q)) return 40;
      return 0;
    }

    function render(q) {
      const query = q.trim().toLowerCase();
      box.classList.toggle('has-query', query.length > 0);
      if (!query) {
        results.classList.remove('open');
        results.innerHTML = '';
        currentMatches = [];
        return;
      }
      currentMatches = HELP_ARTICLES
        .map(a => ({ a, s: score(a, query) }))
        .filter(x => x.s > 0)
        .sort((x, y) => y.s - x.s)
        .slice(0, 8)
        .map(x => x.a);

      activeIndex = -1;
      if (!currentMatches.length) {
        results.innerHTML = '<div class="help-search-empty">No results for &ldquo;' + escapeHtml(q.trim()) + '&rdquo;</div>';
      } else {
        results.innerHTML = currentMatches.map(a =>
          '<a class="help-search-result" href="' + a.url + '" data-cat="' + a.cat + '" role="option">' +
            '<span class="dot"></span>' +
            '<span class="txt"><strong>' + escapeHtml(a.title) + '</strong><span>' + escapeHtml(a.desc) + '</span></span>' +
            '<span class="cat-label">' + escapeHtml(a.catLabel) + '</span>' +
          '</a>'
        ).join('');
      }
      results.classList.add('open');
    }

    input.addEventListener('input', () => render(input.value));
    input.addEventListener('focus', () => { if (input.value.trim()) results.classList.add('open'); });

    input.addEventListener('keydown', (e) => {
      const items = Array.from(results.querySelectorAll('.help-search-result'));
      if (e.key === 'ArrowDown' && items.length) {
        e.preventDefault();
        activeIndex = Math.min(activeIndex + 1, items.length - 1);
        items.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
        items[activeIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'ArrowUp' && items.length) {
        e.preventDefault();
        activeIndex = Math.max(activeIndex - 1, 0);
        items.forEach((el, i) => el.classList.toggle('active', i === activeIndex));
        items[activeIndex].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (activeIndex >= 0 && items[activeIndex]) {
          window.location.href = items[activeIndex].getAttribute('href');
        } else if (currentMatches.length) {
          window.location.href = currentMatches[0].url;
        }
      } else if (e.key === 'Escape') {
        results.classList.remove('open');
        input.blur();
      }
    });

    clearBtn && clearBtn.addEventListener('click', () => {
      input.value = '';
      render('');
      input.focus();
    });

    document.addEventListener('click', (e) => {
      if (!e.target.closest('.help-search-wrap')) results.classList.remove('open');
    });

    // deep-link support: /help/index.html?q=notifications
    const params = new URLSearchParams(window.location.search);
    const q = params.get('q');
    if (q) { input.value = q; render(q); input.focus(); }
  }

  // ── article enhancements: kicker, TOC, reading time, feedback ────
  function initArticle() {
    const body = document.querySelector('.help-article-body');
    if (!body) return;

    const wrap = body.closest('.page-wrap');
    const cat = wrap ? wrap.getAttribute('data-cat') : null;
    const crumb = document.querySelector('.help-breadcrumb');
    const catLabel = crumb ? (crumb.querySelector('a[href$="/index.html"]:not([href="/help/index.html"])') || {}).textContent : null;

    const h1 = body.querySelector('h1');
    if (h1 && catLabel) {
      const kicker = document.createElement('div');
      kicker.className = 'help-kicker';
      kicker.innerHTML = '<span class="dot"></span>' + escapeHtml(catLabel);
      h1.parentNode.insertBefore(kicker, h1);
    }

    // reading time, appended into the existing .help-meta line
    const wordCount = body.textContent.trim().split(/\s+/).length;
    const minutes = Math.max(1, Math.round(wordCount / 200));
    const meta = document.querySelector('.help-meta');
    if (meta) {
      const time = document.createElement('span');
      time.textContent = minutes + ' min read';
      if (meta.firstChild) {
        const sep = document.createElement('span');
        sep.className = 'sep';
        sep.textContent = '•';
        meta.insertBefore(sep, meta.firstChild);
        meta.insertBefore(time, meta.firstChild);
      } else {
        meta.appendChild(time);
      }
    }

    // "On this page" TOC — only worth showing for longer articles
    const headings = Array.from(body.querySelectorAll('h2'));
    if (headings.length >= 2) {
      headings.forEach((h, i) => { if (!h.id) h.id = 'section-' + (i + 1); });
      const toc = document.createElement('div');
      toc.className = 'help-toc';
      toc.innerHTML = '<div class="help-toc-title">On this page</div><ol>' +
        headings.map(h => '<li><a href="#' + h.id + '">' + escapeHtml(h.textContent) + '</a></li>').join('') +
        '</ol>';
      // place right after the meta line, before the body copy resumes
      const firstP = body.querySelector('p');
      if (firstP) firstP.parentNode.insertBefore(toc, firstP);
    }

    // "Was this helpful?" feedback widget
    const key = 'oc-help-feedback:' + window.location.pathname;
    const related = document.querySelector('.help-related');
    const widget = document.createElement('div');
    widget.className = 'help-feedback';

    function renderWidget(choice) {
      if (choice) {
        widget.innerHTML = '<span class="thanks">Thanks for the feedback — it helps us improve this article.</span>';
      } else {
        widget.innerHTML =
          '<span class="q">Was this article helpful?</span>' +
          '<span class="btns">' +
            '<button type="button" data-v="yes">Yes</button>' +
            '<button type="button" data-v="no">No</button>' +
          '</span>';
        widget.querySelectorAll('button').forEach(btn => {
          btn.addEventListener('click', () => {
            try { localStorage.setItem(key, btn.dataset.v); } catch (e) {}
            renderWidget(btn.dataset.v);
          });
        });
      }
    }
    let saved = null;
    try { saved = localStorage.getItem(key); } catch (e) {}
    renderWidget(saved);

    if (related) related.parentNode.insertBefore(widget, related);
    else body.parentNode.insertBefore(widget, body.nextSibling);
  }

  // ── category index: turn "12. Group chats and channels" into a
  // small numbered badge + clean title, instead of raw text ────────
  function initArticleListBadges() {
    document.querySelectorAll('.help-article-row .t').forEach(el => {
      const m = el.textContent.match(/^(\d+)\.\s*(.+)$/);
      if (!m) return;
      const badge = document.createElement('span');
      badge.className = 'n';
      badge.textContent = m[1];
      el.textContent = m[2];
      el.parentNode.insertBefore(badge, el);
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    initSearch();
    initArticle();
    initArticleListBadges();
  });
})();
