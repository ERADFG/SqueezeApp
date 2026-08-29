// ─────────────────────────────────────────────────────────────
// ACHIEVEMENTS PAGE — /achievements.html (requires login)
// Fetches the single get_my_achievements() RPC (see
// supabase/achievements.sql), which syncs + returns everything in
// one call: current level/XP and the full catalog, each entry
// already marked locked/unlocked with a live current_value for
// progress bars. This file only renders that payload.
// ─────────────────────────────────────────────────────────────

// Fixed display order for categories — sync_achievements() doesn't
// guarantee any particular category ordering (it comes from
// sort_order, which groups by metric, not category), so this list
// controls what the page actually shows top-to-bottom. Any category
// present in the data but missing here just falls to the end,
// alphabetically, so a future new category never silently disappears.
const ACHV_CATEGORY_ORDER = [
  'Getting Started', 'Posting', 'Likes', 'Comments', 'Sharing',
  'Community', 'Communities', 'Chat', 'Saving', 'Lists', 'Articles',
  'Polls', 'Streaks', 'Special'
];

const ACHV_TIER_COLOR = {
  Bronze: '#B08D57', Silver: '#9AA3AC', Gold: '#EAB308', Platinum: '#8B9BB4',
  Diamond: '#38BDF8', Master: '#7C3AED', Grandmaster: '#EC4899',
  Legendary: '#F97316', Mythic: '#EF4444', Eternal: '#0EA5E9',
  Ascendant: '#EAB308', Special: '#0B6FE0'
};

