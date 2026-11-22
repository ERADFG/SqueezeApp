import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';

const {
  PINTEREST_ACCESS_TOKEN: TOKEN,
  PINTEREST_API_BASE = 'https://api-sandbox.pinterest.com/v5', // use https://api.pinterest.com/v5 after Standard access
  ADMIN_PASSWORD, SITE_URL = '', HOST = '127.0.0.1', PORT = 3000,
  DATA_DIR = './data', MIN_INTERVAL_SECONDS = '5',
} = process.env;
const { PINTEREST_REFRESH_TOKEN: REFRESH, PINTEREST_APP_ID: APP_ID, PINTEREST_APP_SECRET: APP_SECRET } = process.env;
if ((!TOKEN && !REFRESH) || !ADMIN_PASSWORD) { console.error('Set PINTEREST_ACCESS_TOKEN (or a refresh token) and ADMIN_PASSWORD'); process.exit(1); }
if ((process.env.RUN_ONCE === '1' || !['127.0.0.1', 'localhost'].includes(HOST)) && ADMIN_PASSWORD.length < 12) {
  console.error('ADMIN_PASSWORD must be at least 12 characters (it is reachable from the internet, or it encrypts the saved token)'); process.exit(1);
}
const MIN_INTERVAL = Math.max(1, Number(MIN_INTERVAL_SECONDS) || 5);

// RUN_ONCE=1: no web server. Post one batch of pins, save state, exit. Used by the free GitHub Actions schedule.
const RUN_ONCE = process.env.RUN_ONCE === '1';
const BATCH_MAX_POSTS = Math.max(1, Number(process.env.BATCH_MAX_POSTS) || 5);   // pins per run
const BATCH_SECONDS = Math.max(10, Number(process.env.BATCH_SECONDS) || 240);    // time budget per run
const BOARD_ID = process.env.BOARD_ID || '';

/* ---------- storage ---------- */
const DB_FILE = path.join(DATA_DIR, 'db.json');
const defaults = {
  running: false, intervalSeconds: 10, dailyCap: 0 /* 0 = no cap */, likesAbove: 10, niche: [],
  siteUrl: SITE_URL, boardId: '', dryRun: false, autoLearn: true, learnEveryHours: 6, recycleDays: 30,
};
let db = { settings: { ...defaults }, queue: [], posted: [], log: [], learned: null, learnTried: null, account: null, token: null };
try {
  const saved = JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
  db = { ...db, ...saved, settings: { ...defaults, ...saved.settings } };
} catch { /* first run */ }

// The renewed Pinterest token lives in its own encrypted file (key derived from ADMIN_PASSWORD),
// so db.json can be committed to a repo without leaking a token.
const TOKEN_FILE = path.join(DATA_DIR, 'token.enc');
const tokKey = crypto.scryptSync(ADMIN_PASSWORD, 'pinbot-token-v1', 32);
const sealToken = obj => {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', tokKey, iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj)), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString('base64');
};
const openToken = s => {
  try {
    const b = Buffer.from(s, 'base64'), d = crypto.createDecipheriv('aes-256-gcm', tokKey, b.subarray(0, 12));
    d.setAuthTag(b.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(b.subarray(28)), d.final()]).toString());
  } catch { return null; }
};
try { db.token = openToken(await fs.readFile(TOKEN_FILE, 'utf8')) || db.token; } catch { /* no token file yet */ }

let saving = Promise.resolve();
const save = () => (saving = saving.then(async () => {
  await fs.mkdir(DATA_DIR, { recursive: true });
  const { token, ...rest } = db;
  await fs.writeFile(DB_FILE + '.tmp', JSON.stringify(rest, null, RUN_ONCE ? 1 : 0));
  await fs.rename(DB_FILE + '.tmp', DB_FILE);
  if (token) { await fs.writeFile(TOKEN_FILE + '.tmp', sealToken(token)); await fs.rename(TOKEN_FILE + '.tmp', TOKEN_FILE); }
}).catch(e => console.error('save failed:', e.message)));

