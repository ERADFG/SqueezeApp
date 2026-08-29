// ─────────────────────────────────────────────────────────────
// CHAT PAGE — /messages (conversation list) or /messages/<username> (thread)
// Also reachable via the legacy chat.html?u=<username> form.
//
// Messages (1:1 DMs, group, and channel) are encrypted at rest
// server-side — see supabase/chat_server_side_encryption.sql. Reading
// message bodies always goes through the get_dm_thread / get_dm_list /
// get_group_thread / get_group_last_messages / get_message RPCs,
// which decrypt with a key that only exists in Supabase Vault, gated
// by the same sender/recipient/membership checks the table's RLS
// already enforces. Nothing here holds or derives any key — there's
// no per-device state, so chat works identically the instant you open
// it on any device, no passphrase or backup step involved. See that
// SQL file's header comment for the trade-off this makes vs. true
// end-to-end encryption.
// ─────────────────────────────────────────────────────────────
// Group/channel thread route: /messages/g/<id> (pretty, added to
// vercel.json alongside the existing /messages/<username> rewrite),
// or the legacy chat.html?g=<id> query form for local dev without
// Vercel's rewrite engine — same fallback pattern chatWithUsername
// already uses for the 1:1 case just below.
// Recomputed on every visit (see loadChat() below) rather than
// frozen here — pjax (js/pjax.js) keeps this script loaded for the
// life of the tab, so opening a *different* DM or group thread later
// would otherwise silently keep showing the very first one forever,
// since this file only ever gets parsed once.
function chatReadGroupId() {
  const m = location.pathname.match(/^\/messages\/g\/([^/]+)\/?$/);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(location.search).get('g');
}
function chatReadWithUsername(groupId) {
  if (groupId) return null;
  const m = location.pathname.match(/^\/messages\/([^/]+)\/?$/);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(location.search).get('u');
}
// Computed immediately (not left null) — the address-bar-upgrade IIFE
// just below reads these synchronously at parse time, before loadChat()
// ever runs, so if they weren't set from the real URL right here, that
// IIFE would always see "no thread open" and rewrite a freshly-loaded
// /messages/<username> or /messages/g/<id> straight back to the bare
// /messages list before loadChat() got a chance to see the real path —
// which is exactly what silently sent every deep link (including the
// "New chat" search's location.href navigation, chatNewPickUser() below)
// back to the conversation list instead of opening the tapped user's
// thread. loadChat() still recomputes both fresh on every visit (see its
// own comment) since pjax keeps this script alive across navigations.
let chatGroupId = chatReadGroupId();
let chatWithUsername = chatReadWithUsername(chatGroupId);
function groupMessagesUrl(id) { return `/messages/g/${encodeURIComponent(id)}`; }
let chatOther = null;   // the other user's profile, once a thread is open
let chatOtherBlockedByMe = false; // whether *I've* blocked chatOther — drives the "···" menu label and the composer-vs-blocked-notice swap in loadThread()
let chatChannel = null;

// ── GROUP/CHANNEL STATE ──
let chatGroup = null;        // the conversations row, once a group/channel thread is open
let chatGroupMembers = [];   // conversation_members rows, joined with profiles
let chatGroupMyRole = null;  // 'owner' | 'admin' | 'member' | null (not a member)
let chatGroupRealtimeChannel = null;
const gcvPickedMembers = new Map(); // username -> profile, for the create-group/channel modal
let gcvAvatarBlob = null;       // cropped File staged for the group/channel picture, until Create is pressed
let gcvAvatarPreviewUrl = null; // local object URL for the picker preview, revoked on close/create
let gcvStep = 1;                // 1 = basic info, 2 = privacy, 3 = members — see gcvGoToStep()

// ── MEDIA / VOICE-NOTE COMPOSER STATE ──
// At most one pending attachment at a time (image, video, or a
// recorded voice note) — picked/recorded, previewed, then uploaded
// only once the person actually hits send. `chatAttachment.file` is
// the raw File/Blob; `previewUrl` is a local object URL for the
// preview thumbnail/player, revoked as soon as it's no longer needed.
let chatAttachment = null; // { file, type: 'image'|'video'|'audio', previewUrl }
let chatRecorder = null;   // active MediaRecorder while recording a voice note
let chatRecorderChunks = [];
let chatRecorderStream = null;
let chatRecordStartedAt = 0;
let chatRecordTimerHandle = null;
let chatActiveVoiceAudio = null; // the <audio> element currently playing, if any (only one at a time)

const ICON_SEND = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 20V4l18 8-18 8Zm2-3 12.85-5L5 7v3.83L11 12l-6 1.17V17Z"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
// Distinct from ICON.reply (common.js) — the reply icon on posts is a
// single speech bubble, so re-using that exact shape here (as a
// previous pass did, matching NAV_ICON.chat 1:1) made "chat" and
// "comment" visually indistinguishable. This mirrors NAV_ICON.chat's
// current two-bubble "conversations" glyph instead, which reads as
// its own icon at a glance.
const ICON_CHAT_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M14 9a2 2 0 0 1-2 2H6l-4 4V4a2 2 0 0 1 2-2h8a2 2 0 0 1 2 2Z"/><path d="M18 9h2a2 2 0 0 1 2 2v11l-4-4h-6a2 2 0 0 1-2-2v-1"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
const CHAT_ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
// ── group/channel icon set — kept alongside the rest of chat.js's own
// icons (see the ICON_ATTACH comment above for why this file doesn't
// borrow from common.js's ICON/NAV_ICON objects). ──
const ICON_PLUS_CIRCLE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_MSG_ONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.75c-4.97 0-9 3.5-9 7.9 0 2.55 1.35 4.82 3.46 6.28.1.85-.16 1.9-.82 3.02a.4.4 0 0 0 .43.59c1.53-.32 2.83-.92 3.7-1.5.7.15 1.44.23 2.23.23 4.97 0 9-3.55 9-7.9 0-4.4-4.03-8.9-9-8.9z"/></svg>';
const ICON_GROUP = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="9" cy="8.3" r="3.3"/><path d="M2.8 20c.9-3.7 3.2-5.6 6.2-5.6s5.3 1.9 6.2 5.6"/><path d="M15.6 5.3a3.2 3.2 0 0 1 0 6.1"/><path d="M16.2 14.8c2.4.5 4.1 2.2 4.9 5.2"/></svg>';
const ICON_CHANNEL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 11.5 19 4l-2.2 16-6-4.3L7 19v-5.1z"/><path d="M10.8 14.6 19 4"/></svg>';
// Used only as the round avatar *placeholder* glyph for a channel
// with no picture set yet (create-channel modal, group/channel list
// rows). ICON_CHANNEL above is fine as a small tab/menu icon, but its
// paper-plane shape has most of its "ink" bunched in the top half —
// mathematically centered in its 24x24 viewBox, but visibly
// off-balance once it's blown up inside a 64px circle. A megaphone
// is symmetric top-to-bottom/left-to-right, so simple flex centering
// (align-items/justify-content:center) actually looks centered.
const ICON_CHANNEL_AVATAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 10v4a1 1 0 0 0 1 1h2l4.5 3.4a1 1 0 0 0 1.6-.8V6.4a1 1 0 0 0-1.6-.8L6 9H4a1 1 0 0 0-1 1Z"/><path d="M17.5 9a4 4 0 0 1 0 6"/><path d="M20 6.5a7.5 7.5 0 0 1 0 11"/></svg>';
// Default group/channel avatar placeholder before a picture is chosen —
// a plain profile silhouette, same for both kinds (matches the approved
// "New channel" modal redesign).
const ICON_AVATAR_PLACEHOLDER = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 20c1.1-4.4 3.9-6.6 8-6.6s6.9 2.2 8 6.6"/></svg>';
// Plain plus glyph for the avatar-pick badge — replaces the camera icon
// there per the redesign; ICON_CAMERA is still used elsewhere (group-info
// "change picture") where a camera is the clearer affordance.
const ICON_PLUS_PLAIN = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r="1" fill="currentColor" stroke="none"/></svg>';
const ICON_GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 6 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-6-3.8-9s1.3-6.3 3.8-9Z"/></svg>';
const ICON_LOCK_SMALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
// Group/channel name & description limits — enforced client-side via
// maxlength + these constants (used for the live counters below) and
// server-side via check constraints in supabase/chat_group_manage.sql.
const GCV_NAME_MAX = 20;
const GCV_DESC_MAX = 80;
// Camera glyph for the group/channel avatar picker overlay — mirrors
// the .cc-avatar-pick / .cc-banner-pick icon used for community/List
// pictures (js/common.js's createCommunity wizard), kept local here
// since chat.js doesn't share an icon set with common.js (see the
// ICON_ATTACH comment above).
const ICON_CAMERA = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 7h3l2-2h6l2 2h3v12H4V7Z"/><circle cx="12" cy="13" r="3.5"/></svg>';
// Attach / voice-note UI — kept as separate constants from the post
// composer's icon set (js/common.js) even though a couple overlap
// visually, since chat's toolbar lives in a different file and has
// no reason to depend on common.js's internal icon names.
const ICON_ATTACH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="5" width="18" height="14" rx="2"/><circle cx="9" cy="10.5" r="1.6"/><path d="m4 17 5-5 3.5 3.5L17 11l3 3"/></svg>';
const ICON_MIC = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><path d="M12 18v3"/></svg>';
const ICON_STOP = '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>';
const ICON_TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M9 7V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v2m-9 0 1 13a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-13"/></svg>';
const ICON_VOICE_PLAY = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.14v13.72c0 .6.66.96 1.17.65l10.9-6.86a.75.75 0 0 0 0-1.28L9.17 4.49A.75.75 0 0 0 8 5.14z"/></svg>';
const ICON_VOICE_PAUSE = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 5.5A1.5 1.5 0 0 1 8.5 4h1A1.5 1.5 0 0 1 11 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-1A1.5 1.5 0 0 1 7 18.5v-13zM13 5.5A1.5 1.5 0 0 1 14.5 4h1A1.5 1.5 0 0 1 17 5.5v13a1.5 1.5 0 0 1-1.5 1.5h-1a1.5 1.5 0 0 1-1.5-1.5v-13z"/></svg>';
// WhatsApp-style receipts: one check = sent, still unread; two checks
// (tinted with the accent colour) = the recipient has opened the
// thread and read this particular message.
const ICON_TICK1 = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.5 8.4l3.3 3.3L13.5 4"/></svg>';
const ICON_TICK2 = '<svg viewBox="0 0 20 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 8.4l3.3 3.3L11.5 4"/><path d="M7.2 8.4l3.3 3.3L18 4"/></svg>';

// Same address-bar upgrade as profile.js/thread.js/followlist.js —
// safe to run immediately since chatGroupId/chatWithUsername (if any)
// already came off the URL itself above, no data load needed to know
// it. Group threads canonicalize to /messages/g/<id>, DM threads to
// /messages/<username>, so this has to check chatGroupId first — the
// old version always canonicalized against chatWithUsername alone,
// which stripped a freshly-loaded group-thread URL back to the list
// too.
(function () {
  const canonical = chatGroupId ? groupMessagesUrl(chatGroupId) : prettyMessagesUrl(chatWithUsername);
  if (location.pathname + location.search !== canonical) { try { history.replaceState(null, '', canonical); } catch (e) {} }
})();

async function loadChat() {
  // pjax guard — see the identical comment in js/notifications.js.
  // Without this, leaving the chat page for anywhere else would
  // still fire this on every later navigation, re-subscribing to
  // realtime chat channels are already properly torn down (see
  // convListChannel/chatChannel above) but there's no #chat-root to
  // write into elsewhere, so it'd throw and silently do nothing.
  if (document.body.dataset.page !== 'chat') return;
  // Recompute the thread target fresh on every visit — see the
  // comment on chatReadGroupId()/chatReadWithUsername() above.
  chatGroupId = chatReadGroupId();
  chatWithUsername = chatReadWithUsername(chatGroupId);
  chatOther = null;
  const root = document.getElementById('chat-root');
  if (!root) return;
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
    document.body.classList.remove('chat-thread-open');
    const gate = t('chat.loginGate')
      .replace('{login}', `<a href="login.html">${t('nav.logIn')}</a>`)
      .replace('{signup}', `<a href="signup.html">${t('nav.signUp')}</a>`);
    root.innerHTML = `<div class="post-login-gate" style="border-top:none;">${gate}</div>`;
    return;
  }

  if (chatGroupId) {
    return loadGroupThread(session, root);
  }
  if (chatWithUsername) {
    return loadThread(session, root);
  }
  return loadConversationList(session, root);
}

// ── CONVERSATION LIST ──
async function loadConversationList(session, root) {
  document.body.classList.remove('chat-thread-open'); // see .chat-thread-open note in style.css — list view, not a thread
  document.getElementById('chat-sec-bar').innerHTML = t('nav.chat');
  subscribeConversationListRealtime(session, root);

  // get_dm_list() decrypts server-side and returns the same shape the
  // old embedded-resource select used (sender/recipient nested) — see
  // supabase/chat_server_side_encryption.sql.
  const [{ data, error }, groupRows] = await Promise.all([
    sb.rpc('get_dm_list'),
    loadMyGroupRows(session),
  ]);

  if (error) { root.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }

  // Drop anything the current viewer has "deleted for me" (a single
  // message, or an entire contact via deleteConversationWithUser())
  // before it ever reaches the list — a conversation whose every
  // message is hidden this way just silently stops appearing, which
  // is exactly "deleted this contact from my messages".
  const visibleRows = (data || []).filter(m => {
    const mine = m.sender_id === session.user.id;
    return mine ? !m.deleted_for_sender : !m.deleted_for_recipient;
  });

  // Collapse the flat message log into one row per other participant,
  // keeping only the most recent message (list is already newest-first).
  const seen = new Map();
  visibleRows.forEach(m => {
    const mine = m.sender_id === session.user.id;
    const otherId = mine ? m.recipient_id : m.sender_id;
    if (!seen.has(otherId)) {
      seen.set(otherId, { other: mine ? m.recipient : m.sender, last: m, mine, when: m.created_at });
    }
  });

  // Compose is collapsed behind a single pill by default (Twitter-
  // style) instead of a bar that permanently eats space above the
  // list — toggled open/closed by toggleNewChat(). The floating "+"
  // (#chat-fab, Bluesky-style) opens a small sheet offering this same
  // 1:1 flow plus New group / New channel.
  const newMsgBox = `
    <button type="button" class="chat-new-trigger" id="chat-new-trigger" onclick="toggleNewChat(true)">
      ${ICON_SEARCH}<span>${t('chat.searchUserTrigger')}</span>
    </button>
    <div class="chat-new" id="chat-new" style="display:none;">
      <div class="xsearch">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
        <input id="chat-new-user" placeholder="${esc(t('chat.searchUserPlaceholder'))}" autocomplete="off" oninput="chatNewSearchUsers(this.value)" onkeydown="if(event.key==='Enter'){startChat();}if(event.key==='Escape'){toggleNewChat(false);}">
      </div>
      <button type="button" class="chat-new-close" onclick="toggleNewChat(false)">${esc(t('compose.cancel'))}</button>
    </div>
    <div class="gcv-member-results" id="chat-new-results" style="margin:0 16px 8px;"></div>
    <div class="errmsg" id="chat-new-err" style="display:none;margin:0 16px 10px;"></div>`;

  const groupItems = groupRows.map(g => ({ kind: 'group', row: g, when: g.lastAt }));
  const dmItems = [...seen.values()].map(v => ({ kind: 'dm', row: v, when: v.when }));
  const merged = [...groupItems, ...dmItems].sort((a, b) => new Date(b.when) - new Date(a.when));

  renderChatFab(root);

  if (!merged.length) {
    root.innerHTML = newMsgBox + `
      <div class="chat-empty">
        ${ICON_CHAT_EMPTY}
        <h3>${esc(t('chat.noMessagesTitle'))}</h3>
        <p>${esc(t('chat.noMessagesSub'))}</p>
        <button type="button" class="chat-empty-fab-btn" onclick="openNewChatSheet()">${ICON_PLUS_CIRCLE}<span>New chat</span></button>
      </div>`;
    return;
  }

  // Snippet preview needs decrypting for encrypted rows — done in
  // parallel across every conversation up front rather than blocking
  // row-by-row.
  const rows = await Promise.all(merged.map(async item => {
    if (item.kind === 'group') return groupConvRowHtml(item.row);
    const { other, last, mine } = item.row;
    const unread = !mine && !last.read;
    const uname = other?.username || 'unknown';
    let snip;
    if (last.deleted_for_everyone) {
      snip = `<em>${esc(t('chat.messageDeleted'))}</em>`;
    } else if (last.media_url && !last.body) {
      // Caption-less attachment — show what kind instead of a blank snippet.
      const label = last.media_type === 'video' ? t('chat.video') : last.media_type === 'audio' ? t('chat.voiceMessage') : t('chat.photo');
      snip = esc(label);
    } else {
      snip = esc((last.body || '').slice(0, 80));
    }
    return `
    <div class="conv-row-wrap">
    <a class="conv-row${unread ? ' unread' : ''}" href="${messagesUrl(uname)}">
      <img class="avatar${avSqClass(other)}" src="${esc(avatarUrl(other?.avatar_url))}" alt="" loading="lazy" decoding="async">
      <div class="conv-txt">
        <div class="conv-top">
          <span class="conv-name">${esc(other?.display_name || uname)}${vBadge(other)}</span>
          <span class="conv-handle">@${esc(uname)}</span>
          <span class="conv-time">${timeAgo(last.created_at)}</span>
        </div>
        <div class="conv-snip">${mine ? esc(t('chat.youPrefix')) : ''}${snip}</div>
      </div>
      ${unread ? '<span class="conv-dot"></span>' : ''}
    </a>
    ${other?.id ? `
    <div class="pc-menu-wrap conv-menu-wrap" id="cmenu-${other.id}">
      <button type="button" class="pc-menu-btn" onclick="toggleConvMenu('${other.id}', event)">${ICON.menu}</button>
      <div class="pc-menu-dd">
        <button type="button" class="pc-menu-danger" onclick="deleteConversationWithUser('${other.id}', '${esc(uname)}', event)">${esc(t('chat.deleteConversation'))}</button>
      </div>
    </div>` : ''}
    </div>`;
  }));

  root.innerHTML = newMsgBox + rows.join('');
}

