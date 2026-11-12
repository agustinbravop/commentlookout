import { expect, spyOn, test } from 'bun:test';
import { createCipheriv, randomBytes } from 'node:crypto';

Bun.env.DATABASE_PATH = ':memory:';
Bun.env.ZERNIO_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
const { db, createSession } = await import('./db');
const { zernio } = await import('./zernio');
const { syncComments } = await import('./sync');
const { moderateComments, moderation } = await import('./moderate');

function connect(sub: string, owner: string) {
  const session = createSession(sub, `${sub}@example.com`, sub);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv);
  const encrypted = Buffer.concat([iv, cipher.update('test-token'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  db.prepare('INSERT INTO zernio_connections VALUES (?, ?, ?, ?, ?)')
    .run(session.user.id, owner, encrypted, encrypted, Math.floor(Date.now() / 1000) + 3600);
  return session;
}

test('sync persists future posts before thread reads, retries failures, and isolates inboxes', async () => {
  const alice = connect('sync-alice', 'sync-alice-owner');
  const bob = createSession('sync-bob', 'bob@example.com', 'Bob');
  const accountId = '111111111111111111111111';
  const future = new Date(Date.now() + 60_000).toISOString();
  let failThread = true;
  let feedPages = 0;
  let threadPages = 0;
  const originalFetch = globalThis.fetch;
  const log = spyOn(console, 'error').mockImplementation(() => {});
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'sync-alice-owner', users: [{ _id: 'sync-alice-owner', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: accountId, platform: 'instagram' }] });
    if (url.pathname.endsWith(`/accounts/${accountId}/posts`)) return Response.json({ status: 'success', posts: [] });
    if (url.pathname.endsWith('/inbox/comments')) {
      feedPages++;
      if (!url.searchParams.has('cursor')) return Response.json({ data: [{ id: 'old-post', accountId, platform: 'instagram', createdTime: '2020-01-01T00:00:00Z', commentCount: 2 }], pagination: { hasMore: true, nextCursor: 'next-posts' } });
      expect(url.searchParams.get('cursor')).toBe('next-posts');
      return Response.json({ data: [{ id: 'new-post', accountId, platform: 'instagram', content: 'Caption', picture: failThread ? 'https://images.example.com/post.jpg' : 'http://127.0.0.1/private', createdTime: future, commentCount: 2 }], pagination: { hasMore: false } });
    }
    if (url.pathname.endsWith('/inbox/comments/new-post')) {
      if (failThread) return Response.json({ code: 'platform_api_error' }, { status: 503 });
      threadPages++;
      if (!url.searchParams.has('cursor')) return Response.json({ comments: [{ id: 'comment-a', message: 'First', createdTime: future, from: { name: 'Visitor' } }], pagination: { hasMore: true, cursor: 'next-comments' } });
      return Response.json({ comments: [{ id: 'comment-b', message: 'Second', createdTime: future, from: { name: 'Owner', isOwner: true } }, { id: 'comment-c', message: 'Third', createdTime: future }], pagination: { hasMore: false } });
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  try {
    await syncComments();
    expect(db.prepare('SELECT post_id, pending FROM monitored_posts').all()).toEqual([{ post_id: 'new-post', pending: 1 }]);
    expect(db.prepare('SELECT count(*) AS count FROM synced_comments').get()).toEqual({ count: 0 });
    failThread = false;
    await syncComments();
    expect(feedPages).toBe(4);
    expect(threadPages).toBe(2);
    expect(db.prepare('SELECT pending FROM monitored_posts').get()).toEqual({ pending: 0 });
    const headers = { Cookie: `cl_session=${alice.token}` };
    const response = await zernio.request('/api/comments', { headers });
    expect(response.status).toBe(200);
    const inbox = await response.json() as { comments: { id: string; postContent: string; postPicture: string; postCreatedAt: string; category: string | null }[] };
    expect(inbox.comments.map((comment) => comment.id)).toEqual(['comment-c', 'comment-a']);
    expect(inbox.comments[0].postContent).toBe('Caption');
    expect(inbox.comments[0].postPicture).toBe('https://images.example.com/post.jpg');
    expect(inbox.comments[0].postCreatedAt).toBe(future);
    expect(inbox.comments.every((comment) => comment.category === null)).toBe(true);
    const bobResponse = await zernio.request('/api/comments', { headers: { Cookie: `cl_session=${bob.token}` } });
    expect((await bobResponse.json() as { comments: unknown[] }).comments).toEqual([]);
    expect((await zernio.request('/api/comments?before=invalid', { headers })).status).toBe(400);
    expect((await zernio.request('/api/comments')).status).toBe(401);
  } finally { globalThis.fetch = originalFetch; log.mockRestore(); }
});

test('recovery polling rereads completed older threads without webhooks and keeps failed reads pending', async () => {
  const alice = connect('recovery-alice', 'recovery-owner');
  const bob = createSession('recovery-bob', 'recovery-bob@example.com', 'Bob');
  const account = '121212121212121212121212';
  const old = new Date(Date.now() - 86400_000).toISOString();
  const now = new Date().toISOString();
  for (const user of [alice.user, bob.user]) {
    db.prepare('INSERT INTO monitored_accounts VALUES (?, ?, ?, ?)').run(user.id, account, 'instagram', now);
    db.prepare('INSERT INTO backfill_accounts VALUES (?, ?, 1)').run(user.id, account);
    db.prepare('INSERT INTO monitored_posts (user_id,account_id,post_id,pending,picture,created_at) VALUES (?, ?, ?, 0, ?, ?)')
      .run(user.id, account, 'older-post', 'https://images.example.com/post.jpg', old);
    db.prepare('INSERT INTO backfill_posts VALUES (?, ?, ?, 0, ?, ?)').run(user.id, account, 'older-post', old, old);
  }
  let fail = true;
  let reads = 0;
  const original = globalThis.fetch;
  const log = spyOn(console, 'error').mockImplementation(() => {});
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'recovery-owner', users: [{ _id: 'recovery-owner', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: account, platform: 'instagram' }] });
    if (url.pathname.endsWith('/inbox/comments')) return Response.json({ data: [], pagination: { hasMore: false } });
    if (url.pathname.endsWith('/inbox/comments/older-post')) {
      reads++;
      if (fail) return Response.json({}, { status: 503 });
      return Response.json({ comments: [
        { id: 'new-visitor', message: 'New question', createdTime: now },
        { id: 'owner', message: 'Owner comment', createdTime: now, from: { isOwner: true } },
      ], pagination: { hasMore: false } });
    }
    throw new Error('Unexpected request');
  }) as typeof fetch;
  try {
    await syncComments();
    expect(db.prepare('SELECT pending FROM monitored_posts WHERE user_id = ?').get(alice.user.id)).toEqual({ pending: 1 });
    fail = false;
    await syncComments();
    await syncComments();
    expect(reads).toBe(3);
    expect(db.prepare('SELECT pending FROM monitored_posts WHERE user_id = ?').get(alice.user.id)).toEqual({ pending: 0 });
    expect(db.prepare('SELECT comment_id FROM synced_comments WHERE user_id = ?').all(alice.user.id)).toEqual([{ comment_id: 'new-visitor' }]);
    expect(db.prepare('SELECT * FROM backfill_comments WHERE user_id = ?').all(alice.user.id)).toEqual([]);
    expect(db.prepare('SELECT pending FROM monitored_posts WHERE user_id = ?').get(bob.user.id)).toEqual({ pending: 0 });
    expect(db.prepare('SELECT * FROM synced_comments WHERE user_id = ?').all(bob.user.id)).toEqual([]);
    expect(db.prepare('SELECT completed_at FROM backfill_posts WHERE user_id = ?').get(alice.user.id)).toEqual({ completed_at: old });
  } finally { globalThis.fetch = original; log.mockRestore(); }
});

