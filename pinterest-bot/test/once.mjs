// Test for run-once mode (no express needed): node test/once.mjs
import http from 'node:http';
import { spawn } from 'node:child_process';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';

const PORT = 4020, created = []; let validToken = 'fresh-token';
const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://x'); let body = '';
  req.on('data', d => (body += d));
  req.on('end', () => {
    const json = (s, o) => { res.writeHead(s, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    if (url.pathname === '/img/bad') { res.writeHead(200, { 'content-type': 'text/html' }); return res.end('x'); }
    if (url.pathname.startsWith('/img/')) { res.writeHead(200, { 'content-type': 'image/jpeg' }); return res.end('x'); }
    if (url.pathname === '/v5/oauth/token') {
      const ok = req.headers.authorization === 'Basic ' + Buffer.from('app:secret').toString('base64') && body.includes('refresh_token=r1');
      if (!ok) return json(401, { message: 'bad refresh' });
      validToken = 'fresh-token'; return json(200, { access_token: 'fresh-token', refresh_token: 'r1' });
    }
    if (req.headers.authorization !== 'Bearer ' + validToken) return json(401, { message: 'Authentication failed' });
    if (url.pathname === '/v5/boards') return json(200, { items: [{ id: 'b1', name: 'Ink' }] });
    if (url.pathname === '/v5/pins' && req.method === 'GET') return json(200, { items: [] });
    if (url.pathname === '/v5/pins' && req.method === 'POST') { created.push(JSON.parse(body)); return json(201, { id: 'n' + created.length }); }
    json(404, {});
  });
});
await new Promise(r => server.listen(PORT, '127.0.0.1', r));

const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'once-'));
const item = n => ({ id: 'i' + n, hash: 'h' + n, status: 'pending', source: 'manual', imageUrl: `http://127.0.0.1:${PORT}/img/${n}.jpg`,
  title: `Ink journaling idea ${n}`, description: 'ink journal', alt: '', path: '', tags: [], likes: 50 });
fs.writeFileSync(path.join(DATA, 'db.json'), JSON.stringify({
  settings: { siteUrl: 'https://example.com', boardId: 'b1', niche: ['ink'], intervalSeconds: 1, likesAbove: 10, autoLearn: false },
  queue: [1, 2, 3, 4, 5, 6, 7].map(item).concat([{ ...item(99), imageUrl: `http://127.0.0.1:${PORT}/img/bad` }]),
  posted: [], log: [],
}));

const run = extra => new Promise(resolve => {
  const p = spawn(process.execPath, ['server.js'], { env: { ...process.env, RUN_ONCE: '1', PINTEREST_ACCESS_TOKEN: 'expired', PINTEREST_REFRESH_TOKEN: 'r1', PINTEREST_APP_ID: 'app', PINTEREST_APP_SECRET: 'secret',
    PINTEREST_API_BASE: `http://127.0.0.1:${PORT}/v5`, ADMIN_PASSWORD: 'secret-password-123', DATA_DIR: DATA, MIN_INTERVAL_SECONDS: '1', BATCH_MAX_POSTS: '3', ...extra } });
  let stdout = '', stderr = '';
  p.stdout.on('data', d => (stdout += d)); p.stderr.on('data', d => (stderr += d));
  p.on('exit', status => resolve({ status, stdout, stderr }));
});
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS  ' : 'FAIL  ') + m); if (!c) fails++; };

let r = await run();
ok(r.status === 0, 'run 1 exits cleanly');
ok(created.length === 3, `run 1 posts exactly BATCH_MAX_POSTS pins (got ${created.length})`);
ok(created.every(b => b.link.includes('utm_source=pinterest') && b.board_id === 'b1'), 'pins link to the site with UTM tags');
let db = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
ok(db.posted.length === 3, 'state saved to db.json');
ok(!('token' in db) && !fs.readFileSync(path.join(DATA, 'db.json'), 'utf8').includes('fresh-token'), 'db.json contains no token');
ok(fs.existsSync(path.join(DATA, 'token.enc')) && !fs.readFileSync(path.join(DATA, 'token.enc'), 'utf8').includes('fresh'), 'refreshed token stored encrypted');

validToken = 'something-else'; // force another refresh to prove the stored token is reused/renewed
r = await run();
ok(r.status === 0 && created.length === 6, `run 2 continues from saved state (total ${created.length})`);
r = await run();
db = JSON.parse(fs.readFileSync(path.join(DATA, 'db.json'), 'utf8'));
ok(r.status === 0 && created.length === 7, 'run 3 posts the last good pin');
ok(db.queue.find(i => i.id === 'i99').status === 'failed', 'broken image is marked failed, not retried');
r = await run();
ok(r.status === 0 && created.length === 7, 'empty queue: exits cleanly, posts nothing');

fs.writeFileSync(path.join(DATA, 'db.json'), JSON.stringify({ ...db, queue: [item(50)] }));
r = await run({ PINTEREST_REFRESH_TOKEN: '', PINTEREST_ACCESS_TOKEN: 'bad', BATCH_MAX_POSTS: '1' });
ok(r.status === 1, 'bad token with no refresh token exits with code 1 (so GitHub emails you)');

server.close();
console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
if (fails) console.log(r.stdout, r.stderr);
process.exit(fails ? 1 : 0);