// ── GROUPS/CHANNELS: conversation-list rows ──
// Fetches every group/channel the person belongs to, plus (in one
// follow-up query) the single most recent message in each, so the
// list can be merged with the 1:1 rows above and sorted by whichever
// is more recent — group or DM.
async function loadMyGroupRows(session) {
  const { data: memberRows, error } = await sb.from('conversation_members')
    .select('conversation_id, role, last_read_at, conversation:conversations(id,kind,name,description,avatar_url,is_public,created_by)')
    .eq('user_id', session.user.id);
  if (error || !memberRows?.length) return [];

  const ids = memberRows.map(r => r.conversation_id);
  // get_group_last_messages() decrypts server-side (see
  // supabase/chat_server_side_encryption.sql) and already returns one
  // row per conversation_id, most recent first.
  const { data: msgs } = await sb.rpc('get_group_last_messages', { conv_ids: ids });

  const lastByGroup = new Map();
  (msgs || []).forEach(m => { if (!lastByGroup.has(m.conversation_id)) lastByGroup.set(m.conversation_id, m); });

  return memberRows.filter(r => r.conversation).map(r => {
    const last = lastByGroup.get(r.conversation_id);
    return {
      id: r.conversation_id, role: r.role, lastReadAt: r.last_read_at,
      conv: r.conversation, last,
      lastAt: last?.created_at || r.conversation.created_at || new Date(0).toISOString(),
    };
  });
}

function groupAvatarHtml(conv) {
  if (conv.avatar_url) return `<div class="conv-group-avatar"><img src="${esc(avatarUrl(conv.avatar_url))}" alt=""></div>`;
  return `<div class="conv-group-avatar">${esc((conv.name || '?').slice(0, 1).toUpperCase())}</div>`;
}

function groupConvRowHtml(g) {
  const unread = g.last && g.lastReadAt ? new Date(g.last.created_at) > new Date(g.lastReadAt) : !!(g.last && !g.lastReadAt);
  let snip = '';
  if (g.last) {
    const who = g.last.sender ? `${g.last.sender.display_name || g.last.sender.username}: ` : '';
    if (g.last.media_type) snip = esc(who) + esc(g.last.media_type === 'video' ? t('chat.video') : g.last.media_type === 'audio' ? t('chat.voiceMessage') : t('chat.photo'));
    else snip = esc(who) + esc((g.last.body || '').slice(0, 70));
  } else {
    snip = g.conv.kind === 'channel' ? 'Channel created' : 'Group created';
  }
  return `
  <a class="conv-row${unread ? ' unread' : ''}" href="${groupMessagesUrl(g.id)}" style="position:relative;">
    ${groupAvatarHtml(g.conv)}
    <span class="conv-kind-badge">${g.conv.kind === 'channel' ? ICON_CHANNEL : ICON_GROUP}</span>
    <div class="conv-txt">
      <div class="conv-top">
        <span class="conv-name">${esc(g.conv.name)}</span>
        <span class="conv-time">${g.last ? timeAgo(g.last.created_at) : ''}</span>
      </div>
      <div class="conv-snip">${snip}</div>
    </div>
    ${unread ? '<span class="conv-dot"></span>' : ''}
  </a>`;
}

// ── FLOATING "+" BUTTON — Bluesky-style circular FAB pinned to the
// conversation list, opening a small sheet with New message / New
// group / New channel. Only rendered on the list view. ──
function renderChatFab(root) {
  document.getElementById('chat-fab')?.remove();
  document.getElementById('chat-fab-sheet-bg')?.remove();
  const fab = document.createElement('button');
  fab.id = 'chat-fab';
  fab.type = 'button';
  fab.setAttribute('aria-label', 'New chat');
  fab.innerHTML = ICON_PLUS_CIRCLE;
  fab.onclick = () => openNewChatSheet();
  document.body.appendChild(fab);

  const sheetBg = document.createElement('div');
  sheetBg.id = 'chat-fab-sheet-bg';
  sheetBg.className = 'chat-fab-sheet-bg';
  sheetBg.onclick = e => { if (e.target === sheetBg) closeNewChatSheet(); };
  sheetBg.innerHTML = `
    <div class="chat-fab-sheet" role="menu" aria-label="New chat">
      <button type="button" onclick="closeNewChatSheet();toggleNewChat(true);">
        ${ICON_MSG_ONE}<span>New message<span class="chat-fab-sheet-sub">Direct message someone</span></span>
      </button>
      <button type="button" onclick="closeNewChatSheet();openCreateConversationModal('group');">
        ${ICON_GROUP}<span>New group<span class="chat-fab-sheet-sub">Chat with several people</span></span>
      </button>
      <button type="button" onclick="closeNewChatSheet();openCreateConversationModal('channel');">
        ${ICON_CHANNEL}<span>New channel<span class="chat-fab-sheet-sub">Broadcast to followers</span></span>
      </button>
    </div>`;
  document.body.appendChild(sheetBg);
}
function openNewChatSheet() { document.getElementById('chat-fab-sheet-bg')?.classList.add('open'); document.body.classList.add('oc-sheet-open'); }
function closeNewChatSheet() { document.getElementById('chat-fab-sheet-bg')?.classList.remove('open'); document.body.classList.remove('oc-sheet-open'); }