const log = (msg, level = 'info') => {
  if (db.log[0]?.msg === msg) return;
  db.log.unshift({ t: new Date().toISOString(), level, msg });
  db.log.length = Math.min(db.log.length, 200);
  console.log(`[${level}] ${msg}`);
};

/* ---------- Pinterest client ---------- */
// Tokens expire, so a refreshed token is kept in the data folder and reused after restarts
const sig = `${TOKEN}|${REFRESH}`;
let accessToken = (db.token?.sig === sig && db.token.access) || TOKEN || '';
let refreshToken = (db.token?.sig === sig && db.token.refresh) || REFRESH;
let refreshing = null;
function refreshAccess() {
  if (!refreshToken || !APP_ID || !APP_SECRET) return Promise.resolve(false);
  return (refreshing ||= (async () => {
    try {
      const r = await fetch(PINTEREST_API_BASE + '/oauth/token', {
        method: 'POST', signal: AbortSignal.timeout(20000),
        headers: { Authorization: 'Basic ' + Buffer.from(`${APP_ID}:${APP_SECRET}`).toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok || !j.access_token) { log(`Token refresh failed: ${j.message || r.status}`, 'error'); return false; }
      accessToken = j.access_token; refreshToken = j.refresh_token || refreshToken;
      db.token = { sig, access: accessToken, refresh: refreshToken, at: new Date().toISOString() };
      log('Access token refreshed'); await save();
      return true;
    } catch (e) { log(`Token refresh failed: ${e.message}`, 'error'); return false; }
    finally { refreshing = null; }
  })());
}
async function api(p, opts = {}, retried = false) {
  const r = await fetch(PINTEREST_API_BASE + p, {
    ...opts, signal: AbortSignal.timeout(20000),
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  });
  const body = await r.json().catch(() => ({}));
  if (r.status === 401 && !retried && await refreshAccess()) return api(p, opts, true);
  if (!r.ok) {
    const e = new Error(`Pinterest ${r.status}: ${body.message || r.statusText}`);
    e.status = r.status; e.retryAfter = Number(r.headers.get('retry-after')) || 0;
    throw e;
  }
  return body;
}
async function listAll(p, maxPages) {
  const out = []; let bookmark;
  for (let i = 0; i < maxPages; i++) {
    const sep = p.includes('?') ? '&' : '?';
    const r = await api(`${p}${sep}page_size=250${bookmark ? '&bookmark=' + encodeURIComponent(bookmark) : ''}`);
    out.push(...(r.items || []));
    bookmark = r.bookmark;
    if (!bookmark) break;
  }
  return out;
}

/* ---------- niche learning: reads every pin and board on YOUR account ---------- */
const STOP = new Set(('a an and are as at be been but by can did do does for from had has have he her his how i if in into is it its ' +
  'just like make made more most my new no not now of on one or our out over she so some such than that the their them then there ' +
  'these they this those to up us use used using very was we were what when where which who why will with you your about after all ' +
  'also any because best easy free get good idea ideas ways way top tips diy pin pins').split(' '));
const words = t => (String(t || '').toLowerCase().match(/\p{L}[\p{L}'’-]{2,}/gu) || [])
  .map(w => w.replace(/['’-]+$/, '')).filter(w => w.length > 2 && !STOP.has(w));
const lifetime = p => p.pin_metrics?.lifetime_metrics || p.pin_metrics?.['90d'] || {};
function pickImage(p) {
  const im = p.media?.images;
  if (!im) return null;
  return (im['1200x'] || im.originals || im['600x'] || Object.values(im).sort((a, b) => (b.width || 0) - (a.width || 0))[0])?.url || null;
}
const hashUrl = u => crypto.createHash('sha1').update(String(u).split('?')[0]).digest('hex').slice(0, 12);

async function learnNiche() {
  const boards = await listAll('/boards', 3);
  const boardName = Object.fromEntries(boards.map(b => [b.id, b.name]));
  const pins = await listAll('/pins?pin_metrics=true', 4);
  const score = new Map(), seen = new Map();
  for (const p of pins) {
    const m = lifetime(p);
    const pinWeight = 1 + Math.log1p((m.reaction || 0) + 2 * (m.save || 0)); // pins people liked/saved teach the niche more
    for (const [text, fieldWeight] of [[p.title, 3], [boardName[p.board_id], 2], [p.description, 1], [p.alt_text, 1]]) {
      const w = words(text), terms = new Set(w);
      for (let i = 0; i < w.length - 1; i++) terms.add(w[i] + ' ' + w[i + 1]);
      for (const t of terms) {
        score.set(t, (score.get(t) || 0) + pinWeight * fieldWeight);
        if (!seen.has(t)) seen.set(t, new Set());
        seen.get(t).add(p.id);
      }
    }
  }
  const need = pins.length >= 10 ? 2 : 1; // a term must show up in 2+ pins once there is enough data
  const ranked = [...score].filter(([t]) => seen.get(t).size >= need).sort((a, b) => b[1] - a[1]).slice(0, 30);
  const max = ranked[0]?.[1] || 1;
  db.learned = {
    at: new Date().toISOString(), pinsScanned: pins.length,
    keywords: ranked.map(([w, s]) => ({ w, weight: +(s / max).toFixed(3) })),
  };
  db.learnTried = db.learned.at;

  // Your own pins that already link to your site and have more than N reactions become queue items
  const { siteUrl, likesAbove, recycleDays } = db.settings;
  let host = ''; try { host = new URL(siteUrl).hostname; } catch { /* no site yet */ }
  let queued = 0;
  for (const p of pins) {
    let u; try { u = new URL(p.link); } catch { continue; }
    const likes = lifetime(p).reaction || 0, img = pickImage(p);
    if (!host || u.hostname !== host || likes <= likesAbove || !img || !p.title) continue;
    const id = 'acct-' + p.id, ex = db.queue.find(i => i.id === id);
    if (!ex) {
      db.queue.push({ id, hash: hashUrl(img), status: 'pending', source: 'account', imageUrl: img, title: p.title,
        description: p.description || '', alt: p.alt_text || '', path: u.pathname === '/' ? '' : u.pathname, tags: [], likes });
      queued++;
    } else if (ex.status === 'posted' && Date.now() - new Date(ex.postedAt || 0) > recycleDays * 864e5) {
      ex.status = 'pending'; ex.likes = likes; queued++;
    }
  }
  await save();
  return { ...db.learned, queued };
}

/* ---------- picking ---------- */
const keywordList = () => [
  ...db.settings.niche.map(w => ({ w: w.toLowerCase(), weight: 1 })),
  ...(db.learned?.keywords || []),
];
function matches(item) {
  const text = `${item.title} ${item.description} ${(item.tags || []).join(' ')}`.toLowerCase();
  return keywordList().filter(k => text.includes(k.w));
}
const relevance = item => matches(item).reduce((s, k) => s + k.weight, 0);
const rank = i => relevance(i) * 10 + Math.min(i.likes || 0, 100) / 10;

function pick() {
  const { likesAbove } = db.settings, hasNiche = keywordList().length > 0;
  const recent = new Set(db.posted.slice(0, 30).map(p => p.title));
  return db.queue
    .filter(i => i.status === 'pending' && !i.checked
      && (typeof i.likes !== 'number' || i.likes > likesAbove) // only MORE than N likes
      && (!hasNiche || relevance(i) > 0)                        // must fit your niche
      && !recent.has(i.title))
    .sort((a, b) => rank(b) - rank(a))[0];
}
function hashtagsFor(item) {
  const hit = matches(item).sort((a, b) => b.weight - a.weight).map(k => k.w);
  const top = keywordList().sort((a, b) => b.weight - a.weight).map(k => k.w);
  return [...new Set([...hit, ...top])].slice(0, 4).map(k => '#' + k.replace(/[^\p{L}\p{N}]+/gu, '')).filter(t => t.length > 1);
}
function buildLink(item) {
  const u = new URL(db.settings.siteUrl.replace(/\/$/, '') + (item.path ? '/' + item.path.replace(/^\//, '') : ''));
  u.searchParams.set('utm_source', 'pinterest');
  u.searchParams.set('utm_medium', 'social');
  u.searchParams.set('utm_content', item.id);
  return u.toString();
}
async function imageOk(url) {
  try {
    const r = await fetch(url, { method: 'HEAD', redirect: 'follow', signal: AbortSignal.timeout(8000) });
    return r.status === 405 || (r.ok && /^image\//.test(r.headers.get('content-type') || ''));
  } catch { return false; }
}
const postedToday = () => db.posted.filter(p => p.t.startsWith(new Date().toISOString().slice(0, 10))).length;

async function post(item) {
  const s = db.settings;
  if (!s.siteUrl || !s.boardId) throw Object.assign(new Error('Set a website URL and a board first'), { fatal: true });
  if (!(await imageOk(item.imageUrl))) {
    item.status = 'failed'; item.error = 'Image URL is unreachable or not an image';
    log(`Skipped "${item.title}": ${item.error}`, 'error');
    return;
  }
  const tags = hashtagsFor(item).join(' ');
  const body = {
    board_id: item.boardId || s.boardId,
    title: item.title.slice(0, 100),
    description: `${item.description || item.title}${tags ? '\n\n' + tags : ''}`.slice(0, 800),
    alt_text: (item.alt || item.title).slice(0, 500),
    link: buildLink(item),
    media_source: { source_type: 'image_url', url: item.imageUrl },
  };
  if (s.dryRun) { item.checked = true; log(`Dry run OK, would post "${item.title}" linking to ${body.link}`); return; }
  try {
    const r = await api('/pins', { method: 'POST', body: JSON.stringify(body) });
    item.status = 'posted'; item.postedAt = new Date().toISOString();
    db.posted.unshift({ t: item.postedAt, id: r.id, title: item.title, link: body.link });
    db.posted.length = Math.min(db.posted.length, 2000);
    log(`Posted "${item.title}"`);
  } catch (e) {
    item.attempts = (item.attempts || 0) + 1;
    if (e.status === 400 || item.attempts >= 3) { item.status = 'failed'; item.error = e.message; }
    throw e;
  }
}

/* ---------- scheduler: one pin per interval, never overlapping ---------- */
let timer, busy = false;
let nextAt = 0;
const schedule = ms => { clearTimeout(timer); nextAt = Date.now() + ms; if (db.settings.running) timer = setTimeout(tick, ms); };
// Safety net for 24/7 running: if the loop ever goes quiet, restart it
setInterval(() => { if (db.settings.running && !busy && Date.now() > nextAt + 120_000) { log('Scheduler was idle, restarting it', 'error'); schedule(1000); } }, 60_000).unref();
process.on('unhandledRejection', e => log(`Unexpected error: ${e?.message || e}`, 'error'));

// One unit of work: maybe learn the niche, then maybe post one pin. Shared by the 24/7 server and the run-once batch.
async function step() {
  const s = db.settings;
  let next = s.intervalSeconds * 1000, idle = false, fatal = false, worked = false;
  try {
    if (s.autoLearn && Date.now() - new Date(db.learnTried || 0) > s.learnEveryHours * 3.6e6) {
      db.learnTried = new Date().toISOString();
      try { const r = await learnNiche(); log(`Learned your niche from ${r.pinsScanned} pins (${r.queued} added to the queue)`); }
      catch (e) { if (e.status === 401) throw e; log(`Could not learn niche: ${e.message}`, 'error'); }
    }
    if (s.dailyCap > 0 && postedToday() >= s.dailyCap) {
      log(`Daily cap of ${s.dailyCap} reached, checking again in 10 minutes`);
      next = 600_000; idle = true;
    } else {
      const item = pick();
      if (item) { worked = true; await post(item); }
      else { log('No eligible pins in the queue'); idle = true; } // idle check is local, so keep the normal interval
    }
  } catch (e) {
    log(e.message, 'error'); idle = true;
    if (e.fatal || e.status === 401 || e.status === 403) { fatal = true; s.running = false; log('Bot stopped. Fix the problem above, then start it again', 'error'); }
    else if (e.status === 429) next = e.retryAfter ? e.retryAfter * 1000 + 500 : 60_000;
    else next = Math.max(next, 30_000);
  }
  return { next, idle, fatal, worked };
}

async function tick() {
  if (busy) return schedule(1000);
  busy = true;
  let next;
  try { next = (await step()).next; } finally { busy = false; }
  await save();
  schedule(next);
}

/* ---------- run-once mode (GitHub Actions): a short batch, then exit ---------- */
async function runOnce() {
  const s = db.settings;
  s.running = true; // the schedule itself is the on/off switch: disable the workflow to pause the bot
  s.boardId ||= BOARD_ID;
  const deadline = Date.now() + BATCH_SECONDS * 1000;
  let worked = 0, failed = false;
  log(`Batch started (up to ${BATCH_MAX_POSTS} pins, ${BATCH_SECONDS}s budget)`);
  while (worked < BATCH_MAX_POSTS) {
    const r = await step();
    if (r.worked) worked++;
    if (r.fatal) failed = true;
    if (r.idle || worked >= BATCH_MAX_POSTS || Date.now() + r.next > deadline) break;
    await new Promise(res => setTimeout(res, r.next));
  }
  await save();
  console.log(`Batch finished: ${worked} pin(s) handled${failed ? ', stopped by a fatal error' : ''}`);
  process.exit(failed ? 1 : 0); // a failing exit code makes GitHub email you
}

if (RUN_ONCE) await runOnce();

/* ---------- admin API (password protected) ---------- */
const { default: express } = await import('express'); // only needed for the admin page, not for run-once mode
const app = express();
app.use(express.json({ limit: '1mb' }));
app.set('trust proxy', 1);
app.get('/healthz', (_, res) => res.json({ ok: true, running: db.settings.running }));
const attempts = new Map(); // ip -> { n, until }: 10 wrong passwords locks that address for 15 minutes
app.use((req, res, next) => {
  const f = attempts.get(req.ip) || { n: 0, until: 0 };
  if (f.until > Date.now()) return res.status(429).send('Too many attempts, try again in 15 minutes');
  if (f.until) { f.n = 0; f.until = 0; }
  const [, b64 = ''] = (req.headers.authorization || '').split(' ');
  const pass = Buffer.from(Buffer.from(b64, 'base64').toString().split(':').slice(1).join(':'));
  const want = Buffer.from(ADMIN_PASSWORD);
  if (pass.length === want.length && crypto.timingSafeEqual(pass, want)) { attempts.delete(req.ip); return next(); }
  if (req.headers.authorization) { f.n++; if (f.n >= 10) f.until = Date.now() + 15 * 60_000; attempts.set(req.ip, f); }
  res.set('WWW-Authenticate', 'Basic realm="Pin bot"').status(401).send('Sign in required');
});
app.use(express.static('public'));
app.get('/', (_, res) => res.redirect('/admin.html'));

app.get('/api/state', (_, res) => {
  const q = db.queue;
  res.json({
    settings: db.settings, learned: db.learned, account: db.account, sandbox: PINTEREST_API_BASE.includes('sandbox'),
    stats: { pending: q.filter(i => i.status === 'pending').length, posted: db.posted.length, failed: q.filter(i => i.status === 'failed').length, today: postedToday() },
    queue: q.slice(-300).reverse(), posted: db.posted.slice(0, 30), log: db.log.slice(0, 80),
  });
});

app.post('/api/settings', async (req, res) => {
  const b = req.body, s = db.settings;
  const num = (v, min, d) => (v !== '' && Number.isFinite(Number(v)) ? Math.max(min, Number(v)) : d);
  if (b.intervalSeconds != null) s.intervalSeconds = num(b.intervalSeconds, MIN_INTERVAL, 10);
  if (b.dailyCap != null) s.dailyCap = num(b.dailyCap, 0, 0);
  if (b.likesAbove != null) s.likesAbove = num(b.likesAbove, 0, 10);
  if (b.recycleDays != null) s.recycleDays = num(b.recycleDays, 1, 30);
  if (typeof b.autoLearn === 'boolean') s.autoLearn = b.autoLearn;
  if (typeof b.dryRun === 'boolean') { if (s.dryRun && !b.dryRun) db.queue.forEach(i => delete i.checked); s.dryRun = b.dryRun; }
  if (Array.isArray(b.niche)) s.niche = b.niche.map(x => String(x).trim()).filter(Boolean).slice(0, 30);
  if (typeof b.boardId === 'string') s.boardId = b.boardId.trim();
  if (typeof b.siteUrl === 'string') {
    try { new URL(b.siteUrl); s.siteUrl = b.siteUrl.trim(); } catch { return res.status(400).json({ error: 'Website URL is not valid' }); }
  }
  await save();
  if (s.running) schedule(s.intervalSeconds * 1000);
  res.json({ ok: true });
});

app.post('/api/bot', async (req, res) => {
  const s = db.settings;
  if (req.body.running) {
    if (!s.dryRun && (!s.siteUrl || !s.boardId)) return res.status(400).json({ error: 'Set a website URL and a board first' });
    try { const a = await api('/user_account'); db.account = { username: a.username, type: a.account_type }; }
    catch (e) {
      if (e.status === 401 || e.status === 403) return res.status(400).json({ error: `Pinterest rejected the access token (${e.message}). Create a new token and update .env` });
      log(`Could not read account details: ${e.message}`, 'error');
    }
  }
  s.running = !!req.body.running;
  log(s.running ? 'Bot started' : 'Bot stopped');
  await save();
  if (s.running) schedule(500); else clearTimeout(timer);
  res.json({ ok: true });
});

app.post('/api/learn', async (_, res) => {
  if (busy) return res.status(409).json({ error: 'The bot is working, try again in a moment' });
  busy = true;
  try { const r = await learnNiche(); log(`Learned your niche from ${r.pinsScanned} pins (${r.queued} added to the queue)`); res.json(r); }
  catch (e) { log(`Could not learn niche: ${e.message}`, 'error'); await save(); res.status(e.status || 500).json({ error: e.message }); }
  finally { busy = false; }
});

app.post('/api/queue', async (req, res) => {
  const seen = new Set(db.queue.map(i => i.hash));
  let added = 0;
  for (const x of [].concat(req.body)) {
    if (!x?.imageUrl?.startsWith('https://') && !x?.imageUrl?.startsWith('http://127.0.0.1')) continue;
    if (!x.title) continue;
    const h = hashUrl(x.imageUrl);
    if (seen.has(h)) continue;
    seen.add(h);
    db.queue.push({
      id: h, hash: h, status: 'pending', source: 'manual', imageUrl: x.imageUrl, title: String(x.title),
      description: x.description || '', alt: x.alt || '', path: x.path || '', tags: x.tags || [],
      likes: x.likes == null ? undefined : Number(x.likes), boardId: x.boardId || '',
    });
    added++;
  }
  await save();
  res.json({ added });
});

app.delete('/api/queue/:id', async (req, res) => {
  db.queue = db.queue.filter(i => i.id !== req.params.id);
  await save();
  res.json({ ok: true });
});

app.get('/api/boards', async (_, res) => {
  try { res.json((await listAll('/boards', 3)).map(b => ({ id: b.id, name: b.name }))); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

app.post('/api/post-now', async (_, res) => {
  if (busy) return res.status(409).json({ error: 'The bot is posting right now, try again in a moment' });
  const item = pick();
  if (!item) return res.status(404).json({ error: 'No eligible pin in the queue' });
  busy = true;
  try { await post(item); await save(); res.json({ ok: true, status: item.status }); }
  catch (e) { log(e.message, 'error'); await save(); res.status(500).json({ error: e.message }); }
  finally { busy = false; }
});

const stop = async () => { await save(); process.exit(0); };
process.on('SIGINT', stop); process.on('SIGTERM', stop);

app.listen(PORT, HOST, () => {
  console.log(`Admin page: http://${HOST}:${PORT}`);
  if (db.settings.running) schedule(1000);
});
