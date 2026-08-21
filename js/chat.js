// ─────────────────────────────────────────────────────────────
// CHAT PAGE — /messages (conversation list) or /messages/<username> (thread)
// Also reachable via the legacy chat.html?u=<username> form.
//
// Thread view is end-to-end encrypted (see js/chat-crypto.js): once
// both sides of a conversation have opened chat at least once (which
// publishes an ECDH public key to their profile), every new message
// is AES-GCM ciphertext the moment it leaves the browser — Supabase
// never sees plaintext. Older/legacy rows (iv is null) still render
// as plain text.
// ─────────────────────────────────────────────────────────────
// Group/channel thread route: /messages/g/<id> (pretty, added to
// vercel.json alongside the existing /messages/<username> rewrite),
// or the legacy chat.html?g=<id> query form for local dev without
// Vercel's rewrite engine — same fallback pattern chatWithUsername
// already uses for the 1:1 case just below.
const chatGroupId = (() => {
  const m = location.pathname.match(/^\/messages\/g\/([^/]+)\/?$/);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(location.search).get('g');
})();
const chatWithUsername = chatGroupId ? null : (() => {
  const m = location.pathname.match(/^\/messages\/([^/]+)\/?$/);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(location.search).get('u');
})();
function groupMessagesUrl(id) { return `/messages/g/${encodeURIComponent(id)}`; }
let chatOther = null;   // the other user's profile, once a thread is open
let chatChannel = null;
let chatKey = null;     // this thread's derived AES-GCM key, or null if not (yet) encrypted

// ── GROUP/CHANNEL STATE ──
let chatGroup = null;        // the conversations row, once a group/channel thread is open
let chatGroupMembers = [];   // conversation_members rows, joined with profiles
let chatGroupMyRole = null;  // 'owner' | 'admin' | 'member' | null (not a member)
let chatGroupRealtimeChannel = null;
const gcvPickedMembers = new Map(); // username -> profile, for the create-group/channel modal
let gcvAvatarBlob = null;       // cropped File staged for the group/channel picture, until Create is pressed
let gcvAvatarPreviewUrl = null; // local object URL for the picker preview, revoked on close/create

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
const ICON_INFO = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7.6" r="1" fill="currentColor" stroke="none"/></svg>';
const ICON_GLOBE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 3.8 6 3.8 9s-1.3 6.3-3.8 9c-2.5-2.7-3.8-6-3.8-9s1.3-6.3 3.8-9Z"/></svg>';
const ICON_LOCK_SMALL = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
// Group/channel name & description limits — enforced client-side via
// maxlength + these constants (used for the live counters below) and
// server-side via check constraints in supabase/chat_group_manage.sql.
const GCV_NAME_MAX = 14;
const GCV_DESC_MAX = 50;
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
// safe to run immediately since chatWithUsername (if any) already
// came off the URL itself, no data load needed to know it.
(function () {
  const canonical = prettyMessagesUrl(chatWithUsername);
  if (location.pathname + location.search !== canonical) { try { history.replaceState(null, '', canonical); } catch (e) {} }
})();

