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
// ...plus supabase/analytics_engagement_v2.sql:
//   get_video_watch_stats()        -> total/avg watch time + top 3 videos
//   get_mentions_count(days)       -> @mentions received, lifetime + window
//   get_prior_period_totals(days)  -> same metrics as above, for the window
//                                      right before the current one (deltas)
// Every RPC checks auth.uid() server-side — there is no way to load
// anyone's insights but your own.
//
// No Shares metric: nothing in this schema logs a share event (see
// the comment at the top of analytics_engagement.sql for why) — the
// Content tab shows Likes/Reposts/Saves/Comments only.
//
// No video completion %: post_watch_events has watched time but no
// stored video duration anywhere (js/video-player.js reads it live
// from the <video> element, never persists it) — Video watch time
// reports totals/averages only, not a "% watched" figure.
// ─────────────────────────────────────────────────────────────

let insDays = 30;
let insTab = 'overview';
let insData = null;       // { viewStats, growth, demo, activeTimes, content, viewerLocations, engagement, periodEngagement, prior, topWeek, topMonth, video, mentions }
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
    root.innerHTML = `<div class="ins-gate">You need an account to see your Insights. <a href="/signup">Create an account</a> — it takes a minute.</div>`;
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

// Postgres error 42883 = "function ... does not exist" and 42P01 =
// "relation ... does not exist" — the two errors every RPC here can
// throw if the SQL migration hasn't been (fully) run in the Supabase
// SQL editor yet: 42883 when an RPC itself was never created, 42P01
// when an RPC exists but a table it reads from wasn't. Surface both
// distinctly instead of the generic message so it's obvious what to
// do — "run the SQL file" — rather than a raw Postgres error code.
//
// For anything else, show the real error code/message from Postgres
// instead of a generic "couldn't load" — a guess at the cause is
// useless if it's wrong, and there's no way to know from here whether
// a given project's schema matches the assumptions the SQL was
// written against (table/column names, etc). Whatever this prints is
// the actual thing to fix.
function insErrorHtml(e) {
  const code = e && e.code;
  const msg = (e && (e.message || e.details || e.hint)) || '';
  const retryBtn = `<button type="button" onclick="loadInsights()" style="margin-top:10px;background:var(--maroon);color:#fff;border:none;border-radius:var(--r-sm);padding:7px 14px;font-size:13px;font-weight:600;cursor:pointer;">Retry</button>`;
  if (code === '42883' || code === '42P01' || /function .* does not exist/i.test(msg) || /relation .* does not exist/i.test(msg) || /schema cache/i.test(msg)) {
    return `<div class="errmsg">Insights isn't set up on this project yet — run <code>insights_all_in_one.sql</code> (the whole file, top to bottom) in the Supabase SQL editor, then retry.<br><br><code style="font-size:11px;word-break:break-word;display:block;margin-top:6px;">${esc(code || '')} ${esc(msg || '')}</code>${retryBtn}</div>`;
  }
  if (code === '42501' || /permission denied/i.test(msg)) {
    return `<div class="errmsg">Insights can't read some data it needs — a permission (RLS/GRANT) is blocking one of the report functions.<br><br><code style="font-size:11px;word-break:break-word;display:block;margin-top:6px;">${esc(code || '')} ${esc(msg || 'Unknown error')}</code>${retryBtn}</div>`;
  }
  return `<div class="errmsg">Couldn't load Insights right now.<br><br><code style="font-size:11px;word-break:break-word;display:block;margin-top:6px;">${esc(code || '')} ${esc(msg || 'Unknown error')}</code>${retryBtn}</div>`;
}

