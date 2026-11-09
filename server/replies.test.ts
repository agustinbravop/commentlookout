import { expect, test } from 'bun:test';
import { createCipheriv, randomBytes } from 'node:crypto';

Bun.env.DATABASE_PATH = ':memory:';
Bun.env.ZERNIO_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
const { db, createSession } = await import('./db');
const { replies } = await import('./replies');
const { zernio } = await import('./zernio');

function setup(sub: string, id: string) {
  const session = createSession(sub, `${sub}@example.com`, sub);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv);
  const encrypted = Buffer.concat([iv, cipher.update('test-token'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  db.prepare('INSERT INTO zernio_connections VALUES (?, ?, ?, ?, ?)').run(session.user.id, sub, encrypted, encrypted, Math.floor(Date.now() / 1000) + 3600);
  db.prepare('INSERT INTO monitored_accounts VALUES (?, ?, ?, ?)').run(session.user.id, id, 'instagram', new Date().toISOString());
  db.prepare('INSERT INTO monitored_posts VALUES (?, ?, ?, ?, 0)').run(session.user.id, id, 'post', 'Caption');
  for (const commentId of ['fresh', 'answered', 'uncertain']) db.prepare('INSERT INTO synced_comments VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0)')
    .run(session.user.id, id, 'post', commentId, 'Hello?', 'Visitor', new Date().toISOString());
  return session;
}

test('manual send confirms only once, isolates workspaces, and blocks existing owner replies', async () => {
  const account = '777777777777777777777777';
  const alice = setup('reply-alice', account);
  const bob = createSession('reply-bob', 'reply-bob@example.com', 'Bob');
  const originalFetch = globalThis.fetch;
  let posts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'reply-alice', users: [{ _id: 'reply-alice', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: account, platform: 'instagram' }] });
    if (init?.method === 'POST') {
      posts++;
      expect(init.headers).toMatchObject({ 'Idempotency-Key': expect.any(String) });
      expect(JSON.parse(String(init.body))).toEqual({ accountId: account, commentId: 'fresh', message: 'Thanks!' });
      return Response.json({ success: true, data: { commentId: 'sent-id' } });
    }
    if (url.searchParams.get('commentId') === 'answered') return Response.json({ comment: { id: 'answered' }, comments: [{ id: 'owner-reply', from: { isOwner: true } }], pagination: { hasMore: false } });
    return Response.json({ comment: { id: url.searchParams.get('commentId') }, comments: [], pagination: { hasMore: false } });
  }) as typeof fetch;
  const path = `/api/comments/${account}/fresh/reply`;
  const request = (cookie: string, route = path) => replies.request(route, { method: 'POST', headers: { Cookie: `cl_session=${cookie}`, Origin: 'http://localhost', 'Content-Type': 'application/json' }, body: JSON.stringify({ message: 'Thanks!' }) });
  try {
    expect((await request(bob.token)).status).toBe(404);
    expect((await request(alice.token, `/api/comments/${account}/answered/reply`)).status).toBe(409);
    expect((await request(alice.token, `/api/comments/${account}/answered/reply`)).status).toBe(409);
    expect((await request(alice.token)).status).toBe(200);
    expect((await request(alice.token)).status).toBe(409);
    expect(posts).toBe(1);
    expect(db.prepare('SELECT status, reply_id FROM comment_replies WHERE user_id = ? AND comment_id = ?').get(alice.user.id, 'fresh')).toEqual({ status: 'sent', reply_id: 'sent-id' });
    const list = await (await zernio.request('/api/comments?view=replies', { headers: { Cookie: `cl_session=${alice.token}` } })).json() as { comments: { id: string }[] };
    expect(list.comments.map((comment) => comment.id)).toEqual([]);
  } finally { globalThis.fetch = originalFetch; }
});

test('ambiguous provider failure remains blocked and never auto-retries', async () => {
  const account = '888888888888888888888888';
  const alice = setup('reply-unknown', account);
  const originalFetch = globalThis.fetch;
  const originalError = console.error;
  console.error = () => {};
  let posts = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'reply-unknown', users: [{ _id: 'reply-unknown', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: account, platform: 'instagram' }] });
    if (init?.method === 'POST') { posts++; return Response.json({}, { status: 503 }); }
    return Response.json({ comment: { id: 'uncertain' }, comments: [], pagination: { hasMore: false } });
  }) as typeof fetch;
  const request = () => replies.request(`/api/comments/${account}/uncertain/reply`, { method: 'POST', headers: { Cookie: `cl_session=${alice.token}`, Origin: 'http://localhost' }, body: JSON.stringify({ message: 'Thanks!' }) });
  try {
    expect((await request()).status).toBe(502);
    expect((await request()).status).toBe(409);
    expect(posts).toBe(1);
    expect(db.prepare('SELECT status FROM comment_replies WHERE user_id = ? AND comment_id = ?').get(alice.user.id, 'uncertain')).toEqual({ status: 'unknown' });
  } finally { globalThis.fetch = originalFetch; console.error = originalError; }
});
