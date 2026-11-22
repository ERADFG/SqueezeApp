// Tiny fake of the Pinterest v5 API so the bot can be tested without touching a real account.
import express from 'express';

export function startMock(port) {
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  let validToken = 'test-token';
  const created = [], failQueue = [];
  const pins = Array.from({ length: 30 }, (_, i) => ({
    id: 'p' + i, board_id: 'b1',
    title: `${i % 2 ? 'Fountain pen ink swatches' : 'Journaling with ink'} ${i}`,
    description: 'ink pen journal notebook', alt_text: '',
    link: i < 6 ? `https://example.com/post-${i}` : `https://other.com/x${i}`,
    media: { images: { '1200x': { url: `http://127.0.0.1:${port}/img/${i}.jpg`, width: 1200, height: 800 } } },
    pin_metrics: { lifetime_metrics: { reaction: i < 4 ? 20 + i : 2, save: i, pin_click: 1, impression: 10 } },
  }));

  app.post('/v5/oauth/token', (req, res) => {
    const good = req.headers.authorization === 'Basic ' + Buffer.from('app:secret').toString('base64')
      && req.body.grant_type === 'refresh_token' && req.body.refresh_token === 'r1';
    if (!good) return res.status(401).json({ message: 'bad refresh request' });
    validToken = 'test-token-2';
    res.json({ access_token: 'test-token-2', refresh_token: 'r1', expires_in: 2592000 });
  });
  app.use('/v5', (req, res, next) =>
    req.headers.authorization === 'Bearer ' + validToken ? next() : res.status(401).json({ message: 'Authentication failed' }));
  app.get('/v5/user_account', (_, res) => res.json({ username: 'tester', account_type: 'BUSINESS' }));
  app.get('/v5/boards', (_, res) => res.json({ items: [{ id: 'b1', name: 'Ink journaling' }], bookmark: null }));
  app.get('/v5/pins', (req, res) => {
    const size = +req.query.page_size || 25, start = +(req.query.bookmark || 0);
    res.json({ items: pins.slice(start, start + size), bookmark: start + size < pins.length ? String(start + size) : null });
  });
  app.post('/v5/pins', (req, res) => {
    const f = failQueue.shift();
    if (f) { if (f.retryAfter) res.set('retry-after', String(f.retryAfter)); return res.status(f.status).json({ message: 'mock failure' }); }
    const b = req.body;
    if (!b.board_id || !b.link || !b.title || b.media_source?.source_type !== 'image_url' || !b.media_source.url)
      return res.status(400).json({ message: 'invalid body' });
    created.push(b);
    res.status(201).json({ id: 'new' + created.length });
  });

  app.get('/img/bad', (_, res) => res.type('html').send('<p>not an image</p>'));
  app.get('/img/:n', (_, res) => res.type('image/jpeg').send(Buffer.from('x')));
  app.post('/__expire', (_, res) => { validToken = 'rotated'; res.json({ ok: true }); });
  app.get('/__created', (_, res) => res.json(created));
  app.post('/__fail', (req, res) => { failQueue.push(...[].concat(req.body)); res.json({ ok: true }); });
  return app.listen(port, '127.0.0.1');
}