test('saved inbox pages newest-first without duplicates', async () => {
  const { token, user } = createSession('paged-inbox', 'paged-inbox@example.com', 'Paged');
  const account = '222222222222222222222222';
  db.prepare('INSERT INTO monitored_accounts VALUES (?, ?, ?, ?)').run(user.id, account, 'instagram', new Date().toISOString());
  db.prepare('INSERT INTO monitored_posts (user_id, account_id, post_id, content, pending) VALUES (?, ?, ?, ?, 0)').run(user.id, account, 'post', 'Caption');
  const insert = db.prepare('INSERT INTO synced_comments VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0)');
  for (let i = 0; i < 52; i++) insert.run(user.id, account, 'post', `comment-${i}`, `Message ${i}`, 'Visitor', new Date(Date.now() - i * 1000).toISOString());
  db.prepare('UPDATE synced_comments SET is_hidden = 1 WHERE user_id = ? AND comment_id = ?').run(user.id, 'comment-51');
  db.prepare('INSERT INTO backfill_comments VALUES (?, ?, ?)').run(user.id, account, 'comment-50');
  const headers = { Cookie: `cl_session=${token}` };
  const first = await (await zernio.request('/api/comments', { headers })).json() as { comments: { id: string }[]; nextCursor: string };
  expect(first.comments).toHaveLength(50);
  expect(first.nextCursor).toBeTruthy();
  const second = await (await zernio.request(`/api/comments?${new URLSearchParams({ before: first.nextCursor })}`, { headers })).json() as { comments: { id: string }[]; nextCursor: string | null };
  expect(second.comments).toHaveLength(2);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.comments, ...second.comments].map(({ id }) => id)).size).toBe(52);
  expect(second.comments.map(({ id }) => id)).toEqual(['comment-50', 'comment-51']);
  const hidden = await (await zernio.request('/api/comments?view=hidden', { headers })).json() as { comments: { id: string; isHidden: boolean }[] };
  expect(hidden.comments).toEqual([expect.objectContaining({ id: 'comment-51', isHidden: true })]);
  const historical = await (await zernio.request('/api/comments?view=all', { headers })).json() as { comments: { id: string; isBackfill: boolean }[] };
  expect(historical.comments).toHaveLength(50);
  expect((await (await zernio.request(`/api/comments?view=all&before=${encodeURIComponent(first.nextCursor)}`, { headers })).json() as { comments: { id: string; isBackfill: boolean }[] }).comments)
    .toContainEqual(expect.objectContaining({ id: 'comment-50', isBackfill: true }));
  const oldest = await (await zernio.request('/api/comments?sort=oldest', { headers })).json() as { comments: { id: string }[]; nextCursor: string };
  expect(oldest.comments[0].id).toBe('comment-51');
  expect((await (await zernio.request(`/api/comments?sort=oldest&before=${encodeURIComponent(oldest.nextCursor)}`, { headers })).json() as { comments: { id: string }[] }).comments.map((item) => item.id))
    .toEqual(['comment-1', 'comment-0']);
});