// Keeps the inbox list itself live, not just the sidebar badge.
// subscribeChatBadge() (auth.js) already bumps the unread count from
// anywhere in the app, but that's a counter, not the list underneath
// it — sitting on /messages while a new message arrives (or replying
// from another tab/device) left the rows on screen stale until a
// manual reload, since nothing here was listening for it. A fresh
// INSERT just re-runs the same load — the list is capped at 300 rows
// and this is a low-frequency event, so a full re-fetch is simpler
// and less error-prone than hand-patching one row/re-sorting in place.
let convListChannel = null;
function subscribeConversationListRealtime(session, root) {
  if (convListChannel) { sb.removeChannel(convListChannel); convListChannel = null; }
  convListChannel = sb.channel(`chat-list-${session.user.id}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `recipient_id=eq.${session.user.id}` },
      () => loadConversationList(session, root))
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `sender_id=eq.${session.user.id}` },
      () => loadConversationList(session, root))
    .subscribe();
}

function toggleNewChat(open) {
  const trigger = document.getElementById('chat-new-trigger');
  const panel = document.getElementById('chat-new');
  if (!trigger || !panel) return;
  panel.style.display = open ? 'flex' : 'none';
  trigger.style.display = open ? 'none' : 'flex';
  if (open) document.getElementById('chat-new-user')?.focus();
  else {
    clearErr(document.getElementById('chat-new-err'));
    const resultsEl = document.getElementById('chat-new-results');
    if (resultsEl) resultsEl.innerHTML = '';
    const input = document.getElementById('chat-new-user');
    if (input) input.value = '';
  }
}

// Live results as you type — mirrors gcvSearchMembers()'s pattern
// (debounced ilike on username/display_name) so "New message" is an
// actual user search, not just an exact-username lookup that only
// resolves on Enter/Send.
// "New message" is scoped to people you already have some connection
// to — folks who follow you, folks you follow, and anyone you've
// already DMed — rather than a raw search across every profile on the
// site. This is cached per page-load (it only changes when you follow/
// unfollow someone or start a new DM, neither of which happens while
// this panel is open) so re-typing in the search box doesn't refire
// three queries per keystroke.
let chatEligibleContactIdsCache = null;
async function chatEligibleContactIds() {
  if (chatEligibleContactIdsCache) return chatEligibleContactIdsCache;
  const uid = currentSession?.user?.id;
  if (!uid) return new Set();
  const [{ data: iFollow }, { data: followMe }, { data: sent }, { data: received }] = await Promise.all([
    sb.from('follows').select('followee_id').eq('follower_id', uid),
    sb.from('follows').select('follower_id').eq('followee_id', uid),
    sb.from('messages').select('recipient_id').eq('sender_id', uid),
    sb.from('messages').select('sender_id').eq('recipient_id', uid),
  ]);
  const ids = new Set();
  (iFollow || []).forEach(r => ids.add(r.followee_id));
  (followMe || []).forEach(r => ids.add(r.follower_id));
  (sent || []).forEach(r => r.recipient_id && ids.add(r.recipient_id));
  (received || []).forEach(r => r.sender_id && ids.add(r.sender_id));
  ids.delete(uid);
  chatEligibleContactIdsCache = ids;
  return ids;
}

// "New chat" search covers two very different result kinds sharing
// one box: people (scoped to chatEligibleContactIds() — folks you've
// already DMed, who follow you, or who you follow, mutual or not —
// same restriction as before) and public groups/channels (open to
// everyone, per the conversations_select RLS policy: `is_public =
// true` is readable by any authenticated user regardless of
// membership — see supabase/fix_conversation_members_recursion.sql).
// Tapping either kind jumps straight into that chat: a user goes to
// their DM thread, a public group/channel goes to loadGroupThread()
// which auto-joins on arrival if you're not a member yet (same
// Telegram-style "subscribe by opening" flow used there).
let chatNewSearchDebounce = null;
let chatNewSearchResults = new Map();      // username -> profile
let chatNewSearchGroupResults = new Map(); // id -> conversation row
let chatNewSearchFirstHit = null;          // { type: 'user'|'group', key } — whatever Enter should open
function chatNewSearchUsers(q) {
  clearTimeout(chatNewSearchDebounce);
  const resultsEl = document.getElementById('chat-new-results');
  const errEl = document.getElementById('chat-new-err');
  if (!resultsEl) return;
  clearErr(errEl);
  chatNewSearchFirstHit = null;
  if (!q.trim()) { resultsEl.innerHTML = ''; return; }
  chatNewSearchDebounce = setTimeout(async () => {
    const uname = q.trim().replace(/^@/, '');
    const ids = [...await chatEligibleContactIds()];
    const [peopleRes, groupsRes] = await Promise.all([
      ids.length
        ? sb.from('profiles').select('id,username,display_name,avatar_url,verified,verification_type')
            .or(`username.ilike.%${uname}%,display_name.ilike.%${uname}%`)
            .in('id', ids)
            .limit(6)
        : Promise.resolve({ data: [] }),
      sb.from('conversations').select('id,kind,name,description,avatar_url')
        .eq('is_public', true)
        .in('kind', ['group', 'channel'])
        .ilike('name', `%${uname}%`)
        .limit(6),
    ]);
    const people = peopleRes.data || [];
    const groups = groupsRes.data || [];
    chatNewSearchResults = new Map(people.map(p => [p.username, p]));
    chatNewSearchGroupResults = new Map(groups.map(g => [g.id, g]));
    chatNewSearchFirstHit = people.length ? { type: 'user', key: people[0].username }
      : groups.length ? { type: 'group', key: groups[0].id }
      : null;

    if (!people.length && !groups.length) {
      const msg = ids.length ? t('chat.userNotFound') : t('chat.noContactsYet');
      resultsEl.innerHTML = `<div class="gcv-member-row" style="cursor:default;"><div class="ulrow-txt"><span class="ulrow-name">${esc(msg)}</span></div></div>`;
      return;
    }

    const peopleHtml = people.map(p => `
      <div class="gcv-member-row" onclick="chatNewPickUser('${esc(p.username)}')">
        <img src="${esc(avatarUrl(p.avatar_url))}" alt="">
        <div class="ulrow-txt"><span class="ulrow-name">${esc(p.display_name || p.username)}${vBadge(p)}</span><span class="ulrow-handle">@${esc(p.username)}</span></div>
      </div>`).join('');
    const groupsHtml = groups.map(g => `
      <div class="gcv-member-row" onclick="chatNewPickGroup('${esc(g.id)}')">
        <div class="chat-search-group-avatar">${g.avatar_url ? `<img src="${esc(avatarUrl(g.avatar_url))}" alt="">` : esc((g.name || '?').slice(0, 1).toUpperCase())}</div>
        <div class="ulrow-txt"><span class="ulrow-name">${esc(g.name)}</span><span class="ulrow-handle">${g.kind === 'channel' ? ICON_CHANNEL : ICON_GROUP}${g.kind === 'channel' ? 'Channel' : 'Group'} &middot; Public</span></div>
      </div>`).join('');

    // Only bother labeling the two sections when both are present —
    // a single-kind result list reads fine with no header at all.
    const showHeaders = peopleHtml && groupsHtml;
    resultsEl.innerHTML =
      (peopleHtml ? (showHeaders ? '<div class="chat-search-section-hdr">People</div>' : '') + peopleHtml : '') +
      (groupsHtml ? (showHeaders ? '<div class="chat-search-section-hdr">Groups &amp; channels</div>' : '') + groupsHtml : '');
  }, 250);
}
function chatNewPickUser(username) {
  const p = chatNewSearchResults.get(username);
  if (!p) return;
  location.href = messagesUrl(p.username);
}
function chatNewPickGroup(id) {
  const g = chatNewSearchGroupResults.get(id);
  if (!g) return;
  location.href = groupMessagesUrl(g.id);
}

// Enter-to-send fallback for the same box — opens whichever result
// the live search above ranked first (a person or a public group/
// channel), so Enter behaves like tapping the top row. Falls back to
// an exact-username lookup (still scoped to chatEligibleContactIds())
// if no live search has run yet, e.g. paste-then-Enter before the
// debounce fires.
async function startChat() {
  const input = document.getElementById('chat-new-user');
  const errEl = document.getElementById('chat-new-err');
  clearErr(errEl);
  const uname = input.value.trim().replace(/^@/, '');
  if (!uname) return;
  if (chatNewSearchFirstHit) {
    if (chatNewSearchFirstHit.type === 'user') return chatNewPickUser(chatNewSearchFirstHit.key);
    return chatNewPickGroup(chatNewSearchFirstHit.key);
  }
  const ids = [...await chatEligibleContactIds()];
  if (!ids.length) { showErr(errEl, t('chat.userNotFound')); return; }
  const { data: profile, error } = await sb.from('profiles').select('id,username').ilike('username', uname).in('id', ids).maybeSingle();
  if (error || !profile) { showErr(errEl, t('chat.userNotFound')); return; }
  location.href = messagesUrl(profile.username);
}

// ── CREATE GROUP / CHANNEL ──
// Reuses the app's generic .modal-bg/.modal shell (see the delete-
// post confirm modal / edit-post modal in common.js for the same
// pattern). 'group' = anyone in it can post; 'channel' = only the
// owner/admin can post, everyone else just reads — matches the
// kind check constraint in supabase/chat_full_setup.sql.
//
// Redesigned as a 3-step wizard (basic info -> privacy -> members)
// instead of one long scrolling form — same fields and same backing
// #gcv-* element ids as before (so gcvSearchMembers/gcvPickMember/
// createConversation/etc. all still work untouched), just split
// across three panels that gcvGoToStep() shows one at a time. All
// three panels are built up front (not injected per-step) so nothing
// the person already typed is lost switching steps, and Group<->
// Channel can still be swapped from step 1 without losing step 2/3
// input, same as before.
function openCreateConversationModal(kind) {
  gcvPickedMembers.clear();
  gcvResetAvatarState();
  gcvStep = 1;
  document.getElementById('gcv-modal-bg')?.remove();
  const bg = document.createElement('div');
  bg.id = 'gcv-modal-bg';
  bg.className = 'modal-bg';
  bg.onclick = e => { if (e.target === bg) closeCreateConversationModal(); };
  bg.innerHTML = `
    <div class="modal gcv-modal" role="dialog" aria-modal="true">
      <div class="gcv-head">
        <a class="gcv-back" href="#" id="gcv-back" onclick="event.preventDefault();gcvGoToStep(gcvStep-1);" aria-label="Back" style="visibility:hidden;">${ICON_BACK}</a>
        <h2 id="gcv-title">New ${kind === 'channel' ? 'channel' : 'group'}</h2>
        <a class="gcv-close" href="#" onclick="event.preventDefault();closeCreateConversationModal();" aria-label="Close">${ICON_CLOSE}</a>
      </div>
      <div class="gcv-progress" aria-hidden="true">
        <span class="gcv-progress-seg" id="gcv-seg-1"></span>
        <span class="gcv-progress-seg" id="gcv-seg-2"></span>
        <span class="gcv-progress-seg" id="gcv-seg-3"></span>
      </div>
      <p class="gcv-step-label" id="gcv-step-label">Step 1 of 3 &middot; Basic info</p>

      <div class="gcv-step" id="gcv-step-1">
        <div class="gcv-kind-tabs" role="tablist">
          <button type="button" id="gcv-tab-group" class="${kind !== 'channel' ? 'cur' : ''}" onclick="gcvSwitchKind('group')">${ICON_GROUP} Group</button>
          <button type="button" id="gcv-tab-channel" class="${kind === 'channel' ? 'cur' : ''}" onclick="gcvSwitchKind('channel')">${ICON_CHANNEL} Channel</button>
        </div>
        <p class="dc-desc" id="gcv-desc-text">${kind === 'channel'
          ? 'Only you (and any admins you add) can post. Everyone else just reads — like a broadcast list.'
          : 'Everyone you add can post and see the conversation.'}</p>
        <div class="gcv-upload-box">
          <span class="gcv-avatar-wrap" id="gcv-avatar-wrap">
            <label class="gcv-avatar-preview" id="gcv-avatar-preview" for="gcv-avatar-file">${ICON_AVATAR_PLACEHOLDER}</label>
            <label class="gcv-avatar-badge" for="gcv-avatar-file" aria-hidden="true">${ICON_PLUS_PLAIN}</label>
            <input type="file" id="gcv-avatar-file" accept="image/*" style="display:none;">
          </span>
          <span class="gcv-upload-txt" id="gcv-upload-txt">Add a picture<small>Optional</small></span>
        </div>
        <div class="gcv-pill-field">
          <input type="text" id="gcv-name" maxlength="${GCV_NAME_MAX}" placeholder="Name" oninput="gcvUpdateCreateBtn();gcvUpdateCharCount('gcv-name','gcv-name-count',${GCV_NAME_MAX})">
          <span class="gcv-pill-charcount" id="gcv-name-count">0/${GCV_NAME_MAX}</span>
        </div>
        <div class="gcv-pill-field gcv-pill-field-area">
          <textarea id="gcv-desc" rows="1" maxlength="${GCV_DESC_MAX}" placeholder="Description (optional)" oninput="gcvUpdateCharCount('gcv-desc','gcv-desc-count',${GCV_DESC_MAX})"></textarea>
          <span class="gcv-pill-charcount" id="gcv-desc-count">0/${GCV_DESC_MAX}</span>
        </div>
      </div>

      <div class="gcv-step" id="gcv-step-2" style="display:none;">
        <div class="gcv-privacy-illus" id="gcv-privacy-illus" aria-hidden="true">${ICON_GLOBE}</div>
        <div class="gcv-setting-row">
          <span class="gcv-setting-icon">${ICON_GLOBE}</span>
          <span class="gcv-setting-txt" id="gcv-toggle-txt">Public ${kind}<small>Anyone can find and join without an invite</small></span>
          <label class="toggle"><input type="checkbox" id="gcv-public"><span class="toggle-track"></span></label>
        </div>
      </div>

      <div class="gcv-step" id="gcv-step-3" style="display:none;">
        <div class="gcv-pill-field gcv-pill-field-search">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
          <input id="gcv-member-search" placeholder="Add members by username" oninput="gcvSearchMembers(this.value)">
        </div>
        <div class="gcv-member-results" id="gcv-member-results"></div>
        <div class="gcv-members-picked" id="gcv-members-picked"></div>
      </div>

      <div class="errmsg" id="gcv-err" style="display:none;"></div>
      <input type="hidden" id="gcv-kind" value="${esc(kind)}">
      <div class="gcv-footer">
        <button type="button" class="gcv-create-btn" id="gcv-next-btn" onclick="gcvGoToStep(gcvStep+1)" disabled>Continue</button>
        <button type="button" class="gcv-create-btn" id="gcv-create-btn" onclick="createConversation()" style="display:none;">Create ${kind === 'channel' ? 'channel' : 'group'}</button>
      </div>
    </div>`;
  document.body.appendChild(bg);
  requestAnimationFrame(() => bg.classList.add('open'));
  setTimeout(() => document.getElementById('gcv-name')?.focus(), 50);
  // Every other modal/sheet in the app (compose, GIF/emoji pickers,
  // the chat FAB sheet) locks page scroll behind it via .oc-sheet-open
  // — this one never did, so the conversation list kept scrolling
  // (and showing its own scrollbar) right through the dimmed overlay
  // while the modal was open.
  document.body.classList.add('oc-sheet-open');
  gcvGoToStep(1);
  document.getElementById('gcv-avatar-file').addEventListener('change', (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    const errEl = document.getElementById('gcv-err');
    if (!file || !validateFile(file, errEl)) return;
    clearErr(errEl);
    openCropModal(file, 'square', (cropped) => {
      gcvAvatarBlob = cropped;
      if (gcvAvatarPreviewUrl) URL.revokeObjectURL(gcvAvatarPreviewUrl);
      gcvAvatarPreviewUrl = URL.createObjectURL(cropped);
      const prev = document.getElementById('gcv-avatar-preview');
      if (prev) prev.innerHTML = `<img src="${gcvAvatarPreviewUrl}" alt="">`;
    });
  });
}
function gcvResetAvatarState() {
  if (gcvAvatarPreviewUrl) { URL.revokeObjectURL(gcvAvatarPreviewUrl); }
  gcvAvatarPreviewUrl = null;
  gcvAvatarBlob = null;
}
function closeCreateConversationModal() {
  document.getElementById('gcv-modal-bg')?.remove();
  gcvResetAvatarState();
  document.body.classList.remove('oc-sheet-open');
}

// Moves the wizard to step n (1-3), swapping which panel is visible,
// updating the progress bar/step label/back-button visibility, and
// swapping the footer between "Continue" (steps 1-2) and the actual
// "Create group/channel" button (step 3) — so the create action is
// physically a different, unmissable button rather than the same
// "Continue" pill silently changing what it does on the last step.
// Clamped to 1-3 so Back on step 1 / Continue past step 3 no-op.
const GCV_STEP_LABELS = { 1: 'Basic info', 2: 'Privacy', 3: 'Members' };
function gcvGoToStep(n) {
  n = Math.max(1, Math.min(3, n));
  if (n === 2 && !document.getElementById('gcv-name')?.value.trim()) return; // guard against Enter-key/direct calls skipping the name requirement
  gcvStep = n;
  for (let i = 1; i <= 3; i++) {
    const panel = document.getElementById(`gcv-step-${i}`);
    if (panel) panel.style.display = i === n ? '' : 'none';
    document.getElementById(`gcv-seg-${i}`)?.classList.toggle('filled', i <= n);
  }
  const label = document.getElementById('gcv-step-label');
  if (label) label.innerHTML = `Step ${n} of 3 &middot; ${GCV_STEP_LABELS[n]}`;
  const back = document.getElementById('gcv-back');
  if (back) back.style.visibility = n === 1 ? 'hidden' : 'visible';
  const nextBtn = document.getElementById('gcv-next-btn');
  const createBtn = document.getElementById('gcv-create-btn');
  if (nextBtn) nextBtn.style.display = n === 3 ? 'none' : '';
  if (createBtn) createBtn.style.display = n === 3 ? '' : 'none';
  if (n === 1) gcvUpdateCreateBtn();
  const focusTarget = n === 1 ? 'gcv-name' : n === 3 ? 'gcv-member-search' : null;
  if (focusTarget) setTimeout(() => document.getElementById(focusTarget)?.focus(), 50);
}

// Switches between Group/Channel without rebuilding the modal, so

// whatever the person already typed (name, description, public
// toggle, picked members) survives the switch instead of getting
// wiped — the old openCreateConversationModal(kind) re-call used to
// blow all of that away just to swap a couple of labels.
function gcvSwitchKind(kind) {
  const kindInput = document.getElementById('gcv-kind');
  if (!kindInput || kindInput.value === kind) return;
  kindInput.value = kind;
  const isChannel = kind === 'channel';
  document.getElementById('gcv-tab-group')?.classList.toggle('cur', !isChannel);
  document.getElementById('gcv-tab-channel')?.classList.toggle('cur', isChannel);
  const titleEl = document.getElementById('gcv-title');
  if (titleEl) titleEl.textContent = `New ${isChannel ? 'channel' : 'group'}`;
  const descEl = document.getElementById('gcv-desc-text');
  if (descEl) descEl.textContent = isChannel
    ? 'Only you (and any admins you add) can post. Everyone else just reads — like a broadcast list.'
    : 'Everyone you add can post and see the conversation.';
  const nameEl = document.getElementById('gcv-name');
  if (nameEl) nameEl.placeholder = 'Name';
  const descField = document.getElementById('gcv-desc');
  if (descField) descField.placeholder = 'Description (optional)';
  const toggleTxt = document.getElementById('gcv-toggle-txt');
  if (toggleTxt) toggleTxt.innerHTML = `Public ${kind}<small>Anyone can find and join without an invite</small>`;
  const btn = document.getElementById('gcv-create-btn');
  if (btn) btn.textContent = `Create ${isChannel ? 'channel' : 'group'}`;
  // Upload-box plus glyph is identical for both kinds, so switching
  // Group<->Channel no longer needs to swap it — only guard against
  // clobbering a real chosen picture.
  if (!gcvAvatarBlob) {
    const prev = document.getElementById('gcv-avatar-preview');
    if (prev) prev.innerHTML = ICON_AVATAR_PLACEHOLDER;
  }
}

// Continue (step 1) is only enabled once a name is typed — matches
// the same "disable until valid" pattern used elsewhere in the app,
// instead of letting the person tap through and only then finding
// out step 3 needs a name. gcv-create-btn itself has nothing to
// validate (name was already required to reach it), so this only
// ever touches gcv-next-btn.
function gcvUpdateCreateBtn() {
  const nameEl = document.getElementById('gcv-name');
  const btn = document.getElementById('gcv-next-btn');
  if (!nameEl || !btn) return;
  btn.disabled = !nameEl.value.trim();
}

// Shared live character counter for the name/description fields in
// both the create modal (gcv-*) and the group-info edit form
// (gi-edit-*) — same "N/max" pattern, just parameterized by ids so
// one function covers both. Turns red once the field is full (still
// valid, just a heads-up the limit's been hit) rather than only once
// it's over, since maxlength makes "over" impossible by typing.
function gcvUpdateCharCount(inputId, countId, max) {
  const input = document.getElementById(inputId);
  const countEl = document.getElementById(countId);
  if (!input || !countEl) return;
  const len = input.value.length;
  countEl.textContent = `${len}/${max}`;
  countEl.classList.toggle('gcv-charcount-limit', len >= max);
}

let gcvSearchDebounce = null;
function gcvSearchMembers(q) {
  clearTimeout(gcvSearchDebounce);
  const resultsEl = document.getElementById('gcv-member-results');
  if (!resultsEl) return;
  if (!q.trim()) { resultsEl.innerHTML = ''; return; }
  gcvSearchDebounce = setTimeout(async () => {
    const { data } = await sb.from('profiles').select('id,username,display_name,avatar_url,verified,verification_type')
      .or(`username.ilike.%${q.trim()}%,display_name.ilike.%${q.trim()}%`)
      .neq('id', currentSession?.user?.id || '')
      .limit(8);
    gcvSearchResults = new Map((data || []).map(p => [p.username, p]));
    resultsEl.innerHTML = (data || [])
      .filter(p => !gcvPickedMembers.has(p.username))
      .map(p => `
        <div class="gcv-member-row" onclick="gcvPickMember('${esc(p.username)}')">
          <img src="${esc(avatarUrl(p.avatar_url))}" alt="">
          <div class="ulrow-txt"><span class="ulrow-name">${esc(p.display_name || p.username)}${vBadge(p)}</span><span class="ulrow-handle">@${esc(p.username)}</span></div>
        </div>`).join('');
  }, 250);
}
let gcvSearchResults = new Map(); // username -> full profile row from the last search, so gcvPickMember() can carry verified status through without cramming it into an inline-handler string
function gcvPickMember(username) {
  const p = gcvSearchResults.get(username);
  if (!p) return;
  gcvPickedMembers.set(username, p);
  document.getElementById('gcv-member-search').value = '';
  document.getElementById('gcv-member-results').innerHTML = '';
  renderGcvPicked();
}
function gcvRemoveMember(username) { gcvPickedMembers.delete(username); renderGcvPicked(); }
function renderGcvPicked() {
  const el = document.getElementById('gcv-members-picked');
  if (!el) return;
  el.innerHTML = [...gcvPickedMembers.values()].map(p => `
    <span class="gcv-chip">
      <img src="${esc(avatarUrl(p.avatar_url))}" alt="">
      ${esc(p.display_name || p.username)}${vBadge(p)}
      <button type="button" onclick="gcvRemoveMember('${esc(p.username)}')" aria-label="Remove">${ICON_CLOSE}</button>
    </span>`).join('');
}

async function createConversation() {
  const errEl = document.getElementById('gcv-err');
  clearErr(errEl);
  const kind = document.getElementById('gcv-kind').value;
  const name = document.getElementById('gcv-name').value.trim();
  const description = document.getElementById('gcv-desc').value.trim();
  const isPublic = document.getElementById('gcv-public').checked;
  if (!name) { showErr(errEl, 'Give it a name first.'); return; }
  if (name.length > GCV_NAME_MAX) { showErr(errEl, `Name must be ${GCV_NAME_MAX} characters or less.`); return; }
  if (description.length > GCV_DESC_MAX) { showErr(errEl, `Description must be ${GCV_DESC_MAX} characters or less.`); return; }
  if (!currentSession) return;

  const btn = document.getElementById('gcv-create-btn');
  btn.disabled = true;

  let avatar_url = null;
  if (gcvAvatarBlob) {
    try {
      avatar_url = await uploadAvatar(gcvAvatarBlob, currentSession.user.id);
    } catch (e) {
      showErr(errEl, e.message || 'Could not upload the picture — try again.');
      btn.disabled = false;
      return;
    }
  }

  const { data: conv, error } = await sb.from('conversations')
    .insert({ kind, name, description: description || null, is_public: isPublic, avatar_url })
    .select('id').single();
  if (error || !conv) { showErr(errEl, error?.message || 'Could not create it — try again.'); btn.disabled = false; return; }

  const extraMembers = [...gcvPickedMembers.values()];
  if (extraMembers.length) {
    await sb.from('conversation_members').insert(
      extraMembers.map(p => ({ conversation_id: conv.id, user_id: p.id, role: 'member' }))
    );
  }
  closeCreateConversationModal();
  location.href = groupMessagesUrl(conv.id);
}

// ── ONE-ON-ONE THREAD ──
async function loadThread(session, root) {
  const { data: other, error: otherErr } = await sb.from('profiles').select('*').ilike('username', chatWithUsername).maybeSingle();
  if (otherErr || !other) { root.innerHTML = `<div class="errmsg">${esc(t('chat.userNotFound'))}</div>`; return; }
  if (other.id === session.user.id) { root.innerHTML = `<div class="errmsg">${esc(t('chat.cantMessageSelf'))}</div>`; return; }
  chatOther = other;
  // Mirrors :has(.chat-thread) in style.css for mobile browsers that
  // don't support :has() — see the comment on .chat-thread-open there.
  document.body.classList.add('chat-thread-open');

  document.getElementById('chat-sec-bar').innerHTML = `<a class="back" href="chat.html" style="margin:0 10px 0 0;">&larr;</a> ${esc(other.display_name || other.username)}`;

  // get_dm_thread() decrypts server-side (see
  // supabase/chat_server_side_encryption.sql) — no client-side key
  // material or per-device state involved, so this works identically
  // on any device the instant it's opened.
  const { data: msgs, error } = await sb.rpc('get_dm_thread', { other_user_id: other.id });

  if (error) { root.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }

  // Drop anything I've deleted-for-me (a single message, or the
  // whole conversation via deleteConversationWithUser()) — the other
  // person's copy is untouched, this only affects what I see.
  const visibleMsgs = (msgs || []).filter(m => {
    const mine = m.sender_id === session.user.id;
    return mine ? !m.deleted_for_sender : !m.deleted_for_recipient;
  });
  visibleMsgs.forEach(m => {
    if (m.deleted_for_everyone) { m._plain = ''; }
    // Rows still tagged with the old client-side E2E format (iv set,
    // body_encrypted false) hold ciphertext under a scheme this app no
    // longer has any key material for — show that plainly instead of
    // either garbled ciphertext or claiming it decrypted.
    else if (m.iv && !m.body_encrypted) { m._plain = null; }
    else { m._plain = m.body; }
  });

  const encBanner = `<div class="chat-e2e-banner">${CHAT_ICON_LOCK}<span>${esc(t('chat.e2eActive'))}</span></div>`;

  // Snapshot which messages are unread *before* we mark them read
  // below — renderMsgsHtml() uses this to drop a WhatsApp-style
  // "N unread messages" divider right above the first one, so
  // opening a thread with a backlog shows where to start reading
  // instead of just dumping you at the bottom.
  const unreadMsgIds = new Set(visibleMsgs.filter(m => m.recipient_id === session.user.id && !m.read).map(m => m.id));

  // Belt-and-suspenders same as the profile "···" menu — @marpe can't
  // be blocked (see isProtectedFollowUsername() / the DB trigger in
  // supabase/profile_extras.sql), so the option is simply left out of
  // the dropdown here rather than offered and then rejected.
  chatOtherBlockedByMe = currentSession ? await isBlocked(other.id) : false;
  const chatBlockItem = isProtectedFollowUsername(other.username) ? '' :
    `<button type="button" class="pc-menu-danger" onclick="chatToggleBlock(event, '${other.id}', '${u_(other.username)}')">${esc((chatOtherBlockedByMe ? t('chat.unblockUser') : t('chat.blockUser')).replace('{username}', '@' + other.username))}</button>`;
  const blockedNotice = chatOtherBlockedByMe ? `
      <div class="chat-channel-notice">${ICON_LOCK_SMALL}<span>${esc(t('chat.blockedNotice').replace('{username}', '@' + other.username))}</span></div>` : '';

  root.innerHTML = `
    <div class="chat-thread">
      <div class="chat-hdr">
        <a class="chat-hdr-back" href="chat.html" aria-label="${esc(t('chat.back'))}">${ICON_BACK}</a>
        <a href="${profileUrl(other.username)}"><img class="avatar${avSqClass(other)}" src="${esc(avatarUrl(other.avatar_url))}" alt="" loading="lazy" decoding="async"></a>
        <div>
          <a class="nm" href="${profileUrl(other.username)}">${esc(other.display_name || other.username)}${vBadge(other)}</a>
          <span class="pc-handle">@${esc(other.username)}</span>
        </div>
        <div class="pc-menu-wrap chat-hdr-menu-wrap" id="cmenu-thread-${other.id}">
          <button type="button" class="pc-menu-btn" aria-label="${esc(t('chat.chatOptions'))}" onclick="toggleConvMenu('thread-${other.id}', event)">${ICON.menu}</button>
          <div class="pc-menu-dd">
            <button type="button" onclick="toggleChatSearch(event)">${esc(t('chat.searchInConversation'))}</button>
            <button type="button" class="pc-menu-danger" onclick="clearChatWithUser('${other.id}', '${u_(other.username)}', event)">${esc(t('chat.clearChat'))}</button>
            ${chatBlockItem}
          </div>
        </div>
      </div>
      <div class="chat-search-bar" id="chat-search-bar" hidden>
        ${ICON_SEARCH}
        <input type="text" id="chat-search-input" placeholder="${esc(t('chat.searchPlaceholder'))}" oninput="filterChatSearch(this.value)">
        <button type="button" class="chat-search-close" aria-label="${esc(t('chat.back'))}" onclick="toggleChatSearch(event)">${ICON_CLOSE}</button>
      </div>
      <div class="chat-msgs" id="chat-msgs">${encBanner}${renderMsgsHtml(visibleMsgs, session.user.id, unreadMsgIds)}</div>
      <div id="chat-search-empty" class="chat-search-empty" hidden>${esc(t('chat.noSearchResults'))}</div>
      ${blockedNotice}
      <div id="chat-attach-preview" class="chat-attach-preview" hidden></div>
      <div id="chat-record-bar" class="chat-record-bar" hidden>
        <span class="chat-record-dot"></span>
        <span id="chat-record-time" class="chat-record-time">0:00</span>
        <span class="chat-record-hint">&lsaquo; ${esc(t('chat.slideToCancel'))}</span>
        <button type="button" class="chat-record-cancel" title="${esc(t('chat.cancelRecording'))}" aria-label="${esc(t('chat.cancelRecording'))}" onclick="cancelVoiceRecording()">${ICON_TRASH}</button>
        <button type="button" class="chat-record-stop" title="${esc(t('chat.stopRecording'))}" aria-label="${esc(t('chat.stopRecording'))}" onclick="stopVoiceRecording()">${ICON_STOP}</button>
      </div>
      ${chatOtherBlockedByMe ? '' : `
      <div class="chat-composer" id="chat-composer">
        <input type="file" id="chat-file" accept="image/*,video/*" style="display:none;" onchange="onChatFileChosen(this)">
        <button type="button" class="chat-tool-btn" id="chat-attach-btn" title="${esc(t('chat.attachMedia'))}" aria-label="${esc(t('chat.attachMedia'))}" onclick="document.getElementById('chat-file').click()">${ICON_ATTACH}</button>
        <button type="button" class="chat-tool-btn" id="chat-mic-btn" title="${esc(t('chat.recordVoice'))}" aria-label="${esc(t('chat.recordVoice'))}" onclick="startVoiceRecording()">${ICON_MIC}</button>
        <textarea id="chat-body" maxlength="2000" placeholder="${esc(t('chat.startMessagePlaceholder'))}" rows="1"
          oninput="autoGrowChatInput(this)"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage();}"></textarea>
        <button class="chat-send-btn" id="chat-send-btn" title="${esc(t('chat.send'))}" aria-label="${esc(t('chat.send'))}" disabled onclick="sendMessage()">${ICON_SEND}</button>
      </div>`}
    </div>`;

  sizeChatThread();
  scrollChatToBottom();
  applyChatPrefill();

  const unreadIds = [...unreadMsgIds];
  if (unreadIds.length) {
    await sb.from('messages').update({ read: true }).in('id', unreadIds);
    if (typeof unreadChatCount === 'number') {
      unreadChatCount = Math.max(0, unreadChatCount - unreadIds.length);
      renderSideNav(); renderMobileChrome();
    }
  }

  subscribeChatRealtime(session.user.id, other.id);
}

// Picks up a one-shot prefill dropped into sessionStorage by another
// page's "Send via Chat" action (see listMenuSendChat() in list.js) —
// there's no in-app recipient picker yet, so the flow is: stash the
// text, land on the inbox (or straight into a thread if the link
// already named a recipient), and whichever thread opens first
// consumes it. Cleared immediately after use so it doesn't leak into
// an unrelated later message.
function applyChatPrefill() {
  let text;
  try { text = sessionStorage.getItem('oc-chat-prefill'); } catch (e) { return; }
  if (!text) return;
  try { sessionStorage.removeItem('oc-chat-prefill'); } catch (e) {}
  const bodyEl = document.getElementById('chat-body');
  if (!bodyEl) return;
  bodyEl.value = text;
  autoGrowChatInput(bodyEl);
  bodyEl.focus();
}

// Grows the composer textarea to fit its content (up to the CSS
// max-height, after which it scrolls internally), toggles the send
// button on/off based on whether there's anything to send, and lets
// the other side know I'm typing (throttled — see notifyTyping()).
function autoGrowChatInput(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
  const hasText = !!el.value.trim();
  updateChatSendBtn();
  if (hasText) notifyTyping();
}

// Send is enabled once there's text OR a pending attachment (image/
// video/voice note) — a caption isn't required to send media, same
// as every other chat app.
function updateChatSendBtn() {
  const btn = document.getElementById('chat-send-btn');
  if (!btn) return;
  const bodyEl = document.getElementById('chat-body');
  const hasText = !!(bodyEl && bodyEl.value.trim());
  btn.disabled = !hasText && !chatAttachment;
}

// ── TYPING INDICATOR ──
// Broadcast-only (no DB row, nothing to clean up): while the other
// person has text in their composer their client pings this channel
// roughly every 2s; we show an animated "..." bubble for a few
// seconds after the most recent ping and let it expire on its own if
// no more arrive (covers them closing the tab, navigating away, etc.
// without needing an explicit "stopped typing" event).
let typingLastSentAt = 0;
let typingHideTimer = null;
let recordingLastSentAt = 0;

function notifyTyping() {
  if (!chatChannel || !currentSession) return;
  const now = Date.now();
  if (now - typingLastSentAt < 2000) return;
  typingLastSentAt = now;
  chatChannel.send({ type: 'broadcast', event: 'typing', payload: { from: currentSession.user.id, kind: 'text' } });
}

// Same channel/event as notifyTyping() but with kind:'audio', so the
// other side's bubble can say "recording a voice message" with a mic
// icon instead of the generic "…" dots — called once immediately
// when recording starts and then re-pinged every 2s off the existing
// record-timer tick (see updateChatRecordTimer()) for as long as the
// mic stays open. stopVoiceRecording()/cancelVoiceRecording() send an
// explicit 'typing-stop' so the bubble disappears the instant
// recording ends instead of waiting out the 3s expiry.
function notifyRecording() {
  if (!chatChannel || !currentSession) return;
  const now = Date.now();
  if (now - recordingLastSentAt < 2000) return;
  recordingLastSentAt = now;
  chatChannel.send({ type: 'broadcast', event: 'typing', payload: { from: currentSession.user.id, kind: 'audio' } });
}
function notifyStoppedActivity() {
  if (!chatChannel || !currentSession) return;
  chatChannel.send({ type: 'broadcast', event: 'typing-stop', payload: { from: currentSession.user.id } });
}

function showTypingBubble(kind = 'text') {
  const container = document.getElementById('chat-msgs');
  if (!container) return;
  const existing = document.getElementById('chat-typing-row');
  if (existing) { existing.dataset.kind = kind; existing.querySelector('.msg-bubble').innerHTML = typingBubbleInnerHtml(kind); return; }
  container.insertAdjacentHTML('beforeend', `
    <div class="msg-row theirs g-start g-end" id="chat-typing-row" data-kind="${esc(kind)}">
      <div class="msg-bubble chat-typing-bubble" aria-label="${esc(kind === 'audio' ? t('chat.recording') : t('chat.typing'))}">
        ${typingBubbleInnerHtml(kind)}
      </div>
    </div>`);
  scrollChatToBottom();
}
function typingBubbleInnerHtml(kind) {
  return kind === 'audio'
    ? `<span class="chat-recording-indicator">${ICON_MIC}<span class="chat-recording-pulse"></span></span>`
    : `<span class="chat-typing-dots"><span></span><span></span><span></span></span>`;
}
function hideTypingBubble() {
  document.getElementById('chat-typing-row')?.remove();
  if (typingHideTimer) { clearTimeout(typingHideTimer); typingHideTimer = null; }
}

// "Today" / "Yesterday" / "Monday" / "Aug 6" — same day-grouping
// labels used by real chat apps, shown as dividers between messages.
function chatDayLabel(iso) {
  const d = new Date(iso);
  const startOfDay = dt => new Date(dt.getFullYear(), dt.getMonth(), dt.getDate());
  const diffDays = Math.round((startOfDay(new Date()) - startOfDay(d)) / 86400000);
  if (diffDays === 0) return t('chat.today');
  if (diffDays === 1) return t('chat.yesterday');
  if (diffDays < 7) return d.toLocaleDateString(getLang(), { weekday: 'long' });
  return d.toLocaleDateString(getLang(), { weekday: 'short', month: 'short', day: 'numeric' });
}

function chatClockTime(iso) {
  return new Date(iso).toLocaleTimeString(getLang(), { hour: 'numeric', minute: '2-digit' });
}

// Renders the full message list with day-divider headers inserted
// wherever the calendar day changes between consecutive messages,
// and groups consecutive same-sender messages sent within 5 minutes
// of each other (tight spacing, tail only on the group's last
// bubble) rather than giving every message its own gap and tail.
const GROUP_GAP_MS = 5 * 60 * 1000;
function renderMsgsHtml(msgs, myId, unreadIds) {
  let html = '';
  let lastDay = null;
  // First message whose id is in `unreadIds` gets the "N unread
  // messages" divider dropped right above it — matches WhatsApp's
  // behavior of marking where the backlog starts instead of just
  // showing every unread message with a generic dot.
  const unreadCount = unreadIds ? unreadIds.size : 0;
  const firstUnreadIdx = unreadCount ? msgs.findIndex(m => unreadIds.has(m.id)) : -1;
  msgs.forEach((m, i) => {
    const day = chatDayLabel(m.created_at);
    if (day !== lastDay) { html += `<div class="chat-daydivider">${esc(day)}</div>`; lastDay = day; }
    if (i === firstUnreadIdx) {
      html += `<div class="chat-unread-divider"><span>${unreadCount === 1 ? esc(t('chat.unreadOne')) : esc(t('chat.unreadMany').replace('{n}', unreadCount))}</span></div>`;
    }
    const prev = msgs[i - 1];
    const next = msgs[i + 1];
    const groupsWithPrev = prev && prev.sender_id === m.sender_id && day === chatDayLabel(prev.created_at)
      && (new Date(m.created_at) - new Date(prev.created_at)) < GROUP_GAP_MS;
    const groupsWithNext = next && next.sender_id === m.sender_id && day === chatDayLabel(next.created_at)
      && (new Date(next.created_at) - new Date(m.created_at)) < GROUP_GAP_MS;
    html += msgBubbleHtml(m, myId, { start: !groupsWithPrev, end: !groupsWithNext });
  });
  return html;
}

// m._plain must already be set before calling this (the loaders above
// set it directly from the already-decrypted RPC result) — this
// Telegram/WhatsApp-style "meta" (clock time + read ticks) that sits
// on the same line as the end of the message text, inside the bubble
// itself, instead of floating outside it as a separate element. For
// a bare-media bubble (photo/video with no caption) there's no text
// flow to float alongside, so it renders as a small translucent chip
// docked over the bottom-right corner of the media instead — same
// convention every chat app uses for that case.
function msgMetaHtml(iso, ticksHtml, overlay) {
  return `<span class="msg-meta${overlay ? ' msg-meta-overlay' : ''}">${chatClockTime(iso)}${ticksHtml}</span>`;
}

// isn't.
function msgBubbleHtml(m, myId, group = { start: true, end: true }) {
  const mine = m.sender_id === myId;
  const cls = ['msg-row', mine ? 'mine' : 'theirs'];
  if (group.start) cls.push('g-start');
  if (group.end) cls.push('g-end');

  // Deleted-for-everyone tombstone — content was already wiped
  // server-side (delete_message_for_everyone), so there's nothing to
  // decrypt or render but a placeholder. Takes priority over the
  // undecryptable-bubble case below.
  if (m.deleted_for_everyone) {
    const meta = msgMetaHtml(m.created_at, '', false);
    return `
  <div class="${cls.join(' ')}" id="msg-${m.id}" data-day="${esc(chatDayLabel(m.created_at))}" data-sender="${esc(m.sender_id)}" data-ts="${esc(m.created_at)}" data-search="">
    ${msgMenuHtml(m, mine)}
    <div class="msg-bubble">${CHAT_ICON_LOCK}<em class="msg-deleted-note">${esc(t('chat.messageDeleted'))}</em>${meta}</div>
  </div>`;
  }

  // An attachment's iv/body only cover the caption — the message can
  // have media with no caption at all, in which case m._plain is ''
  // (never null, since '' never went through encryption/decryption
  // to begin with) and no text bubble content is rendered for it.
  const hasCaption = m._plain != null && m._plain !== '';
  const bodyHtml = m._plain != null
    ? (hasCaption ? renderBody(m._plain) : '')
    : `<div class="msg-undecryptable">${CHAT_ICON_LOCK}<em>This message used the old encryption system and can't be read anymore.</em></div>`;
  const mediaHtml = chatMediaHtml(m);
  const ticksHtml = mine
    ? `<span class="msg-ticks${m.read ? ' read' : ''}">${m.read ? ICON_TICK2 : ICON_TICK1}</span>`
    : '';
  // A media-only bubble (no caption) drops the usual chat-bubble
  // background/padding for images & video — same visual treatment
  // WhatsApp/Telegram use, so a photo isn't sitting in a maroon box
  // with padding around it. Voice notes always render inside a
  // normal bubble since they're compact either way.
  const bareMedia = mediaHtml && !hasCaption && m.media_type !== 'audio';
  const meta = msgMetaHtml(m.created_at, ticksHtml, bareMedia);
  const bubbleInner = mediaHtml + bodyHtml + meta;
  const menu = msgMenuHtml(m, mine);
  // Menu sits on the side of the bubble closest to the thread's
  // center column — before the bubble for "mine" (row is packed to
  // the right, so this lands just left of it), after the bubble for
  // "theirs" (row packed left, lands just right of it).
  const searchText = hasCaption ? esc(m._plain.toLowerCase()) : '';
  return `
  <div class="${cls.join(' ')}" id="msg-${m.id}" data-day="${esc(chatDayLabel(m.created_at))}" data-sender="${esc(m.sender_id)}" data-ts="${esc(m.created_at)}" data-search="${searchText}">
    ${mine ? menu : ''}
    <div class="msg-bubble${bareMedia ? ' msg-bubble-bare-media' : ''}">${bubbleInner}</div>
    ${mine ? '' : menu}
  </div>`;
}

// The hover-reveal "···" next to a bubble. "Delete for me" is always
// offered (works for either side of the DM); "Delete for everyone"
// only for your own, not-already-deleted messages.
function msgMenuHtml(m, mine) {
  return `
    <div class="pc-menu-wrap msg-menu-wrap" id="mmenu-${m.id}">
      <button type="button" class="pc-menu-btn" onclick="toggleMsgMenu('${m.id}', event)">${ICON.menu}</button>
      <div class="pc-menu-dd">
        <button type="button" onclick="deleteMessageForMe('${m.id}', event)">${esc(t('chat.deleteForMe'))}</button>
        ${mine && !m.deleted_for_everyone ? `<button type="button" class="pc-menu-danger" onclick="deleteMessageForEveryone('${m.id}', event)">${esc(t('chat.deleteForEveryone'))}</button>` : ''}
      </div>
    </div>`;
}

// ── PER-MESSAGE / PER-CONVERSATION "···" MENUS ──
// Same open/close/position behavior as togglePostMenu() (common.js),
// just generic over any wrap element instead of assuming the
// "pmenu-<id>" post-menu id shape.
function toggleGenericMenu(wrap, ev) {
  if (ev) ev.stopPropagation();
  if (!wrap) return;
  const willOpen = !wrap.classList.contains('open');
  document.querySelectorAll('.pc-menu-wrap.open').forEach(w => { if (w !== wrap) w.classList.remove('open'); });
  if (willOpen) { wrap.classList.add('open'); positionMenuDd(wrap); }
  else { wrap.classList.remove('open'); }
}
function toggleMsgMenu(id, ev) { toggleGenericMenu(document.getElementById(`mmenu-${id}`), ev); }
function toggleConvMenu(id, ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  toggleGenericMenu(document.getElementById(`cmenu-${id}`), ev);
}

// Hides one message from just this account's view (see
// delete_message_for_me in supabase/chat_delete_messages_and_contacts.sql).
// Works whether the current user is the sender or the recipient.
async function deleteMessageForMe(id, ev) {
  if (ev) ev.stopPropagation();
  document.getElementById(`mmenu-${id}`)?.classList.remove('open');
  const ok = await ocConfirm({
    title: t('chat.deleteMessageTitle'),
    desc: t('chat.deleteForMeDesc'),
    confirmLabel: t('chat.deleteForMe'),
  });
  if (!ok) return;
  try {
    const { error } = await sb.rpc('delete_message_for_me', { message_id: id });
    if (error) throw error;
    document.getElementById(`msg-${id}`)?.remove();
  } catch (e) {
    toast(e.message || 'Could not delete that message.', 'error');
  }
}

// Sender-only. Wipes the message for both sides and swaps the bubble
// to a "This message was deleted" tombstone in place, without a full
// thread reload.
async function deleteMessageForEveryone(id, ev) {
  if (ev) ev.stopPropagation();
  document.getElementById(`mmenu-${id}`)?.classList.remove('open');
  const ok = await ocConfirm({
    title: t('chat.deleteMessageTitle'),
    desc: t('chat.deleteForEveryoneDesc'),
    confirmLabel: t('chat.deleteForEveryone'),
  });
  if (!ok) return;
  try {
    const { error } = await sb.rpc('delete_message_for_everyone', { message_id: id });
    if (error) throw error;
    const row = document.getElementById(`msg-${id}`);
    if (row) {
      const bubble = row.querySelector('.msg-bubble');
      if (bubble) bubble.innerHTML = `${CHAT_ICON_LOCK}<em class="msg-deleted-note">${esc(t('chat.messageDeleted'))}</em>`;
      row.querySelectorAll('.msg-menu-wrap .pc-menu-danger').forEach(b => b.remove());
    }
  } catch (e) {
    toast(e.message || 'Could not delete that message.', 'error');
  }
}

// "Delete this contact" from the message list — delete-for-me on
// every message exchanged with them (see delete_conversation_with_user
// in the same migration). Only affects this account's own inbox.
async function deleteConversationWithUser(otherId, uname, ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  document.getElementById(`cmenu-${otherId}`)?.classList.remove('open');
  const ok = await ocConfirm({
    title: t('chat.deleteConversationTitle'),
    desc: t('chat.deleteConversationDesc').replace(/\{username\}/g, uname),
    confirmLabel: t('chat.deleteConversation'),
  });
  if (!ok) return;
  try {
    const { error } = await sb.rpc('delete_conversation_with_user', { other_user_id: otherId });
    if (error) throw error;
    document.getElementById(`cmenu-${otherId}`)?.closest('.conv-row-wrap')?.remove();
  } catch (e) {
    toast(e.message || 'Could not delete that conversation.', 'error');
  }
}

// ── THREAD "···" MENU: search / clear chat / block ──
// Same delete_conversation_with_user RPC as deleteConversationWithUser()
// above (delete-for-me, other side untouched) — just triggered from
// inside an already-open thread instead of a conversation-list row,
// and re-labeled "Clear chat" since that's the more accurate name for
// what it does when you're looking at the thread itself: it empties
// the thread you're looking at rather than removing a row from a list.
async function clearChatWithUser(otherId, uname, ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  document.getElementById(`cmenu-thread-${otherId}`)?.classList.remove('open');
  const decoded = decodeURIComponent(uname);
  const ok = await ocConfirm({
    title: t('chat.clearChatTitle'),
    desc: t('chat.clearChatDesc').replace(/\{username\}/g, decoded),
    confirmLabel: t('chat.clearChat'),
  });
  if (!ok) return;
  try {
    const { error } = await sb.rpc('delete_conversation_with_user', { other_user_id: otherId });
    if (error) throw error;
    // Re-run the normal page loader rather than hand-rolling an empty
    // state here — it re-fetches get_dm_thread(), which now comes
    // back empty (every row is deleted_for_sender for me), so this
    // naturally lands on the same empty-thread view a brand new
    // conversation would show.
    await loadChat();
    toast(t('chat.chatCleared'));
  } catch (e) {
    toast(e.message || 'Could not clear this chat.', 'error');
  }
}

// Blocks (or unblocks) the person I'm currently chatting with, right
// from the thread's "···" menu — same blockUser()/unblockUser()/
// isBlocked() used by the profile page's own block button (see
// profileMenuBlock() in profile.js), just re-entered here so it's
// reachable without leaving the chat. @marpe is exempt (see
// isProtectedFollowUsername()) same as everywhere else blocking is
// offered.
async function chatToggleBlock(ev, userId, uname) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  document.getElementById(`cmenu-thread-${userId}`)?.classList.remove('open');
  if (!requireLogin()) return;
  const decoded = decodeURIComponent(uname);
  if (isProtectedFollowUsername(decoded)) { toast(`You can't block @${decoded}.`, 'error'); return; }

  const currentlyBlocked = chatOtherBlockedByMe;
  if (!currentlyBlocked) {
    const ok = await ocConfirm({
      title: t('chat.blockTitle').replace('{username}', '@' + decoded),
      desc: t('chat.blockDesc'),
      confirmLabel: t('action.block'),
      danger: true
    });
    if (!ok) return;
  }
  try {
    if (currentlyBlocked) {
      await unblockUser(userId);
      toast(`Unblocked @${decoded}.`);
    } else {
      await blockUser(userId);
      toast(`Blocked @${decoded}.`);
    }
    // Re-render: this both flips the menu's Block/Unblock label and
    // swaps the composer for the "you've blocked them" notice (or
    // back), same as loadProfile() re-rendering after a block toggle
    // on the profile page.
    await loadChat();
  } catch (e) {
    toast(e.message || 'Could not update block status.', 'error');
  }
}

