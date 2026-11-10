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
  db.prepare('INSERT INTO monitored_posts (user_id, account_id, post_id, content, pending) VALUES (?, ?, ?, ?, 0)').run(session.user.id, id, 'post', 'Caption');
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

test('reply recovery requires an explicit owner decision and never sends', async () => {
  const account = 'abababababababababababab';
  const alice = setup('reply-recovery', account);
  const bob = createSession('recovery-outsider', 'recovery@example.com', 'Outsider');
  const insert = db.prepare(`INSERT INTO comment_replies (user_id, account_id, comment_id, message, idempotency_key, status, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)`);
  insert.run(alice.user.id, account, 'fresh', 'Attempted reply', 'attempt-one', 'pending', null);
  insert.run(alice.user.id, account, 'answered', 'Other reply', 'attempt-two', 'unknown', null);
  insert.run(alice.user.id, account, 'uncertain', 'In flight', 'attempt-three', 'pending', Math.floor(Date.now() / 1000));
  const path = (id: string) => `/api/comments/${account}/${id}/reply/resolve`;
  const request = (id: string, token: string, resolution: string, attempt: string, origin = 'http://localhost') => replies.request(path(id), {
    method: 'POST', headers: { Cookie: `cl_session=${token}`, Origin: origin }, body: JSON.stringify({ resolution, attempt }),
  });
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL) => { calls++; return Response.json({}, { status: 500 }); }) as typeof fetch;
  try {
    const inbox = await (await zernio.request('/api/comments?view=all', { headers: { Cookie: `cl_session=${alice.token}` } })).json() as { comments: { id: string; replyMessage: string; replyAttempt: string }[] };
    expect(inbox.comments.find((item) => item.id === 'fresh')).toMatchObject({ replyMessage: 'Attempted reply', replyAttempt: 'attempt-one' });
    expect((await request('fresh', bob.token, 'found', 'attempt-one')).status).toBe(409);
    expect((await request('fresh', alice.token, 'found', 'attempt-one', 'https://bad.example')).status).toBe(403);
    expect((await replies.request(path('fresh'), { method: 'POST' })).status).toBe(401);
    expect((await request('uncertain', alice.token, 'not_sent', 'attempt-three')).status).toBe(409);
    expect((await request('fresh', alice.token, 'found', 'attempt-one')).status).toBe(200);
    expect((await request('fresh', alice.token, 'not_sent', 'attempt-one')).status).toBe(409);
    expect((await request('answered', alice.token, 'not_sent', 'attempt-two')).status).toBe(200);
    expect(db.prepare('SELECT status, reply_id, message FROM comment_replies WHERE user_id = ? AND comment_id = ?').get(alice.user.id, 'fresh')).toEqual({ status: 'sent', reply_id: null, message: 'Attempted reply' });
    expect(db.prepare('SELECT 1 FROM comment_replies WHERE user_id = ? AND comment_id = ?').get(alice.user.id, 'answered')).toBeNull();
    expect(calls).toBe(0);
  } finally { globalThis.fetch = original; }
});