test('posts view pages by post date, keeps groups together and isolates workspaces', async () => {
  const alice = createSession('grouped-alice', 'grouped-a@example.com', 'Alice');
  const bob = createSession('grouped-bob', 'grouped-b@example.com', 'Bob');
  const account = 'abababababababababababab';
  for (const user of [alice.user, bob.user]) {
    db.prepare('INSERT INTO monitored_accounts VALUES (?, ?, ?, ?)').run(user.id, account, 'instagram', new Date().toISOString());
    for (const [post, date] of [['old', '2025-01-01T00:00:00.000Z'], ['new', '2026-01-01T00:00:00.000Z'], ['unknown', null]] as const) {
      db.prepare('INSERT INTO monitored_posts (user_id, account_id, post_id, content, pending, created_at) VALUES (?, ?, ?, ?, 0, ?)').run(user.id, account, post, post, date);
    }
  }
  const insert = db.prepare('INSERT INTO synced_comments VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0)');
  for (let i = 0; i < 51; i++) insert.run(alice.user.id, account, 'new', `n-${i}`, `n-${i}`, 'A', new Date(Date.now() - i * 1000).toISOString());
  insert.run(alice.user.id, account, 'old', 'old-1', 'Old', 'A', '2026-06-01T00:00:00.000Z');
  db.prepare('UPDATE synced_comments SET is_hidden = 1 WHERE user_id = ? AND comment_id = ?').run(alice.user.id, 'old-1');
  insert.run(alice.user.id, account, 'unknown', 'unknown-1', 'Unknown', 'A', '2026-11-01T00:00:00.000Z');
  db.prepare('INSERT INTO comment_assessments (user_id, account_id, comment_id, classified_message, category, needs_reply) VALUES (?, ?, ?, ?, ?, 1)')
    .run(alice.user.id, account, 'unknown-1', 'Unknown', 'safe');
  insert.run(bob.user.id, account, 'new', 'bob-1', 'Private', 'B', new Date().toISOString());
  const headers = { Cookie: `cl_session=${alice.token}` };
  const get = async (path: string) => (await (await zernio.request(path, { headers })).json()) as { comments: { id: string; postId: string; postCreatedAt: string | null }[]; nextCursor: string | null };
  const first = await get('/api/comments?view=posts');
  expect(first.comments).toHaveLength(50);
  expect(first.comments.every((item) => item.postId === 'new')).toBe(true);
  const second = await get(`/api/comments?view=posts&before=${encodeURIComponent(first.nextCursor!)}`);
  expect(second.comments.map((item) => item.postId)).toEqual(['new', 'old', 'unknown']);
  expect(second.comments[2]).toEqual(expect.objectContaining({ postCreatedAt: null, needsReply: true }));
  expect((await get('/api/comments?view=replies')).comments.map((item) => item.id)).toEqual(['unknown-1']);
  expect((await get('/api/comments?view=hidden,replies')).comments.map((item) => item.id)).toEqual(['unknown-1', 'old-1']);
  expect((await zernio.request('/api/comments?view=hidden,replies,other', { headers })).status).toBe(400);
  expect(second.nextCursor).toBeNull();
  expect(new Set([...first.comments, ...second.comments].map((item) => item.id)).size).toBe(53);
  const oldest = await get('/api/comments?view=posts&sort=oldest');
  expect(oldest.comments[0].postId).toBe('old');
  expect((await get(`/api/comments?view=posts&sort=oldest&before=${encodeURIComponent(oldest.nextCursor!)}`)).comments.map((item) => item.postId))
    .toEqual(['new', 'new', 'unknown']);
  const bobPage = await (await zernio.request('/api/comments?view=posts', { headers: { Cookie: `cl_session=${bob.token}` } })).json() as { comments: { id: string }[] };
  expect(bobPage.comments.map((item) => item.id)).toEqual(['bob-1']);
  expect((await zernio.request('/api/comments?view=posts,bad', { headers })).status).toBe(400);
  expect((await get('/api/comments?view=posts,hidden')).comments.map((item) => item.id)).toEqual(['old-1']);
  expect((await get('/api/comments?view=posts,replies')).comments.map((item) => item.id)).toEqual(['unknown-1']);
  expect((await zernio.request('/api/comments?view=posts&before=bad', { headers })).status).toBe(400);
});

test('moderation preferences require confirmation and stay scoped to the verified connected account', async () => {
  const alice = connect('settings-alice', 'settings-alice-owner');
  const bob = connect('settings-bob', 'settings-bob-owner');
  const account = 'aaaaaaaaaaaaaaaaaaaaaaaa';
  const other = 'bbbbbbbbbbbbbbbbbbbbbbbb';
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'settings-alice-owner', users: [{ _id: 'settings-alice-owner', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: account, platform: 'instagram' }] });
    throw new Error(`Unexpected request ${init?.method}`);
  }) as typeof fetch;
  const headers = { Cookie: `cl_session=${alice.token}`, Origin: 'http://localhost', 'Content-Type': 'application/json' };
  const put = (id: string, body: unknown, requestHeaders = headers) => zernio.request(`/api/accounts/${id}/moderation`, { method: 'PUT', headers: requestHeaders, body: JSON.stringify(body) });
  try {
    expect(db.prepare('SELECT COUNT(*) AS n FROM moderation_preferences WHERE user_id = ?').get(alice.user.id)).toEqual({ n: 0 });
    expect((await put(account, { enabled: true }, { ...headers, Origin: 'https://bad.example' })).status).toBe(403);
    expect((await put(account, { enabled: 'true' })).status).toBe(400);
    expect((await put(other, { enabled: true })).status).toBe(404);
    expect((await put(account, { enabled: true })).status).toBe(200);
    const connected = await (await zernio.request('/api/zernio', { headers })).json() as { moderation: Record<string, boolean> };
    expect(connected.moderation).toEqual({ [account]: true });
    expect(db.prepare('SELECT enabled FROM moderation_preferences WHERE user_id = ?').get(bob.user.id)).toBeNull();
    expect((await put(account, { enabled: false })).status).toBe(200);
    expect(db.prepare('SELECT enabled FROM moderation_preferences WHERE user_id = ? AND account_id = ?').get(alice.user.id, account)).toEqual({ enabled: 0 });
    expect((await put(account, { enabled: true }, { ...headers, Cookie: `cl_session=${bob.token}` })).status).toBe(502);
    expect(db.prepare('SELECT COUNT(*) AS n FROM moderation_preferences WHERE user_id = ?').get(bob.user.id)).toEqual({ n: 0 });
  } finally { globalThis.fetch = originalFetch; }
});