// Reveals/hides the in-thread search bar. Closing it also clears
// whatever filter was applied, so re-opening the menu later starts
// from a full, unfiltered thread rather than remembering a stale query.
function toggleChatSearch(ev) {
  if (ev) { ev.preventDefault(); ev.stopPropagation(); }
  document.querySelectorAll('.pc-menu-wrap.open').forEach(w => w.classList.remove('open'));
  const bar = document.getElementById('chat-search-bar');
  if (!bar) return;
  const opening = bar.hidden;
  if (opening) {
    bar.hidden = false;
    document.getElementById('chat-search-input')?.focus();
  } else {
    bar.hidden = true;
    const input = document.getElementById('chat-search-input');
    if (input) input.value = '';
    filterChatSearch('');
  }
}

// Plain substring match against each bubble's data-search (already
// lower-cased at render time) — no fuzzy matching, same as every
// other in-app search (see e.g. side-search). Day dividers and the
// unread divider are hidden while a query is active since they'd
// otherwise float above whatever handful of messages happen to match,
// which reads as a rendering bug rather than a filtered view.
function filterChatSearch(query) {
  const q = query.trim().toLowerCase();
  const msgsBox = document.getElementById('chat-msgs');
  const emptyEl = document.getElementById('chat-search-empty');
  if (!msgsBox) return;
  const rows = msgsBox.querySelectorAll('.msg-row');
  let visibleCount = 0;
  rows.forEach(row => {
    const match = !q || (row.dataset.search || '').includes(q);
    row.hidden = !match;
    if (match) visibleCount++;
  });
  msgsBox.querySelectorAll('.chat-daydivider, .chat-unread-divider').forEach(el => { el.hidden = !!q; });
  if (emptyEl) emptyEl.hidden = !(q && visibleCount === 0);
}

