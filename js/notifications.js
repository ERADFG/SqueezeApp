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
    <span class="notif-icon ${n.type}">${NOTIF_ICON[n.type] || ''}</span>
    <img class="avatar pfp-sm${avSqClass(n.actor)}" style="width:20px;height:20px;margin-top:2px;" src="${esc(actorAvatar)}" alt="" loading="lazy" decoding="async">
    <div class="notif-body">
      <div class="notif-time">${timeAgo(n.created_at)}</div>
      <div class="notif-txt">${notifText(n)}</div>
      ${snippet}
    </div>
  </a>`;
}

async function loadNotifications() {
  const root = document.getElementById('notif-root');
  root.innerHTML = skeletonFeedHtml();
  const { data: { session } } = await sb.auth.getSession();

  if (!session) {
    root.innerHTML = `<div class="post-login-gate" style="border-top:none;">Log in to see your notifications. <a href="login.html">Log in</a> or <a href="signup.html">sign up</a>.</div>`;
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

  root.innerHTML = data.map(notifItemHtml).join('');

  const unreadIds = data.filter(n => !n.read).map(n => n.id);
  if (unreadIds.length) {
    await sb.from('notifications').update({ read: true }).in('id', unreadIds);
    unreadNotifCount = 0;
    renderSideNav();
  }
}

document.addEventListener('DOMContentLoaded', loadNotifications);