// ── ICON SET — premium stroke-line SVGs, one per metric, swapped in
// for the old emoji so unlocked badges look consistent and crisp at
// any size/theme instead of relying on the platform's emoji font.
// Same viewBox/stroke convention as the existing lock glyph. The
// catalog's `icon` column (emoji) is kept as-is in the DB as a plain-
// text fallback; this map is purely a client-side render swap. ──────
function achvSvg(inner) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}
const ACHV_ICON_MAP = {
  account_age_days:   achvSvg('<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 3v4M16 3v4"/><circle cx="8" cy="14" r="1.1" fill="currentColor" stroke="none"/><circle cx="12" cy="14" r="1.1" fill="currentColor" stroke="none"/>'),
  posts_count:        achvSvg('<path d="M14.5 4.5 19 9l-9.5 9.5L4 20l1.5-5.5z"/><path d="M13 6 17.5 10.5"/>'),
  likes_given:        achvSvg('<path d="M12 20.2S3.6 15.2 3.6 9.3c0-3 2.3-5 4.9-5 1.7 0 3.1.9 3.5 2.4C12.4 5.2 13.8 4.3 15.5 4.3c2.6 0 4.9 2 4.9 5 0 5.9-8.4 10.9-8.4 10.9Z"/>'),
  likes_received:     achvSvg('<path d="M12 20.2S3.6 15.2 3.6 9.3c0-3 2.3-5 4.9-5 1.7 0 3.1.9 3.5 2.4C12.4 5.2 13.8 4.3 15.5 4.3c2.6 0 4.9 2 4.9 5 0 5.9-8.4 10.9-8.4 10.9Z" fill="currentColor" fill-opacity=".25"/><path d="m18.5 3 .7 1.6L21 5.3l-1.8.7L18.5 8l-.7-2-1.8-.7 1.8-.7Z" fill="currentColor" stroke="none"/>'),
  replies_given:      achvSvg('<path d="M4 5h16v10H9l-5 4z"/>'),
  replies_received:   achvSvg('<path d="M4 5h16v10H9l-5 4z"/><path d="M8 9h8M8 12h5"/>'),
  reposts_given:      achvSvg('<path d="M17 2 21 6l-4 4"/><path d="M3 12V9a3 3 0 0 1 3-3h15"/><path d="M7 22 3 18l4-4"/><path d="M21 12v3a3 3 0 0 1-3 3H3"/>'),
  reposts_received:   achvSvg('<path d="M11 4 3 8l8 4"/><path d="M3 8v9l8 4V12"/><path d="M13 4l8 4-8 4"/><path d="M21 8v9l-8 4V12"/>'),
  quotes_given:        achvSvg('<path d="M7 8c-1.7 0-3 1.3-3 3v1.2C4 14 5.5 15 7 15" /><path d="M8 8H5.4C5 8 4.5 8.4 4.5 9v2.2c0 1.3.9 2.4 2.1 2.7"/><path d="M17 8c-1.7 0-3 1.3-3 3v1.2c0 1.8 1.5 2.8 3 2.8"/><path d="M18 8h-2.6c-.4 0-.9.4-.9 1v2.2c0 1.3.9 2.4 2.1 2.7"/>'),
  followers_count:     achvSvg('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6"/><circle cx="17.5" cy="8.5" r="2.4"/><path d="M15.8 14.3c2.6.3 4.7 2.5 4.7 5.7"/>'),
  following_count:     achvSvg('<circle cx="9" cy="8" r="3.2"/><path d="M3.5 20c0-3.6 2.5-6 5.5-6s5.5 2.4 5.5 6"/><path d="M17 5v6M20 8h-6"/>'),
  communities_joined:  achvSvg('<path d="M3 21V9.5L11 4l8 5.5V21"/><path d="M9 21v-6h4v6"/>'),
  communities_created: achvSvg('<path d="M14.5 3.5 20.5 9.5 9.5 20.5H3.5V14.5Z"/><path d="M13 5l6 6"/>'),
  community_moderator: achvSvg('<path d="M12 3 4.5 6v5.5c0 5 3.3 8.4 7.5 9.5 4.2-1.1 7.5-4.5 7.5-9.5V6Z"/><path d="m9 12 2 2 4-4"/>'),
  messages_sent:       achvSvg('<path d="M4 4 20.5 12 4 20l2.5-8Z"/>'),
  dm_partners_count:   achvSvg('<rect x="3" y="5" width="18" height="14" rx="2.5"/><circle cx="9" cy="10.5" r="2"/><path d="M6 16c0-1.7 1.3-3 3-3s3 1.3 3 3"/><path d="M14 9.5h4M14 13h3"/>'),
  bookmarks_count:     achvSvg('<path d="M6 3.5h12v17l-6-4-6 4Z"/>'),
  lists_created:       achvSvg('<rect x="4" y="4" width="4" height="4" rx="1"/><rect x="4" y="10.5" width="4" height="4" rx="1"/><rect x="4" y="17" width="4" height="4" rx="1"/><path d="M11 6h9M11 12.5h9M11 19h9"/>'),
  list_with_5_members: achvSvg('<path d="M4 4h5v5H4z"/><path d="M4 20c0-2.8 2-4.5 4.5-4.5S13 17.2 13 20"/><circle cx="17" cy="8" r="2.3"/><path d="M13.5 15.5c2.4.2 4.5 1.9 4.5 4.5"/>'),
  articles_written:    achvSvg('<path d="M5 3.5h11l3 3V20a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V4.5a1 1 0 0 1 1-1Z"/><path d="M8 9h8M8 12.5h8M8 16h5"/>'),
  streak_days:         achvSvg('<path d="M12 2.5c1.5 3 .5 4.5-.5 6-1.5 2-1 4 .5 5-2 0-3.5-1.5-3.5-3.5 0 0-2.5 2-2.5 5.5A6 6 0 0 0 12 21.5a6 6 0 0 0 6-6c0-4.5-3-6.5-4-9-1 1.5-.5 3 0 4-1-.5-2-2.3-2-8Z"/>'),
  polls_created:       achvSvg('<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="M8 15v-3M12 15V8M16 15v-5.2"/>'),
  polls_voted:         achvSvg('<rect x="4" y="3.5" width="16" height="17" rx="2"/><path d="m8 12 2.3 2.3L16 9"/>'),
  joined:               achvSvg('<path d="m4.5 20 2-6 12-9.5-9.5 12Z"/><path d="M13 3.5 20.5 11"/><path d="M4.5 20 2 22"/><circle cx="18" cy="4" r="1" fill="currentColor" stroke="none"/><circle cx="21" cy="8" r="1" fill="currentColor" stroke="none"/>'),
  profile_complete:    achvSvg('<path d="M9 3.5H5.5A1.5 1.5 0 0 0 4 5v3.5h5Z"/><path d="M15 3.5h3.5A1.5 1.5 0 0 1 20 5v3.5h-5Z"/><path d="M9 20.5H5.5A1.5 1.5 0 0 1 4 19v-3.5h5Z"/><path d="M15 20.5h3.5a1.5 1.5 0 0 0 1.5-1.5v-3.5h-5Z"/>'),
  verified_account:    achvSvg('<path d="m12 2.5 2.4 1.4 2.7-.4 1.3 2.4 2.4 1.4-.4 2.7 1.4 2.4-1.4 2.4.4 2.7-2.4 1.3-1.3 2.4-2.7-.4L12 22.5l-2.4-1.4-2.7.4-1.3-2.4-2.4-1.3.4-2.7-1.4-2.4 1.4-2.4-.4-2.7 2.4-1.4 1.3-2.4 2.7.4Z"/><path d="m8.5 12 2.3 2.3L16 9"/>'),
  night_owl_post:      achvSvg('<path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z"/>'),
  early_bird_post:     achvSvg('<path d="M12 3v5"/><circle cx="12" cy="14" r="4.5"/><path d="M4.5 21h15M6 17.5l-1.5 1M18 17.5l1.5 1"/>'),
  weekend_both_days:   achvSvg('<rect x="3" y="5" width="18" height="16" rx="2.5"/><path d="M3 9.5h18M8 3v4M16 3v4"/><path d="m8.5 13.5 1.8 1.8L14 11.5"/>'),
  first_mutual_follow: achvSvg('<path d="M9 15 15 9"/><path d="M10.5 6.5 13 4a3.5 3.5 0 0 1 5 5l-2.5 2.5"/><path d="M13.5 17.5 11 20a3.5 3.5 0 0 1-5-5l2.5-2.5"/>'),
  posted_long_form:    achvSvg('<path d="M6 3.5h9l3 3V19a1.5 1.5 0 0 1-1.5 1.5h-10A1.5 1.5 0 0 1 5 19V5a1.5 1.5 0 0 1 1-1.5Z"/><path d="M8 8.5h6M8 12h8M8 15.5h5"/>'),
  posted_media:        achvSvg('<rect x="3" y="4.5" width="18" height="15" rx="2"/><circle cx="9" cy="10" r="1.7"/><path d="m5 18 5-5 3.5 3.5L18 12l3 3"/>'),
  posted_video:        achvSvg('<rect x="3" y="5.5" width="13" height="13" rx="2"/><path d="m16 10 5-2.5v9L16 14Z"/>'),
  posted_gif:          achvSvg('<rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 9v6M17 9h-3v6M14 12h2M11 9c-1.4 0-2.4 1.3-2.4 3s1 3 2.4 3c.7 0 1.3-.2 1.7-.6v-2.4H11"/>'),
  reply_got_liked:     achvSvg('<path d="M4 5h16v10H9l-5 4z"/><path d="m12.3 6.7.5.9.9.1-.7.7.2.9-.9-.4-.9.4.2-.9-.7-.7.9-.1z" fill="currentColor" stroke-width="1"/>'),
  nested_reply:        achvSvg('<path d="M5 4v7a3 3 0 0 0 3 3h9"/><path d="m13 10.5 4.5 3.5-4.5 3.5"/>'),
  got_quoted:          achvSvg('<path d="M7 8c-1.7 0-3 1.3-3 3v1.2C4 14 5.5 15 7 15" /><path d="M8 8H5.4C5 8 4.5 8.4 4.5 9v2.2c0 1.3.9 2.4 2.1 2.7"/><path d="M17 8c-1.7 0-3 1.3-3 3v1.2c0 1.8 1.5 2.8 3 2.8"/><path d="M18 8h-2.6c-.4 0-.9.4-.9 1v2.2c0 1.3.9 2.4 2.1 2.7"/><path d="M12 3.5v2M8.5 4.3l1 1.7M15.5 4.3l-1 1.7"/>'),
  chat_key_backup:     achvSvg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/><circle cx="12" cy="15" r="1.3" fill="currentColor" stroke="none"/>'),
  bio_written:         achvSvg('<path d="M14.5 4.5 19 9l-9.5 9.5L4 20l1.5-5.5z"/><path d="M4 20h16"/>')
};
const ACHV_LOCK_ICON = achvSvg('<rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>');