async function loadChat() {
  const root = document.getElementById('chat-root');
  const { data: { session } } = await sb.auth.getSession();

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

// ── ENCRYPTION KEY HELPERS ──
// One derived AES-GCM key per conversation partner, cached for the
// life of the page (cheap to derive, but no reason to redo it for
// every row in the conversation list). ensureMyKeypair() is also
// idempotent/cached inside chat-crypto.js itself.
const chatKeyCache = new Map();
function getChatKey(myId, otherId, otherPubkey) {
  if (!otherPubkey || !chatCryptoSupported()) return Promise.resolve(null);
  if (chatKeyCache.has(otherId)) return chatKeyCache.get(otherId);
  const p = deriveChatKey(myId, otherPubkey);
  chatKeyCache.set(otherId, p);
  return p;
}
// Resolves a message row to plaintext for display: unencrypted rows
// (iv is null — legacy, or sent before either side had a key) pass
// through as-is; encrypted rows decrypt with the given key, or
// resolve to null (rendered as an explicit "can't decrypt" bubble
// instead of silently showing nothing or garbage) if that fails.
async function decryptForDisplay(key, body, iv) {
  if (!iv) return body;
  if (!key) return null;
  return await chatDecrypt(key, body, iv);
}

// ── CONVERSATION LIST ──
async function loadConversationList(session, root) {
  document.body.classList.remove('chat-thread-open'); // see .chat-thread-open note in style.css — list view, not a thread
  document.getElementById('chat-sec-bar').innerHTML = t('nav.chat');
  if (chatCryptoSupported()) ensureMyKeypair(session.user.id); // fire-and-forget: publishes my pubkey so others can start encrypting to me
  subscribeConversationListRealtime(session, root);

  const [{ data, error }, groupRows] = await Promise.all([
    sb.from('messages')
      .select(`*, sender:profiles!messages_sender_id_fkey(id,username,display_name,avatar_url,verified,verification_type,pubkey),
                  recipient:profiles!messages_recipient_id_fkey(id,username,display_name,avatar_url,verified,verification_type,pubkey)`)
      .or(`sender_id.eq.${session.user.id},recipient_id.eq.${session.user.id}`)
      .order('created_at', { ascending: false })
      .limit(300),
    loadMyGroupRows(session),
  ]);

  if (error) { root.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }

  // Collapse the flat message log into one row per other participant,
  // keeping only the most recent message (list is already newest-first).
  const seen = new Map();
  (data || []).forEach(m => {
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
        <input id="chat-new-user" placeholder="${esc(t('chat.searchUserPlaceholder'))}" oninput="chatNewSearchUsers(this.value)" onkeydown="if(event.key==='Enter'){startChat();}if(event.key==='Escape'){toggleNewChat(false);}">
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
    if (last.iv) {
      const key = other?.id ? await getChatKey(session.user.id, other.id, other.pubkey) : null;
      const plain = await decryptForDisplay(key, last.body, last.iv);
      snip = plain != null ? esc(plain.slice(0, 80)) : `${CHAT_ICON_LOCK}<span>${esc(t('chat.encryptedMessage'))}</span>`;
    } else if (last.media_url && !last.body) {
      // Caption-less attachment — show what kind instead of a blank snippet.
      const label = last.media_type === 'video' ? t('chat.video') : last.media_type === 'audio' ? t('chat.voiceMessage') : t('chat.photo');
      snip = esc(label);
    } else {
      snip = esc((last.body || '').slice(0, 80));
    }
    return `
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
    </a>`;
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
  const { data: msgs } = await sb.from('messages')
    .select('id, conversation_id, sender_id, body, media_type, created_at, sender:profiles!messages_sender_id_fkey(username,display_name)')
    .in('conversation_id', ids)
    .order('created_at', { ascending: false })
    .limit(500);

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

let chatNewSearchDebounce = null;
let chatNewSearchResults = new Map();
function chatNewSearchUsers(q) {
  clearTimeout(chatNewSearchDebounce);
  const resultsEl = document.getElementById('chat-new-results');
  const errEl = document.getElementById('chat-new-err');
  if (!resultsEl) return;
  clearErr(errEl);
  if (!q.trim()) { resultsEl.innerHTML = ''; return; }
  chatNewSearchDebounce = setTimeout(async () => {
    const ids = [...await chatEligibleContactIds()];
    if (!ids.length) {
      resultsEl.innerHTML = `<div class="gcv-member-row" style="cursor:default;"><div class="ulrow-txt"><span class="ulrow-name">${esc(t('chat.noContactsYet'))}</span></div></div>`;
      return;
    }
    const uname = q.trim().replace(/^@/, '');
    const { data } = await sb.from('profiles').select('id,username,display_name,avatar_url,verified,verification_type')
      .or(`username.ilike.%${uname}%,display_name.ilike.%${uname}%`)
      .in('id', ids)
      .limit(8);
    chatNewSearchResults = new Map((data || []).map(p => [p.username, p]));
    resultsEl.innerHTML = (data || []).map(p => `
      <div class="gcv-member-row" onclick="chatNewPickUser('${esc(p.username)}')">
        <img src="${esc(avatarUrl(p.avatar_url))}" alt="">
        <div class="ulrow-txt"><span class="ulrow-name">${esc(p.display_name || p.username)}${vBadge(p)}</span><span class="ulrow-handle">@${esc(p.username)}</span></div>
      </div>`).join('') || `<div class="gcv-member-row" style="cursor:default;"><div class="ulrow-txt"><span class="ulrow-name">${esc(t('chat.userNotFound'))}</span></div></div>`;
  }, 250);
}
function chatNewPickUser(username) {
  const p = chatNewSearchResults.get(username);
  if (!p) return;
  location.href = messagesUrl(p.username);
}

// Enter-to-send fallback for the same box — kept scoped to the same
// contact list as the live search above so it can't be used to jump
// straight to an arbitrary stranger's DMs by typing their exact
// username.
async function startChat() {
  const input = document.getElementById('chat-new-user');
  const errEl = document.getElementById('chat-new-err');
  clearErr(errEl);
  const uname = input.value.trim().replace(/^@/, '');
  if (!uname) return;
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
function openCreateConversationModal(kind) {
  gcvPickedMembers.clear();
  gcvResetAvatarState();
  document.getElementById('gcv-modal-bg')?.remove();
  const bg = document.createElement('div');
  bg.id = 'gcv-modal-bg';
  bg.className = 'modal-bg';
  bg.onclick = e => { if (e.target === bg) closeCreateConversationModal(); };
  bg.innerHTML = `
    <div class="modal gcv-modal" role="dialog" aria-modal="true">
      <a class="modal-close" href="#" onclick="event.preventDefault();closeCreateConversationModal();">${ICON_CLOSE}</a>
      <h2 id="gcv-title">New ${kind === 'channel' ? 'channel' : 'group'}</h2>
      <p class="dc-desc" id="gcv-desc-text">${kind === 'channel'
        ? 'Only you (and any admins you add) can post. Everyone else just reads — like a broadcast list.'
        : 'Everyone you add can post and see the conversation.'}</p>
      <div class="gcv-kind-tabs" role="tablist">
        <button type="button" id="gcv-tab-group" class="${kind !== 'channel' ? 'cur' : ''}" onclick="gcvSwitchKind('group')">${ICON_GROUP} Group</button>
        <button type="button" id="gcv-tab-channel" class="${kind === 'channel' ? 'cur' : ''}" onclick="gcvSwitchKind('channel')">${ICON_CHANNEL} Channel</button>
      </div>
      <div class="gcv-identity-row">
        <span class="gcv-avatar-wrap" id="gcv-avatar-wrap">
          <span class="gcv-avatar-preview" id="gcv-avatar-preview">${kind === 'channel' ? ICON_CHANNEL_AVATAR : ICON_GROUP}</span>
          <label class="gcv-avatar-pick" for="gcv-avatar-file" title="Choose a picture">${ICON_CAMERA}</label>
          <input type="file" id="gcv-avatar-file" accept="image/*" style="display:none;">
        </span>
        <div class="gcv-field gcv-name-field">
          <label for="gcv-name">Name</label>
          <input type="text" id="gcv-name" maxlength="${GCV_NAME_MAX}" placeholder="${kind === 'channel' ? 'e.g. Announcements' : 'e.g. Weekend plans'}" oninput="gcvUpdateCreateBtn();gcvUpdateCharCount('gcv-name','gcv-name-count',${GCV_NAME_MAX})">
          <span class="gcv-charcount" id="gcv-name-count">0/${GCV_NAME_MAX}</span>
        </div>
      </div>
      <div class="gcv-field">
        <label for="gcv-desc">Description <span style="font-weight:400;">(optional)</span></label>
        <textarea id="gcv-desc" rows="2" maxlength="${GCV_DESC_MAX}" placeholder="What's this ${kind} about?" oninput="gcvUpdateCharCount('gcv-desc','gcv-desc-count',${GCV_DESC_MAX})"></textarea>
        <span class="gcv-charcount" id="gcv-desc-count">0/${GCV_DESC_MAX}</span>
      </div>
      <div class="gcv-toggle-row">
        <span class="gcv-toggle-icon">${ICON_GLOBE}</span>
        <span class="gcv-toggle-txt" id="gcv-toggle-txt">Public ${kind}<small>Anyone can find and join without an invite</small></span>
        <label class="toggle"><input type="checkbox" id="gcv-public"><span class="toggle-track"></span></label>
      </div>
      <div class="gcv-field">
        <label for="gcv-member-search">Add members</label>
        <div class="xsearch" style="margin:0;">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
          <input id="gcv-member-search" placeholder="Search by username" oninput="gcvSearchMembers(this.value)">
        </div>
        <div class="gcv-member-results" id="gcv-member-results"></div>
        <div class="gcv-members-picked" id="gcv-members-picked"></div>
      </div>
      <div class="errmsg" id="gcv-err" style="display:none;"></div>
      <input type="hidden" id="gcv-kind" value="${esc(kind)}">
      <button type="button" class="gcv-create-btn" id="gcv-create-btn" onclick="createConversation()" disabled>Create ${kind === 'channel' ? 'channel' : 'group'}</button>
    </div>`;
  document.body.appendChild(bg);
  requestAnimationFrame(() => bg.classList.add('open'));
  setTimeout(() => document.getElementById('gcv-name')?.focus(), 50);
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
  if (nameEl) nameEl.placeholder = isChannel ? 'e.g. Announcements' : 'e.g. Weekend plans';
  const descField = document.getElementById('gcv-desc');
  if (descField) descField.placeholder = `What's this ${kind} about?`;
  const toggleTxt = document.getElementById('gcv-toggle-txt');
  if (toggleTxt) toggleTxt.innerHTML = `Public ${kind}<small>Anyone can find and join without an invite</small>`;
  const btn = document.getElementById('gcv-create-btn');
  if (btn) btn.textContent = `Create ${isChannel ? 'channel' : 'group'}`;
  // Only swap the avatar placeholder glyph if no picture has been
  // chosen yet — once someone's picked a real image, switching
  // Group<->Channel shouldn't wipe it back to the generic icon.
  if (!gcvAvatarBlob) {
    const prev = document.getElementById('gcv-avatar-preview');
    if (prev) prev.innerHTML = isChannel ? ICON_CHANNEL_AVATAR : ICON_GROUP;
  }
}

// Create is only enabled once a name is typed — matches the same
// "disable until valid" pattern used elsewhere in the app, instead of
// letting the person tap Create and only then finding out it needs a
// name.
function gcvUpdateCreateBtn() {
  const nameEl = document.getElementById('gcv-name');
  const btn = document.getElementById('gcv-create-btn');
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

  const { data: msgs, error } = await sb.from('messages').select('*')
    .or(`and(sender_id.eq.${session.user.id},recipient_id.eq.${other.id}),and(sender_id.eq.${other.id},recipient_id.eq.${session.user.id})`)
    .order('created_at', { ascending: true })
    .limit(500);

  if (error) { root.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }

  // Publish my key (if missing) and derive the shared key for this
  // conversation before rendering anything, so the very first paint
  // already shows decrypted text instead of a flash of ciphertext/
  // placeholders.
  chatKey = null;
  if (chatCryptoSupported()) {
    await ensureMyKeypair(session.user.id);
    if (other.pubkey) chatKey = await getChatKey(session.user.id, other.id, other.pubkey);
  }
  await Promise.all((msgs || []).map(async m => { m._plain = await decryptForDisplay(chatKey, m.body, m.iv); }));

  const encBanner = chatKey
    ? `<div class="chat-e2e-banner">${CHAT_ICON_LOCK}<span>${esc(t('chat.e2eActive'))}</span></div>`
    : (chatCryptoSupported()
        ? `<div class="chat-e2e-banner pending">${CHAT_ICON_LOCK}<span>${esc(t('chat.e2ePending').replace('{username}', other.username))}</span></div>`
        : '');

  // Snapshot which messages are unread *before* we mark them read
  // below — renderMsgsHtml() uses this to drop a WhatsApp-style
  // "N unread messages" divider right above the first one, so
  // opening a thread with a backlog shows where to start reading
  // instead of just dumping you at the bottom.
  const unreadMsgIds = new Set((msgs || []).filter(m => m.recipient_id === session.user.id && !m.read).map(m => m.id));

  root.innerHTML = `
    <div class="chat-thread">
      <div class="chat-hdr">
        <a class="chat-hdr-back" href="chat.html" aria-label="${esc(t('chat.back'))}">${ICON_BACK}</a>
        <a href="${profileUrl(other.username)}"><img class="avatar${avSqClass(other)}" src="${esc(avatarUrl(other.avatar_url))}" alt="" loading="lazy" decoding="async"></a>
        <div>
          <a class="nm" href="${profileUrl(other.username)}">${esc(other.display_name || other.username)}${vBadge(other)}</a>
          <span class="pc-handle">@${esc(other.username)}</span>
        </div>
      </div>
      <div class="chat-msgs" id="chat-msgs">${encBanner}${renderMsgsHtml(msgs || [], session.user.id, unreadMsgIds)}</div>
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
        <textarea id="chat-body" maxlength="2000" placeholder="${esc(t('chat.startMessagePlaceholder'))}" rows="1"
          oninput="autoGrowChatInput(this)"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage();}"></textarea>
        <button class="chat-send-btn" id="chat-send-btn" title="${esc(t('chat.send'))}" aria-label="${esc(t('chat.send'))}" disabled onclick="sendMessage()">${ICON_SEND}</button>
      </div>
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

// m._plain must already be set (decryptForDisplay()) before calling
// this — it never decrypts on its own, since that's async and this
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
  // An attachment's iv/body only cover the caption — the message can
  // have media with no caption at all, in which case m._plain is ''
  // (never null, since '' never went through encryption/decryption
  // to begin with) and no text bubble content is rendered for it.
  const hasCaption = m._plain != null && m._plain !== '';
  const bodyHtml = m._plain != null
    ? (hasCaption ? renderBody(m._plain) : '')
    : `<span class="msg-undecryptable">${CHAT_ICON_LOCK}<em>Can't decrypt this message on this device</em></span>`;
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
  return `
  <div class="${cls.join(' ')}" id="msg-${m.id}" data-day="${esc(chatDayLabel(m.created_at))}" data-sender="${esc(m.sender_id)}" data-ts="${esc(m.created_at)}">
    <div class="msg-bubble${bareMedia ? ' msg-bubble-bare-media' : ''}">${bubbleInner}</div>
  </div>`;
}

// Renders a message row's attachment, if any. Images/video reuse the
// exact same helpers the feed uses (renderMedia() -> lightbox, ttv
// player) so tapping a photo/video in a DM behaves identically to
// tapping one in a post. Voice notes get the compact player above.
function chatMediaHtml(m) {
  if (!m.media_url) return '';
  if (m.media_type === 'audio') return voicePlayerHtml(m.media_url);
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
    box.innerHTML = `<div class="chat-attach-voice">${voicePlayerHtml(chatAttachment.previewUrl)}${rmBtn}</div>`;
  }
}

// ── VOICE NOTES: RECORD ──
async function startVoiceRecording() {
  if (chatRecorder) return; // already recording
  if (chatAttachment) clearChatAttachment(); // voice-note and file are mutually exclusive
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
    toast(t('chat.micPermissionDenied'), 'error');
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
    chatAttachment = { file, type: 'audio', previewUrl: URL.createObjectURL(blob) };
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
function voicePlayerHtml(url) {
  return `
  <span class="voice-msg">
    <button type="button" class="voice-play-btn" onclick="toggleVoicePlay(this)">${ICON_VOICE_PLAY}</button>
    <span class="voice-wave">${voiceWaveformSvg(url)}<span class="voice-wave-fg-clip">${voiceWaveformSvg(url)}</span></span>
    <span class="voice-time">0:00</span>
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
function toggleVoicePlay(btn) {
  const wrap = btn.closest('.voice-msg');
  const audio = wrap.querySelector('audio');
  const fill = wrap.querySelector('.voice-wave-fg-clip');
  const timeEl = wrap.querySelector('.voice-time');
  if (chatActiveVoiceAudio && chatActiveVoiceAudio !== audio) {
    chatActiveVoiceAudio.pause(); // only one voice note plays at a time
  }
  if (audio.paused) {
    audio.play().catch(() => {});
    chatActiveVoiceAudio = audio;
    btn.innerHTML = ICON_VOICE_PAUSE;
  } else {
    audio.pause();
    btn.innerHTML = ICON_VOICE_PLAY;
    return;
  }
  audio.ontimeupdate = () => {
    const pct = audio.duration ? (audio.currentTime / audio.duration) * 100 : 0;
    fill.style.clipPath = `inset(0 ${100 - pct}% 0 0)`;
    timeEl.textContent = fmtVoiceTime(audio.currentTime);
  };
  audio.onpause = () => { btn.innerHTML = ICON_VOICE_PLAY; };
  audio.onended = () => {
    btn.innerHTML = ICON_VOICE_PLAY;
    fill.style.clipPath = 'inset(0 100% 0 0)';
    timeEl.textContent = fmtVoiceTime(audio.duration);
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

  const insertRow = { sender_id: currentSession.user.id, recipient_id: chatOther.id, media_url, media_type };
  if (chatKey && body) {
    const enc = await chatEncrypt(chatKey, body);
    insertRow.body = enc.body;
    insertRow.iv = enc.iv;
  } else {
    insertRow.body = body; // '' when it's a caption-less attachment
  }

  const { data, error } = await sb.from('messages').insert(insertRow).select('*').single();
  if (error) { alert(error.message || t('chat.failedToSend')); return; }
  data._plain = body; // already have the plaintext locally — no need to decrypt what we just encrypted
  if (!document.getElementById(`msg-${data.id}`)) {
    appendChatMsg(data, currentSession.user.id);
    scrollChatToBottom();
  }
}

function subscribeChatRealtime(myId, otherId) {
  if (chatChannel) sb.removeChannel(chatChannel);
  chatChannel = sb.channel(`dm-${[myId, otherId].sort().join('-')}`)
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `sender_id=eq.${otherId}` }, async payload => {
      const m = payload.new;
      if (m.recipient_id !== myId) return;
      if (document.getElementById(`msg-${m.id}`)) return;
      m._plain = await decryptForDisplay(chatKey, m.body, m.iv);
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
// `chatOther`, so it works here unchanged. Group/channel messages
// aren't end-to-end encrypted (see the PART 3 comment in
// supabase/chat_full_setup.sql) — sendGroupMessage() below just never
// touches chat-crypto.js.
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

  const { data: msgs, error } = await sb.from('messages').select('*')
    .eq('conversation_id', conv.id)
    .order('created_at', { ascending: true })
    .limit(500);
  if (error) { root.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }
  (msgs || []).forEach(m => { m._plain = m.body; }); // never encrypted — see comment above

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
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'messages', filter: `conversation_id=eq.${conversationId}` }, payload => {
      const m = payload.new;
      if (m.sender_id === myId) return; // already appended optimistically by sendGroupMessage()
      if (document.getElementById(`msg-${m.id}`)) return;
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
          ${groupAvatarHtml(chatGroup)}
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
