import { expect, test } from 'bun:test';
import { createHmac } from 'node:crypto';

Bun.env.DATABASE_PATH = ':memory:';
Bun.env.ZERNIO_TOKEN_KEY = Buffer.alloc(32, 7).toString('base64');
const { accountPaused, db, createSession } = await import('./db');
const { encrypt, zernio } = await import('./zernio');
const { webhooks, prepareWebhookBinding, ZERNIO_WEBHOOK_EVENTS } = await import('./webhooks');
const { syncWebhookWork } = await import('./sync');
const { moderateComments, moderation } = await import('./moderate');
const { replies } = await import('./replies');
const { configureWebhook } = await import('../scripts/zernio-webhook');
const secret = 'a'.repeat(64);
const accountId = '123456789012345678901234';

function fixture(name: string) {
  const { user, token } = createSession(name, `${name}@example.com`, name);
  db.prepare('INSERT INTO zernio_connections VALUES (?, ?, ?, ?, ?)').run(user.id, name, encrypt('token'), encrypt('refresh'), 9999999999);
  db.prepare('INSERT INTO monitored_accounts VALUES (?, ?, ?, ?)').run(user.id, accountId, 'instagram', '2026-01-01T00:00:00.000Z');
  db.prepare('INSERT INTO backfill_accounts VALUES (?, ?, 1)').run(user.id, accountId);
  db.prepare('INSERT INTO monitored_posts (user_id, account_id, post_id, pending, created_at) VALUES (?, ?, ?, 0, ?)').run(user.id, accountId, 'post', '2026-02-01T00:00:00.000Z');
  const binding = prepareWebhookBinding(user.id, secret);
  db.prepare('UPDATE webhook_bindings SET enabled = 1 WHERE id = ?').run(binding);
  return { user, token, binding, owner: name };
}
const payload = (id: string, extra = {}) => ({ id, event: 'comment.received', timestamp: '2026-02-01T00:00:00.000Z',
  account: { accountId, platform: 'instagram' }, comment: { postId: 'post' }, ...extra });
function deliver(binding: string, body: unknown, headers: Record<string, string> = {}) {
  const raw = typeof body === 'string' ? body : JSON.stringify(body);
  return webhooks.request(`/api/webhooks/zernio/${binding}`, { method: 'POST', body: raw,
    headers: { 'Content-Type': 'application/json', 'X-Zernio-Signature': createHmac('sha256', secret).update(raw).digest('hex'), ...headers } });
}

test('webhooks authenticate raw bodies, dedupe delayed deliveries, ignore samples, and isolate tenants', async () => {
  const a = fixture('hook-auth');
  const b = fixture('hook-other');
  db.prepare('UPDATE webhook_bindings SET encrypted_secret = ? WHERE id = ?').run(encrypt('b'.repeat(64)), b.binding);
  db.prepare('UPDATE webhook_bindings SET enabled = 0 WHERE id = ?').run(a.binding);
  expect((await deliver(a.binding, payload('disabled'))).status).toBe(404);
  db.prepare('UPDATE webhook_bindings SET enabled = 1 WHERE id = ?').run(a.binding);
  expect((await deliver(b.binding, payload('wrong-tenant-secret'))).status).toBe(401);
  expect((await deliver(a.binding, payload('bad-signature'), { 'X-Zernio-Signature': '0'.repeat(64) })).status).toBe(401);
  expect((await deliver(a.binding, payload('mismatch'), { 'X-Zernio-Event-Id': 'other' })).status).toBe(400);
  expect((await deliver(a.binding, '{')).status).toBe(400);
  expect((await deliver(a.binding, 'x'.repeat(128 * 1024 + 1))).status).toBe(413);
  expect((await deliver(a.binding, payload('sample', { test: true }))).status).toBe(200);
  expect((await deliver(a.binding, payload('unsupported', { account: { accountId, platform: 'facebook' } }))).status).toBe(200);
  expect(db.prepare('SELECT 1 FROM webhook_work WHERE binding_id = ?').get(a.binding)).toBeNull();
  expect((await deliver(a.binding, payload('delayed'))).status).toBe(200);
  expect((await deliver(a.binding, payload('delayed'))).status).toBe(200);
  expect(db.prepare('SELECT generation FROM webhook_work WHERE binding_id = ?').get(a.binding)).toEqual({ generation: 1 });
  expect(db.prepare('SELECT 1 FROM webhook_work WHERE binding_id = ?').get(b.binding)).toBeNull();
  expect((await deliver(a.binding, payload('wrong-account', { account: { accountId: 'other', platform: 'instagram' } }))).status).toBe(404);
  expect(db.prepare('SELECT count(*) AS n FROM synced_comments WHERE user_id = ?').get(a.user.id)).toEqual({ n: 0 });
  db.prepare('DELETE FROM zernio_connections WHERE user_id = ?').run(a.user.id);
  expect((await deliver(a.binding, payload('stale'))).status).toBe(404);
  expect(db.prepare('SELECT 1 FROM webhook_work WHERE binding_id = ?').get(a.binding)).toBeNull();
  db.prepare('DELETE FROM users WHERE id = ?').run(b.user.id);
});