function achvIconFor(a) {
  return ACHV_ICON_MAP[a.metric] || a.icon;
}

// ── LOCAL "SEEN" STATE — used only to detect what's newly unlocked
// / newly leveled-up between visits, so we know what to celebrate.
// Purely cosmetic client-side cache; the server payload is always
// the source of truth for what's actually unlocked. ────────────────
function achvStorageKey(suffix) {
  const uid = (typeof currentSession !== 'undefined' && currentSession?.user?.id) || 'anon';
  return `ii-achv-${suffix}-${uid}`;
}
function achvLoadSeen() {
  try {
    const raw = localStorage.getItem(achvStorageKey('seen'));
    return raw ? new Set(JSON.parse(raw)) : null; // null = never recorded (first visit)
  } catch (e) { return null; }
}
function achvSaveSeen(ids) {
  try { localStorage.setItem(achvStorageKey('seen'), JSON.stringify([...ids])); } catch (e) {}
}
function achvLoadLevel() {
  try {
    const raw = localStorage.getItem(achvStorageKey('level'));
    return raw === null ? null : parseInt(raw, 10);
  } catch (e) { return null; }
}
function achvSaveLevel(level) {
  try { localStorage.setItem(achvStorageKey('level'), String(level)); } catch (e) {}
}

let achvData = null;
let achvOpenId = null;