async function insFetchAll() {
  const [viewStatsRes, growthRes, demoRes, activeRes, contentRes, viewerLocRes, engagementRes, topWeekRes, topMonthRes, periodEngagementRes, priorRes, videoRes, mentionsRes] = await Promise.all([
    sb.rpc('get_profile_view_stats', { p_days: insDays }),
    sb.rpc('get_follower_growth', { p_days: insDays }),
    sb.rpc('get_audience_demographics'),
    sb.rpc('get_active_times', { p_days: insDays }),
    sb.rpc('get_content_view_totals'),
    sb.rpc('get_viewer_locations', { p_days: insDays }),
    sb.rpc('get_engagement_totals', { p_days: null }),
    sb.rpc('get_top_posts', { p_period: 'week' }),
    sb.rpc('get_top_posts', { p_period: 'month' }),
    sb.rpc('get_engagement_totals', { p_days: insDays }),
    sb.rpc('get_prior_period_totals', { p_days: insDays }),
    sb.rpc('get_video_watch_stats'),
    sb.rpc('get_mentions_count', { p_days: insDays }),
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
  if (periodEngagementRes.error) throw periodEngagementRes.error;
  if (priorRes.error) throw priorRes.error;
  if (videoRes.error) throw videoRes.error;
  if (mentionsRes.error) throw mentionsRes.error;

  insData = {
    viewStats: viewStatsRes.data,
    growth: growthRes.data,
    demo: demoRes.data,
    activeTimes: (activeRes.data || []).map(r => new Date(r.viewed_at)),
    content: contentRes.data,
    viewerLocations: viewerLocRes.data || [],
    engagement: engagementRes.data,
    periodEngagement: periodEngagementRes.data,
    prior: priorRes.data,
    topWeek: topWeekRes.data || [],
    topMonth: topMonthRes.data || [],
    video: videoRes.data,
    mentions: mentionsRes.data,
  };
}

// Small ▲/▼ delta badge comparing a current-period number to the
// equal-length period right before it (from get_prior_period_totals).
// No badge when both periods are zero (nothing to compare); "New"
// when the prior period was zero but this one isn't (a %, undefined
// mathematically, would be misleading here).
function insDeltaBadge(current, previous) {
  current = current || 0;
  previous = previous || 0;
  if (current === 0 && previous === 0) return '';
  if (previous === 0) return `<span class="ins-delta up">New</span>`;
  const pct = ((current - previous) / previous) * 100;
  if (Math.abs(pct) < 0.5) return `<span class="ins-delta flat">flat</span>`;
  const dir = pct > 0 ? 'up' : 'down';
  const arrow = dir === 'up' ? '▲' : '▼';
  return `<span class="ins-delta ${dir}">${arrow} ${Math.abs(pct).toFixed(0)}%</span>`;
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
  const prior = insData.prior || {};

  return `
    <div class="ins-stats-grid">
      <div class="ins-stat-tile">
        <div class="ins-stat-num">${fmtCount(vs.total_views)} ${insDeltaBadge(vs.total_views, prior.views)}</div>
        <div class="ins-stat-label">Profile views</div>
      </div>
      <div class="ins-stat-tile">
        <div class="ins-stat-num">${fmtCount(gr.new_followers)} ${insDeltaBadge(gr.new_followers, prior.new_followers)}</div>
        <div class="ins-stat-label">New followers</div>
      </div>
    </div>
    <p class="ins-note" style="margin:-6px 16px 18px;">vs. the previous ${insDays} days.</p>

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
  const periodEng = insData.periodEngagement || { likes: 0, reposts: 0, comments: 0, saves: 0 };
  const prior = insData.prior || {};
  const mentions = insData.mentions || { total: 0, period: 0 };
  const video = insData.video || { total_watch_ms: 0, viewers: 0, avg_ms_per_viewer: 0, top_videos: [] };

  const totalEngagement = (eng.likes || 0) + (eng.reposts || 0) + (eng.comments || 0) + (eng.saves || 0);
  const engagementRate = ct.total > 0 ? (totalEngagement / ct.total) * 100 : 0;

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
      <div class="ins-stat-tile">
        <div class="ins-stat-num">${engagementRate.toFixed(1)}%</div>
        <div class="ins-stat-label">Engagement rate</div>
      </div>
      <div class="ins-stat-tile">
        <div class="ins-stat-num">${fmtCount(mentions.period)} ${insDeltaBadge(mentions.period, prior.mentions)}</div>
        <div class="ins-stat-label">Mentions, last ${insDays}d</div>
      </div>
    </div>
    <p class="ins-note" style="margin:-6px 16px 18px;">Engagement rate = (likes + reposts + comments + saves) ÷ post &amp; reply views, all-time.</p>

    <div class="ins-section">
      <h2 class="ins-section-title">This period</h2>
      <p class="ins-section-sub">Last ${insDays} days, vs. the ${insDays} days before that.</p>
      <div class="ins-engage-grid">
        ${INS_ENGAGEMENT_META.map(m => `
          <div class="ins-engage-tile">
            <span class="ins-engage-icon">${m.icon}</span>
            <div class="ins-engage-num">${fmtCount(periodEng[m.key] || 0)}</div>
            <div class="ins-engage-label">${m.label}</div>
            <div class="ins-engage-delta">${insDeltaBadge(periodEng[m.key], prior[m.key])}</div>
          </div>`).join('')}
      </div>
    </div>

    <div class="ins-section">
      <h2 class="ins-section-title">All-time engagement</h2>
      <p class="ins-section-sub">Across everything you've ever posted.</p>
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
      <h2 class="ins-section-title">Video watch time</h2>
      <p class="ins-section-sub">All-time, across videos you've posted. ${fmtCount(video.viewers)} people have watched at least some of one.</p>
      <div class="ins-stats-grid" style="margin-left:0;margin-right:0;">
        <div class="ins-stat-tile">
          <div class="ins-stat-num">${insFmtDuration(video.total_watch_ms)}</div>
          <div class="ins-stat-label">Total watch time</div>
        </div>
        <div class="ins-stat-tile">
          <div class="ins-stat-num">${insFmtDuration(video.avg_ms_per_viewer)}</div>
          <div class="ins-stat-label">Avg. per viewer</div>
        </div>
      </div>
      <p class="ins-note" style="margin:6px 0 12px;">No completion % here — video length isn't stored anywhere in the app, only accumulated playback time, so there's nothing to compare it against.</p>
      ${video.top_videos && video.top_videos.length ? `
        <div class="ins-top-posts">${video.top_videos.map((v, i) => `
          <a class="ins-top-post" href="${postUrlById(v.id, currentProfile?.username)}">
            <span class="ins-top-post-rank">#${i + 1}</span>
            <span class="ins-top-post-body">
              <span class="ins-top-post-snippet">${esc(v.snippet || '')}</span>
              <span class="ins-top-post-stats">
                <span>${insFmtDuration(v.total_ms)} watched</span>
                <span>${fmtCount(v.viewers)} viewers</span>
              </span>
            </span>
          </a>`).join('')}</div>
      ` : `<div class="ins-empty-note">No video watch time recorded yet.</div>`}
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

// ms -> "1h 12m" / "8m 04s" / "37s", whichever units are non-zero.
function insFmtDuration(ms) {
  const totalSec = Math.round((ms || 0) / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${String(s).padStart(2, '0')}s`;
  return `${s}s`;
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

    <div class="ins-section">
      <h2 class="ins-section-title">Locations</h2>
      <div class="ins-loc-toggle">
        <button type="button" class="ins-loc-btn${insLocView === 'followers' ? ' active' : ''}" onclick="insSetLocView('followers')">Followers</button>
        <button type="button" class="ins-loc-btn${insLocView === 'viewers' ? ' active' : ''}" onclick="insSetLocView('viewers')">Viewers</button>
      </div>
      <div id="ins-loc-body">${insLocationsHtml()}</div>
    </div>

    <div class="ins-section">
      <h2 class="ins-section-title">Profile visit times</h2>
      <p class="ins-section-sub">Based on all profile views in the last ${insDays} days, in your current time zone.</p>
      ${insActiveTimesHtml()}
    </div>
  `;
}

// Locations toggle — "Followers" is who's actually following you
// (countryRows/countryKnown from get_audience_demographics), "Viewers"
// is everyone who's visited your profile, follower or not, in the
// current day range (viewerRows/viewerKnown from get_viewer_locations).
// Same underlying numbers as before, just one section with a switch
// instead of two always-stacked ones.
let insLocView = 'followers';
function insSetLocView(view) {
  insLocView = view;
  document.querySelectorAll('.ins-loc-btn').forEach(b => b.classList.remove('active'));
  const idx = view === 'followers' ? 0 : 1;
  document.querySelectorAll('.ins-loc-btn')[idx]?.classList.add('active');
  const body = document.getElementById('ins-loc-body');
  if (body) body.innerHTML = insLocationsHtml();
}

function insLocationsHtml() {
  const demo = insData.demo;
  const total = demo.total_followers || 0;
  const countryRows = demo.countries || [];
  const countryKnown = countryRows.reduce((s, c) => s + c.cnt, 0);
  const viewerRows = insData.viewerLocations || [];
  const viewerKnown = viewerRows.reduce((s, c) => s + c.cnt, 0);

  if (insLocView === 'followers') {
    if (!countryRows.length) return `<div class="ins-empty-note">Not enough followers with a detected country yet.</div>`;
    return `
      <p class="ins-section-sub">Based on ${fmtCount(countryKnown)} of ${fmtCount(total)} followers with a detected country.</p>
      ${countryRows.map(c => insBarRowHtml(insCountryName(c.country), c.cnt, countryKnown)).join('')}
    `;
  }
  if (!viewerRows.length) return `<div class="ins-empty-note">Not enough profile views with a detected country yet.</div>`;
  return `
    <p class="ins-section-sub">Based on ${fmtCount(viewerKnown)} profile views with a detected country, last ${insDays} days. Includes everyone who's visited, not just followers.</p>
    ${viewerRows.map(c => insBarRowHtml(insCountryName(c.country), c.cnt, viewerKnown)).join('')}
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
  // "when people visit most" list below the chart, and to turn #1
  // into a direct "post around then" recommendation up top.
  const combos = [];
  grid.forEach((slots, day) => slots.forEach((cnt, slot) => { if (cnt > 0) combos.push({ day, slot, cnt }); }));
  combos.sort((a, b) => b.cnt - a.cnt);
  const top = combos.slice(0, 3);

  return `
    ${top.length ? `<div class="ins-callout">Your audience is most active on <b>${INS_DAY_NAME[top[0].day]}</b>, <b>${INS_SLOT_RANGE[top[0].slot]}</b> — a good window to post.</div>` : ''}
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
