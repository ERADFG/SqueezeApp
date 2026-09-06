// ─────────────────────────────────────────────────────────────
// INSIGHTS PAGE — /insights.html (own account only). Pulls from the
// RPCs in supabase/analytics_setup.sql:
//   get_profile_view_stats(days)   -> total/follower views + daily series
//   get_follower_growth(days)      -> new-followers-per-day series
//   get_audience_demographics()    -> gender/age/country of current followers
//   get_active_times(days)         -> raw view timestamps to bucket client-side
//   get_content_view_totals()      -> summed post/reply view_count
// ...plus supabase/analytics_engagement.sql:
//   get_viewer_locations(days)     -> country breakdown of profile VIEWERS
//   get_engagement_totals(days)    -> likes/reposts/saves/comments received
//   get_top_posts(period)          -> top 3 posts by engagement, 'week'/'month'
// Every RPC checks auth.uid() server-side — there is no way to load
// anyone's insights but your own.
//
// No Shares metric: nothing in this schema logs a share event (see
// the comment at the top of analytics_engagement.sql for why) — the
// Content tab shows Likes/Reposts/Saves/Comments only.
// ─────────────────────────────────────────────────────────────

let insDays = 30;
let insTab = 'overview';
let insData = null;       // { viewStats, growth, demo, activeTimes, content, viewerLocations, engagement, topWeek, topMonth }
let insActiveDay = new Date().getDay(); // 0=Sun .. 6=Sat, viewer's local "today"
const INS_TABS = ['overview', 'content', 'audience'];

const INS_COUNTRY_NAMES = {
  US:'United States', GB:'United Kingdom', CA:'Canada', AU:'Australia', IN:'India',
  DE:'Germany', FR:'France', ES:'Spain', IT:'Italy', NL:'Netherlands', BE:'Belgium',
  PT:'Portugal', IE:'Ireland', CH:'Switzerland', AT:'Austria', SE:'Sweden', NO:'Norway',
  DK:'Denmark', FI:'Finland', PL:'Poland', CZ:'Czechia', RO:'Romania', HU:'Hungary',
  GR:'Greece', UA:'Ukraine', RU:'Russia', TR:'Turkey', IL:'Israel', AE:'United Arab Emirates',
  SA:'Saudi Arabia', EG:'Egypt', NG:'Nigeria', ZA:'South Africa', KE:'Kenya',
  BR:'Brazil', MX:'Mexico', AR:'Argentina', CL:'Chile', CO:'Colombia', PE:'Peru',
  JP:'Japan', KR:'South Korea', CN:'China', HK:'Hong Kong', TW:'Taiwan', SG:'Singapore',
  MY:'Malaysia', TH:'Thailand', VN:'Vietnam', PH:'Philippines', ID:'Indonesia',
  PK:'Pakistan', BD:'Bangladesh', NZ:'New Zealand',
};
function insCountryName(code) { return INS_COUNTRY_NAMES[code] || code; }

const INS_GENDER_LABEL = { male: 'Men', female: 'Women', other: 'Other', not_specified: 'Not specified' };
const INS_DAY_LABEL = ['Su', 'M', 'Tu', 'W', 'Th', 'F', 'Sa'];
const INS_DAY_NAME = ['Sundays', 'Mondays', 'Tuesdays', 'Wednesdays', 'Thursdays', 'Fridays', 'Saturdays'];
const INS_SLOT_LABEL = ['12a', '3a', '6a', '9a', '12p', '3p', '6p', '9p'];
const INS_SLOT_RANGE = ['12 AM - 3 AM', '3 AM - 6 AM', '6 AM - 9 AM', '9 AM - 12 PM', '12 PM - 3 PM', '3 PM - 6 PM', '6 PM - 9 PM', '9 PM - 12 AM'];

async function loadInsights() {
  if (document.body.dataset.page !== 'insights') return;
  const root = document.getElementById('insights-root');
  if (!root) return;

  await authReady;
  const session = currentSession;
  if (!session) {
    root.innerHTML = `<div class="ins-gate">You need an account to see your Insights. <a href="signup.html">Create an account</a> — it takes a minute.</div>`;
    return;
  }

  root.innerHTML = `<div class="skel-form">
    <div class="skel-field"><div class="skel-line label w20"></div><div class="skel-line input w90"></div></div>
    <div class="skel-field"><div class="skel-line label w30"></div><div class="skel-line input w90"></div></div>
    <div class="skel-field"><div class="skel-line label w20"></div><div class="skel-line input w90"></div></div>
  </div>`;

  try {
    await insFetchAll();
  } catch (e) {
    console.error('[insights] failed to load:', e);
    root.innerHTML = insErrorHtml(e);
    return;
  }

  insRender();
}