// Renders a message row's attachment, if any. Images/video reuse the
// exact same helpers the feed uses (renderMedia() -> lightbox, ttv
// player) so tapping a photo/video in a DM behaves identically to
// tapping one in a post. Voice notes get the compact player above.
function chatMediaHtml(m) {
  if (!m.media_url) return '';
  if (m.media_type === 'audio') return voicePlayerHtml(m.media_url, m.media_duration_ms);
  return renderMedia(m.media_url, m.media_type, 'chat-media-img');
}

// Appends one new message (from sendMessage() or the realtime
// subscription below), inserting a fresh day-divider first if it
// falls on a different day than the last message already shown, and
// re-flagging the previously-last row as a group continuation if the
// new message groups with it (same sender, <5min apart, same day).
function appendChatMsg(m, myId) {
  const container = document.getElementById('chat-msgs');
  if (!container) return;
  hideTypingBubble(); // a real message supersedes the "..." bubble
  const day = chatDayLabel(m.created_at);
  const rows = container.querySelectorAll('.msg-row');
  const lastRow = rows.length ? rows[rows.length - 1] : null;
  const lastDay = lastRow ? lastRow.dataset.day : null;

  const groupsWithLast = lastRow && lastRow.dataset.sender === m.sender_id && day === lastDay
    && (new Date(m.created_at) - new Date(lastRow.dataset.ts)) < GROUP_GAP_MS;
  if (groupsWithLast) lastRow.classList.remove('g-end');

  let html = '';
  if (day !== lastDay) html += `<div class="chat-daydivider">${esc(day)}</div>`;
  html += msgBubbleHtml(m, myId, { start: !groupsWithLast, end: true });
  container.insertAdjacentHTML('beforeend', html);
}