test('persisted event IDs and work survive a separate process restart', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const dir = mkdtempSync('/tmp/opencode/comment-lookout-webhooks-');
  const env = { ...Bun.env, DATABASE_PATH: `${dir}/test.sqlite` };
  const run = async (code: string) => {
    const proc = Bun.spawn([process.execPath, '--eval', code], { cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe' });
    const [out, error, exit] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
    expect(error).toBe('');
    expect(exit).toBe(0);
    return out.trim();
  };
  const setup = `
    import { db, createSession } from './server/db';
    import { encrypt } from './server/zernio';
    import { prepareWebhookBinding } from './server/webhooks';
    const { user } = createSession('restart', 'restart@example.com', 'Restart');
    db.prepare('INSERT INTO zernio_connections VALUES (?, ?, ?, ?, ?)').run(user.id, 'owner', encrypt('token'), encrypt('refresh'), 9999999999);
    db.prepare('INSERT INTO monitored_accounts VALUES (?, ?, ?, ?)').run(user.id, '${accountId}', 'instagram', '2026-01-01T00:00:00.000Z');
    const id = prepareWebhookBinding(user.id, '${secret}');
    db.prepare('UPDATE webhook_bindings SET enabled = 1 WHERE id = ?').run(id);
    console.log(id);
  `;
  try {
    const binding = await run(setup);
    const delivery = `
      import { createHmac } from 'node:crypto';
      import { db } from './server/db';
      import { webhooks } from './server/webhooks';
      const body = ${JSON.stringify(JSON.stringify(payload('persisted')))};
      const response = await webhooks.request('/api/webhooks/zernio/${binding}', { method: 'POST', body,
        headers: { 'Content-Type': 'application/json', 'X-Zernio-Signature': createHmac('sha256', '${secret}').update(body).digest('hex') } });
      if (response.status !== 200) throw new Error('Delivery rejected');
      console.log(JSON.stringify(db.prepare('SELECT generation FROM webhook_work').all()));
    `;
    expect(await run(delivery)).toBe('[{"generation":1}]');
    await run("import { db } from './server/db'; db.exec('ALTER TABLE webhook_work DROP COLUMN account_event');");
    expect(await run(delivery)).toBe('[{"generation":1}]');
  } finally { rmSync(dir, { recursive: true }); }
});

test('native and unselected historical posts request discovery without expanding eligibility', async () => {
  const a = fixture('hook-native');
  db.prepare('INSERT INTO monitored_posts (user_id, account_id, post_id, pending, created_at) VALUES (?, ?, ?, 0, ?)').run(a.user.id, accountId, 'old', '2020-01-01T00:00:00.000Z');
  expect((await deliver(a.binding, payload('native', { comment: { postId: null, platformPostId: 'unknown' }, post: { id: null, platformPostId: 'unknown' } }))).status).toBe(200);
  expect((await deliver(a.binding, payload('old', { comment: { postId: 'old' } }))).status).toBe(200);
  expect(db.prepare('SELECT post_id, generation FROM webhook_work WHERE binding_id = ?').all(a.binding)).toEqual([{ post_id: '', generation: 2 }]);
  db.prepare('UPDATE zernio_connections SET owner_id = ? WHERE user_id = ?').run('new-owner', a.user.id);
  expect((await deliver(a.binding, payload('transfer'))).status).toBe(404);
  db.prepare('DELETE FROM users WHERE id = ?').run(a.user.id);
});

test('worker verifies ownership, retries failures, and preserves deliveries arriving during reads', async () => {
  const a = fixture('hook-worker');
  await deliver(a.binding, payload('first'));
  const originalFetch = globalThis.fetch;
  let fail = true;
  let inFlight = true;
  let wrongOwner = true;
  let threadReads = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: wrongOwner ? 'wrong' : a.owner, users: [{ _id: a.owner, role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) return Response.json({ accounts: [{ _id: accountId, platform: 'instagram' }] });
    if (url.pathname.endsWith(`/accounts/${accountId}/posts`)) return Response.json({ status: 'success', posts: [] });
    if (url.pathname.endsWith('/inbox/comments')) return Response.json({ data: [] });
    if (url.pathname.endsWith('/inbox/comments/post')) {
      threadReads++;
      if (fail) return new Response('', { status: 503 });
      if (inFlight) { inFlight = false; await deliver(a.binding, payload('during-read')); }
      return Response.json({ comments: [] });
    }
    throw new Error('Unexpected request');
  }) as typeof fetch;
  const retry = () => db.prepare('UPDATE webhook_work SET next_attempt_at = 0 WHERE binding_id = ?').run(a.binding);
  try {
    await syncWebhookWork();
    expect(threadReads).toBe(0);
    wrongOwner = false;
    retry();
    await syncWebhookWork();
    expect(db.prepare('SELECT next_attempt_at FROM webhook_work WHERE binding_id = ?').get(a.binding)).not.toEqual({ next_attempt_at: 0 });
    fail = false;
    retry();
    await syncWebhookWork();
    expect(db.prepare('SELECT generation FROM webhook_work WHERE binding_id = ?').get(a.binding)).toEqual({ generation: 2 });
    await syncWebhookWork();
    expect(db.prepare('SELECT 1 FROM webhook_work WHERE binding_id = ?').get(a.binding)).toBeNull();
    expect(threadReads).toBe(3);
  } finally { globalThis.fetch = originalFetch; db.prepare('DELETE FROM users WHERE id = ?').run(a.user.id); }
});

