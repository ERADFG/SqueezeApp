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
const chatWithUsername = (() => {
  const m = location.pathname.match(/^\/messages\/([^/]+)\/?$/);
  if (m) return decodeURIComponent(m[1]);
  return new URLSearchParams(location.search).get('u');
})();
let chatOther = null;   // the other user's profile, once a thread is open
let chatChannel = null;
let chatKey = null;     // this thread's derived AES-GCM key, or null if not (yet) encrypted

const ICON_SEND = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M3 20V4l18 8-18 8Zm2-3 12.85-5L5 7v3.83L11 12l-6 1.17V17Z"/></svg>';
const ICON_CLOSE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>';
const ICON_CHAT_EMPTY = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 5.5h16v11H9.5L5 20.5v-4H4Z"/><path d="M8 10h8M8 13h5" stroke-linecap="round"/></svg>';
const ICON_BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>';
const CHAT_ICON_LOCK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
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

  const { data, error } = await sb.from('messages')
    .select(`*, sender:profiles!messages_sender_id_fkey(id,username,display_name,avatar_url,verified,pubkey),
                recipient:profiles!messages_recipient_id_fkey(id,username,display_name,avatar_url,verified,pubkey)`)
    .or(`sender_id.eq.${session.user.id},recipient_id.eq.${session.user.id}`)
    .order('created_at', { ascending: false })
    .limit(300);

  if (error) { root.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`; return; }

  // Collapse the flat message log into one row per other participant,
  // keeping only the most recent message (list is already newest-first).
  const seen = new Map();
  (data || []).forEach(m => {
    const mine = m.sender_id === session.user.id;
    const otherId = mine ? m.recipient_id : m.sender_id;
    if (!seen.has(otherId)) {
      seen.set(otherId, { other: mine ? m.recipient : m.sender, last: m, mine });
    }
  });

  // Compose is collapsed behind a single pill by default (Twitter-
  // style) instead of a bar that permanently eats space above the
  // list — toggled open/closed by toggleNewChat().
  const newMsgBox = `
    <button type="button" class="chat-new-trigger" id="chat-new-trigger" onclick="toggleNewChat(true)">
      ${ICON_COMPOSE}<span>${t('chat.newMessage')}</span>
    </button>
    <div class="chat-new" id="chat-new" style="display:none;">
      <div class="xsearch">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="m21 21-4.35-4.35"/></svg>
        <input id="chat-new-user" placeholder="${esc(t('chat.messageUsernamePlaceholder'))}" onkeydown="if(event.key==='Enter'){startChat();}if(event.key==='Escape'){toggleNewChat(false);}">
      </div>
      <button type="button" class="chat-send-btn" title="${esc(t('chat.send'))}" aria-label="${esc(t('chat.send'))}" onclick="startChat()">${ICON_SEND}</button>
      <button type="button" class="chat-new-close" title="${esc(t('compose.cancel'))}" aria-label="${esc(t('compose.cancel'))}" onclick="toggleNewChat(false)">${ICON_CLOSE}</button>
    </div>
    <div class="errmsg" id="chat-new-err" style="display:none;margin:0 16px 10px;"></div>`;

  if (!seen.size) {
    root.innerHTML = newMsgBox + `
      <div class="chat-empty">
        ${ICON_CHAT_EMPTY}
        <h3>${esc(t('chat.noMessagesTitle'))}</h3>
        <p>${esc(t('chat.noMessagesSub'))}</p>
      </div>`;
    return;
  }

  // Snippet preview needs decrypting for encrypted rows — done in
  // parallel across every conversation up front rather than blocking
  // row-by-row.
  const rows = await Promise.all([...seen.values()].map(async ({ other, last, mine }) => {
    const unread = !mine && !last.read;
    const uname = other?.username || 'unknown';
    let snip;
    if (last.iv) {
      const key = other?.id ? await getChatKey(session.user.id, other.id, other.pubkey) : null;
      const plain = await decryptForDisplay(key, last.body, last.iv);
      snip = plain != null ? esc(plain.slice(0, 80)) : `${CHAT_ICON_LOCK}<span>${esc(t('chat.encryptedMessage'))}</span>`;
    } else {
      snip = esc((last.body || '').slice(0, 80));
    }
    return `
    <a class="conv-row${unread ? ' unread' : ''}" href="${messagesUrl(uname)}">
      <img class="avatar" src="${esc(avatarUrl(other?.avatar_url))}" alt="" loading="lazy" decoding="async">
      <div class="conv-txt">
        <div class="conv-top">
          <span class="conv-name">${esc(other?.display_name || uname)}</span>
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

function toggleNewChat(open) {
  const trigger = document.getElementById('chat-new-trigger');
  const panel = document.getElementById('chat-new');
  if (!trigger || !panel) return;
  panel.style.display = open ? 'flex' : 'none';
  trigger.style.display = open ? 'none' : 'flex';
  if (open) document.getElementById('chat-new-user')?.focus();
  else clearErr(document.getElementById('chat-new-err'));
}

async function startChat() {
  const input = document.getElementById('chat-new-user');
  const errEl = document.getElementById('chat-new-err');
  clearErr(errEl);
  const uname = input.value.trim().replace(/^@/, '');
  if (!uname) return;
  const { data: profile, error } = await sb.from('profiles').select('username').ilike('username', uname).maybeSingle();
  if (error || !profile) { showErr(errEl, t('chat.userNotFound')); return; }
  location.href = messagesUrl(profile.username);
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

  root.innerHTML = `
    <div class="chat-thread">
      <div class="chat-hdr">
        <a class="chat-hdr-back" href="chat.html" aria-label="${esc(t('chat.back'))}">${ICON_BACK}</a>
        <a href="${profileUrl(other.username)}"><img class="avatar" src="${esc(avatarUrl(other.avatar_url))}" alt="" loading="lazy" decoding="async"></a>
        <div>
          <a class="nm" href="${profileUrl(other.username)}">${esc(other.display_name || other.username)}</a>
          <span class="pc-handle">@${esc(other.username)}</span>
        </div>
      </div>
      <div class="chat-msgs" id="chat-msgs">${encBanner}${renderMsgsHtml(msgs || [], session.user.id)}</div>
      <div class="chat-composer">
        <textarea id="chat-body" maxlength="2000" placeholder="${esc(t('chat.startMessagePlaceholder'))}" rows="1"
          oninput="autoGrowChatInput(this)"
          onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendMessage();}"></textarea>
        <button class="chat-send-btn" id="chat-send-btn" title="${esc(t('chat.send'))}" aria-label="${esc(t('chat.send'))}" disabled onclick="sendMessage()">${ICON_SEND}</button>
      </div>
    </div>`;

  sizeChatThread();
  scrollChatToBottom();
  applyChatPrefill();

  const unreadIds = (msgs || []).filter(m => m.recipient_id === session.user.id && !m.read).map(m => m.id);
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
  const btn = document.getElementById('chat-send-btn');
  const hasText = !!el.value.trim();
  if (btn) btn.disabled = !hasText;
  if (hasText) notifyTyping();
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

function notifyTyping() {
  if (!chatChannel || !currentSession) return;
  const now = Date.now();
  if (now - typingLastSentAt < 2000) return;
  typingLastSentAt = now;
  chatChannel.send({ type: 'broadcast', event: 'typing', payload: { from: currentSession.user.id } });
}

function showTypingBubble() {
  const container = document.getElementById('chat-msgs');
  if (!container) return;
  if (document.getElementById('chat-typing-row')) return;
  container.insertAdjacentHTML('beforeend', `
    <div class="msg-row theirs g-start g-end" id="chat-typing-row">
      <div class="msg-bubble chat-typing-bubble" aria-label="${esc(t('chat.typing'))}">
        <span class="chat-typing-dots"><span></span><span></span><span></span></span>
      </div>
    </div>`);
  scrollChatToBottom();
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
function renderMsgsHtml(msgs, myId) {
  let html = '';
  let lastDay = null;
  msgs.forEach((m, i) => {
    const day = chatDayLabel(m.created_at);
    if (day !== lastDay) { html += `<div class="chat-daydivider">${esc(day)}</div>`; lastDay = day; }
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
// isn't.
function msgBubbleHtml(m, myId, group = { start: true, end: true }) {
  const mine = m.sender_id === myId;
  const cls = ['msg-row', mine ? 'mine' : 'theirs'];
  if (group.start) cls.push('g-start');
  if (group.end) cls.push('g-end');
  const bodyHtml = m._plain != null
    ? renderBody(m._plain)
    : `<span class="msg-undecryptable">${CHAT_ICON_LOCK}<em>Can't decrypt this message on this device</em></span>`;
  const ticksHtml = mine
    ? `<span class="msg-ticks${m.read ? ' read' : ''}">${m.read ? ICON_TICK2 : ICON_TICK1}</span>`
    : '';
  return `
  <div class="${cls.join(' ')}" id="msg-${m.id}" data-day="${esc(chatDayLabel(m.created_at))}" data-sender="${esc(m.sender_id)}" data-ts="${esc(m.created_at)}">
    <div class="msg-bubble">${bodyHtml}</div>
    <span class="msg-time-inline">${chatClockTime(m.created_at)}</span>${ticksHtml}
  </div>`;
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

async function sendMessage() {
  const bodyEl = document.getElementById('chat-body');
  const body = bodyEl.value.trim();
  if (!body || !chatOther || !currentSession) return;
  bodyEl.value = '';
  autoGrowChatInput(bodyEl);
  hideTypingBubble();

  const insertRow = { sender_id: currentSession.user.id, recipient_id: chatOther.id };
  if (chatKey) {
    const enc = await chatEncrypt(chatKey, body);
    insertRow.body = enc.body;
    insertRow.iv = enc.iv;
  } else {
    insertRow.body = body;
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
      showTypingBubble();
      if (typingHideTimer) clearTimeout(typingHideTimer);
      typingHideTimer = setTimeout(hideTypingBubble, 3000);
    })
    .subscribe();
}

document.addEventListener('DOMContentLoaded', loadChat);