test('moderation queues confirmed clear violations and retries failed hides', async () => {
  const alice = connect('moderation-alice', 'moderation-owner');
  const account = 'cccccccccccccccccccccccc';
  db.prepare('INSERT INTO monitored_accounts VALUES (?, ?, ?, ?)').run(alice.user.id, account, 'instagram', new Date().toISOString());
  db.prepare('INSERT INTO monitored_posts (user_id, account_id, post_id, content, pending) VALUES (?, ?, ?, ?, 0)').run(alice.user.id, account, 'post', 'Caption');
  for (const [id, category] of [['bad', 'profanity'], ['uncertain', 'review'], ['normal', 'safe']]) {
    db.prepare('INSERT INTO synced_comments VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0)').run(alice.user.id, account, 'post', id, id, 'Visitor', new Date().toISOString());
    db.prepare('INSERT INTO comment_assessments (user_id, account_id, comment_id, classified_message, category) VALUES (?, ?, ?, ?, ?)').run(alice.user.id, account, id, id, category);
  }
  db.prepare('INSERT INTO backfill_comments VALUES (?, ?, ?)').run(alice.user.id, account, 'bad');
  db.prepare('INSERT INTO moderation_preferences (user_id, account_id, owner_id, enabled, confirmed_at, backfill_confirmed) VALUES (?, ?, ?, 1, ?, 0)')
    .run(alice.user.id, account, 'moderation-owner', new Date().toISOString());
  const original = globalThis.fetch;
  let fail = true;
  let writes = 0;
  let restores = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'moderation-owner', users: [{ _id: 'moderation-owner', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: account, platform: 'instagram' }] });
    if (init?.method === 'DELETE') {
      restores++;
      expect(url.searchParams.get('accountId')).toBe(account);
      return Response.json({ hidden: false, commentId: 'bad' });
    }
    if (init?.method === 'POST') {
      writes++;
      expect(url.pathname).toEndWith('/post/bad/hide');
      return fail ? Response.json({}, { status: 403 }) : Response.json({ hidden: true, commentId: 'bad' });
    }
    throw new Error('Unexpected request');
  }) as typeof fetch;
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await moderateComments();
    expect(writes).toBe(0);
    db.prepare('UPDATE moderation_preferences SET backfill_confirmed = 1 WHERE user_id = ?').run(alice.user.id);
    await moderateComments();
    expect(writes).toBe(1);
    expect(db.prepare('SELECT status FROM moderation_jobs WHERE user_id = ?').get(alice.user.id)).toEqual({ status: 'pending' });
    db.prepare('UPDATE moderation_jobs SET next_attempt_at = 0 WHERE user_id = ?').run(alice.user.id);
    fail = false;
    await moderateComments();
    await moderateComments();
    expect(writes).toBe(2);
    expect(db.prepare('SELECT is_hidden FROM synced_comments WHERE user_id = ? AND comment_id = ?').get(alice.user.id, 'bad')).toEqual({ is_hidden: 1 });
    expect(db.prepare('SELECT count(*) AS n FROM moderation_jobs WHERE user_id = ?').get(alice.user.id)).toEqual({ n: 1 });
    const outsider = createSession('restore-outsider', 'restore@example.com', 'Outsider');
    const path = `/api/comments/${account}/bad/restore`;
    expect((await moderation.request(path, { method: 'POST', headers: { Cookie: `cl_session=${outsider.token}`, Origin: 'http://localhost' } })).status).toBe(404);
    expect((await moderation.request(path, { method: 'POST', headers: { Cookie: `cl_session=${alice.token}`, Origin: 'https://bad.example' } })).status).toBe(403);
    expect((await moderation.request(path, { method: 'POST', headers: { Cookie: `cl_session=${alice.token}`, Origin: 'http://localhost' } })).status).toBe(200);
    expect(restores).toBe(1);
    await moderateComments();
    expect(writes).toBe(2);
    expect(db.prepare('SELECT status FROM moderation_jobs WHERE user_id = ?').get(alice.user.id)).toEqual({ status: 'restored' });
  } finally { globalThis.fetch = original; log.mockRestore(); }
});

