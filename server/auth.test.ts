import { expect, spyOn, test } from 'bun:test';
import { createCipheriv, randomBytes } from 'node:crypto';

Bun.env.DATABASE_PATH = ':memory:';
Bun.env.ZERNIO_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
const { startLogin, finishLogin, createSession, getUser, endSession, db } = await import('./db');
const { auth } = await import('./auth');
const { zernio } = await import('./zernio');

test('login state is single-use and expires', () => {
  startLogin('state-one', 'verifier', 'nonce');
  expect(finishLogin('other-state')).toBeNull();
  expect(finishLogin('state-one')).toEqual({ verifier: 'verifier', nonce: 'nonce' });
  expect(finishLogin('state-one')).toBeNull();
  startLogin('expired', 'verifier', 'nonce');
  db.prepare('UPDATE login_attempts SET expires_at = 0 WHERE verifier = ?').run('verifier');
  expect(finishLogin('expired')).toBeNull();
});

test('sessions stay attached to their Google identity and can be revoked', () => {
  const alice = createSession('google-alice', 'alice@example.com', 'Alice');
  const bob = createSession('google-bob', 'bob@example.com', 'Bob');
  expect(getUser(alice.token)?.id).not.toBe(getUser(bob.token)?.id);
  expect(createSession('google-alice', 'new@example.com', 'Alice').user.id).toBe(alice.user.id);
  expect(getUser(alice.token)?.email).toBe('new@example.com');
  endSession(alice.token);
  expect(getUser(alice.token)).toBeNull();
  expect(getUser(bob.token)?.name).toBe('Bob');
});

test('Google profile photo updates on sign-in without invalidating existing sessions', async () => {
  const original = createSession('photo-owner', 'photo@example.com', 'Photo');
  expect(getUser(original.token)?.picture).toBeNull();
  const updated = createSession('photo-owner', 'photo@example.com', 'Photo', 'https://lh3.googleusercontent.com/photo');
  expect(updated.user.id).toBe(original.user.id);
  expect(getUser(original.token)?.picture).toBe('https://lh3.googleusercontent.com/photo');
  const response = await auth.request('/api/me', { headers: { Cookie: `cl_session=${original.token}` } });
  expect((await response.json()).picture).toBe('https://lh3.googleusercontent.com/photo');
  expect(getUser(createSession('no-photo', 'none@example.com', 'No photo').token)?.picture).toBeNull();
});

test('unauthenticated requests and forged callbacks cannot create a session', async () => {
  expect((await auth.request('/api/me')).status).toBe(401);
  expect((await auth.request('/api/auth/google/callback?state=forged')).status).toBe(400);
  expect((await auth.request('/api/auth/logout', { method: 'POST' })).status).toBe(403);
  expect((await zernio.request('/api/zernio')).status).toBe(401);
  expect((await zernio.request('/api/zernio/callback?state=forged')).status).toBe(400);
  expect((await zernio.request('/api/zernio/disconnect', { method: 'POST' })).status).toBe(403);
});

test('Get Started sends guests to Google and signed-in users home', async () => {
  const guest = await auth.request('/api/auth/start');
  expect(guest.status).toBe(302);
  expect(guest.headers.get('location')).toBe('/api/auth/google');
  const { token } = createSession('get-started', 'started@example.com', 'Started');
  const member = await auth.request('/api/auth/start', { headers: { Cookie: `cl_session=${token}` } });
  expect(member.status).toBe(302);
  expect(new URL(member.headers.get('location')!, 'http://localhost').pathname).toBe('/app');
});

test('logo sends guests to landing and signed-in users to the app', async () => {
  expect((await auth.request('/api/auth/home')).headers.get('location')).toBe('/');
  const { token } = createSession('logo-owner', 'logo@example.com', 'Logo');
  expect((await auth.request('/api/auth/home', { headers: { Cookie: `cl_session=${token}` } })).headers.get('location')).toBe('/app');
});

test('one Zernio team cannot belong to two users', () => {
  const first = createSession('first-owner', 'first@example.com', 'First').user;
  const second = createSession('second-owner', 'second@example.com', 'Second').user;
  db.prepare('INSERT INTO zernio_connections VALUES (?, ?, ?, ?, ?)').run(first.id, 'zernio-owner', 'encrypted', 'encrypted', 1);
  expect(() => db.prepare('INSERT INTO zernio_connections VALUES (?, ?, ?, ?, ?)').run(second.id, 'zernio-owner', 'encrypted', 'encrypted', 1)).toThrow();
});

test('read-only comment preview requires an owned account', async () => {
  const { token, user } = createSession('preview-owner', 'preview@example.com', 'Preview');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv);
  const encrypted = Buffer.concat([iv, cipher.update('test-access-token'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  db.prepare('INSERT INTO zernio_connections VALUES (?, ?, ?, ?, ?)').run(user.id, 'team-owner', encrypted, encrypted, Math.floor(Date.now() / 1000) + 3600);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'team-owner', users: [{ _id: 'team-owner', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [
      { _id: '111111111111111111111111', platform: 'instagram', profilePicture: 'https://scontent.cdninstagram.com/photo.jpg' },
      { _id: '333333333333333333333333', platform: 'youtube', profilePicture: 'https://yt3.ggpht.com/photo.jpg' },
      { _id: '444444444444444444444444', platform: 'instagram', profilePicture: 'https://cdninstagram.com.evil.test/track' },
    ] });
    if (url.pathname.endsWith('/inbox/comments')) return Response.json({ data: [{ id: 'post-1', content: 'Hello', commentCount: 1 }] });
    if (url.pathname.endsWith('/inbox/comments/post-1')) return Response.json({ comments: [{ id: 'comment-1', message: 'Question?', from: { name: 'Visitor' } }] });
    throw new Error(`Unexpected request: ${url}`);
  }) as typeof fetch;
  try {
    const headers = { Cookie: `cl_session=${token}` };
    const accounts = await zernio.request('/api/zernio', { headers });
    expect((await accounts.json()).accounts.map((account: { profilePicture: string | null }) => account.profilePicture))
      .toEqual(['https://scontent.cdninstagram.com/photo.jpg', 'https://yt3.ggpht.com/photo.jpg', null]);
    const denied = await zernio.request('/api/zernio/preview?accountId=222222222222222222222222', { headers });
    expect(denied.status).toBe(404);
    const allowed = await zernio.request('/api/zernio/preview?accountId=111111111111111111111111', { headers });
    expect(allowed.status).toBe(200);
    expect((await allowed.json()).comments[0].message).toBe('Question?');
  } finally { globalThis.fetch = originalFetch; }
});

