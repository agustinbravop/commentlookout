import { expect, test } from 'bun:test';

const fixture = `
  import assert from 'node:assert/strict';
  import { createHmac } from 'node:crypto';
  import { db, createSession, queueWebhookSetup } from './server/db';
  import { encrypt, decrypt, zernio, accessToken } from './server/zernio';
  import { webhooks, ZERNIO_WEBHOOK_EVENTS } from './server/webhooks';
  import { setupWebhooks, webhookOrigin } from './server/webhook-setup';
  import { configureWebhook } from './scripts/zernio-webhook';
  console.error = () => {};
  const hooks = new Map();
  const counts = { creates: 0, tests: 0, activations: 0, deletes: 0 };
  let loseCreate = false;
  let testMode = 'valid';
  let deniedOwner = '';
  let disconnectDuringActivation = false;
  let reconnectDuringTest = false;
  let sequence = 0;
  function connect(name) {
    const session = createSession(name, name+'@example.com', name);
    db.query('INSERT INTO zernio_connections VALUES (?, ?, ?, ?, ?)').run(session.user.id, name, encrypt(name), encrypt('refresh-'+name), 9999999999);
    return { ...session, owner: name };
  }
  const state = (user) => db.query('SELECT s.*, b.enabled FROM webhook_setup s JOIN webhook_bindings b ON b.id = s.binding_id WHERE b.user_id = ?').get(user.id);
  const due = () => db.query('UPDATE webhook_setup SET next_attempt_at = 0').run();
  async function deliver(hook, overrides = {}, signature = null) {
    const body = JSON.stringify({ id: 'test-'+(++sequence), event: 'webhook.test', timestamp: new Date().toISOString(), ...overrides });
    return webhooks.request(new URL(hook.url).pathname, { method: 'POST', body, headers: {
      'Content-Type': 'application/json', 'X-Zernio-Signature': signature ?? createHmac('sha256', hook.secret).update(body).digest('hex'),
    } });
  }
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, 'https://zernio.com');
    const owner = new Headers(init?.headers).get('Authorization')?.replace('Bearer ', '');
    if (url.pathname.endsWith('/users')) return Response.json({ currentUserId: owner, users: [{ _id: owner, role: 'owner' }] });
    if (owner === deniedOwner) return Response.json({ code: 'insufficient_permissions' }, { status: 403 });
    const owned = [...hooks.values()].filter(h => h.owner === owner);
    if (url.pathname.endsWith('/webhooks/settings') && (!init?.method || init.method === 'GET')) return Response.json({ webhooks: owned });
    if (init?.method === 'DELETE') {
      const hook = hooks.get(url.searchParams.get('webhookId'));
      assert.equal(hook?.owner, owner);
      hooks.delete(hook._id);
      counts.deletes++;
      return Response.json({ success: true });
    }
    const body = JSON.parse(init.body);
    if (url.pathname.endsWith('/webhooks/test')) {
      const hook = hooks.get(body.webhookId);
      assert.equal(hook?.owner, owner);
      assert.equal(hook.isActive, false);
      counts.tests++;
      const gate = state(db.query('SELECT id FROM users WHERE id = (SELECT user_id FROM zernio_connections WHERE owner_id = ?)').get(owner));
      assert.equal(gate.status, 'testing');
      assert.equal((await deliver(hook, { event: 'comment.received' })).status, 503);
      if (testMode === 'missing') return Response.json({ success: true });
      const overrides = testMode === 'old' ? { timestamp: '2020-01-01T00:00:00Z' } : {};
      const response = await deliver(hook, overrides, testMode === 'bad-signature' ? '0'.repeat(64) : null);
      assert.equal(response.status, testMode === 'bad-signature' ? 401 : 200);
      if (reconnectDuringTest) {
        reconnectDuringTest = false;
        const connection = db.query('SELECT user_id FROM zernio_connections WHERE owner_id = ?').get(owner);
        db.transaction(() => {
          db.query('DELETE FROM webhook_bindings WHERE user_id = ?').run(connection.user_id);
          queueWebhookSetup(connection.user_id, encrypt('replacement-secret-'.repeat(4)));
        })();
      }
      return Response.json({ success: true });
    }
    if (init.method === 'POST' && url.pathname.endsWith('/webhooks/settings')) {
      assert.equal(body.isActive, false);
      assert.deepEqual(body.events, ZERNIO_WEBHOOK_EVENTS);
      assert(new URL(body.url).pathname.startsWith('/api/webhooks/zernio/'));
      const id = 'hook-'+(++sequence);
      hooks.set(id, { _id: id, ...body, owner });
      counts.creates++;
      if (loseCreate) { loseCreate = false; throw new Error('Lost creation response'); }
      return Response.json({ success: true });
    }
    if (init.method === 'PUT' && url.pathname.endsWith('/webhooks/settings')) {
      const hook = hooks.get(body.webhookId);
      assert.equal(hook?.owner, owner);
      if (body.isActive === true) {
        const proof = db.query('SELECT test_verified FROM webhook_setup WHERE webhook_id = ?').get(hook._id);
        assert.equal(proof?.test_verified, 1);
        counts.activations++;
      }
      Object.assign(hook, body);
      if (body.isActive && disconnectDuringActivation) {
        disconnectDuringActivation = false;
        db.query('DELETE FROM zernio_connections WHERE owner_id = ?').run(owner);
      }
      return Response.json({ success: true });
    }
    throw new Error('Unexpected provider operation');
  };
`;

