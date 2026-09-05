// ─────────────────────────────────────────────────────────────
// NOTIFICATIONS PAGE — /notifications.html (requires login)
// Rows are created server-side by triggers (see schema.sql) — this
// page only ever reads + marks-read, never inserts.
// ─────────────────────────────────────────────────────────────
const NOTIF_SELECT = '*, actor:profiles!notifications_actor_id_fkey(username,display_name,avatar_url,verified,verification_type), post:posts(id,body,is_deleted,profile:profiles!posts_author_id_fkey(username)), reply:replies(id,body,is_deleted), conversation:conversations(id,kind,name,avatar_url)';

const NOTIF_ICON = {
  like:    ICON.heart,
  reply:   ICON.reply,
  repost:  ICON.repost,
  quote:   ICON.quote,
  mention: '<svg viewBox="0 0 24 24"><path d="M15.5 12a3.5 3.5 0 1 1-7 0 3.5 3.5 0 0 1 7 0Z"/><path d="M15.5 12v1.2c0 1.3 1 2.3 2.3 2.3s2.2-1 2.2-3.5a8 8 0 1 0-3.5 6.6"/></svg>',
  follow:  '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.3" r="3.6"/><path d="M4.5 20c1.2-4 4-6 7.5-6s6.3 2 7.5 6"/></svg>',
  message: ICON.chat,
  group_invite: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8.3" r="3.3"/><path d="M2.8 20c.9-3.7 3.2-5.6 6.2-5.6s5.3 1.9 6.2 5.6"/><path d="M15.6 5.3a3.2 3.2 0 0 1 0 6.1"/><path d="M16.2 14.8c2.4.5 4.1 2.2 4.9 5.2"/></svg>',
  // Same person-silhouette body as the plain `follow` icon above, with
  // a small padlock swapped in for the head — reads as "a follow,
  // but gated" at a glance, and stays legible at the 11x11 size every
  // notif-badge is rendered at.
  follow_request: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 20c1.2-4 4-6 7.5-6s6.3 2 7.5 6"/><rect x="9.3" y="5.6" width="5.4" height="4.4" rx="1"/><path d="M10.4 5.6V4.5a1.6 1.6 0 0 1 3.2 0v1.1"/></svg>',
  follow_request_accepted: '<svg viewBox="0 0 24 24"><circle cx="12" cy="8.3" r="3.6"/><path d="M4.5 20c1.2-4 4-6 7.5-6s6.3 2 7.5 6"/></svg>'
};

// Path for a group/channel thread — mirrors groupMessagesUrl() in
// js/chat.js, which isn't loaded on this page.
function notifGroupUrl(id) { return `/messages/g/${encodeURIComponent(id)}`; }

function notifText(n) {
  const who = `<b>${esc(n.actor?.display_name || n.actor?.username || 'Someone')}${vBadge(n.actor)}</b>`;
  if (n.type === 'like') return `${who} liked your post`;
  if (n.type === 'reply') return `${who} replied to your post`;
  if (n.type === 'repost') return `${who} reposted your post`;
  if (n.type === 'quote') return `${who} quoted your post`;
  if (n.type === 'mention') return `${who} mentioned you`;
  if (n.type === 'follow') return `${who} followed you`;
  if (n.type === 'message') return `${who} sent you a message`;
  if (n.type === 'group_invite') return `${who} invited you to join <b>${esc(n.conversation?.name || (n.conversation?.kind === 'channel' ? 'a channel' : 'a group'))}</b>`;
  if (n.type === 'follow_request') return `${who} requested to follow you`;
  if (n.type === 'follow_request_accepted') return `${who} accepted your follow request`;
  return who;
}

function notifHref(n) {
  if (n.type === 'follow' || n.type === 'follow_request' || n.type === 'follow_request_accepted') return n.actor?.username ? profileUrl(n.actor.username) : '#';
  if (n.type === 'message') return n.actor?.username ? messagesUrl(n.actor.username) : '#';
  if (n.type === 'group_invite') return n.conversation?.id ? notifGroupUrl(n.conversation.id) : '#';
  if (n.post && !n.post.is_deleted) return postUrlById(n.post.id, n.post.profile?.username || n.post.author?.username);
  return '#';
}