// Postgres error 42883 = "function ... does not exist" — the exact
// error every RPC here throws if supabase/analytics_setup.sql hasn't
// been run in the Supabase SQL editor yet. Surface that distinctly
// instead of the generic message so it's obvious what to do, instead
// of just "try refreshing" (which can't fix a missing migration).
function insErrorHtml(e) {
  const code = e && e.code;
  const msg = (e && (e.message || e.details || '')) || '';
  if (code === '42883' || /function .* does not exist/i.test(msg) || /schema cache/i.test(msg)) {
    return `<div class="errmsg">Insights isn't set up on this project yet — run <code>supabase/analytics_setup.sql</code> in the Supabase SQL editor, then refresh this page.</div>`;
  }
  return `<div class="errmsg">Couldn't load Insights right now. Try refreshing.</div>`;
}

async function insFetchAll() {
  const [viewStatsRes, growthRes, demoRes, activeRes, contentRes, viewerLocRes, engagementRes, topWeekRes, topMonthRes] = await Promise.all([
    sb.rpc('get_profile_view_stats', { p_days: insDays }),
    sb.rpc('get_follower_growth', { p_days: insDays }),
    sb.rpc('get_audience_demographics'),
    sb.rpc('get_active_times', { p_days: insDays }),
    sb.rpc('get_content_view_totals'),
    sb.rpc('get_viewer_locations', { p_days: insDays }),
    sb.rpc('get_engagement_totals', { p_days: null }),
    sb.rpc('get_top_posts', { p_period: 'week' }),
    sb.rpc('get_top_posts', { p_period: 'month' }),
  ]);
  if (viewStatsRes.error) throw viewStatsRes.error;
  if (growthRes.error) throw growthRes.error;
  if (demoRes.error) throw demoRes.error;
  if (activeRes.error) throw activeRes.error;
  if (contentRes.error) throw contentRes.error;
  if (viewerLocRes.error) throw viewerLocRes.error;
  if (engagementRes.error) throw engagementRes.error;
  if (topWeekRes.error) throw topWeekRes.error;
  if (topMonthRes.error) throw topMonthRes.error;

  insData = {
    viewStats: viewStatsRes.data,
    growth: growthRes.data,
    demo: demoRes.data,
    activeTimes: (activeRes.data || []).map(r => new Date(r.viewed_at)),
    content: contentRes.data,
    viewerLocations: viewerLocRes.data || [],
    engagement: engagementRes.data,
    topWeek: topWeekRes.data || [],
    topMonth: topMonthRes.data || [],
  };
}

function insRender() {
  const root = document.getElementById('insights-root');
  if (!root || !insData) return;

  root.innerHTML = `
    <div class="ins-range-pills">
      ${[7, 30, 90].map(d => `<button type="button" class="ins-range-pill${insDays === d ? ' active' : ''}" onclick="insSetRange(${d})">${d} days</button>`).join('')}
    </div>
    <div class="sec-bar profile-tabs ins-tabs" style="padding:0;">
      <div class="xtabs">
        <button class="xtab${insTab === 'overview' ? ' active' : ''}" onclick="insSetTab('overview');return false;">Overview</button>
        <button class="xtab${insTab === 'content' ? ' active' : ''}" onclick="insSetTab('content');return false;">Content</button>
        <button class="xtab${insTab === 'audience' ? ' active' : ''}" onclick="insSetTab('audience');return false;">Audience</button>
      </div>
    </div>
    <div id="ins-tab-body"></div>
  `;
  insRenderTabBody();
}

function insRenderTabBody() {
  const body = document.getElementById('ins-tab-body');
  if (!body) return;
  body.innerHTML = insTab === 'overview' ? insOverviewHtml() : insTab === 'content' ? insContentHtml() : insAudienceHtml();
}

function insSetRange(days) {
  insDays = days;
  const root = document.getElementById('insights-root');
  if (root) root.innerHTML = `<div class="skel-form"><div class="skel-field"><div class="skel-line label w20"></div><div class="skel-line input w90"></div></div></div>`;
  insFetchAll().then(insRender).catch((e) => {
    console.error('[insights] failed to load:', e);
    if (root) root.innerHTML = insErrorHtml(e);
  });
}