function run(code: string, env: Record<string, string> = {}) {
  const result = Bun.spawnSync([process.execPath, '-e', fixture + code], {
    cwd: process.cwd(), env: { ...Bun.env, DATABASE_PATH: ':memory:', DISCORD_SIGNUP_WEBHOOK_URL: '',
      ZERNIO_TOKEN_KEY: Buffer.alloc(32, 7).toString('base64'),
      GOOGLE_REDIRECT_URI: 'https://app.example.com/api/auth/google/callback',
      ZERNIO_REDIRECT_URI: 'https://app.example.com/api/zernio/callback', ...env },
    stdout: 'pipe', stderr: 'pipe', timeout: 30_000,
  });
  expect({ code: result.exitCode, error: result.stderr.toString() }).toEqual({ code: 0, error: '' });
}

test('existing workspaces provision automatically; steady reconciliation and disabled bindings do not recreate subscriptions', () => run(`
  const a = connect('automatic');
  assert.equal(webhookOrigin(), 'https://app.example.com');
  await setupWebhooks();
  assert.equal(state(a.user).status, 'active');
  assert.equal(state(a.user).enabled, 1);
  assert.equal(counts.creates, 1);
  assert.equal(counts.tests, 1);
  assert.equal(counts.activations, 1);
  assert.equal(db.query('SELECT count(*) AS n FROM webhook_work').get().n, 0);
  due();
  await setupWebhooks();
  assert.equal(counts.creates, 1);
  assert.equal(counts.tests, 1);
  await configureWebhook(a.user.id, 'https://app.example.com', 'disable');
  due();
  await setupWebhooks();
  assert.equal(state(a.user).status, 'disabled');
  assert.equal(state(a.user).enabled, 0);
  assert.equal(counts.activations, 1);
`));

test('lost creation responses, missing delivery, invalid signatures and stale tests retry without duplicates or early activation', () => run(`
  const a = connect('retries');
  loseCreate = true;
  await setupWebhooks();
  assert.equal(state(a.user).status, 'pending');
  assert.equal(counts.creates, 1);
  await setupWebhooks();
  assert.equal(counts.creates, 1);
  for (const mode of ['missing', 'bad-signature', 'old']) {
    testMode = mode;
    due();
    await setupWebhooks();
    assert.equal(state(a.user).status, 'pending');
    assert.equal(state(a.user).enabled, 0);
    assert.equal(counts.creates, 1);
    assert.equal(counts.activations, 0);
  }
  testMode = 'valid';
  due();
  await setupWebhooks();
  assert.equal(state(a.user).status, 'active');
  assert.equal(counts.creates, 1);
  const hook = [...hooks.values()][0];
  hook.isActive = false;
  due();
  await setupWebhooks();
  assert.equal(hook.isActive, true);
  assert.equal(counts.tests, 5);
`));

test('permissions failures are workspace-scoped; localhost does not attempt automatic provider setup', () => run(`
  const a = connect('needs-consent');
  const b = connect('has-consent');
  deniedOwner = a.owner;
  Bun.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/api/auth/google/callback';
  await setupWebhooks();
  assert.equal(counts.creates, 0);
  Bun.env.GOOGLE_REDIRECT_URI = 'https://app.example.com/api/auth/google/callback';
  await setupWebhooks();
  assert.equal(state(a.user).status, 'reconnect');
  assert.equal(state(a.user).enabled, 0);
  assert.equal(state(b.user).status, 'active');
  assert.equal([...hooks.values()][0].owner, b.owner);
  assert.equal(counts.creates, 1);
`));

test('new public origins rotate binding secrets, remove obsolete callbacks, and require a fresh test', () => run(`
  const a = connect('origin-change');
  await setupWebhooks();
  const old = [...hooks.values()][0];
  Bun.env.GOOGLE_REDIRECT_URI = 'https://new.example.com/api/auth/google/callback';
  due();
  await setupWebhooks();
  assert.equal((await deliver(old)).status, 404);
  assert.equal(hooks.size, 0);
  assert.equal(db.query('SELECT count(*) AS n FROM webhook_cleanup').get().n, 0);
  await setupWebhooks();
  const replacement = [...hooks.values()][0];
  assert.notEqual(replacement.secret, old.secret);
  assert.equal(new URL(replacement.url).origin, 'https://new.example.com');
  assert.equal(counts.tests, 2);
  assert.equal(state(a.user).status, 'active');
`));

test('revoked refresh grants request user reauthorization instead of silently widening access', () => run(`
  const a = connect('revoked-grant');
  db.query('INSERT INTO zernio_clients VALUES (?, ?)').run(Bun.env.ZERNIO_REDIRECT_URI, 'client');
  db.query('UPDATE zernio_connections SET expires_at = 0 WHERE user_id = ?').run(a.user.id);
  globalThis.fetch = async (input) => {
    assert.equal(String(input), 'https://zernio.com/api/oauth/token');
    return Response.json({ error: 'invalid_grant' }, { status: 400 });
  };
  await setupWebhooks();
  assert.equal(state(a.user).status, 'reconnect');
  assert.equal(state(a.user).enabled, 0);
  assert.equal(counts.creates, 0);
`));

