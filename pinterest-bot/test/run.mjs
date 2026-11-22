// End-to-end test against the mock API: node test/run.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { startMock } from './mock-pinterest.js';

const MOCK = 4010, APP = 4011, PW = 'pw-test';
const mock = startMock(MOCK);
const out = [], DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'pinbot-'));
let srv;
const start = () => {
  srv = spawn(process.execPath, ['server.js'], {
    env: { ...process.env, PINTEREST_ACCESS_TOKEN: 'test-token', PINTEREST_REFRESH_TOKEN: 'r1', PINTEREST_APP_ID: 'app', PINTEREST_APP_SECRET: 'secret',
      PINTEREST_API_BASE: `http://127.0.0.1:${MOCK}/v5`, ADMIN_PASSWORD: PW, PORT: APP, DATA_DIR: DATA, MIN_INTERVAL_SECONDS: '1', SITE_URL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  srv.stdout.on('data', d => out.push(String(d))); srv.stderr.on('data', d => out.push(String(d)));
};
const stopSrv = () => new Promise(r => { srv.once('exit', r); srv.kill(); });
start();

const headers = { Authorization: 'Basic ' + Buffer.from('x:' + PW).toString('base64'), 'Content-Type': 'application/json' };
const call = async (p, method = 'GET', body) => {
  const r = await fetch(`http://127.0.0.1:${APP}${p}`, { method, headers, body: body && JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const created = async () => (await fetch(`http://127.0.0.1:${MOCK}/__created`)).json();
const until = async (fn, ms = 15000) => { const t = Date.now(); while (Date.now() - t < ms) { if (await fn()) return true; await sleep(250); } return false; };
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fails++; };
const img = n => `http://127.0.0.1:${MOCK}/img/${n}.jpg`;

try {
  ok(await until(async () => (await fetch(`http://127.0.0.1:${APP}/api/state`).catch(() => ({ status: 0 }))).status === 401, 5000), 'admin API rejects requests without the password');
  ok((await fetch(`http://127.0.0.1:${APP}/admin.html`, { headers })).status === 200, 'admin page is served');

  await call('/api/settings', 'POST', { siteUrl: 'https://example.com', boardId: 'b1', intervalSeconds: 1, likesAbove: 10, niche: ['journaling'] });
  const learn = await call('/api/learn', 'POST');
  ok(learn.status === 200 && learn.json.pinsScanned === 30, 'read all 30 pins from the account across pages');
  ok(learn.json.keywords.some(k => k.w === 'ink'), 'learned "ink" as part of the niche');
  ok(learn.json.queued === 4, 'queued the 4 own site-linked pins that have more than 10 reactions');

  const add = await call('/api/queue', 'POST', [
    { imageUrl: img(100), title: 'Journaling prompts for ink lovers', description: 'pen ink journal', likes: 50 },
    { imageUrl: img(101), title: 'Low engagement ink post', description: 'ink', likes: 5 },
    { imageUrl: img(102), title: 'Chocolate cake recipe', description: 'baking', likes: 99 },
    { imageUrl: `http://127.0.0.1:${MOCK}/img/bad`, title: 'Broken image ink post', description: 'ink', likes: 30 },
    { imageUrl: img(100), title: 'Duplicate of the first one ink', likes: 60 },
  ]);
  ok(add.json.added === 4, 'duplicate images are skipped when adding');

  ok((await call('/api/bot', 'POST', { running: true })).status === 200, 'bot starts after checking the token');
  ok(await until(async () => (await created()).length >= 5), 'bot posts on its own');
  await sleep(3500);
  let c = await created();
  ok(c.length === 5, `posted exactly the 5 eligible pins (got ${c.length})`);
  ok(c.every(b => b.link.startsWith('https://example.com') && b.link.includes('utm_source=pinterest')), 'every pin links to the website with UTM tags');
  ok(!c.some(b => /Chocolate|Low engagement/.test(b.title)), 'skipped off-niche pins and pins with 10 or fewer likes');
  ok(c.every(b => /#\w+/.test(b.description)), 'descriptions get niche hashtags');
  let st = (await call('/api/state')).json;
  ok(st.queue.find(i => i.title.startsWith('Broken image'))?.status === 'failed', 'unreachable image is marked failed instead of retried');
  ok(st.account?.username === 'tester', 'account is verified');

  await call('/api/queue', 'POST', { imageUrl: img(103), title: 'Ink journaling layout ideas', description: 'journal ink', likes: 40 });
  await fetch(`http://127.0.0.1:${MOCK}/__fail`, { method: 'POST', headers, body: JSON.stringify({ status: 429, retryAfter: 1 }) });
  ok(await until(async () => (await created()).length >= 6, 10000), 'recovers after a 429 rate limit');
  ok((await call('/api/state')).json.log.some(l => l.msg.includes('429')), 'rate limit was logged');

  await call('/api/settings', 'POST', { dryRun: true });
  await call('/api/queue', 'POST', { imageUrl: img(104), title: 'Fountain pen journaling setup', description: 'ink journal', likes: 40 });
  await sleep(3500);
  ok((await created()).length === 6, 'dry run posts nothing');
  ok((await call('/api/state')).json.log.some(l => l.msg.startsWith('Dry run OK')), 'dry run reports what it would post');
  await call('/api/settings', 'POST', { dryRun: false });
  ok(await until(async () => (await created()).length >= 7, 8000), 'turning dry run off posts the pin');

  await call('/api/settings', 'POST', { dailyCap: 7 });
  await call('/api/queue', 'POST', { imageUrl: img(105), title: 'Ink and journal flatlay', description: 'ink journal', likes: 40 });
  await sleep(3500);
  ok((await created()).length === 7, 'daily cap stops posting');
  await call('/api/settings', 'POST', { dailyCap: 0 });
  ok(await until(async () => (await created()).length >= 8, 20000), 'cap of 0 means no limit (posts resume after the cap check delay)');

  // 24/7 behaviour: token expiry, restarts, health check, brute-force lockout
  ok((await fetch(`http://127.0.0.1:${APP}/healthz`)).status === 200, 'health check works without a password');
  await fetch(`http://127.0.0.1:${MOCK}/__expire`, { method: 'POST' });
  await call('/api/queue', 'POST', { imageUrl: img(106), title: 'Ink journaling after token expiry', description: 'ink journal', likes: 40 });
  ok(await until(async () => (await created()).length >= 9, 12000), 'keeps posting after the access token expires (auto refresh)');
  ok((await call('/api/state')).json.log.some(l => l.msg === 'Access token refreshed'), 'token refresh was logged');

  await call('/api/queue', 'POST', { imageUrl: img(107), title: 'Ink journaling after restart', description: 'ink journal', likes: 40 });
  await stopSrv(); start();
  ok(await until(async () => (await created()).length >= 10, 15000), 'resumes by itself after a restart, using the refreshed token');
  ok((await call('/api/state')).json.settings.running === true, 'running state survives restarts');

  let last;
  for (let i = 0; i < 11; i++) last = (await fetch(`http://127.0.0.1:${APP}/api/state`, { headers: { Authorization: 'Basic ' + Buffer.from('x:wrong').toString('base64') } })).status;
  ok(last === 429, 'locks out an address after 10 wrong passwords');
} catch (e) { console.log('FAIL  test crashed:', e.message); fails++; }

if (fails) console.log('\n--- server output ---\n' + out.join(''));
console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
srv.kill(); mock.close();
process.exit(fails ? 1 : 0);