function insSetTab(tab) {
  insTab = tab;
  document.querySelectorAll('.ins-tabs .xtab').forEach(b => b.classList.remove('active'));
  const idx = INS_TABS.indexOf(tab);
  document.querySelectorAll('.ins-tabs .xtab')[idx]?.classList.add('active');
  insRenderTabBody();
}

// ── OVERVIEW TAB ─────────────────────────────────────────────
function insOverviewHtml() {
  const vs = insData.viewStats;
  const gr = insData.growth;

  return `
    <div class="ins-stats-grid">
      <div class="ins-stat-tile">
        <div class="ins-stat-num">${fmtCount(vs.total_views)}</div>
        <div class="ins-stat-label">Profile views</div>
      </div>
      <div class="ins-stat-tile">
        <div class="ins-stat-num">${fmtCount(gr.new_followers)}</div>
        <div class="ins-stat-label">New followers</div>
      </div>
    </div>

    <div class="ins-section">
      <h2 class="ins-section-title">Profile views</h2>
      <p class="ins-section-sub">${fmtCount(vs.follower_views)} from followers, ${fmtCount(vs.non_follower_views)} from non-followers, last ${insDays} days.</p>
      <div class="ins-chart-wrap">${insLineChartSvg(vs.series, 'views')}</div>
    </div>

    <div class="ins-section">
      <h2 class="ins-section-title">New followers</h2>
      <p class="ins-section-sub">Last ${insDays} days. This tracks new follows, not net change — InteractInk doesn't currently log unfollows.</p>
      <div class="ins-chart-wrap">${insLineChartSvg(gr.series, 'new_followers')}</div>
    </div>
  `;
}

// ── CONTENT TAB ──────────────────────────────────────────────
const INS_ENGAGEMENT_META = [
  { key: 'likes',    label: 'Likes',    icon: ICON.heart },
  { key: 'reposts',  label: 'Reposts',  icon: ICON.repost },
  { key: 'comments', label: 'Comments', icon: ICON.reply },
  { key: 'saves',    label: 'Saves',    icon: ICON.bookmark },
];

function insContentHtml() {
  const ct = insData.content;
  const eng = insData.engagement || { likes: 0, reposts: 0, comments: 0, saves: 0 };

  return `
    <div class="ins-stats-grid">
      <div class="ins-stat-tile">
        <div class="ins-stat-num">${fmtCount(ct.total)}</div>
        <div class="ins-stat-label">Post &amp; reply views</div>
      </div>
      <div class="ins-stat-tile">
        <div class="ins-stat-num">${fmtCount(ct.post_views)}</div>
        <div class="ins-stat-label">Post views</div>
      </div>
      <div class="ins-stat-tile">
        <div class="ins-stat-num">${fmtCount(ct.reply_views)}</div>
        <div class="ins-stat-label">Reply views</div>
      </div>
    </div>

    <div class="ins-section">
      <h2 class="ins-section-title">Engagement</h2>
      <p class="ins-section-sub">All-time, across everything you've posted.</p>
      <div class="ins-engage-grid">
        ${INS_ENGAGEMENT_META.map(m => `
          <div class="ins-engage-tile">
            <span class="ins-engage-icon">${m.icon}</span>
            <div class="ins-engage-num">${fmtCount(eng[m.key] || 0)}</div>
            <div class="ins-engage-label">${m.label}</div>
          </div>`).join('')}
      </div>
      <p class="ins-note" style="margin-top:10px;">No Shares number here — InteractInk's share button opens your device's share sheet without reporting back whether anything was actually sent, so there's nothing reliable to count yet.</p>
    </div>

    <div class="ins-section">
      <h2 class="ins-section-title">Trending this week</h2>
      <p class="ins-section-sub">Your top 3 posts by likes, reposts, comments, and saves in the last 7 days.</p>
      ${insTopPostsHtml(insData.topWeek)}
    </div>

    <div class="ins-section">
      <h2 class="ins-section-title">Trending this month</h2>
      <p class="ins-section-sub">Your top 3 posts by likes, reposts, comments, and saves in the last 30 days.</p>
      ${insTopPostsHtml(insData.topMonth)}
    </div>
  `;
}

