import { expect, spyOn, test } from 'bun:test';
import { createCipheriv, randomBytes } from 'node:crypto';

Bun.env.DATABASE_PATH = ':memory:';
Bun.env.ZERNIO_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
const { db, createSession } = await import('./db');
const { zernio } = await import('./zernio');
const { syncComments } = await import('./sync');

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
      return Response.json({ data: [{ id: 'new-post', accountId, platform: 'instagram', content: 'Caption', createdTime: future, commentCount: 2 }], pagination: { hasMore: false } });
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
    const inbox = await response.json() as { comments: { id: string; postContent: string; category: string | null }[] };
    expect(inbox.comments.map((comment) => comment.id)).toEqual(['comment-c', 'comment-a']);
    expect(inbox.comments[0].postContent).toBe('Caption');
    expect(inbox.comments.every((comment) => comment.category === null)).toBe(true);
    const bobResponse = await zernio.request('/api/comments', { headers: { Cookie: `cl_session=${bob.token}` } });
    expect((await bobResponse.json() as { comments: unknown[] }).comments).toEqual([]);
    expect((await zernio.request('/api/comments?before=invalid', { headers })).status).toBe(400);
    expect((await zernio.request('/api/comments')).status).toBe(401);
  } finally { globalThis.fetch = originalFetch; log.mockRestore(); }
});

test('saved inbox pages newest-first without duplicates', async () => {
  const { token, user } = createSession('paged-inbox', 'paged-inbox@example.com', 'Paged');
  const account = '222222222222222222222222';
  db.prepare('INSERT INTO monitored_accounts VALUES (?, ?, ?, ?)').run(user.id, account, 'instagram', new Date().toISOString());
  db.prepare('INSERT INTO monitored_posts VALUES (?, ?, ?, ?, 0)').run(user.id, account, 'post', 'Caption');
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
        id: `historical-${n}`, platform: 'instagram', message: `Caption ${n}`, createdTime: new Date(Date.now() - n * 86400_000).toISOString(), commentCount: n === 2 ? 6 : 0,
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
