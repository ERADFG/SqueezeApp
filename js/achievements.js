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

let achvData = null;
let achvOpenId = null;

function achvFmtXp(n) {
  n = Math.round(n || 0);
  return n.toLocaleString();
}

// Renders the level ring + XP bar at the top of the page.
function achvLevelCardHtml(d) {
  const pct = d.xp_for_next_level > 0 ? Math.max(2, Math.min(100, (d.xp_in_level / d.xp_for_next_level) * 100)) : 100;
  const r = 42, c = 2 * Math.PI * r;
  const dash = c * (pct / 100);
  return `
    <div class="achv-level-card">
      <div class="achv-ring-wrap">
        <svg class="achv-ring" viewBox="0 0 100 100">
          <circle class="achv-ring-bg" cx="50" cy="50" r="${r}"></circle>
          <circle class="achv-ring-fg" cx="50" cy="50" r="${r}" stroke-dasharray="${dash.toFixed(1)} ${c.toFixed(1)}"></circle>
        </svg>
        <div class="achv-ring-inner">
          <span class="achv-ring-level">${d.level}</span>
          <span class="achv-ring-label">LEVEL</span>
        </div>
      </div>
      <div class="achv-level-info">
        <div class="achv-level-title">Level ${d.level}</div>
        <div class="achv-level-sub">${achvFmtXp(d.xp_in_level)} / ${achvFmtXp(d.xp_for_next_level)} XP to next level</div>
        <div class="achv-xpbar"><div class="achv-xpbar-fill" style="width:${pct}%;"></div></div>
        <div class="achv-level-stats">
          <span><b>${d.unlocked_count}</b> / ${d.total_count} unlocked</span>
          <span><b>${achvFmtXp(d.total_xp)}</b> total XP</span>
        </div>
      </div>
    </div>`;
}

function achvBadgeHtml(a) {
  const unlocked = !!a.unlocked;
  const color = ACHV_TIER_COLOR[a.tier] || 'var(--maroon)';
  const style = unlocked ? `--achv-c:${color};` : '';
  const progressPct = a.threshold > 0 ? Math.max(0, Math.min(100, (a.current_value / a.threshold) * 100)) : 0;
  return `
    <button class="achv-badge${unlocked ? ' unlocked' : ' locked'}" style="${style}" onclick="openAchvModal('${a.id}')" data-achv-id="${esc(a.id)}">
      <span class="achv-badge-icon">${unlocked ? a.icon : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'}</span>
      <span class="achv-badge-title">${unlocked ? esc(a.title) : '???'}</span>
      ${!unlocked ? `<span class="achv-badge-progress"><span class="achv-badge-progress-fill" style="width:${progressPct}%;"></span></span>` : ''}
    </button>`;
}

function achvCategoryHtml(category, items) {
  const unlockedN = items.filter(a => a.unlocked).length;
  return `
    <div class="achv-cat">
      <div class="achv-cat-head">
        <span class="achv-cat-title">${esc(category)}</span>
        <span class="achv-cat-count">${unlockedN}/${items.length}</span>
      </div>
      <div class="achv-grid">${items.map(achvBadgeHtml).join('')}</div>
    </div>`;
}

function renderAchievements(d) {
  const root = document.getElementById('achv-root');
  if (!root) return;
  achvData = d;

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
    `<div class="achv-cats">${cats.map(c => achvCategoryHtml(c, byCat.get(c))).join('')}</div>`;
}

function achvModalBodyHtml(a) {
  const unlocked = !!a.unlocked;
  const color = ACHV_TIER_COLOR[a.tier] || 'var(--maroon)';
  const dateStr = a.unlocked_at ? new Date(a.unlocked_at).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' }) : '';
  const progressPct = a.threshold > 0 ? Math.max(0, Math.min(100, (a.current_value / a.threshold) * 100)) : 0;
  return `
    <div class="achv-modal-icon" style="--achv-c:${color};">
      ${unlocked ? a.icon : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>'}
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
    root.innerHTML = `<div class="post-login-gate" style="border-top:none;">Log in to see your level and achievements. <a href="login.html">Log in</a> or <a href="signup.html">sign up</a>.</div>`;
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
  renderAchievements(data);
}

document.addEventListener('DOMContentLoaded', async () => {
  // Same pjax-relisten guard used by every other page bundle (see
  // bookmarks.js/board.js) — without it, navigating away and back to
  // any page reusing #achv-root would re-run this there too.
  if (document.body.dataset.page !== 'achievements') return;
  await authReady;
  loadAchievements();
});