function insTopPostsHtml(posts) {
  if (!posts || !posts.length) {
    return `<div class="ins-empty-note">Not enough activity yet to surface a top post here.</div>`;
  }
  return `<div class="ins-top-posts">${posts.map((p, i) => `
    <a class="ins-top-post" href="${postUrlById(p.id, currentProfile?.username)}">
      <span class="ins-top-post-rank">#${i + 1}</span>
      <span class="ins-top-post-body">
        <span class="ins-top-post-snippet">${esc(p.snippet || '')}</span>
        <span class="ins-top-post-stats">
          <span class="ins-ico-stroke">${ICON.heart} ${fmtCount(p.likes)}</span>
          <span class="ins-ico-stroke">${ICON.repost} ${fmtCount(p.reposts)}</span>
          <span class="ins-ico-stroke">${ICON.reply} ${fmtCount(p.comments)}</span>
          <span class="ins-ico-stroke">${ICON.bookmark} ${fmtCount(p.saves)}</span>
          <span class="ins-ico-solid">${ICON.views} ${fmtCount(p.view_count)}</span>
        </span>
      </span>
    </a>`).join('')}</div>`;
}

// ── AUDIENCE TAB ─────────────────────────────────────────────
function insAudienceHtml() {
  const demo = insData.demo;
  const total = demo.total_followers || 0;

  const genderRows = (demo.gender || []).slice().sort((a, b) => b.cnt - a.cnt);
  const genderKnown = genderRows.reduce((s, g) => s + g.cnt, 0);

  const ageRows = demo.age || [];
  const ageKnown = ageRows.reduce((s, a) => s + a.cnt, 0);

  const countryRows = demo.countries || [];
  const countryKnown = countryRows.reduce((s, c) => s + c.cnt, 0);

  const viewerRows = insData.viewerLocations || [];
  const viewerKnown = viewerRows.reduce((s, c) => s + c.cnt, 0);

  return `
    <div class="ins-section">
      <h2 class="ins-section-title">Followers</h2>
      <p class="ins-section-sub">${fmtCount(total)} total.</p>
      <div class="ins-chart-wrap">${insLineChartSvg(insData.growth.series, 'new_followers')}</div>
    </div>

    ${genderRows.length ? `
    <div class="ins-section">
      <h2 class="ins-section-title">Gender</h2>
      <p class="ins-section-sub">Based on ${fmtCount(genderKnown)} of ${fmtCount(total)} followers who shared this.</p>
      ${genderRows.map(g => insBarRowHtml(INS_GENDER_LABEL[g.gender] || g.gender, g.cnt, genderKnown)).join('')}
    </div>` : ''}

    ${ageRows.length ? `
    <div class="ins-section">
      <h2 class="ins-section-title">Age range</h2>
      <p class="ins-section-sub">Based on ${fmtCount(ageKnown)} of ${fmtCount(total)} followers who shared this.</p>
      ${ageRows.map(a => insBarRowHtml(a.bucket, a.cnt, ageKnown)).join('')}
    </div>` : ''}

    ${countryRows.length ? `
    <div class="ins-section">
      <h2 class="ins-section-title">Follower locations</h2>
      <p class="ins-section-sub">Based on ${fmtCount(countryKnown)} of ${fmtCount(total)} followers with a detected country.</p>
      ${countryRows.map(c => insBarRowHtml(insCountryName(c.country), c.cnt, countryKnown)).join('')}
    </div>` : ''}

    ${viewerRows.length ? `
    <div class="ins-section">
      <h2 class="ins-section-title">Where your viewers are from</h2>
      <p class="ins-section-sub">Based on ${fmtCount(viewerKnown)} profile views with a detected country, last ${insDays} days. Includes everyone who's visited, not just followers.</p>
      ${viewerRows.map(c => insBarRowHtml(insCountryName(c.country), c.cnt, viewerKnown)).join('')}
    </div>` : ''}

    <div class="ins-section">
      <h2 class="ins-section-title">Profile visit times</h2>
      <p class="ins-section-sub">Based on all profile views in the last ${insDays} days, in your current time zone.</p>
      ${insActiveTimesHtml()}
    </div>
  `;
}

function insBarRowHtml(label, count, denom) {
  const pct = denom > 0 ? (count / denom) * 100 : 0;
  return `
    <div class="ins-bar-row">
      <span class="ins-bar-label">${esc(label)}</span>
      <div class="ins-bar-line">
        <div class="ins-bar-track"><div class="ins-bar-fill" style="width:${Math.max(pct, pct > 0 ? 1.5 : 0)}%"></div></div>
        <span class="ins-bar-pct">${pct.toFixed(1)}%</span>
      </div>
    </div>`;
}

// ── ACTIVE TIMES ─────────────────────────────────────────────
// Buckets the raw view timestamps (already in the viewer's local
// time once turned into a Date) into 7 days x 8 three-hour slots.
function insBucketActiveTimes() {
  const grid = Array.from({ length: 7 }, () => new Array(8).fill(0));
  for (const d of insData.activeTimes) {
    const day = d.getDay();
    const slot = Math.floor(d.getHours() / 3);
    grid[day][slot]++;
  }
  return grid;
}