// Flips a single message's tick from single (sent) to double (read),
// or back, in place — driven by the realtime UPDATE handler below,
// which fires once per row the other person's client marks read.
function markMsgRead(id, read) {
  const tickEl = document.querySelector(`#msg-${id} .msg-ticks`);
  if (!tickEl) return;
  tickEl.classList.toggle('read', read);
  tickEl.innerHTML = read ? ICON_TICK2 : ICON_TICK1;
}

function scrollChatToBottom() {
  const el = document.getElementById('chat-msgs');
  if (el) el.scrollTop = el.scrollHeight;
}

// On mobile, .chat-thread goes full-screen (position:fixed, see
// style.css) and sizes itself off --vvh (kept in sync with
// window.visualViewport by common.js) so the composer rides right
// above the on-screen keyboard instead of getting hidden underneath
// it — same trick the global compose modal uses. On desktop it's
// just a normal panel sized to fill from wherever it starts down to
// the bottom of the screen.
function sizeChatThread() {
  const wrap = document.querySelector('.chat-thread');
  if (!wrap) return;
  if (window.matchMedia('(max-width:700px)').matches) {
    wrap.style.height = ''; // CSS handles it (position:fixed + var(--vvh))
    // The composer stays pinned above the keyboard via --vvh, but the
    // message list itself was never re-scrolled when the keyboard
    // opens/closes and the container height changes — that left a
    // visible gap between the last bubble and the composer (or the
    // last few messages hidden under the keyboard). Re-pin to the
    // bottom on every viewport resize, same as a real chat app.
    scrollChatToBottom();
    return;
  }
  const top = wrap.getBoundingClientRect().top;
  wrap.style.height = `calc(100vh - ${top}px)`;
}
window.addEventListener('resize', sizeChatThread);
if (window.visualViewport) window.visualViewport.addEventListener('resize', sizeChatThread);

// ── ATTACHMENTS: PICK A FILE ──
function onChatFileChosen(input) {
  const file = input.files[0];
  input.value = ''; // so picking the exact same file again still fires 'change'
  if (!file) return;
  if (!validateFile(file, null)) return; // validateFile() alert()s its own error when passed no errEl
  cancelVoiceRecording(); // file and voice-note are mutually exclusive, same as post composer's file/GIF
  if (chatAttachment) URL.revokeObjectURL(chatAttachment.previewUrl);
  chatAttachment = { file, type: mediaTypeFor(file), previewUrl: URL.createObjectURL(file) };
  renderChatAttachPreview();
  updateChatSendBtn();
}

function clearChatAttachment() {
  if (chatAttachment) URL.revokeObjectURL(chatAttachment.previewUrl);
  chatAttachment = null;
  renderChatAttachPreview();
  updateChatSendBtn();
}

// Shows a small thumbnail/player above the composer for whatever's
// about to be sent, with a way to back out before it uploads.
function renderChatAttachPreview() {
  const box = document.getElementById('chat-attach-preview');
  if (!box) return;
  if (!chatAttachment) { box.hidden = true; box.innerHTML = ''; return; }
  box.hidden = false;
  const rmBtn = `<button type="button" class="chat-attach-remove" title="${esc(t('chat.removeAttachment'))}" aria-label="${esc(t('chat.removeAttachment'))}" onclick="clearChatAttachment()">${ICON_TRASH}</button>`;
  if (chatAttachment.type === 'image') {
    box.innerHTML = `<div class="chat-attach-thumb"><img src="${esc(chatAttachment.previewUrl)}" alt="">${rmBtn}</div>`;
  } else if (chatAttachment.type === 'video') {
    box.innerHTML = `<div class="chat-attach-thumb"><video src="${esc(chatAttachment.previewUrl)}" muted></video>${rmBtn}</div>`;
  } else { // audio (recorded voice note, played back for confirmation before sending)
    box.innerHTML = `<div class="chat-attach-voice">${voicePlayerHtml(chatAttachment.previewUrl, chatAttachment.durationMs)}${rmBtn}</div>`;
  }
}

// ── VOICE NOTES: RECORD ──
async function startVoiceRecording() {
  if (chatRecorder) return; // already recording
  if (chatAttachment) clearChatAttachment(); // voice-note and file are mutually exclusive
  // getUserMedia only exists in a secure context (https, or localhost)
  // and isn't implemented at all in some embedded/in-app browser
  // WebViews — catching that up front gives a real explanation instead
  // of the generic denied-permission toast, which is misleading when
  // the mic was never even prompted for.
  if (!navigator.mediaDevices?.getUserMedia) {
    toast(t('chat.micUnsupported'), 'error');
    return;
  }
  let stream;
  try {
    // Explicit constraints instead of bare `audio:true`. autoGainControl
    // is what actually fixes "recordings come out quiet" — some mobile
    // WebViews only apply gain control when it's asked for by name,
    // they don't reliably turn it on for a bare boolean request. Echo
    // cancellation/noise suppression are on for the same reason: don't
    // assume the browser's implicit defaults are good enough for a
    // voice note that's about to get compressed further.
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
    });
  } catch (e) {
    // Different failure modes need different guidance — a blanket
    // "couldn't access your microphone" leaves someone whose browser
    // has the mic permanently blocked with no idea it's a one-time
    // site-settings fix, not a bug that'll go away on retry.
    const msgKey = e?.name === 'NotAllowedError' || e?.name === 'SecurityError' ? 'chat.micBlocked'
      : e?.name === 'NotFoundError' || e?.name === 'OverconstrainedError' ? 'chat.micNotFound'
      : e?.name === 'NotReadableError' ? 'chat.micInUse'
      : 'chat.micPermissionDenied';
    toast(t(msgKey), 'error');
    return;
  }
  chatRecorderStream = stream;
  chatRecorderChunks = [];
  const mimeType = ['audio/webm', 'audio/mp4', 'audio/ogg'].find(m => window.MediaRecorder?.isTypeSupported?.(m)) || '';
  // audioBitsPerSecond was previously left unset, which lets the
  // browser pick its own default — and for the opus/webm path that
  // default is tuned for small file size over clarity (well under
  // 32kbps on some browsers), which is exactly what "sounds quiet and
  // low quality" looks like from the encoder's side. 128kbps is
  // plenty for a voice note and still small enough to upload quickly.
  const recorderOpts = { audioBitsPerSecond: 128000, ...(mimeType ? { mimeType } : {}) };
  chatRecorder = new MediaRecorder(stream, recorderOpts);
  chatRecorder.ondataavailable = e => { if (e.data && e.data.size) chatRecorderChunks.push(e.data); };
  chatRecorder.onstop = () => {
    stream.getTracks().forEach(tr => tr.stop());
    chatRecorderStream = null;
    const blob = new Blob(chatRecorderChunks, { type: chatRecorder.mimeType || 'audio/webm' });
    chatRecorder = null;
    if (chatRecordCancelled) { chatRecordCancelled = false; return; }
    if (!blob.size) return;
    const ext = (blob.type.split('/')[1] || 'webm').split(';')[0];
    const file = new File([blob], `voice-note.${ext}`, { type: blob.type });
    // Recorded here, not read back from the audio element later — see
    // supabase/voice_note_duration.sql for why: the browser's own
    // .duration reporting for a fresh webm blob is unreliable (varies
    // by device/browser), but we already know exactly how long the
    // recording ran, so there's nothing to guess.
    const durationMs = Date.now() - chatRecordStartedAt;
    chatAttachment = { file, type: 'audio', previewUrl: URL.createObjectURL(blob), durationMs };
    renderChatAttachPreview();
    updateChatSendBtn();
  };
  chatRecorder.start();
  chatRecordStartedAt = Date.now();
  document.getElementById('chat-record-bar').hidden = false;
  const composerEl = document.getElementById('chat-composer');
  if (composerEl) composerEl.hidden = true; // recording replaces the composer entirely (record bar only) instead of showing both at once
  recordingLastSentAt = 0; // force the first ping out immediately rather than waiting on stale throttle state from an earlier recording
  notifyRecording();
  chatRecordTimerHandle = setInterval(updateChatRecordTimer, 250);
  updateChatRecordTimer();
}

let chatRecordCancelled = false;
function updateChatRecordTimer() {
  const el = document.getElementById('chat-record-time');
  if (!el) return;
  const secs = Math.floor((Date.now() - chatRecordStartedAt) / 1000);
  el.textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
  notifyRecording();
}
function stopChatRecordUi() {
  if (chatRecordTimerHandle) { clearInterval(chatRecordTimerHandle); chatRecordTimerHandle = null; }
  const bar = document.getElementById('chat-record-bar');
  if (bar) bar.hidden = true;
  const composerEl = document.getElementById('chat-composer');
  if (composerEl) composerEl.hidden = false;
  notifyStoppedActivity();
}
function stopVoiceRecording() {
  if (!chatRecorder) return;
  stopChatRecordUi();
  chatRecorder.stop(); // triggers onstop above, which turns the recording into chatAttachment
}
function cancelVoiceRecording() {
  if (!chatRecorder) return;
  chatRecordCancelled = true;
  stopChatRecordUi();
  chatRecorder.stop();
}

// ── VOICE NOTES: COMPACT PLAYBACK BUBBLE ──
// Used both for the pre-send preview and for rendering a received/
// sent voice note in the thread. Backed by a plain <audio> element
// (hidden) with a small custom play/pause + progress bar on top of
// it, matching the rest of the app's hand-rolled player (js/video-
// player.js) rather than pulling in a dependency for something this
// small.
function voicePlayerHtml(url, durationMs) {
  const knownSecs = durationMs ? durationMs / 1000 : null;
  return `
  <span class="voice-msg" data-known-duration="${knownSecs != null ? knownSecs : ''}">
    <button type="button" class="voice-play-btn" onclick="toggleVoicePlay(this)">${ICON_VOICE_PLAY}</button>
    <span class="voice-wave">${voiceWaveformSvg(url)}<span class="voice-wave-fg-clip">${voiceWaveformSvg(url)}</span></span>
    <span class="voice-time">${knownSecs != null ? fmtVoiceTime(knownSecs) : '0:00'}</span>
    <audio preload="metadata" src="${esc(url)}"></audio>
  </span>`;
}
// Renders the bar-style waveform every voice-note UI uses (WhatsApp/
// Telegram) instead of a flat progress line. There's no real
// waveform data to draw (that'd mean decoding the audio just to
// render a placeholder), so the bar heights are a deterministic
// pseudo-random pattern seeded from the file's own URL — meaningless
// as audio data, but stable across re-renders so a given voice note
// always shows the same "shape" instead of jittering every repaint.
// Called twice per bubble (see voicePlayerHtml): once for the dim
// background bars, once for the bright ones clipped to the played
// fraction by .voice-wave-fg-clip's width.
function voiceWaveformSvg(seed) {
  const barW = 2.6, gap = 2.2, h = 22, n = 27;
  let x = 0;
  for (let i = 0; i < seed.length; i++) x = (x * 31 + seed.charCodeAt(i)) >>> 0;
  let bars = '';
  for (let i = 0; i < n; i++) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    const pct = 24 + (x % 76); // 24%–100% of the lane height
    const barH = Math.max(2, Math.round(h * pct / 100));
    bars += `<rect x="${(i * (barW + gap)).toFixed(1)}" y="${((h - barH) / 2).toFixed(1)}" width="${barW}" height="${barH}" rx="1.3"/>`;
  }
  const totalW = (n * (barW + gap) - gap).toFixed(1);
  return `<svg class="voice-wave-svg" viewBox="0 0 ${totalW} ${h}" preserveAspectRatio="none" width="${totalW}" height="${h}">${bars}</svg>`;
}
function fmtVoiceTime(secs) {
  if (!isFinite(secs) || secs < 0) secs = 0;
  return `${Math.floor(secs / 60)}:${String(Math.floor(secs % 60)).padStart(2, '0')}`;
}
// Recorded voice notes are webm blobs, and Chrome (and Chromium-based
// browsers) has a long-standing, INCONSISTENT bug where a freshly
// recorded webm's .duration reads as Infinity until a seek-to-the-end
// trick runs — "inconsistent" because that trick doesn't reliably
// work the same way across every browser/device (it can work on one
// phone's browser and not on a desktop browser). Rather than lean on
// that fragile workaround, playback now prefers the message's own
// stored, always-correct media_duration_ms (see
// supabase/voice_note_duration.sql) whenever it's present — that
// value came from actually timing the recording, so there's no
// browser quirk to work around. The seek-hack below only runs as a
// fallback for voice notes sent before that column existed.
function fixInfiniteAudioDuration(audio) {
  return new Promise(resolve => {
    if (isFinite(audio.duration) && audio.duration > 0) { resolve(audio.duration); return; }
    let settled = false;
    const finish = (val) => { if (settled) return; settled = true; audio.removeEventListener('timeupdate', onTimeUpdate); resolve(val); };
    const onTimeUpdate = () => { audio.currentTime = 0; finish(audio.duration); };
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.currentTime = 1e101;
    // Some browsers never fire the timeupdate this trick relies on —
    // don't hang the play button forever waiting on it.
    setTimeout(() => finish(0), 1500);
  });
}

function toggleVoicePlay(btn) {
  const wrap = btn.closest('.voice-msg');
  const audio = wrap.querySelector('audio');
  const fill = wrap.querySelector('.voice-wave-fg-clip');
  const timeEl = wrap.querySelector('.voice-time');
  const knownAttr = wrap.dataset.knownDuration;
  const knownDuration = knownAttr ? parseFloat(knownAttr) : null;
  if (chatActiveVoiceAudio && chatActiveVoiceAudio !== audio) {
    chatActiveVoiceAudio.pause(); // only one voice note plays at a time
  }

  const updateBar = () => {
    const durationForPct = knownDuration || (isFinite(audio.duration) ? audio.duration : 0);
    const pct = durationForPct ? Math.min(100, (audio.currentTime / durationForPct) * 100) : 0;
    fill.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    timeEl.textContent = fmtVoiceTime(audio.currentTime);
  };
  // requestAnimationFrame instead of the 'timeupdate' event — timeupdate
  // only fires a few times a second (browser-dependent, often as
  // sparse as 4x/sec), which reads as a bar that jumps in visible
  // steps rather than glides. rAF re-checks audio.currentTime on every
  // paint frame instead, so the fill tracks playback smoothly.
  let rafHandle = null;
  const rafLoop = () => {
    if (audio.paused || audio.ended) { rafHandle = null; return; }
    updateBar();
    rafHandle = requestAnimationFrame(rafLoop);
  };

  if (audio.paused) {
    const startPlayback = () => {
      audio.play().catch(() => {});
      rafHandle = requestAnimationFrame(rafLoop);
    };
    if (knownDuration) {
      startPlayback(); // no need to touch audio.duration at all
    } else if (!isFinite(audio.duration) || audio.duration <= 0) {
      fixInfiniteAudioDuration(audio).then(startPlayback);
    } else {
      startPlayback();
    }
    chatActiveVoiceAudio = audio;
    btn.innerHTML = ICON_VOICE_PAUSE;
  } else {
    audio.pause();
    if (rafHandle) cancelAnimationFrame(rafHandle);
    btn.innerHTML = ICON_VOICE_PLAY;
    return;
  }
  audio.onpause = () => { btn.innerHTML = ICON_VOICE_PLAY; if (rafHandle) cancelAnimationFrame(rafHandle); };
  audio.onended = () => {
    btn.innerHTML = ICON_VOICE_PLAY;
    if (rafHandle) cancelAnimationFrame(rafHandle);
    fill.style.clipPath = 'inset(0 100% 0 0)';
    const total = knownDuration || (isFinite(audio.duration) ? audio.duration : 0);
    timeEl.textContent = fmtVoiceTime(total);
    if (chatActiveVoiceAudio === audio) chatActiveVoiceAudio = null;
  };
}