test('restore failures stay unconfirmed and explicit resolution never hides', async () => {
  const alice = connect('restore-recovery', 'restore-recovery-owner');
  const account = 'dddddddddddddddddddddddd';
  db.prepare('INSERT INTO monitored_accounts VALUES (?, ?, ?, ?)').run(alice.user.id, account, 'instagram', new Date().toISOString());
  db.prepare('INSERT INTO monitored_posts (user_id, account_id, post_id, content, pending) VALUES (?, ?, ?, ?, 0)').run(alice.user.id, account, 'post', 'Caption');
  db.prepare('INSERT INTO synced_comments VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1)').run(alice.user.id, account, 'post', 'hidden', 'Comment', 'Visitor', new Date().toISOString());
  db.prepare("INSERT INTO moderation_jobs (user_id, account_id, comment_id, status) VALUES (?, ?, ?, 'done')").run(alice.user.id, account, 'hidden');
  const original = globalThis.fetch;
  let writes = 0;
  let failVerification = true;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) {
      if (failVerification) return Response.json({}, { status: 503 });
      return Response.json({ currentUserId: 'restore-recovery-owner', users: [{ _id: 'restore-recovery-owner', role: 'owner' }] });
    }
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: account, platform: 'instagram' }] });
    if (init?.method === 'DELETE') { writes++; throw new Error('connection lost'); }
    throw new Error('Unexpected request');
  }) as typeof fetch;
  const log = spyOn(console, 'error').mockImplementation(() => {});
  const headers = { Cookie: `cl_session=${alice.token}`, Origin: 'http://localhost' };
  const path = `/api/comments/${account}/hidden/restore`;
  try {
    expect((await moderation.request(path, { method: 'POST', headers })).status).toBe(502);
    expect(db.prepare('SELECT status FROM moderation_jobs WHERE user_id = ?').get(alice.user.id)).toEqual({ status: 'done' });
    failVerification = false;
    const response = await moderation.request(path, { method: 'POST', headers });
    expect(response.status).toBe(502);
    expect((await response.json() as { status: string }).status).toBe('restore_unknown');
    expect((await moderation.request(path, { method: 'POST', headers })).status).toBe(409);
    const job = db.prepare('SELECT status, restore_token FROM moderation_jobs WHERE user_id = ?').get(alice.user.id) as { status: string; restore_token: string };
    expect(job.status).toBe('restore_unknown');
    const body = JSON.stringify({ resolution: 'hidden', attempt: job.restore_token });
    expect((await moderation.request(`${path}/resolve`, { method: 'POST', headers, body })).status).toBe(200);
    expect((await moderation.request(`${path}/resolve`, { method: 'POST', headers, body })).status).toBe(409);
    expect(db.prepare('SELECT status FROM moderation_jobs WHERE user_id = ?').get(alice.user.id)).toEqual({ status: 'done' });
    expect(writes).toBe(1);
  } finally { globalThis.fetch = original; log.mockRestore(); }
});

test('only one concurrent restore can reach the provider', async () => {
  const alice = connect('restore-concurrent', 'restore-concurrent-owner');
  const account = 'eeeeeeeeeeeeeeeeeeeeeeee';
  db.prepare('INSERT INTO monitored_accounts VALUES (?, ?, ?, ?)').run(alice.user.id, account, 'instagram', new Date().toISOString());
  db.prepare('INSERT INTO monitored_posts (user_id, account_id, post_id, content, pending) VALUES (?, ?, ?, ?, 0)').run(alice.user.id, account, 'post', null);
  db.prepare('INSERT INTO synced_comments VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1)').run(alice.user.id, account, 'post', 'comment', 'Text', 'Visitor', new Date().toISOString());
  const original = globalThis.fetch;
  let release!: () => void;
  let started!: () => void;
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let writes = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'restore-concurrent-owner', users: [{ _id: 'restore-concurrent-owner', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: account, platform: 'instagram' }] });
    if (init?.method === 'DELETE') { writes++; started(); await gate; return Response.json({ hidden: false, commentId: 'comment' }); }
    throw new Error('Unexpected request');
  }) as typeof fetch;
  const request = () => moderation.request(`/api/comments/${account}/comment/restore`, { method: 'POST', headers: { Cookie: `cl_session=${alice.token}`, Origin: 'http://localhost' } });
  try {
    const first = request();
    await startedPromise;
    expect((await request()).status).toBe(409);
    release();
    expect((await first).status).toBe(200);
    expect(writes).toBe(1);
  } finally { release(); globalThis.fetch = original; }
});