function insActiveTimesHtml() {
  if (!insData.activeTimes.length) {
    return `<div class="ins-empty-note">Not enough visits yet to show a pattern here.</div>`;
  }
  const grid = insBucketActiveTimes();
  const dayCounts = grid[insActiveDay];
  const max = Math.max(1, ...dayCounts);

  // Top 3 (day, slot) combos across the whole window, for the
  // "when people visit most" list below the chart.
  const combos = [];
  grid.forEach((slots, day) => slots.forEach((cnt, slot) => { if (cnt > 0) combos.push({ day, slot, cnt }); }));
  combos.sort((a, b) => b.cnt - a.cnt);
  const top = combos.slice(0, 3);

  return `
    <div class="ins-day-pills">
      ${INS_DAY_LABEL.map((lbl, i) => `<button type="button" class="ins-day-pill${insActiveDay === i ? ' active' : ''}" onclick="insSetActiveDay(${i})">${lbl}</button>`).join('')}
    </div>
    <div class="ins-chart-wrap">${insBarChartSvg(INS_SLOT_LABEL, dayCounts, max)}</div>
    ${top.length ? `
      <div style="margin-top:14px;">
        <div class="ins-note" style="margin-bottom:4px;font-weight:700;color:var(--ink);">When people visit most</div>
        ${top.map(c => `<div class="ins-active-row"><span class="ins-active-day">${INS_DAY_NAME[c.day]}</span><span class="ins-active-range">${INS_SLOT_RANGE[c.slot]}</span></div>`).join('')}
      </div>` : ''}
  `;
}

function insSetActiveDay(day) {
  insActiveDay = day;
  const body = document.getElementById('ins-tab-body');
  if (body) body.innerHTML = insAudienceHtml();
}

// ── CHARTS (plain inline SVG, no dependency) ────────────────
function insLineChartSvg(series, key) {
  if (!series || !series.length) return `<div class="ins-chart-empty">No data yet for this range.</div>`;
  const W = 600, H = 160, PAD = 8;
  const values = series.map(p => p[key] || 0);
  const max = Math.max(1, ...values);
  const stepX = (W - PAD * 2) / Math.max(1, series.length - 1);
  const pts = values.map((v, i) => {
    const x = PAD + i * stepX;
    const y = H - PAD - (v / max) * (H - PAD * 2);
    return [x, y];
  });
  const path = pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const firstLabel = insFmtDay(series[0].day);
  const lastLabel = insFmtDay(series[series.length - 1].day);
  const midLabel = insFmtDay(series[Math.floor(series.length / 2)].day);
  return `
    <svg viewBox="0 0 ${W} ${H + 20}" preserveAspectRatio="none">
      <line x1="${PAD}" y1="${H - PAD}" x2="${W - PAD}" y2="${H - PAD}" stroke="var(--line)" stroke-width="1"/>
      <path d="${path}" fill="none" stroke="var(--maroon)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
      <text x="${PAD}" y="${H + 15}" font-size="11" fill="var(--muted)">${firstLabel}</text>
      <text x="${W / 2}" y="${H + 15}" font-size="11" fill="var(--muted)" text-anchor="middle">${midLabel}</text>
      <text x="${W - PAD}" y="${H + 15}" font-size="11" fill="var(--muted)" text-anchor="end">${lastLabel}</text>
    </svg>`;
}

function insBarChartSvg(labels, values, max) {
  const W = 600, H = 160, PAD = 6, gap = 6;
  const n = values.length;
  const barW = (W - PAD * 2 - gap * (n - 1)) / n;
  const bars = values.map((v, i) => {
    const h = Math.max(2, (v / max) * (H - 24));
    const x = PAD + i * (barW + gap);
    const y = H - 20 - h;
    return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3" fill="var(--maroon)"/>`;
  }).join('');
  const labelEls = labels.map((lbl, i) => {
    const x = PAD + i * (barW + gap) + barW / 2;
    return `<text x="${x.toFixed(1)}" y="${H - 4}" font-size="10.5" fill="var(--muted)" text-anchor="middle">${lbl}</text>`;
  }).join('');
  return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none">${bars}${labelEls}</svg>`;
}

function insFmtDay(isoDay) {
  const d = new Date(isoDay + 'T00:00:00');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

document.addEventListener('DOMContentLoaded', loadInsights);