test('lifecycle and native-post hints refresh canonical state without trusting event order or post data', async () => {
  const a = fixture('hook-lifecycle');
  const newAccount = '234567890123456789012345';
  const foreignAccount = '345678901234567890123456';
  for (const event of ZERNIO_WEBHOOK_EVENTS.slice(1)) {
    expect((await deliver(a.binding, { id: `sample-${event}`, event, timestamp: '2026-02-01T00:00:00Z', test: true })).status).toBe(200);
  }
  expect(db.prepare('SELECT 1 FROM webhook_work WHERE binding_id = ?').get(a.binding)).toBeNull();
  const lifecycle = (id: string, event: string, account = accountId) => ({ id, event, timestamp: '2026-02-01T00:00:00Z', account: { accountId: account, platform: 'instagram' } });
  const originalFetch = globalThis.fetch;
  let healthy = false;
  let reads = 0;
  let nativeDiscovered = false;
  let failAccounts = false;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: a.owner, users: [{ _id: a.owner, role: 'owner' }] });
    if (url.pathname.endsWith('/accounts')) {
      if (failAccounts) return new Response('', { status: 503 });
      const id = url.searchParams.get('search');
      return Response.json({ accounts: healthy && id !== foreignAccount ? [{ _id: id ?? accountId, platform: 'instagram' }] : [] });
    }
    reads++;
    if (url.pathname.endsWith('/posts')) return Response.json({ status: 'success', posts: [] });
    if (url.pathname.endsWith('/inbox/comments')) return Response.json({ data: nativeDiscovered ? [
      { id: 'old-native', accountId, platform: 'instagram', createdTime: '2020-01-01T00:00:00Z', commentCount: 3 },
      { id: 'canonical-native', accountId, platform: 'instagram', createdTime: '2026-02-01T00:00:00Z', commentCount: 1 },
    ] : [] });
    return Response.json({ comments: [] });
  }) as typeof fetch;
  try {
    expect((await deliver(a.binding, lifecycle('disconnect', 'account.disconnected'))).status).toBe(200);
    expect(accountPaused(a.user.id, accountId)).toBe(true);
    failAccounts = true;
    await syncWebhookWork();
    expect(accountPaused(a.user.id, accountId)).toBe(true);
    expect(db.prepare('SELECT status FROM webhook_account_state WHERE binding_id = ?').get(a.binding)).toEqual({ status: 'checking' });
    failAccounts = false;
    db.prepare('UPDATE webhook_work SET next_attempt_at = 0 WHERE binding_id = ?').run(a.binding);
    await syncWebhookWork();
    expect(reads).toBe(0);
    expect(db.prepare('SELECT status FROM webhook_account_state WHERE binding_id = ?').get(a.binding)).toEqual({ status: 'disconnected' });
    const response = await zernio.request('/api/zernio', { headers: { Cookie: `cl_session=${a.token}` } });
    expect((await response.json() as { accountIssues: unknown[] }).accountIssues).toEqual([{ accountId, platform: 'instagram', status: 'disconnected' }]);
    healthy = true;
    await deliver(a.binding, lifecycle('reconnect', 'account.connected'));
    await syncWebhookWork();
    expect(accountPaused(a.user.id, accountId)).toBe(false);
    expect(db.prepare('SELECT started_at FROM monitored_accounts WHERE user_id = ? AND account_id = ?').get(a.user.id, accountId)).toEqual({ started_at: '2026-01-01T00:00:00.000Z' });
    // Delayed disconnection must not override a healthy canonical connection.
    await deliver(a.binding, lifecycle('delayed-disconnect', 'account.disconnected'));
    await syncWebhookWork();
    expect(accountPaused(a.user.id, accountId)).toBe(false);
    await deliver(a.binding, lifecycle('permissions', 'account.permissions_changed'));
    await syncWebhookWork();
    expect(accountPaused(a.user.id, accountId)).toBe(false);
    expect(db.prepare('SELECT status FROM webhook_account_state WHERE binding_id = ?').get(a.binding)).toEqual({ status: 'permissions_changed' });
    await deliver(a.binding, lifecycle('new-account', 'account.connected', newAccount));
    expect(db.prepare('SELECT 1 FROM monitored_accounts WHERE user_id = ? AND account_id = ?').get(a.user.id, newAccount)).toBeNull();
    await syncWebhookWork();
    expect(db.prepare('SELECT selected FROM backfill_accounts WHERE user_id = ? AND account_id = ?').get(a.user.id, newAccount)).toEqual({ selected: 1 });
    await deliver(a.binding, lifecycle('foreign', 'account.connected', foreignAccount));
    await syncWebhookWork();
    expect(db.prepare('SELECT 1 FROM monitored_accounts WHERE user_id = ? AND account_id = ?').get(a.user.id, foreignAccount)).toBeNull();
    expect(db.prepare('SELECT 1 FROM webhook_account_state WHERE binding_id = ? AND account_id = ?').get(a.binding, foreignAccount)).toBeNull();
    const native = { id: 'external', event: 'post.external.created', timestamp: '2026-02-01T00:00:00Z',
      account: { id: accountId, platform: 'instagram' }, post: { id: 'forged-post', source: 'external', createdAt: '2020-01-01T00:00:00Z', url: 'http://127.0.0.1/private' } };
    expect((await deliver(a.binding, { ...native, account: { id: accountId, accountId: foreignAccount, platform: 'instagram' } })).status).toBe(400);
    expect((await deliver(a.binding, native)).status).toBe(200);
    expect((await deliver(a.binding, native)).status).toBe(200);
    expect(db.prepare('SELECT generation FROM webhook_work WHERE binding_id = ?').get(a.binding)).toEqual({ generation: 1 });
    nativeDiscovered = true;
    await syncWebhookWork();
    expect(db.prepare('SELECT post_id FROM monitored_posts WHERE user_id = ? ORDER BY post_id').all(a.user.id)).toEqual([{ post_id: 'canonical-native' }, { post_id: 'post' }]);
    expect(db.prepare('SELECT 1 FROM moderation_preferences WHERE user_id = ?').get(a.user.id)).toBeNull();
  } finally { globalThis.fetch = originalFetch; db.prepare('DELETE FROM users WHERE id = ?').run(a.user.id); }
});