test('sync reconciles only explicit observations newer than the last action', async () => {
  const alice = connect('visibility-sync', 'visibility-owner');
  const account = 'ffffffffffffffffffffffff';
  const now = new Date().toISOString();
  db.prepare('INSERT INTO monitored_accounts VALUES (?, ?, ?, ?)').run(alice.user.id, account, 'instagram', now);
  db.prepare('INSERT INTO backfill_accounts VALUES (?, ?, 1)').run(alice.user.id, account);
  db.prepare('INSERT INTO monitored_posts (user_id, account_id, post_id, content, pending) VALUES (?, ?, ?, ?, 1)').run(alice.user.id, account, 'post', null);
  db.prepare('INSERT INTO synced_comments VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1)').run(alice.user.id, account, 'post', 'comment', 'Text', 'Visitor', now);
  db.prepare("INSERT INTO moderation_jobs (user_id, account_id, comment_id, status, action_at) VALUES (?, ?, ?, 'done', ?)").run(alice.user.id, account, 'comment', '2026-01-01T00:00:00.000Z');
  const original = globalThis.fetch;
  let observation: boolean | undefined = false;
  let updated: string | undefined;
  let omit = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'visibility-owner', users: [{ _id: 'visibility-owner', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: account, platform: 'instagram' }] });
    if (url.pathname.endsWith('/inbox/comments')) return Response.json({ data: [], pagination: { hasMore: false } });
    if (url.pathname.endsWith('/inbox/comments/post')) return Response.json({ comments: omit ? [] : [{ id: 'comment', message: 'Text', createdTime: now, isHidden: observation }], pagination: { hasMore: false }, meta: { lastUpdated: updated } });
    throw new Error('Unexpected request');
  }) as typeof fetch;
  const log = spyOn(console, 'error').mockImplementation(() => {});
  const scan = async () => { db.prepare('UPDATE monitored_posts SET pending = 1 WHERE user_id = ?').run(alice.user.id); await syncComments(); };
  const state = () => db.prepare('SELECT c.is_hidden, j.status, j.visibility_uncertain FROM synced_comments c JOIN moderation_jobs j USING (user_id,account_id,comment_id) WHERE c.user_id = ?').get(alice.user.id);
  try {
    await scan();
    expect(state()).toEqual({ is_hidden: 1, status: 'done', visibility_uncertain: 1 });
    omit = true; updated = '2027-01-01T00:00:00.000Z';
    await scan();
    expect(state()).toEqual({ is_hidden: 1, status: 'done', visibility_uncertain: 1 });
    omit = false;
    await scan();
    expect(state()).toEqual({ is_hidden: 0, status: 'done', visibility_uncertain: 0 });
    observation = true; updated = '2026-06-01T00:00:00.000Z';
    await scan();
    expect(state()).toEqual({ is_hidden: 0, status: 'done', visibility_uncertain: 1 });
    db.prepare("UPDATE moderation_jobs SET status = 'restored', action_at = ? WHERE user_id = ?").run('2028-01-01T00:00:00.000Z', alice.user.id);
    await scan();
    expect(state()).toEqual({ is_hidden: 0, status: 'restored', visibility_uncertain: 1 });
  } finally { globalThis.fetch = original; log.mockRestore(); }
});

test('moderation claims serialize workers and expired dispatches remain unconfirmed', async () => {
  const alice = connect('claim-owner', 'claim-owner');
  const account = 'ddddddddddddddddddddddde';
  const now = new Date().toISOString();
  db.prepare('INSERT INTO monitored_accounts VALUES (?, ?, ?, ?)').run(alice.user.id, account, 'instagram', now);
  db.prepare('INSERT INTO monitored_posts (user_id, account_id, post_id, content, pending) VALUES (?, ?, ?, ?, 0)').run(alice.user.id, account, 'post', null);
  db.prepare('INSERT INTO synced_comments VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0)').run(alice.user.id, account, 'post', 'bad', 'bad', 'Visitor', now);
  db.prepare("INSERT INTO comment_assessments (user_id, account_id, comment_id, classified_message, category) VALUES (?, ?, ?, 'bad', 'spam')").run(alice.user.id, account, 'bad');
  db.prepare('INSERT INTO moderation_preferences (user_id, account_id, owner_id, enabled, confirmed_at, backfill_confirmed) VALUES (?, ?, ?, 1, ?, 1)').run(alice.user.id, account, 'claim-owner', now);
  const original = globalThis.fetch;
  let release!: () => void;
  let started!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const startedPromise = new Promise<void>((resolve) => { started = resolve; });
  let writes = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'claim-owner', users: [{ _id: 'claim-owner', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: account, platform: 'instagram' }] });
    if (init?.method === 'POST') { writes++; started(); await gate; return Response.json({ hidden: true, commentId: 'bad' }); }
    throw new Error('Unexpected request');
  }) as typeof fetch;
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    const first = moderateComments();
    await startedPromise;
    await moderateComments();
    expect(writes).toBe(1);
    db.prepare('UPDATE synced_comments SET is_hidden = 1 WHERE user_id = ?').run(alice.user.id);
    expect((await moderation.request(`/api/comments/${account}/bad/restore`, { method: 'POST', headers: { Cookie: `cl_session=${alice.token}`, Origin: 'http://localhost' } })).status).toBe(409);
    db.prepare('UPDATE synced_comments SET is_hidden = 0 WHERE user_id = ?').run(alice.user.id);
    db.prepare('UPDATE moderation_jobs SET claim_expires_at = 0 WHERE user_id = ?').run(alice.user.id);
    await moderateComments();
    expect(db.prepare('SELECT status FROM moderation_jobs WHERE user_id = ?').get(alice.user.id)).toEqual({ status: 'hide_unknown' });
    release();
    await first;
    expect(db.prepare('SELECT status FROM moderation_jobs WHERE user_id = ?').get(alice.user.id)).toEqual({ status: 'hide_unknown' });
    expect(db.prepare('SELECT is_hidden FROM synced_comments WHERE user_id = ?').get(alice.user.id)).toEqual({ is_hidden: 0 });
    await moderateComments();
    expect(writes).toBe(1);
    const job = db.prepare('SELECT claim_token FROM moderation_jobs WHERE user_id = ?').get(alice.user.id) as { claim_token: string };
    const path = `/api/comments/${account}/bad/hide/resolve`;
    const body = JSON.stringify({ resolution: 'hidden', attempt: job.claim_token });
    const outsider = createSession('claim-outsider', 'claim-outsider@example.com', 'Outsider');
    expect((await moderation.request(path, { method: 'POST', headers: { Cookie: `cl_session=${outsider.token}`, Origin: 'http://localhost' }, body })).status).toBe(409);
    expect((await moderation.request(path, { method: 'POST', headers: { Cookie: `cl_session=${alice.token}`, Origin: 'http://localhost' }, body })).status).toBe(200);
    expect((await moderation.request(path, { method: 'POST', headers: { Cookie: `cl_session=${alice.token}`, Origin: 'http://localhost' }, body })).status).toBe(409);
    expect(db.prepare('SELECT is_hidden FROM synced_comments WHERE user_id = ?').get(alice.user.id)).toEqual({ is_hidden: 1 });
  } finally { release(); globalThis.fetch = original; log.mockRestore(); }
});