test('reconnect during a test and disconnect during activation cannot leave obsolete subscriptions active', () => run(`
  const a = connect('connection-races');
  reconnectDuringTest = true;
  await setupWebhooks();
  assert.equal(counts.activations, 0);
  assert.equal(hooks.size, 0);
  assert.equal(state(a.user).status, 'pending');
  disconnectDuringActivation = true;
  await setupWebhooks();
  assert.equal(hooks.size, 0);
  assert.equal(db.query('SELECT count(*) AS n FROM webhook_bindings').get().n, 0);
  assert.equal(db.query('SELECT count(*) AS n FROM webhook_cleanup').get().n, 0);
`));

test('OAuth callback atomically queues setup without making provider subscription requests', () => run(`
  const session = createSession('oauth-new', 'oauth@example.com', 'OAuth');
  const oauthState = 'oauth-state';
  db.query('INSERT INTO zernio_clients VALUES (?, ?)').run(Bun.env.ZERNIO_REDIRECT_URI, 'client');
  db.query('INSERT INTO zernio_attempts VALUES (?, ?, ?, ?)').run(Bun.CryptoHasher.hash('sha256', oauthState, 'hex'), session.user.id, 'verifier', Math.floor(Date.now()/1000)+600);
  const providerFetch = globalThis.fetch;
  globalThis.fetch = async (input, init) => String(input).endsWith('/oauth/token')
    ? Response.json({ access_token: 'oauth-owner', refresh_token: 'refresh', expires_in: 3600 }) : providerFetch(input, init);
  const response = await zernio.request('/api/zernio/callback?state='+oauthState+'&code=approved', {
    headers: { Cookie: 'cl_session='+session.token+'; cl_zernio_oauth='+oauthState },
  });
  assert.equal(response.status, 302);
  assert.equal(stateForUser().status, 'pending');
  assert.equal(stateForUser().enabled, 0);
  assert.equal(counts.creates, 0);
  function stateForUser() { return db.query('SELECT s.status, b.enabled FROM webhook_setup s JOIN webhook_bindings b ON b.id = s.binding_id WHERE b.user_id = ?').get(session.user.id); }
`));

test('concurrent token refreshes share one request and cannot overwrite a replacement connection', () => run(`
  const a = connect('refresh-race');
  db.query('INSERT INTO zernio_clients VALUES (?, ?)').run(Bun.env.ZERNIO_REDIRECT_URI, 'client');
  db.query('UPDATE zernio_connections SET expires_at = 0 WHERE user_id = ?').run(a.user.id);
  let release;
  let calls = 0;
  const gate = new Promise(resolve => { release = resolve; });
  globalThis.fetch = async () => { calls++; await gate; return Response.json({ access_token: 'old-result', refresh_token: 'old-refresh-result', expires_in: 3600 }); };
  const first = accessToken(a.user.id);
  const second = accessToken(a.user.id);
  const settled = Promise.allSettled([first, second]);
  db.query('UPDATE zernio_connections SET access_token = ?, refresh_token = ?, expires_at = 9999999999 WHERE user_id = ?').run(encrypt('replacement'), encrypt('replacement-refresh'), a.user.id);
  release();
  assert((await settled).every(result => result.status === 'rejected'));
  assert.equal(calls, 1);
  assert.equal(decrypt(db.query('SELECT access_token FROM zernio_connections WHERE user_id = ?').get(a.user.id).access_token), 'replacement');
`));

test('setup resumes from SQLite after a process restart without creating a second provider subscription', async () => {
  const { mkdtempSync, rmSync } = await import('node:fs');
  const dir = mkdtempSync('/tmp/opencode/comment-lookout-setup-');
  const env = { DATABASE_PATH: `${dir}/test.sqlite`, FIXTURE_HOOKS: `${dir}/provider.json` };
  try {
    run(`
      const a = connect('setup-restart');
      loseCreate = true;
      await setupWebhooks();
      assert.equal(state(a.user).status, 'pending');
      assert.equal(counts.creates, 1);
      await Bun.write(Bun.env.FIXTURE_HOOKS, JSON.stringify([...hooks.entries()]));
    `, env);
    run(`
      for (const [id, hook] of await Bun.file(Bun.env.FIXTURE_HOOKS).json()) hooks.set(id, hook);
      due();
      await setupWebhooks();
      const user = db.query("SELECT id FROM users WHERE google_sub = 'setup-restart'").get();
      assert.equal(state(user).status, 'active');
      assert.equal(counts.creates, 0);
      assert.equal(counts.tests, 1);
      db.query('DELETE FROM users WHERE id = ?').run(user.id);
      assert.equal(db.query('SELECT count(*) AS n FROM webhook_setup').get().n, 0);
    `, env);
  } finally { rmSync(dir, { recursive: true }); }
});