test('pending account checks block moderation, restoration and replies without losing saved work', async () => {
  const a = fixture('hook-paused');
  db.prepare('INSERT INTO synced_comments VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 0)').run(a.user.id, accountId, 'post', 'spam', 'spam', 'Visitor', '2026-02-01T00:00:00Z');
  db.prepare('INSERT INTO synced_comments VALUES (?, ?, ?, ?, NULL, ?, ?, ?, 1)').run(a.user.id, accountId, 'post', 'hidden', 'hidden', 'Visitor', '2026-02-01T00:00:00Z');
  db.prepare("INSERT INTO comment_assessments (user_id, account_id, comment_id, classified_message, category, draft) VALUES (?, ?, 'spam', 'spam', 'spam', 'saved draft')").run(a.user.id, accountId);
  db.prepare('INSERT INTO moderation_preferences VALUES (?, ?, ?, 1, ?, 1)').run(a.user.id, accountId, a.owner, '2026-02-01T00:00:00Z');
  await deliver(a.binding, payload('pause', { event: 'account.disconnected' }));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL) => { calls++; return new Response('', { status: 500 }); }) as typeof fetch;
  try {
    await moderateComments();
    const headers = { Cookie: `cl_session=${a.token}`, Origin: 'http://localhost', 'Content-Type': 'application/json' };
    expect((await replies.request(`/api/comments/${accountId}/spam/reply`, { method: 'POST', headers, body: JSON.stringify({ message: 'Reply' }) })).status).toBe(409);
    expect((await moderation.request(`/api/comments/${accountId}/hidden/restore`, { method: 'POST', headers })).status).toBe(409);
    expect(calls).toBe(0);
    expect(db.prepare("SELECT status FROM moderation_jobs WHERE user_id = ? AND comment_id = 'spam'").get(a.user.id)).toEqual({ status: 'pending' });
    expect(db.prepare('SELECT draft FROM comment_assessments WHERE user_id = ?').get(a.user.id)).toEqual({ draft: 'saved draft' });
    expect(db.prepare('SELECT 1 FROM comment_replies WHERE user_id = ?').get(a.user.id)).toBeNull();
  } finally { globalThis.fetch = originalFetch; db.prepare('DELETE FROM users WHERE id = ?').run(a.user.id); }
});