test('revoked consent stops a claimed hide before dispatch', async () => {
  const alice = connect('claim-revoked', 'claim-revoked-owner');
  const account = 'dddddddddddddddddddddddf';
  const now = new Date().toISOString();
  db.prepare('INSERT INTO monitored_accounts VALUES (?, ?, ?, ?)').run(alice.user.id, account, 'instagram', now);
  db.prepare('INSERT INTO monitored_posts (user_id, account_id, post_id, content, pending) VALUES (?, ?, ?, ?, 0)').run(alice.user.id, account, 'post', null);
  db.prepare('INSERT INTO synced_comments VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0)').run(alice.user.id, account, 'post', 'bad', 'bad', 'Visitor', now);
  db.prepare("INSERT INTO comment_assessments (user_id, account_id, comment_id, classified_message, category) VALUES (?, ?, ?, 'bad', 'spam')").run(alice.user.id, account, 'bad');
  db.prepare('INSERT INTO moderation_preferences (user_id, account_id, owner_id, enabled, confirmed_at, backfill_confirmed) VALUES (?, ?, ?, 1, ?, 1)').run(alice.user.id, account, 'claim-revoked-owner', now);
  const original = globalThis.fetch;
  let writes = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'claim-revoked-owner', users: [{ _id: 'claim-revoked-owner', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) {
      db.prepare('UPDATE moderation_preferences SET enabled = 0 WHERE user_id = ?').run(alice.user.id);
      return Response.json({ accounts: [{ _id: account, platform: 'instagram' }] });
    }
    if (init?.method === 'POST') writes++;
    return Response.json({});
  }) as typeof fetch;
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    await moderateComments();
    expect(writes).toBe(0);
    expect(db.prepare('SELECT status FROM moderation_jobs WHERE user_id = ?').get(alice.user.id)).toEqual({ status: 'pending' });
  } finally { globalThis.fetch = original; log.mockRestore(); }
});

test('automatic backfill accepts zero, one or two posts without selecting older extras', async () => {
  const alice = connect('backfill-short', 'backfill-short-owner');
  const accounts = [0, 1, 2].map((n) => ({ _id: String(n + 3).repeat(24), platform: 'instagram', count: n }));
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'backfill-short-owner', users: [{ _id: 'backfill-short-owner', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts });
    const account = accounts.find((item) => url.pathname.endsWith(`/accounts/${item._id}/posts`));
    if (account) return Response.json({ status: 'success', posts: Array.from({ length: account.count }, (_, n) => ({
      id: `short-${account.count}-${n}`, platform: 'instagram', message: 'Caption', createdTime: new Date(Date.now() - n * 86400_000).toISOString(), commentCount: 0,
    })) });
    if (url.pathname.endsWith('/inbox/comments')) return Response.json({ data: [], pagination: { hasMore: false } });
    if (url.pathname.includes('/inbox/comments/')) return Response.json({ comments: [], pagination: { hasMore: false } });
    throw new Error('Unexpected request');
  }) as typeof fetch;
  try {
    await syncComments();
    const status = await (await zernio.request('/api/backfill', { headers: { Cookie: `cl_session=${alice.token}` } })).json() as {
      accounts: { selected: number; posts: number; completedPosts: number; expectedComments: number }[];
    };
    expect(status.accounts.map(({ selected, posts, completedPosts, expectedComments }) => [selected, posts, completedPosts, expectedComments]))
      .toEqual([[1, 0, 0, 0], [1, 1, 1, 0], [1, 2, 2, 0]]);
  } finally { globalThis.fetch = originalFetch; }
});

test('backfill keeps native post thumbnails and fills missing pictures on later syncs', async () => {
  const alice = connect('backfill-pictures', 'backfill-pictures-owner');
  const accountId = '777777777777777777777777';
  const createdTime = new Date(Date.now() - 86400_000).toISOString();
  let coffeePicture: string | undefined;
  let discoveryCalls = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'backfill-pictures-owner', users: [{ _id: 'backfill-pictures-owner', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: accountId, platform: 'instagram' }] });
    if (url.pathname.endsWith(`/accounts/${accountId}/posts`)) {
      discoveryCalls++;
      return Response.json({ status: 'success', posts: [
        { id: 'croissants', platform: 'instagram', message: 'Come and try our croissants!', picture: 'https://images.example.com/croissants.jpg', createdTime, commentCount: 1 },
        { id: 'coffee', platform: 'instagram', message: 'The best coffee in town', picture: coffeePicture, createdTime, commentCount: 1 },
      ] });
    }
    if (url.pathname.endsWith('/inbox/comments')) return Response.json({ data: [], pagination: { hasMore: false } });
    if (url.pathname.includes('/inbox/comments/')) return Response.json({ comments: [{ id: `${url.pathname.split('/').at(-1)}-comment`, message: 'Nice', createdTime }], pagination: { hasMore: false } });
    throw new Error('Unexpected request');
  }) as typeof fetch;
  try {
    const headers = { Cookie: `cl_session=${alice.token}` };
    await syncComments();
    expect((await (await zernio.request('/api/comments', { headers })).json() as { comments: { postId: string; postPicture: string | null }[] }).comments
      .map(({ postId, postPicture }) => [postId, postPicture]).sort()).toEqual([
        ['coffee', null], ['croissants', 'https://images.example.com/croissants.jpg'],
      ]);
    coffeePicture = 'https://images.example.com/coffee.jpg';
    await syncComments();
    expect(db.prepare('SELECT post_id, picture, created_at, pending FROM monitored_posts WHERE user_id = ? ORDER BY post_id').all(alice.user.id))
      .toEqual([{ post_id: 'coffee', picture: coffeePicture, created_at: createdTime, pending: 0 }, { post_id: 'croissants', picture: 'https://images.example.com/croissants.jpg', created_at: createdTime, pending: 0 }]);
    expect(db.prepare('SELECT count(*) AS count FROM backfill_posts WHERE user_id = ?').get(alice.user.id)).toEqual({ count: 2 });
    await syncComments();
    expect(discoveryCalls).toBe(2);
  } finally { globalThis.fetch = originalFetch; }
});