function achvFmtXp(n) {
  n = Math.round(n || 0);
  return n.toLocaleString();
}

// Renders the level ring + XP bar at the top of the page. The ring
// starts at 0 and animates up to its real value on the next frame
// (see achvAnimateRingIn) rather than snapping straight to it.
function achvLevelCardHtml(d) {
  const pct = d.xp_for_next_level > 0 ? Math.max(2, Math.min(100, (d.xp_in_level / d.xp_for_next_level) * 100)) : 100;
  const r = 42, c = 2 * Math.PI * r;
  return `
    <div class="achv-level-card">
      <div class="achv-ring-wrap">
        <svg class="achv-ring" viewBox="0 0 100 100">
          <circle class="achv-ring-bg" cx="50" cy="50" r="${r}"></circle>
          <circle class="achv-ring-fg" id="achv-ring-fg" cx="50" cy="50" r="${r}" data-target-pct="${pct}" stroke-dasharray="0 ${c.toFixed(1)}"></circle>
        </svg>
        <div class="achv-ring-inner">
          <span class="achv-ring-level" id="achv-ring-level">${d.level}</span>
          <span class="achv-ring-label">LEVEL</span>
        </div>
      </div>
      <div class="achv-level-info">
        <div class="achv-level-title">Level ${d.level}</div>
        <div class="achv-level-sub">${achvFmtXp(d.xp_in_level)} / ${achvFmtXp(d.xp_for_next_level)} XP to next level</div>
        <div class="achv-xpbar"><div class="achv-xpbar-fill" style="width:0%;" data-target-pct="${pct}" id="achv-xpbar-fill"></div></div>
        <div class="achv-level-stats">
          <span><b>${d.unlocked_count}</b> / ${d.total_count} unlocked</span>
          <span><b>${achvFmtXp(d.total_xp)}</b> total XP</span>
        </div>
      </div>
    </div>`;
}

function achvAnimateRingIn() {
  const ring = document.getElementById('achv-ring-fg');
  const bar = document.getElementById('achv-xpbar-fill');
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (ring) {
      const r = 42, c = 2 * Math.PI * r;
      const pct = parseFloat(ring.dataset.targetPct) || 0;
      ring.setAttribute('stroke-dasharray', `${(c * pct / 100).toFixed(1)} ${c.toFixed(1)}`);
    }
    if (bar) bar.style.width = `${bar.dataset.targetPct}%`;
  }));
}

function achvBadgeHtml(a, isNew) {
  const unlocked = !!a.unlocked;
  const color = ACHV_TIER_COLOR[a.tier] || 'var(--maroon)';
  const style = unlocked ? `--achv-c:${color};` : '';
  const progressPct = a.threshold > 0 ? Math.max(0, Math.min(100, (a.current_value / a.threshold) * 100)) : 0;
  return `
    <button class="achv-badge${unlocked ? ' unlocked' : ' locked'}${isNew ? ' achv-badge-new' : ''}" style="${style}" onclick="openAchvModal('${a.id}')" data-achv-id="${esc(a.id)}">
      <span class="achv-badge-icon">${unlocked ? achvIconFor(a) : ACHV_LOCK_ICON}</span>
      <span class="achv-badge-title">${unlocked ? esc(a.title) : '???'}</span>
      ${!unlocked ? `<span class="achv-badge-progress"><span class="achv-badge-progress-fill" style="width:${progressPct}%;"></span></span>` : ''}
    </button>`;
}