test('operator registration is inactive, retry-safe and activation requires signed delivery', async () => {
  const a = fixture('hook-setup');
  const originalFetch = globalThis.fetch;
  let remote: { _id: string; url: string; isActive: boolean; events: string[] } | null = null;
  let creates = 0;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: a.owner, users: [{ _id: a.owner, role: 'owner' }] });
    if (!init?.method) return Response.json({ webhooks: remote ? [remote] : [] });
    const body = JSON.parse(init.body as string);
    if (url.pathname.endsWith('/webhooks/test')) {
      expect(body).toEqual({ webhookId: 'remote' });
      await deliver(a.binding, payload('test', { event: 'webhook.test', test: true }));
      return Response.json({ success: true });
    }
    if (init.method === 'PUT' && body.isActive === false) {
      expect(body).toEqual({ webhookId: 'remote', isActive: false });
      remote!.isActive = false;
      return Response.json({ success: true });
    }
    if (init.method === 'POST') {
      expect(body.isActive).toBe(false);
      expect(body.events).toEqual(ZERNIO_WEBHOOK_EVENTS);
      expect(body.secret).toBe(secret);
      remote = { _id: 'remote', url: body.url, isActive: false, events: body.events };
      creates++;
    } else {
      expect(body.webhookId).toBe('remote');
      expect(body.events).toEqual(expect.arrayContaining(ZERNIO_WEBHOOK_EVENTS));
      remote!.events = body.events;
      if (body.isActive !== undefined) remote!.isActive = body.isActive;
      else expect(remote!.isActive).toBe(false);
    }
    return Response.json({ success: true });
  }) as typeof fetch;
  try {
    await expect(configureWebhook(a.user.id, 'http://localhost')).rejects.toThrow('HTTPS');
    expect((await configureWebhook(a.user.id, 'https://hooks.example.com')).active).toBe(false);
    await configureWebhook(a.user.id, 'https://hooks.example.com');
    expect(creates).toBe(1);
    remote!.events = ['comment.received', 'post.published'];
    await configureWebhook(a.user.id, 'https://hooks.example.com');
    expect(remote!.isActive).toBe(false);
    expect(remote!.events).toContain('post.published');
    await expect(configureWebhook(a.user.id, 'https://hooks.example.com', 'activate')).rejects.toThrow('signed test');
    expect((await configureWebhook(a.user.id, 'https://hooks.example.com', 'test')).active).toBe(false);
    expect((await configureWebhook(a.user.id, 'https://hooks.example.com', 'activate')).active).toBe(true);
    expect((await configureWebhook(a.user.id, 'https://hooks.example.com', 'disable')).active).toBe(false);
    expect(remote!.isActive).toBe(false);
    expect((await deliver(a.binding, payload('disabled-delivery'))).status).toBe(404);
    expect(db.prepare('SELECT enabled FROM webhook_bindings WHERE id = ?').get(a.binding)).toEqual({ enabled: 0 });
  } finally { globalThis.fetch = originalFetch; db.prepare('DELETE FROM users WHERE id = ?').run(a.user.id); }
});

test('bindings default off and local rollback stops queued work even when Zernio is unavailable', async () => {
  const a = fixture('hook-disable-offline');
  const disabled = prepareWebhookBinding(a.user.id, 'b'.repeat(64));
  expect((await deliver(disabled, payload('not-registered'))).status).toBe(404);
  await deliver(a.binding, payload('already-queued'));
  const originalFetch = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = (async (_input: RequestInfo | URL) => { calls++; return new Response('', { status: 503 }); }) as typeof fetch;
  try {
    await expect(configureWebhook(a.user.id, 'https://hooks.example.com', 'disable')).rejects.toThrow();
    expect(db.prepare('SELECT enabled FROM webhook_bindings WHERE id = ?').get(a.binding)).toEqual({ enabled: 0 });
    expect((await deliver(a.binding, payload('after-disable'))).status).toBe(404);
    const before = calls;
    await syncWebhookWork();
    expect(calls).toBe(before);
    expect(db.prepare('SELECT generation FROM webhook_work WHERE binding_id = ?').get(a.binding)).toEqual({ generation: 1 });
  } finally { globalThis.fetch = originalFetch; db.prepare('DELETE FROM users WHERE id = ?').run(a.user.id); }
});
