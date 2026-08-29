// ─────────────────────────────────────────────────────────────
// NOTIFICATIONS PAGE — /notifications.html (requires login)
// Rows are created server-side by triggers (see schema.sql) — this
// page only ever reads + marks-read, never inserts.
// ─────────────────────────────────────────────────────────────
const NOTIF_SELECT = '*, actor:profiles!notifications_actor_id_fkey(username,display_name,avatar_url,verified,verification_type), post:posts(id,body,is_deleted,profile:profiles!posts_author_id_fkey(username))';

const NOTIF_ICON = {
  like:    ICON.heart,
  reply:   ICON.reply,
  repost:  ICON.repost,
  quote:   ICON.quote,
  mention: '<svg viewBox="0 0 24 24"><path d="M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z"/><path d="M15.5 12v1.2c0 1.3 1 2.3 2.3 2.3s2.2-1 2.2-3.5a8 8 0 1 0-3.5 6.6"/></svg>',
  follow:  '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.3" r="3.6"/><path d="M4.5 20c1.2-4 4-6 7.5-6s6.3 2 7.5 6"/></svg>'
};

function notifText(n) {
  const who = `<b>${esc(n.actor?.display_name || n.actor?.username || 'Someone')}${vBadge(n.actor)}</b>`;
  if (n.type === 'like') return `${who} liked your post`;
  if (n.type === 'reply') return `${who} replied to your post`;
  if (n.type === 'repost') return `${who} reposted your post`;
  if (n.type === 'quote') return `${who} quoted your post`;
  if (n.type === 'mention') return `${who} mentioned you`;
  if (n.type === 'follow') return `${who} followed you`;
  return who;
}

function notifHref(n) {
  if (n.type === 'follow') return n.actor?.username ? profileUrl(n.actor.username) : '#';
  if (n.post && !n.post.is_deleted) return postUrlById(n.post.id, n.post.profile?.username || n.post.author?.username);
  return '#';
}

function notifItemHtml(n) {
  const actorAvatar = avatarUrl(n.actor?.avatar_url);
  const snippet = (n.type !== 'follow' && n.post && !n.post.is_deleted) ? `<div class="notif-snip">${renderBody((n.post.body || '').slice(0, 140))}</div>` : '';
  return `
  <a class="notif-item${n.read ? '' : ' unread'}" href="${notifHref(n)}">
    <span class="notif-avatar-wrap">
      <img class="avatar${avSqClass(n.actor)}" src="${esc(actorAvatar)}" alt="" loading="lazy" decoding="async">
      <span class="notif-badge ${n.type}">${NOTIF_ICON[n.type] || ''}</span>
    </span>
    <div class="notif-body">
      <div class="notif-txt">${notifText(n)}</div>
      ${snippet}
      <div class="notif-time">${timeAgo(n.created_at)}</div>
    </div>
    ${n.read ? '' : '<span class="notif-dot" aria-hidden="true"></span>'}
  </a>`;
}

// Buckets rows the way most notification inboxes do: anything unread
// jumps to its own "New" group regardless of age, then everything
// else (already read — from an earlier visit) is grouped by day so a
// long list doesn't read as one undifferentiated wall. Order matters:
// New always leads, then reverse-chronological day buckets.
function notifDayBucket(dateStr) {
  const d = new Date(dateStr);
  const now = new Date();
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfYesterday = new Date(startOfToday); startOfYesterday.setDate(startOfYesterday.getDate() - 1);
  const startOfWeek = new Date(startOfToday); startOfWeek.setDate(startOfWeek.getDate() - 7);
  if (d >= startOfToday) return 'Today';
  if (d >= startOfYesterday) return 'Yesterday';
  if (d >= startOfWeek) return 'This week';
  return 'Earlier';
}
function renderNotifGroups(root, data) {
  const order = ['New', 'Today', 'Yesterday', 'This week', 'Earlier'];
  const groups = { New: [], Today: [], Yesterday: [], 'This week': [], Earlier: [] };
  for (const n of data) groups[n.read ? notifDayBucket(n.created_at) : 'New'].push(n);
  root.innerHTML = order
    .filter(label => groups[label].length)
    .map(label => `<div class="notif-group-hdr">${label}</div>${groups[label].map(notifItemHtml).join('')}`)
    .join('');
}

async function loadNotifications() {
  // pjax keeps this listener registered for the life of the tab and
  // re-fires it on every navigation (see js/pjax.js) — without this
  // check, leaving the notifications page and going anywhere else
  // would re-run this on top of that page, and re-mark everything
  // read again in the background on every single click.
  if (document.body.dataset.page !== 'notifications') return;
  const root = document.getElementById('notif-root');
  if (!root) return;
  root.innerHTML = skeletonFeedHtml();
  // Reuses the already-resolved session from auth.js instead of calling
  // sb.auth.getSession() again — see the note in ensureLikesLoaded()
  // (js/common.js). This file's own DOMContentLoaded listener used to
  // fire its own independent getSession() call at the same time as
  // auth.js's renderAuthArea() did, which is exactly the concurrent-call
  // pattern that can deadlock supabase-js's internal auth lock and hang
  // this page's loading spinner forever.
  await authReady;
  const session = currentSession;

  if (!session) {
    root.innerHTML = `<div class="post-login-gate" style="border-top:none;">Log in to see your notifications. <a href="login.html">Log in</a> or <a href="signup.html">create an account</a>.</div>`;
    return;
  }

  const { data, error } = await sb.from('notifications').select(NOTIF_SELECT)
    .eq('user_id', session.user.id)
    .order('created_at', { ascending: false })
    .limit(100);

  if (error) { root.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
  if (!data.length) {
    root.innerHTML = `<div id="feed-empty">Nothing here yet. Likes, replies, mentions, and new followers will show up here.</div>`;
    return;
  }

  renderNotifGroups(root, data);

  const unreadIds = data.filter(n => !n.read).map(n => n.id);
  if (unreadIds.length) {
    await sb.from('notifications').update({ read: true }).in('id', unreadIds);
    unreadNotifCount = 0;
    renderSideNav();
  }
}

document.addEventListener('DOMContentLoaded', loadNotifications);