function notifItemHtml(n) {
  if (n.type === 'mention') return mentionItemHtml(n);
  if (n.type === 'group_invite') return groupInviteItemHtml(n);
  if (n.type === 'follow_request') return followRequestItemHtml(n);
  const actorAvatar = avatarUrl(n.actor?.avatar_url);
  // A mention inside a reply used to snippet the parent post's body
  // (all notifications link post_id to the parent post, for
  // navigation) — which meant the preview text wasn't actually the
  // text that mentioned you. Prefer the reply's own body when one is
  // attached, same as every other type's snippet reflects the actual
  // content the notification is about.
  const snipSource = (n.post && !n.post.is_deleted) ? n.post : null;
  const snippet = (n.type !== 'follow' && n.type !== 'message' && n.type !== 'follow_request_accepted' && snipSource) ? `<div class="notif-snip">${renderBody((snipSource.body || '').slice(0, 140))}</div>` : '';
  return `
  <a class="notif-item${n.read ? '' : ' unread'}" href="${notifHref(n)}">
    <span class="notif-avatar-wrap${avSqClass(n.actor) ? ' notif-avatar-wrap-sq' : ''}">
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

// Mention notifications get their own two-part layout instead of the
// plain avatar+badge row every other type uses: the actual mentioning
// text rendered like a normal post (avatar, name, time, body) so
// it's immediately readable, then a separate tinted callout below
// explaining what happened — same idea as X's own "You've been
// mentioned in this Tweet" card, minus the unmention action (this app
// has no equivalent feature to hang that button off yet).
function mentionItemHtml(n) {
  const actorAvatar = avatarUrl(n.actor?.avatar_url);
  const name = esc(n.actor?.display_name || n.actor?.username || 'Someone');
  const snipSource = (n.reply && !n.reply.is_deleted) ? n.reply
    : (n.post && !n.post.is_deleted) ? n.post
    : null;
  // Collapse internal blank lines before truncating: a post like
  // "Hi\n\n@ali" was rendering here as two visually disconnected
  // chunks (the "Hi" line, then the @mention link floating on its
  // own line below it) instead of reading as one line of text like
  // every other snippet on the site. Runs of whitespace/newlines
  // flatten to a single space, same as a normal inline preview.
  const snipBody = snipSource ? (snipSource.body || '').replace(/\s+/g, ' ').trim() : '';
  const mentionText = snipBody ? renderBody(snipBody.slice(0, 220)) : '';
  const inWhat = (n.reply && !n.reply.is_deleted) ? 'reply' : 'post';
  return `
  <a class="notif-item notif-item-mention${n.read ? '' : ' unread'}" href="${notifHref(n)}">
    <div class="notif-mention-post">
      <img class="avatar${avSqClass(n.actor)}" src="${esc(actorAvatar)}" alt="" loading="lazy" decoding="async">
      <div class="notif-mention-post-body">
        <div class="notif-mention-who"><b>${name}${vBadge(n.actor)}</b><span class="notif-mention-time">${timeAgo(n.created_at)}</span></div>
        ${mentionText ? `<div class="notif-mention-text">${mentionText}</div>` : ''}
      </div>
    </div>
    <div class="notif-mention-callout">
      <span class="notif-mention-callout-icon">${NOTIF_ICON.mention}</span>
      <div class="notif-mention-callout-copy">
        <div class="notif-mention-callout-title">You were mentioned</div>
        <div class="notif-mention-callout-sub">${name} mentioned you in a ${inWhat}</div>
      </div>
    </div>
    ${n.read ? '' : '<span class="notif-dot" aria-hidden="true"></span>'}
  </a>`;
}

// Group/channel invite — Accept/Decline live right on the
// notification card instead of just linking through, mirroring the
// landing screen chat.js shows if you open the thread link directly
// (renderGroupInviteScreen() in js/chat.js) for whichever one someone
// actually uses. n.inviteStatus is computed in loadNotifications()
// below, not carried on the row itself: 'pending' shows the two
// buttons, 'accepted' shows a plain confirmation, 'gone' means the
// invite was already declined/canceled or the row's simply no longer
// there.
function groupInviteItemHtml(n) {
  const actorAvatar = avatarUrl(n.actor?.avatar_url);
  const status = n.inviteStatus;
  const actionsHtml = status === 'pending' ? `
      <div class="notif-invite-actions">
        <button type="button" class="notif-invite-decline-btn" onclick="respondGroupInviteFromNotif(this,'${esc(n.conversation?.id || '')}',false)">Decline</button>
        <button type="button" class="notif-invite-accept-btn" onclick="respondGroupInviteFromNotif(this,'${esc(n.conversation?.id || '')}',true)">Accept</button>
      </div>`
    : status === 'accepted' ? `<div class="notif-invite-status notif-invite-status-joined">You joined &middot; <a href="${notifHref(n)}">Open</a></div>`
    : `<div class="notif-invite-status">Invite no longer available</div>`;
  return `
  <div class="notif-item notif-item-invite${n.read ? '' : ' unread'}">
    <a class="notif-invite-linkwrap" href="${notifHref(n)}">
      <span class="notif-avatar-wrap${avSqClass(n.actor) ? ' notif-avatar-wrap-sq' : ''}">
        <img class="avatar${avSqClass(n.actor)}" src="${esc(actorAvatar)}" alt="" loading="lazy" decoding="async">
        <span class="notif-badge group_invite">${NOTIF_ICON.group_invite}</span>
      </span>
      <div class="notif-body">
        <div class="notif-txt">${notifText(n)}</div>
        <div class="notif-time">${timeAgo(n.created_at)}</div>
      </div>
    </a>
    ${actionsHtml}
    ${n.read ? '' : '<span class="notif-dot" aria-hidden="true"></span>'}
  </div>`;
}

// Accept/decline right from the card. Neither needs an RPC: accept
// is just flipping your own conversation_members row to 'accepted'
// (conversation_members_update_own RLS), decline just deletes it
// (conversation_members_delete_self) — same two calls
// acceptGroupInvite()/declineGroupInvite() make in js/chat.js, kept
// separate here since chat.js isn't loaded on this page.
async function respondGroupInviteFromNotif(btnEl, convId, accept) {
  if (!currentSession || !convId) return;
  const card = btnEl.closest('.notif-item-invite');
  const actionsEl = card?.querySelector('.notif-invite-actions');
  actionsEl?.querySelectorAll('button').forEach(b => b.disabled = true);
  const { error } = accept
    ? await sb.from('conversation_members').update({ status: 'accepted' }).eq('conversation_id', convId).eq('user_id', currentSession.user.id)
    : await sb.from('conversation_members').delete().eq('conversation_id', convId).eq('user_id', currentSession.user.id);
  if (error) {
    toast(error.message || 'Could not respond to that invite.', 'error');
    actionsEl?.querySelectorAll('button').forEach(b => b.disabled = false);
    return;
  }
  toast(accept ? 'Joined.' : 'Invite declined.');
  if (actionsEl) {
    actionsEl.outerHTML = accept
      ? `<div class="notif-invite-status notif-invite-status-joined">You joined &middot; <a href="${notifGroupUrl(convId)}">Open</a></div>`
      : `<div class="notif-invite-status">Invite declined</div>`;
  }
}

// Follow request — Accept/Decline live right on the card, same
// pattern as the group/channel invite above (reuses its
// .notif-item-invite/.notif-invite-actions/.notif-invite-status CSS
// wholesale — the class names were never group_invite-specific).
// n.requestStatus is computed in loadNotifications() below rather
// than carried on the row itself, since accepting/declining doesn't
// touch the notifications row, only follow_requests/follows (see
// supabase/private_account_follow_requests.sql): 'pending' shows the
// two buttons, 'accepted' shows a confirmation linking to their
// profile, 'gone' means it was declined (or the requester canceled
// it themselves) and there's nothing left to act on.
function followRequestItemHtml(n) {
  const actorAvatar = avatarUrl(n.actor?.avatar_url);
  const status = n.requestStatus;
  const actionsHtml = status === 'pending' ? `
      <div class="notif-invite-actions">
        <button type="button" class="notif-invite-decline-btn" onclick="respondFollowRequestFromNotif(this,'${esc(n.actor_id || '')}',false)">Decline</button>
        <button type="button" class="notif-invite-accept-btn" onclick="respondFollowRequestFromNotif(this,'${esc(n.actor_id || '')}',true)">Accept</button>
      </div>`
    : status === 'accepted' ? `<div class="notif-invite-status notif-invite-status-joined">Accepted &middot; <a href="${notifHref(n)}">View profile</a></div>`
    : `<div class="notif-invite-status">Request no longer available</div>`;
  return `
  <div class="notif-item notif-item-invite${n.read ? '' : ' unread'}">
    <a class="notif-invite-linkwrap" href="${notifHref(n)}">
      <span class="notif-avatar-wrap${avSqClass(n.actor) ? ' notif-avatar-wrap-sq' : ''}">
        <img class="avatar${avSqClass(n.actor)}" src="${esc(actorAvatar)}" alt="" loading="lazy" decoding="async">
        <span class="notif-badge follow_request">${NOTIF_ICON.follow_request}</span>
      </span>
      <div class="notif-body">
        <div class="notif-txt">${notifText(n)}</div>
        <div class="notif-time">${timeAgo(n.created_at)}</div>
      </div>
    </a>
    ${actionsHtml}
    ${n.read ? '' : '<span class="notif-dot" aria-hidden="true"></span>'}
  </div>`;
}

// Decline (and the requester's own cancel, from js/profile.js) are
// plain deletes covered by follow_requests_delete RLS — either side
// of the row can remove it. Accept has to go through the
// accept_follow_request() RPC since it inserts into follows on the
// REQUESTER's behalf, which no client-safe RLS policy on follows
// should ever allow directly.
async function respondFollowRequestFromNotif(btnEl, requesterId, accept) {
  if (!currentSession || !requesterId) return;
  const card = btnEl.closest('.notif-item-invite');
  const actionsEl = card?.querySelector('.notif-invite-actions');
  actionsEl?.querySelectorAll('button').forEach(b => b.disabled = true);
  const { error } = accept
    ? await acceptFollowRequest(requesterId)
    : await cancelFollowRequest(requesterId, currentSession.user.id);
  if (error) {
    toast(error.message || 'Could not respond to that request.', 'error');
    actionsEl?.querySelectorAll('button').forEach(b => b.disabled = false);
    return;
  }
  toast(accept ? 'Follow request accepted.' : 'Follow request declined.');
  if (actionsEl) {
    const href = card.querySelector('.notif-invite-linkwrap')?.getAttribute('href') || '#';
    actionsEl.outerHTML = accept
      ? `<div class="notif-invite-status notif-invite-status-joined">Accepted &middot; <a href="${href}">View profile</a></div>`
      : `<div class="notif-invite-status">Request declined</div>`;
  }
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
    root.innerHTML = `<div class="post-login-gate" style="border-top:none;">You need an account to post. <a href="signup.html">Create an account</a> — it takes a minute.</div>`;
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

  // Whether each group_invite is still pending isn't on the
  // notification row itself (accepting/declining doesn't touch
  // notifications, only conversation_members — see
  // supabase/group_invites.sql) — one batched lookup covers every
  // invite notification on the page instead of a query per card.
  const inviteConvIds = [...new Set(data.filter(n => n.type === 'group_invite' && n.conversation?.id).map(n => n.conversation.id))];
  if (inviteConvIds.length) {
    const { data: memberRows } = await sb.from('conversation_members').select('conversation_id,status')
      .eq('user_id', session.user.id).in('conversation_id', inviteConvIds);
    const statusByConv = new Map((memberRows || []).map(r => [r.conversation_id, r.status]));
    data.forEach(n => { if (n.type === 'group_invite') n.inviteStatus = statusByConv.get(n.conversation?.id) || 'gone'; });
  }

  // Same idea for follow_request: accepting/declining touches
  // follow_requests/follows, never the notification row itself, so
  // "still pending" has to be looked up separately. Unlike the invite
  // case above there's no single status column to read — the request
  // row is deleted either way it's resolved — so accepted vs.
  // declined is told apart by whether a real follows row exists now.
  const frActorIds = [...new Set(data.filter(n => n.type === 'follow_request' && n.actor_id).map(n => n.actor_id))];
  if (frActorIds.length) {
    const [{ data: pendingRows }, { data: followRows }] = await Promise.all([
      sb.from('follow_requests').select('requester_id').eq('target_id', session.user.id).in('requester_id', frActorIds),
      sb.from('follows').select('follower_id').eq('followee_id', session.user.id).in('follower_id', frActorIds)
    ]);
    const pendingSet = new Set((pendingRows || []).map(r => r.requester_id));
    const followingMeSet = new Set((followRows || []).map(r => r.follower_id));
    data.forEach(n => {
      if (n.type !== 'follow_request') return;
      n.requestStatus = pendingSet.has(n.actor_id) ? 'pending' : followingMeSet.has(n.actor_id) ? 'accepted' : 'gone';
    });
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