async function sendMessage() {
  const bodyEl = document.getElementById('chat-body');
  const body = bodyEl.value.trim();
  const attachment = chatAttachment;
  if ((!body && !attachment) || !chatOther || !currentSession) return;
  bodyEl.value = '';
  autoGrowChatInput(bodyEl);
  hideTypingBubble();
  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) sendBtn.disabled = true;

  // Media uploads first (unencrypted — see supabase/chat_media.sql),
  // then the row is inserted with whatever caption came with it.
  // Clearing chatAttachment right away (rather than after upload)
  // means a second message can't accidentally reuse the same file
  // while this one is still in flight.
  chatAttachment = null;
  let media_url = null, media_type = null;
  if (attachment) {
    document.getElementById('chat-attach-preview').innerHTML = `<div class="chat-attach-uploading">${esc(t('chat.uploading'))}</div>`;
    try {
      const uploaded = await uploadMedia(attachment.file, status => {
        const box = document.getElementById('chat-attach-preview');
        if (box) box.innerHTML = `<div class="chat-attach-uploading">${esc(status)}</div>`;
      });
      media_url = uploaded.media_url;
      media_type = attachment.type; // trust our own picker/recorder over uploadMedia()'s guess (it doesn't know 'audio')
    } catch (e) {
      alert(e.message || t('chat.failedToSend'));
      chatAttachment = attachment; // put it back so nothing's lost
      renderChatAttachPreview();
      updateChatSendBtn();
      return;
    } finally {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }
  renderChatAttachPreview();

  const insertRow = { sender_id: currentSession.user.id, recipient_id: chatOther.id, media_url, media_type, body };
  if (attachment?.type === 'audio' && attachment.durationMs) insertRow.media_duration_ms = attachment.durationMs;
  // body is sent as plain text over TLS and encrypted server-side by
  // messages_encrypt_body_trg the moment it's inserted — see
  // supabase/chat_server_side_encryption.sql. Nothing to do client-side.

  const { data, error } = await sb.from('messages').insert(insertRow).select('*').single();
  if (error) { alert(error.message || t('chat.failedToSend')); return; }
  data._plain = body; // already have the plaintext locally — no need to round-trip through the decrypt RPC for our own send
  if (!document.getElementById(`msg-${data.id}`)) {
    appendChatMsg(data, currentSession.user.id);
    scrollChatToBottom();
  }
}

function subscribeChatRealtime(myId, otherId) {
  if (chatChannel) sb.removeChannel(chatChannel);
  chatChannel = sb.channel(`dm-${[myId, otherId].sort().join('-')}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `sender_id=eq.${otherId}` }, async payload => {
      const incoming = payload.new;
      if (incoming.recipient_id !== myId) return;
      if (document.getElementById(`msg-${incoming.id}`)) return;
      // Realtime streams the raw row (still ciphertext) — get_message()
      // decrypts it server-side. See supabase/chat_server_side_encryption.sql.
      const { data: m, error } = await sb.rpc('get_message', { msg_id: incoming.id });
      if (error || !m) return;
      m._plain = m.deleted_for_everyone ? '' : (m.iv && !m.body_encrypted ? null : m.body);
      appendChatMsg(m, myId);
      scrollChatToBottom();
      sb.from('messages').update({ read: true }).eq('id', m.id);
      // subscribeChatBadge() (auth.js) also reacts to this INSERT and
      // bumps the badge — since we mark it read immediately (thread's
      // open), undo that bump right back down.
      if (typeof unreadChatCount === 'number' && unreadChatCount > 0) {
        unreadChatCount--;
        renderSideNav(); renderMobileChrome();
      }
    })
    // Flips the tick to "read" the moment the other person opens the
    // thread and their client marks one of my messages read — fires
    // once per row, so a bulk "mark all as read" updates every tick
    // in the thread individually rather than just the last one.
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'messages', filter: `sender_id=eq.${myId}` }, payload => {
      const m = payload.new;
      if (m.recipient_id !== otherId) return;
      markMsgRead(m.id, !!m.read);
    })
    .on('broadcast', { event: 'typing' }, ({ payload }) => {
      if (!payload || payload.from !== otherId) return;
      showTypingBubble(payload.kind === 'audio' ? 'audio' : 'text');
      if (typingHideTimer) clearTimeout(typingHideTimer);
      // Recording pings arrive every 2s same as typing, but give audio
      // a slightly longer grace window — a brief pause mid-recording
      // (e.g. gathering thoughts) shouldn't flash the bubble away.
      typingHideTimer = setTimeout(hideTypingBubble, payload.kind === 'audio' ? 4000 : 3000);
    })
    .on('broadcast', { event: 'typing-stop' }, ({ payload }) => {
      if (!payload || payload.from !== otherId) return;
      hideTypingBubble();
    })
    .subscribe();
}

// ── GROUP / CHANNEL THREAD ──
// Same composer/attachment machinery as the 1:1 thread above (voice
// notes, image/video attach, auto-grow textarea) — all of that is
// already keyed off the generic `chatAttachment` global rather than
// `chatOther`, so it works here unchanged. Group/channel messages are
// now encrypted at rest server-side too (they weren't before) — see
// supabase/chat_server_side_encryption.sql; nothing client-side needs
// to change between the two cases, get_group_thread()/get_message()
// handle the decryption transparently.
async function loadGroupThread(session, root) {
  const { data: conv, error: convErr } = await sb.from('conversations').select('*').eq('id', chatGroupId).maybeSingle();
  if (convErr || !conv) { root.innerHTML = `<div class="errmsg">${esc(t('chat.userNotFound') || "This chat doesn't exist.")}</div>`; return; }

  const { data: members } = await sb.from('conversation_members')
    .select('user_id, role, joined_at, profile:profiles(id,username,display_name,avatar_url,verified,verification_type)')
    .eq('conversation_id', conv.id);

  chatGroup = conv;
  chatGroupMembers = members || [];
  const mine = chatGroupMembers.find(m => m.user_id === session.user.id);
  chatGroupMyRole = mine ? mine.role : null;

  if (!chatGroupMyRole && !conv.is_public) {
    root.innerHTML = `<div class="errmsg">You're not a member of this ${conv.kind}.</div>`;
    return;
  }

  document.body.classList.add('chat-thread-open');
  document.getElementById('chat-sec-bar').innerHTML = `<a class="back" href="chat.html" style="margin:0 10px 0 0;">&larr;</a> ${esc(conv.name)}`;

  // Public conversation, not yet a member — auto-join like subscribing
  // to a Telegram channel (RLS: conversation_members_insert_self_public).
  if (!chatGroupMyRole && conv.is_public) {
    const { error: joinErr } = await sb.from('conversation_members').insert({ conversation_id: conv.id, user_id: session.user.id, role: 'member' });
    if (!joinErr) {
      chatGroupMyRole = 'member';
      chatGroupMembers.push({ user_id: session.user.id, role: 'member', joined_at: new Date().toISOString(), profile: currentProfile });
    }
  }

  // get_group_thread() decrypts server-side — see
  // supabase/chat_server_side_encryption.sql. Group/channel messages
  // are now encrypted at rest too (they weren't before).
  const { data: msgs, error } = await sb.rpc('get_group_thread', { conv_id: conv.id });
  if (error) { root.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
  (msgs || []).forEach(m => { m._plain = m.body; });

  const canPost = conv.kind === 'group' || chatGroupMyRole === 'owner' || chatGroupMyRole === 'admin';
  const composerHtml = canPost ? `
      <div id="chat-attach-preview" class="chat-attach-preview" hidden></div>
      <div id="chat-record-bar" class="chat-record-bar" hidden>
        <span class="chat-record-dot"></span>
        <span id="chat-record-time" class="chat-record-time">0:00</span>
        <span class="chat-record-hint">&lsaquo; ${esc(t('chat.slideToCancel'))}</span>
        <button type="button" class="chat-record-cancel" title="${esc(t('chat.cancelRecording'))}" aria-label="${esc(t('chat.cancelRecording'))}" onclick="cancelVoiceRecording()">${ICON_TRASH}</button>
        <button type="button" class="chat-record-stop" title="${esc(t('chat.stopRecording'))}" aria-label="${esc(t('chat.stopRecording'))}" onclick="stopVoiceRecording()">${ICON_STOP}</button>
      </div>
      <div class="chat-composer" id="chat-composer">
        <input type="file" id="chat-file" accept="image/*,video/*" style="display:none;" onchange="onChatFileChosen(this)">
        <button type="button" class="chat-tool-btn" id="chat-attach-btn" title="${esc(t('chat.attachMedia'))}" aria-label="${esc(t('chat.attachMedia'))}" onclick="document.getElementById('chat-file').click()">${ICON_ATTACH}</button>
        <button type="button" class="chat-tool-btn" id="chat-mic-btn" title="${esc(t('chat.recordVoice'))}" aria-label="${esc(t('chat.recordVoice'))}" onclick="startVoiceRecording()">${ICON_MIC}</button>
        <textarea id="chat-body" maxlength="2000" placeholder="${conv.kind === 'channel' ? 'Post to this channel' : esc(t('chat.startMessagePlaceholder'))}" rows="1"
          oninput="autoGrowChatInput(this)"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendGroupMessage();}"></textarea>
        <button class="chat-send-btn" id="chat-send-btn" title="${esc(t('chat.send'))}" aria-label="${esc(t('chat.send'))}" disabled onclick="sendGroupMessage()">${ICON_SEND}</button>
      </div>` : `
      <div class="chat-channel-notice">${ICON_LOCK_SMALL}<span>Only the owner and admins can post in this channel.</span></div>`;

  root.innerHTML = `
    <div class="chat-thread">
      <div class="chat-hdr">
        <a class="chat-hdr-back" href="chat.html" aria-label="${esc(t('chat.back'))}">${ICON_BACK}</a>
        <a href="#" onclick="event.preventDefault();openGroupInfo();">${groupAvatarHtml(conv)}</a>
        <div>
          <a class="nm" href="#" onclick="event.preventDefault();openGroupInfo();">${esc(conv.name)}</a>
          <span class="chat-hdr-sub">${conv.kind === 'channel' ? 'Channel' : 'Group'} &middot; ${chatGroupMembers.length} member${chatGroupMembers.length === 1 ? '' : 's'}${conv.is_public ? ' &middot; Public' : ''}</span>
        </div>
        <button type="button" class="chat-hdr-info-btn" aria-label="Chat info" onclick="openGroupInfo()">${ICON_INFO}</button>
      </div>
      <div class="chat-msgs" id="chat-msgs">${renderGroupMsgsHtml(msgs || [], session.user.id, mine ? mine.last_read_at : null)}</div>
      ${composerHtml}
    </div>`;

  sizeChatThread();
  scrollChatToBottom();

  if (mine) {
    await sb.from('conversation_members').update({ last_read_at: new Date().toISOString() }).eq('conversation_id', conv.id).eq('user_id', session.user.id);
  }

  subscribeGroupRealtime(conv.id, session.user.id);
}

function groupSenderProfile(senderId) {
  return chatGroupMembers.find(m => m.user_id === senderId)?.profile || null;
}

function renderGroupMsgsHtml(msgs, myId, lastReadAt) {
  let html = '';
  let lastDay = null;
  // Same "N unread messages" divider as the 1:1 thread, positioned
  // at the first message that arrived after this member's
  // last_read_at (and that isn't mine — I don't need reminding about
  // my own messages) and using last_read_at as the snapshot cutoff
  // since group unread is tracked per-member, not per-message.
  const unreadFromIdx = lastReadAt ? msgs.findIndex(m => m.sender_id !== myId && new Date(m.created_at) > new Date(lastReadAt)) : -1;
  const unreadCount = unreadFromIdx === -1 ? 0 : msgs.slice(unreadFromIdx).filter(m => m.sender_id !== myId).length;
  msgs.forEach((m, i) => {
    const day = chatDayLabel(m.created_at);
    if (day !== lastDay) { html += `<div class="chat-daydivider">${esc(day)}</div>`; lastDay = day; }
    if (i === unreadFromIdx && unreadCount > 0) {
      html += `<div class="chat-unread-divider"><span>${unreadCount === 1 ? esc(t('chat.unreadOne')) : esc(t('chat.unreadMany').replace('{n}', unreadCount))}</span></div>`;
    }
    const prev = msgs[i - 1];
    const next = msgs[i + 1];
    const groupsWithPrev = prev && prev.sender_id === m.sender_id && day === chatDayLabel(prev.created_at)
      && (new Date(m.created_at) - new Date(prev.created_at)) < GROUP_GAP_MS;
    const groupsWithNext = next && next.sender_id === m.sender_id && day === chatDayLabel(next.created_at)
      && (new Date(next.created_at) - new Date(m.created_at)) < GROUP_GAP_MS;
    html += groupMsgBubbleHtml(m, myId, { start: !groupsWithPrev, end: !groupsWithNext });
  });
  return html;
}

function groupMsgBubbleHtml(m, myId, group = { start: true, end: true }) {
  const mine = m.sender_id === myId;
  const cls = ['msg-row', mine ? 'mine' : 'theirs'];
  if (group.start) cls.push('g-start');
  if (group.end) cls.push('g-end');
  const hasCaption = !!(m._plain);
  const bodyHtml = hasCaption ? renderBody(m._plain) : '';
  const mediaHtml = chatMediaHtml(m);
  const bareMedia = mediaHtml && !hasCaption && m.media_type !== 'audio';
  const sender = groupSenderProfile(m.sender_id);
  const nameHtml = (!mine && group.start && sender) ? `<div class="gm-sender-name">${esc(sender.display_name || sender.username)}${vBadge(sender)}</div>` : '';
  const meta = msgMetaHtml(m.created_at, '', bareMedia);
  const bubbleInner = mediaHtml + bodyHtml + meta;
  return `
  <div class="${cls.join(' ')}" id="msg-${m.id}" data-day="${esc(chatDayLabel(m.created_at))}" data-sender="${esc(m.sender_id)}" data-ts="${esc(m.created_at)}">
    ${nameHtml}
    <div class="msg-bubble${bareMedia ? ' msg-bubble-bare-media' : ''}">${bubbleInner}</div>
  </div>`;
}

async function sendGroupMessage() {
  const bodyEl = document.getElementById('chat-body');
  const body = bodyEl.value.trim();
  const attachment = chatAttachment;
  if ((!body && !attachment) || !chatGroup || !currentSession) return;
  bodyEl.value = '';
  autoGrowChatInput(bodyEl);
  const sendBtn = document.getElementById('chat-send-btn');
  if (sendBtn) sendBtn.disabled = true;

  chatAttachment = null;
  let media_url = null, media_type = null;
  if (attachment) {
    document.getElementById('chat-attach-preview').innerHTML = `<div class="chat-attach-uploading">${esc(t('chat.uploading'))}</div>`;
    try {
      const uploaded = await uploadMedia(attachment.file, status => {
        const box = document.getElementById('chat-attach-preview');
        if (box) box.innerHTML = `<div class="chat-attach-uploading">${esc(status)}</div>`;
      });
      media_url = uploaded.media_url;
      media_type = attachment.type;
    } catch (e) {
      alert(e.message || t('chat.failedToSend'));
      chatAttachment = attachment;
      renderChatAttachPreview();
      updateChatSendBtn();
      return;
    } finally {
      URL.revokeObjectURL(attachment.previewUrl);
    }
  }
  renderChatAttachPreview();

  const insertRow = { conversation_id: chatGroup.id, sender_id: currentSession.user.id, body, media_url, media_type };
  if (attachment?.type === 'audio' && attachment.durationMs) insertRow.media_duration_ms = attachment.durationMs;
  const { data, error } = await sb.from('messages').insert(insertRow).select('*').single();
  if (error) { alert(error.message || t('chat.failedToSend')); return; }
  data._plain = body;
  if (!document.getElementById(`msg-${data.id}`)) {
    appendGroupChatMsg(data, currentSession.user.id);
    scrollChatToBottom();
  }
  sb.from('conversation_members').update({ last_read_at: new Date().toISOString() }).eq('conversation_id', chatGroup.id).eq('user_id', currentSession.user.id);
}

function appendGroupChatMsg(m, myId) {
  const container = document.getElementById('chat-msgs');
  if (!container) return;
  const day = chatDayLabel(m.created_at);
  const rows = container.querySelectorAll('.msg-row');
  const lastRow = rows.length ? rows[rows.length - 1] : null;
  const lastDay = lastRow ? lastRow.dataset.day : null;
  const groupsWithLast = lastRow && lastRow.dataset.sender === m.sender_id && day === lastDay
    && (new Date(m.created_at) - new Date(lastRow.dataset.ts)) < GROUP_GAP_MS;
  if (groupsWithLast) lastRow.classList.remove('g-end');
  let html = '';
  if (day !== lastDay) html += `<div class="chat-daydivider">${esc(day)}</div>`;
  html += groupMsgBubbleHtml(m, myId, { start: !groupsWithLast, end: true });
  container.insertAdjacentHTML('beforeend', html);
}

function subscribeGroupRealtime(conversationId, myId) {
  if (chatGroupRealtimeChannel) sb.removeChannel(chatGroupRealtimeChannel);
  chatGroupRealtimeChannel = sb.channel(`group-${conversationId}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` }, async payload => {
      const incoming = payload.new;
      if (incoming.sender_id === myId) return; // already appended optimistically by sendGroupMessage()
      if (document.getElementById(`msg-${incoming.id}`)) return;
      // Realtime streams the raw row (still ciphertext) — get_message()
      // decrypts it server-side. See supabase/chat_server_side_encryption.sql.
      const { data: m, error } = await sb.rpc('get_message', { msg_id: incoming.id });
      if (error || !m) return;
      m._plain = m.body;
      appendGroupChatMsg(m, myId);
      scrollChatToBottom();
      sb.from('conversation_members').update({ last_read_at: new Date().toISOString() }).eq('conversation_id', conversationId).eq('user_id', myId);
    })
    .subscribe();
}