function achvCategoryHtml(category, items, newIds) {
  const unlockedN = items.filter(a => a.unlocked).length;
  return `
    <div class="achv-cat">
      <div class="achv-cat-head">
        <span class="achv-cat-title">${esc(category)}</span>
        <span class="achv-cat-count">${unlockedN}/${items.length}</span>
      </div>
      <div class="achv-grid">${items.map(a => achvBadgeHtml(a, newIds.has(a.id))).join('')}</div>
    </div>`;
}

function renderAchievements(d, newlyUnlockedIds) {
  const root = document.getElementById('achv-root');
  if (!root) return;
  achvData = d;
  const newIds = newlyUnlockedIds || new Set();

  const byCat = new Map();
  (d.achievements || []).forEach(a => {
    if (!byCat.has(a.category)) byCat.set(a.category, []);
    byCat.get(a.category).push(a);
  });
  const cats = [...byCat.keys()].sort((a, b) => {
    const ia = ACHV_CATEGORY_ORDER.indexOf(a), ib = ACHV_CATEGORY_ORDER.indexOf(b);
    if (ia === -1 && ib === -1) return a.localeCompare(b);
    if (ia === -1) return 1;
    if (ib === -1) return -1;
    return ia - ib;
  });

  root.innerHTML = achvLevelCardHtml(d) +
    `<div class="achv-cats">${cats.map(c => achvCategoryHtml(c, byCat.get(c), newIds)).join('')}</div>`;
  achvAnimateRingIn();
}

function achvModalBodyHtml(a) {
  const unlocked = !!a.unlocked;
  const color = ACHV_TIER_COLOR[a.tier] || 'var(--maroon)';
  const dateStr = a.unlocked_at ? new Date(a.unlocked_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  const progressPct = a.threshold > 0 ? Math.max(0, Math.min(100, (a.current_value / a.threshold) * 100)) : 0;
  return `
    <div class="achv-modal-icon" style="--achv-c:${color};">
      ${unlocked ? achvIconFor(a) : ACHV_LOCK_ICON}
    </div>
    <h2 class="achv-modal-title">${unlocked ? esc(a.title) : 'Locked Achievement'}</h2>
    <div class="achv-modal-tier" style="color:${color};">${esc(a.tier)} tier &middot; ${a.xp} XP</div>
    <p class="achv-modal-desc">${unlocked ? esc(a.description) : 'Keep using InteractInk to unlock this one.'}</p>
    ${unlocked
      ? `<div class="achv-modal-unlocked">Unlocked ${dateStr}</div>`
      : `<div class="achv-modal-progress">
           <div class="achv-xpbar"><div class="achv-xpbar-fill" style="width:${progressPct}%;"></div></div>
           <span>${achvFmtXp(a.current_value)} / ${achvFmtXp(a.threshold)}</span>
         </div>`}`;
}

function openAchvModal(id) {
  if (!achvData) return;
  const a = (achvData.achievements || []).find(x => x.id === id);
  if (!a) return;
  achvOpenId = id;
  document.getElementById('achv-modal-body').innerHTML = achvModalBodyHtml(a);
  document.getElementById('modal-achv').classList.add('open');
}
function closeAchvModal() {
  document.getElementById('modal-achv')?.classList.remove('open');
  achvOpenId = null;
}

async function loadAchievements() {
  const root = document.getElementById('achv-root');
  if (!root) return;
  await authReady;
  const session = currentSession;

  if (!session) {
    root.innerHTML = `<div class="post-login-gate" style="border-top:none;">Log in to see your level and achievements. <a href="login.html">Log in</a> or <a href="signup.html">create an account</a>.</div>`;
    return;
  }

  const { data, error } = await sb.rpc('get_my_achievements');
  if (error) {
    root.innerHTML = `<div class="errmsg">${esc(error.message)}</div>`;
    return;
  }
  if (!data) {
    root.innerHTML = `<div id="feed-empty">Couldn't load your achievements right now. Try again in a moment.</div>`;
    return;
  }

  // Diff against what we last saw to figure out what to celebrate.
  const unlockedNow = (data.achievements || []).filter(a => a.unlocked);
  const unlockedIdsNow = new Set(unlockedNow.map(a => a.id));
  const prevSeen = achvLoadSeen();          // null on a person's very first visit
  const prevLevel = achvLoadLevel();
  const newlyUnlocked = prevSeen ? unlockedNow.filter(a => !prevSeen.has(a.id)) : [];
  const leveledUp = prevLevel !== null && data.level > prevLevel;

  renderAchievements(data, new Set(newlyUnlocked.map(a => a.id)));
  achvSaveSeen(unlockedIdsNow);
  achvSaveLevel(data.level);

  if (leveledUp) {
    achvCelebrateLevelUp(data.level);
    // Level-up already carries the moment; queue any new badges after
    // a short beat so they don't compete with the full-screen overlay.
    setTimeout(() => achvQueueUnlockToasts(newlyUnlocked), 1600);
  } else if (newlyUnlocked.length) {
    achvQueueUnlockToasts(newlyUnlocked);
  }
}

// ── CELEBRATIONS ────────────────────────────────────────────────

let achvToastQueue = [];
let achvToastShowing = false;

function achvQueueUnlockToasts(items) {
  if (!items || !items.length) return;
  achvToastQueue.push(...items);
  achvDrainToastQueue();
}

function achvDrainToastQueue() {
  if (achvToastShowing || !achvToastQueue.length) return;
  const a = achvToastQueue.shift();
  achvToastShowing = true;
  const stack = document.getElementById('achv-toast-stack');
  if (!stack) { achvToastShowing = false; return; }

  const color = ACHV_TIER_COLOR[a.tier] || 'var(--maroon)';
  const el = document.createElement('div');
  el.className = 'achv-toast';
  el.style.setProperty('--achv-c', color);
  el.innerHTML = `
    <span class="achv-toast-icon">${achvIconFor(a)}</span>
    <span class="achv-toast-body">
      <span class="achv-toast-kicker">Achievement unlocked</span>
      <span class="achv-toast-title">${esc(a.title)}</span>
    </span>
    <span class="achv-toast-xp">+${a.xp} XP</span>`;
  el.addEventListener('click', () => openAchvModal(a.id));
  stack.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));

  const dismiss = () => {
    el.classList.remove('show');
    el.classList.add('hide');
    setTimeout(() => {
      el.remove();
      achvToastShowing = false;
      achvDrainToastQueue();
    }, 320);
  };
  setTimeout(dismiss, 3600);
}