test('backfill selects only three newest posts, retries failed threads, and saves all pages and replies review-only', async () => {
  const alice = connect('backfill-pages', 'backfill-pages-owner');
  const outsider = createSession('backfill-outsider', 'backfill-outsider@example.com', 'Outsider');
  const accountId = '666666666666666666666666';
  const recent = new Date(Date.now() - 86400_000).toISOString();
  let failThread = true;
  let discoveryCalls = 0;
  const readPosts: string[] = [];
  const originalFetch = globalThis.fetch;
  const log = spyOn(console, 'error').mockImplementation(() => {});
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'backfill-pages-owner', users: [{ _id: 'backfill-pages-owner', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: accountId, platform: 'instagram' }] });
    if (url.pathname.endsWith(`/accounts/${accountId}/posts`)) {
      discoveryCalls++;
      return Response.json({ status: 'success', posts: [4, 2, 3, 1].map((n) => ({
        id: `historical-${n}`, platform: 'instagram', message: `Caption ${n}`, picture: `https://images.example.com/${n}.jpg`, createdTime: new Date(Date.now() - n * 86400_000).toISOString(), commentCount: n === 2 ? 6 : 0,
      })) });
    }
    if (url.pathname.endsWith('/inbox/comments')) return Response.json({ data: [], pagination: { hasMore: false } });
    if (url.pathname.includes('/inbox/comments/')) {
      const postId = url.pathname.split('/').at(-1)!;
      readPosts.push(postId);
      if (postId === 'historical-2' && failThread && url.searchParams.get('cursor') === 'next') return Response.json({}, { status: 503 });
      if (url.searchParams.has('commentId')) return Response.json({ comments: [{ id: 'reply-2', message: 'Second reply', createdTime: recent }], pagination: { hasMore: false } });
      if (postId === 'historical-2' && !url.searchParams.has('cursor')) return Response.json({ comments: [{ id: 'parent', message: 'Question?', createdTime: recent,
        replyCount: 2, replies: [{ id: 'reply-1', message: 'First reply', createdTime: recent }] }], pagination: { hasMore: true, cursor: 'next' } });
      if (postId === 'historical-2') return Response.json({ comments: [{ id: 'old', message: 'Expired', createdTime: '2020-01-01T00:00:00Z' },
        { id: 'second', message: 'Another comment', createdTime: recent, from: { name: 'Visitor' } }], pagination: { hasMore: false } });
      return Response.json({ comments: [], pagination: { hasMore: false } });
    }
    throw new Error('Unexpected request');
  }) as typeof fetch;
  try {
    await syncComments();
    expect(discoveryCalls).toBe(1);
    expect(new Set(readPosts)).toEqual(new Set(['historical-1', 'historical-2', 'historical-3']));
    expect(db.prepare('SELECT post_id FROM backfill_posts WHERE user_id = ? AND account_id = ? ORDER BY post_id').all(alice.user.id, accountId))
      .toEqual([{ post_id: 'historical-1' }, { post_id: 'historical-2' }, { post_id: 'historical-3' }]);
    const headers = { Cookie: `cl_session=${alice.token}` };
    const pending = await (await zernio.request('/api/backfill', { headers })).json() as { accounts: { accountId: string; selected: number; posts: number; completedPosts: number; expectedComments: number; savedComments: number }[] };
    expect(pending.accounts).toEqual([{ accountId, selected: 1, posts: 3, completedPosts: 2, expectedComments: 6, savedComments: 3 }]);
    failThread = false;
    await syncComments();
    expect(discoveryCalls).toBe(1);
    const inbox = await (await zernio.request('/api/comments', { headers })).json() as { comments: { id: string; isBackfill: boolean }[] };
    expect(inbox.comments.map(({ id }) => id).sort()).toEqual(['parent', 'reply-1', 'reply-2', 'second']);
    expect(inbox.comments.every(({ isBackfill }) => isBackfill)).toBe(true);
    const done = await (await zernio.request('/api/backfill', { headers })).json() as { accounts: { completedPosts: number; savedComments: number }[] };
    expect(done.accounts[0].completedPosts).toBe(3);
    expect(done.accounts[0].savedComments).toBe(4);
    expect((await (await zernio.request('/api/backfill', { headers: { Cookie: `cl_session=${outsider.token}` } })).json() as { accounts: unknown[] }).accounts).toEqual([]);
  } finally { globalThis.fetch = originalFetch; log.mockRestore(); }
});