// ── GROUP INFO PANEL — avatar/name/description, member list with
// roles, "Add members" for owner/admin, and a way to leave. ──
function openGroupInfo() {
  if (!chatGroup) return;
  document.getElementById('gi-modal-bg')?.remove();
  const canManage = chatGroupMyRole === 'owner' || chatGroupMyRole === 'admin';
  const isCreator = !!currentSession && chatGroup.created_by === currentSession.user.id;
  const bg = document.createElement('div');
  bg.id = 'gi-modal-bg';
  bg.className = 'modal-bg';
  bg.onclick = e => { if (e.target === bg) bg.remove(); };
  const membersHtml = chatGroupMembers
    .slice()
    .sort((a, b) => (a.role === 'owner' ? -1 : b.role === 'owner' ? 1 : 0))
    .map(m => {
      // Owner can't be removed here (they'd need to delete the whole
      // conversation instead), and removing yourself is "Leave"
      // below, not this button — so it only ever shows for other
      // non-owner members, and only to someone who can manage.
      const canRemove = canManage && m.role !== 'owner' && m.user_id !== currentSession?.user?.id;
      return `
      <div class="gi-member-row">
        <img src="${esc(avatarUrl(m.profile?.avatar_url))}" alt="">
        <span>${esc(m.profile?.display_name || m.profile?.username || 'Unknown')}${vBadge(m.profile)}</span>
        <span class="gi-member-role">${esc(m.role)}</span>
        ${canRemove ? `<button type="button" class="gi-member-remove" onclick="giRemoveMember('${esc(m.user_id)}')" title="Remove from ${chatGroup.kind}">${ICON_CLOSE}</button>` : ''}
      </div>`;
    }).join('');
  bg.innerHTML = `
    <div class="modal gi-modal" role="dialog" aria-modal="true">
      <a class="modal-close" href="#" onclick="event.preventDefault();this.closest('.modal-bg').remove();">${ICON_CLOSE}</a>
      <div class="gi-hdr">
        <span class="gi-avatar-wrap${canManage ? ' gi-avatar-editable' : ''}" id="gi-avatar-wrap">
          ${canManage ? `<label for="gi-avatar-file">${groupAvatarHtml(chatGroup)}</label>` : groupAvatarHtml(chatGroup)}
          ${canManage ? `<label class="gi-avatar-pick" for="gi-avatar-file" title="Change picture">${ICON_CAMERA}</label><input type="file" id="gi-avatar-file" accept="image/*" style="display:none;">` : ''}
        </span>
        <div id="gi-details-view">
          <h2 id="gi-name-display">${esc(chatGroup.name)}</h2>
          <p id="gi-desc-display">${chatGroup.kind === 'channel' ? 'Channel' : 'Group'}${chatGroup.is_public ? ' &middot; Public' : ' &middot; Private'}${chatGroup.description ? ' &middot; ' + esc(chatGroup.description) : ''}</p>
          ${canManage ? `<button type="button" class="gi-edit-details-btn" onclick="giToggleEditDetails()">Edit name &amp; description</button>` : ''}
        </div>
        ${canManage ? `
        <div id="gi-details-edit" style="display:none;">
          <div class="gcv-field" style="text-align:left;">
            <label for="gi-edit-name">Name</label>
            <input type="text" id="gi-edit-name" maxlength="${GCV_NAME_MAX}" value="${esc(chatGroup.name)}" oninput="gcvUpdateCharCount('gi-edit-name','gi-edit-name-count',${GCV_NAME_MAX})">
            <span class="gcv-charcount" id="gi-edit-name-count">${chatGroup.name.length}/${GCV_NAME_MAX}</span>
          </div>
          <div class="gcv-field" style="text-align:left;">
            <label for="gi-edit-desc">Description <span style="font-weight:400;">(optional)</span></label>
            <textarea id="gi-edit-desc" rows="2" maxlength="${GCV_DESC_MAX}" placeholder="What's this ${chatGroup.kind} about?" oninput="gcvUpdateCharCount('gi-edit-desc','gi-edit-desc-count',${GCV_DESC_MAX})">${esc(chatGroup.description || '')}</textarea>
            <span class="gcv-charcount" id="gi-edit-desc-count">${(chatGroup.description || '').length}/${GCV_DESC_MAX}</span>
          </div>
          <div class="gcv-toggle-row">
            <span class="gcv-toggle-icon">${ICON_GLOBE}</span>
            <span class="gcv-toggle-txt">Public ${chatGroup.kind}<small>Anyone can find and join without an invite</small></span>
            <label class="toggle"><input type="checkbox" id="gi-edit-public"${chatGroup.is_public ? ' checked' : ''}><span class="toggle-track"></span></label>
          </div>
          <div class="errmsg" id="gi-edit-err" style="display:none;"></div>
          <div class="gi-edit-actions">
            <button type="button" class="gi-edit-cancel" onclick="giToggleEditDetails()">Cancel</button>
            <button type="button" class="gi-edit-save" onclick="giSaveDetails()">Save</button>
          </div>
        </div>` : ''}
      </div>
      <div class="gi-section-label">${chatGroupMembers.length} member${chatGroupMembers.length === 1 ? '' : 's'}</div>
      <div id="gi-member-list">${membersHtml}</div>
      <div class="gi-actions">
        ${canManage ? `<button type="button" class="gi-add-btn" onclick="giShowAddMembers()">${ICON_PLUS_CIRCLE} Add members</button>` : ''}
        <div id="gi-add-box" style="display:none;">
          <div class="xsearch" style="margin:8px 0 0;">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
            <input id="gi-add-search" placeholder="Search by username" oninput="giSearchAddMembers(this.value)">
          </div>
          <div class="gcv-member-results" id="gi-add-results"></div>
        </div>
        <button type="button" class="gi-leave-btn" onclick="leaveGroup()">Leave ${chatGroup.kind === 'channel' ? 'channel' : 'group'}</button>
        ${isCreator ? `<button type="button" class="gi-delete-btn" onclick="deleteGroupOrChannel()">Delete ${chatGroup.kind === 'channel' ? 'channel' : 'group'}</button>` : ''}
      </div>
    </div>`;
  document.body.appendChild(bg);
  requestAnimationFrame(() => bg.classList.add('open'));
  if (canManage) {
    document.getElementById('gi-avatar-file')?.addEventListener('change', (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      if (!validateFile(file, null)) { toast('Unsupported file, or too large.', 'error'); return; }
      openCropModal(file, 'square', (cropped) => { giSaveAvatar(cropped); });
    });
  }
}

// Swaps the header between the read-only name/description and the
// inline edit form — same show/hide pattern as giShowAddMembers()
// just below, kept as two separate blocks rather than a shared modal
// so a half-typed rename doesn't get lost if someone taps "Add
// members" first.
function giToggleEditDetails() {
  const view = document.getElementById('gi-details-view');
  const edit = document.getElementById('gi-details-edit');
  if (!view || !edit) return;
  const showEdit = edit.style.display === 'none';
  view.style.display = showEdit ? 'none' : '';
  edit.style.display = showEdit ? 'block' : 'none';
  if (showEdit) document.getElementById('gi-edit-name')?.focus();
  else clearErr(document.getElementById('gi-edit-err'));
}

async function giSaveDetails() {
  if (!chatGroup || !currentSession) return;
  const errEl = document.getElementById('gi-edit-err');
  clearErr(errEl);
  const name = document.getElementById('gi-edit-name').value.trim();
  const description = document.getElementById('gi-edit-desc').value.trim();
  const is_public = !!document.getElementById('gi-edit-public')?.checked;
  if (!name) { showErr(errEl, 'Give it a name first.'); return; }
  if (name.length > GCV_NAME_MAX) { showErr(errEl, `Name must be ${GCV_NAME_MAX} characters or less.`); return; }
  if (description.length > GCV_DESC_MAX) { showErr(errEl, `Description must be ${GCV_DESC_MAX} characters or less.`); return; }
  const { error } = await sb.from('conversations').update({ name, description: description || null, is_public }).eq('id', chatGroup.id);
  if (error) { showErr(errEl, error.message || 'Could not save changes.'); return; }
  chatGroup.name = name;
  chatGroup.description = description || null;
  chatGroup.is_public = is_public;
  document.getElementById('gi-modal-bg')?.remove();
  toast('Saved.');
  loadGroupThread(currentSession, document.getElementById('chat-root'));
}

// Uploads a newly-cropped picture and immediately reflects it in
// both the open info panel and the thread header behind it, without
// needing a full reload — loadGroupThread() only gets re-run for the
// name/description case above, where the header markup (member
// count text etc.) also needs rebuilding.
async function giSaveAvatar(file) {
  if (!chatGroup || !currentSession) return;
  try {
    const avatar_url = await uploadAvatar(file, currentSession.user.id);
    const { error } = await sb.from('conversations').update({ avatar_url }).eq('id', chatGroup.id);
    if (error) throw error;
    chatGroup.avatar_url = avatar_url;
    const giHolder = document.querySelector('#gi-avatar-wrap .conv-group-avatar');
    if (giHolder) giHolder.outerHTML = groupAvatarHtml(chatGroup);
    const hdrHolder = document.querySelector('.chat-hdr .conv-group-avatar');
    if (hdrHolder) hdrHolder.outerHTML = groupAvatarHtml(chatGroup);
    toast('Picture updated.');
  } catch (e) {
    toast(e.message || 'Could not update the picture.', 'error');
  }
}

function giShowAddMembers() {
  const box = document.getElementById('gi-add-box');
  if (!box) return;
  box.style.display = box.style.display === 'none' ? 'block' : 'none';
  if (box.style.display === 'block') document.getElementById('gi-add-search')?.focus();
}
let giSearchDebounce = null;
function giSearchAddMembers(q) {
  clearTimeout(giSearchDebounce);
  const resultsEl = document.getElementById('gi-add-results');
  if (!resultsEl) return;
  if (!q.trim()) { resultsEl.innerHTML = ''; return; }
  giSearchDebounce = setTimeout(async () => {
    const existingIds = new Set(chatGroupMembers.map(m => m.user_id));
    const { data } = await sb.from('profiles').select('id,username,display_name,avatar_url,verified,verification_type')
      .or(`username.ilike.%${q.trim()}%,display_name.ilike.%${q.trim()}%`)
      .limit(8);
    resultsEl.innerHTML = (data || [])
      .filter(p => !existingIds.has(p.id))
      .map(p => `
        <div class="gcv-member-row" onclick="giAddMember('${esc(p.id)}')">
          <img src="${esc(avatarUrl(p.avatar_url))}" alt="">
          <div class="ulrow-txt"><span class="ulrow-name">${esc(p.display_name || p.username)}${vBadge(p)}</span><span class="ulrow-handle">@${esc(p.username)}</span></div>
        </div>`).join('');
  }, 250);
}
async function giAddMember(userId) {
  if (!chatGroup) return;
  const { error } = await sb.from('conversation_members').insert({ conversation_id: chatGroup.id, user_id: userId, role: 'member' });
  if (error) { toast(error.message || 'Could not add that member.', 'error'); return; }
  document.getElementById('gi-modal-bg')?.remove();
  toast('Member added.');
  loadGroupThread(currentSession, document.getElementById('chat-root'));
}

// Owner/admin removing someone else from the group/channel (RLS:
// conversation_members_delete_admin — same "am I owner/admin of this
// conversation" check the add/rename policies use). The owner can
// never be removed this way; see the canRemove computation in
// openGroupInfo() above.
async function giRemoveMember(userId) {
  if (!chatGroup) return;
  const m = chatGroupMembers.find(x => x.user_id === userId);
  const label = m?.profile?.display_name || m?.profile?.username || 'this person';
  if (!confirm(`Remove ${label} from this ${chatGroup.kind}?`)) return;
  const { error } = await sb.from('conversation_members').delete()
    .eq('conversation_id', chatGroup.id).eq('user_id', userId);
  if (error) { toast(error.message || 'Could not remove that member.', 'error'); return; }
  document.getElementById('gi-modal-bg')?.remove();
  toast('Member removed.');
  loadGroupThread(currentSession, document.getElementById('chat-root'));
}

async function leaveGroup() {
  if (!chatGroup || !currentSession) return;
  if (!confirm(`Leave this ${chatGroup.kind}?`)) return;
  await sb.from('conversation_members').delete().eq('conversation_id', chatGroup.id).eq('user_id', currentSession.user.id);
  location.href = 'chat.html';
}

// Deletes the whole group/channel — RLS (conversations_delete_creator,
// see supabase/chat_group_manage.sql) restricts this to created_by =
// auth.uid(), so only the person who originally created it can ever
// succeed here, regardless of what this button's visibility does;
// the isCreator check in openGroupInfo() just keeps the button from
// being shown to people it would fail for anyway. Cascades to
// conversation_members and every message in it (on delete cascade).
async function deleteGroupOrChannel() {
  if (!chatGroup || !currentSession) return;
  const kind = chatGroup.kind === 'channel' ? 'channel' : 'group';
  if (!confirm(`Delete this ${kind} for everyone? This permanently deletes all its messages and can't be undone.`)) return;
  const { error } = await sb.from('conversations').delete().eq('id', chatGroup.id);
  if (error) { toast(error.message || `Could not delete this ${kind}.`, 'error'); return; }
  toast(`${kind === 'channel' ? 'Channel' : 'Group'} deleted.`);
  location.href = 'chat.html';
}

document.addEventListener('DOMContentLoaded', loadChat);