function achvCelebrateLevelUp(level) {
  const overlay = document.getElementById('achv-levelup-overlay');
  const numEl = document.getElementById('achv-levelup-num');
  if (!overlay || !numEl) return;
  numEl.textContent = level;
  overlay.classList.add('show');
  achvConfettiBurst(overlay);
  setTimeout(() => overlay.classList.remove('show'), 2400);
}

const ACHV_CONFETTI_COLORS = ['#F97316', '#EAB308', '#EC4899', '#38BDF8', '#7C3AED', '#22C55E'];
function achvConfettiBurst(container) {
  const field = document.createElement('div');
  field.className = 'achv-confetti-field';
  for (let i = 0; i < 36; i++) {
    const piece = document.createElement('span');
    piece.className = 'achv-confetti-piece';
    const x = (Math.random() * 100).toFixed(1);
    const delay = (Math.random() * 0.25).toFixed(2);
    const duration = (1.6 + Math.random() * 0.9).toFixed(2);
    const rot = Math.round(Math.random() * 360);
    const color = ACHV_CONFETTI_COLORS[i % ACHV_CONFETTI_COLORS.length];
    piece.style.cssText = `left:${x}%; --achv-rot:${rot}deg; --achv-color:${color}; animation-delay:${delay}s; animation-duration:${duration}s;`;
    field.appendChild(piece);
  }
  container.appendChild(field);
  setTimeout(() => field.remove(), 2800);
}

document.addEventListener('DOMContentLoaded', async () => {
  // Same pjax-relisten guard used by every other page bundle (see
  // bookmarks.js/board.js) — without it, navigating away and back to
  // any page reusing #achv-root would re-run this there too.
  if (document.body.dataset.page !== 'achievements') return;
  await authReady;
  loadAchievements();
});