test('preview skips zero-comment posts without reading a thread', async () => {
  const { token, user } = createSession('empty-preview', 'empty@example.com', 'Empty');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv);
  const encrypted = Buffer.concat([iv, cipher.update('test-access-token'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  db.prepare('INSERT INTO zernio_connections VALUES (?, ?, ?, ?, ?)').run(user.id, 'empty-owner', encrypted, encrypted, Math.floor(Date.now() / 1000) + 3600);
  const originalFetch = globalThis.fetch;
  const requests: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    requests.push(url.pathname);
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'empty-owner', users: [{ _id: 'empty-owner', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: '111111111111111111111111', platform: 'youtube' }] });
    if (url.pathname.endsWith('/inbox/comments')) {
      expect(url.searchParams.get('minComments')).toBe('1');
      return Response.json({ data: [{ id: 'post-0', commentCount: 0 }], pagination: { hasMore: true } });
    }
    throw new Error(`Unexpected thread request: ${url.pathname}`);
  }) as typeof fetch;
  try {
    const response = await zernio.request('/api/zernio/preview?accountId=111111111111111111111111', { headers: { Cookie: `cl_session=${token}` } });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ posts: [], comments: [], olderPostsMayHaveComments: true });
    expect(requests.filter((path) => path.includes('/inbox/comments/'))).toEqual([]);
  } finally { globalThis.fetch = originalFetch; }
});

test('preview follows an empty filtered page to a commented post', async () => {
  const { token, user } = createSession('paged-preview', 'paged@example.com', 'Paged');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv);
  const encrypted = Buffer.concat([iv, cipher.update('test-access-token'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  db.prepare('INSERT INTO zernio_connections VALUES (?, ?, ?, ?, ?)').run(user.id, 'paged-owner', encrypted, encrypted, Math.floor(Date.now() / 1000) + 3600);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'paged-owner', users: [{ _id: 'paged-owner', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: '111111111111111111111111', platform: 'instagram' }] });
    if (url.pathname.endsWith('/inbox/comments')) {
      if (!url.searchParams.has('cursor')) return Response.json({ data: [], pagination: { hasMore: true, nextCursor: 'page-2' } });
      expect(url.searchParams.get('cursor')).toBe('page-2');
      return Response.json({ data: [{ id: 'post-2', content: 'New post', commentCount: 2 }], pagination: { hasMore: false } });
    }
    if (url.pathname.endsWith('/inbox/comments/post-2')) return Response.json({ comments: [{ id: 'comment-2', message: 'Hello' }] });
    throw new Error(`Unexpected request: ${url.pathname}`);
  }) as typeof fetch;
  try {
    const response = await zernio.request('/api/zernio/preview?accountId=111111111111111111111111', { headers: { Cookie: `cl_session=${token}` } });
    expect(response.status).toBe(200);
    expect((await response.json()).comments[0].message).toBe('Hello');
  } finally { globalThis.fetch = originalFetch; }
});

test('failed Zernio requests log the safe upstream code and request ID', async () => {
  const { token, user } = createSession('failed-preview', 'failed@example.com', 'Failed');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.alloc(32, 7), iv);
  const encrypted = Buffer.concat([iv, cipher.update('test-access-token'), cipher.final(), cipher.getAuthTag()]).toString('base64');
  db.prepare('INSERT INTO zernio_connections VALUES (?, ?, ?, ?, ?)').run(user.id, 'failed-owner', encrypted, encrypted, Math.floor(Date.now() / 1000) + 3600);
  const originalFetch = globalThis.fetch;
  const log = spyOn(console, 'error').mockImplementation(() => {});
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: 'failed-owner', users: [{ _id: 'failed-owner', role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: '111111111111111111111111', platform: 'instagram' }] });
    return Response.json({ code: 'TEST_INBOX_DENIED', error: 'private comment text', platform: 'instagram', platformError: { code: 10, subcode: 20 } }, { status: 403, headers: { 'x-request-id': 'req-test' } });
  }) as typeof fetch;
  try {
    const response = await zernio.request('/api/zernio/preview?accountId=111111111111111111111111', { headers: { Cookie: `cl_session=${token}` } });
    expect(response.status).toBe(502);
    const logged = JSON.stringify(log.mock.calls);
    expect(logged).toContain('TEST_INBOX_DENIED');
    expect(logged).toContain('req-test');
    expect(logged).toContain('"providerCode":10');
    expect(logged).not.toContain('private comment text');
    expect(logged).not.toContain('test-access-token');
  } finally { globalThis.fetch = originalFetch; log.mockRestore(); }
});
