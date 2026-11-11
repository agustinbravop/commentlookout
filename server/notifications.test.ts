import { expect, spyOn, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';

const originalDatabase = Bun.env.DATABASE_PATH;
Bun.env.DATABASE_PATH = ':memory:';
const { db, createSession, getUser } = await import('./db');
if (originalDatabase === undefined) delete Bun.env.DATABASE_PATH;
else Bun.env.DATABASE_PATH = originalDatabase;
const { sendSignupNotification } = await import('./notifications');

const production = 'https://commentlookout.agusbravo.dev/api/auth/google/callback';
const webhook = 'https://discord.com/api/webhooks/123/test-token';
const pending = (id: string) => db.prepare('SELECT * FROM signup_notifications WHERE user_id = ?').get(id) as
  { attempts: number; next_attempt_at: number; delivered_at: number | null } | null;

test('only enabled production signups enqueue; sessions and queue are atomic and deletion cascades', () => {
  const oldUrl = Bun.env.DISCORD_SIGNUP_WEBHOOK_URL;
  const oldRedirect = Bun.env.GOOGLE_REDIRECT_URI;
  try {
    delete Bun.env.DISCORD_SIGNUP_WEBHOOK_URL;
    Bun.env.GOOGLE_REDIRECT_URI = production;
    const old = createSession('notify-before-enable', 'old@example.com', 'Old');
    expect(pending(old.user.id)).toBeNull();
    Bun.env.DISCORD_SIGNUP_WEBHOOK_URL = webhook;
    expect(createSession('notify-before-enable', 'old@example.com', 'Old').user.id).toBe(old.user.id);
    expect(pending(old.user.id)).toBeNull();
    for (const redirect of ['http://localhost:3000/api/auth/google/callback', '', 'invalid',
      'https://commentlookout.agusbravo.dev.evil.test/callback', 'https://commentlookout.agusbravo.dev@evil.test/']) {
      Bun.env.GOOGLE_REDIRECT_URI = redirect;
      expect(pending(createSession(crypto.randomUUID(), 'local@example.com', 'Local').user.id)).toBeNull();
    }
    Bun.env.GOOGLE_REDIRECT_URI = production;
    // Invalid webhook configuration is a worker concern, never a login failure.
    Bun.env.DISCORD_SIGNUP_WEBHOOK_URL = 'invalid';
    const first = createSession('notify-first', 'first@example.com', 'First');
    expect(pending(first.user.id)?.attempts).toBe(0);
    const returning = createSession('notify-first', 'updated@example.com', 'Updated');
    expect(returning.user.id).toBe(first.user.id);
    expect(getUser(first.token)?.email).toBe('updated@example.com');
    expect(pending(first.user.id)?.attempts).toBe(0);
    db.prepare('DELETE FROM users WHERE id = ?').run(first.user.id);
    expect(pending(first.user.id)).toBeNull();
    expect(getUser(returning.token)).toBeNull();

    const sessions = db.prepare('SELECT count(*) AS count FROM sessions').get();
    db.exec(`CREATE TEMP TRIGGER fail_signup BEFORE INSERT ON signup_notifications BEGIN SELECT RAISE(ABORT, 'test'); END`);
    try {
      expect(() => createSession('notify-rollback', 'rollback@example.com', 'Rollback')).toThrow();
      expect(db.prepare("SELECT id FROM users WHERE google_sub = 'notify-rollback'").get()).toBeNull();
      expect(db.prepare('SELECT count(*) AS count FROM sessions').get()).toEqual(sessions);
    } finally { db.exec('DROP TRIGGER fail_signup'); }
  } finally {
    if (oldUrl === undefined) delete Bun.env.DISCORD_SIGNUP_WEBHOOK_URL; else Bun.env.DISCORD_SIGNUP_WEBHOOK_URL = oldUrl;
    if (oldRedirect === undefined) delete Bun.env.GOOGLE_REDIRECT_URI; else Bun.env.GOOGLE_REDIRECT_URI = oldRedirect;
  }
});

test('outbox survives a process restart without enqueueing returning users', () => {
  const directory = mkdtempSync('/tmp/opencode/discord-signup-test-');
  try {
    const env = { DATABASE_PATH: `${directory}/test.sqlite`, GOOGLE_REDIRECT_URI: production, DISCORD_SIGNUP_WEBHOOK_URL: webhook };
    for (let i = 0; i < 2; i++) {
      const result = Bun.spawnSync([process.execPath, '--eval', `
        const { db, createSession } = await import('./server/db');
        const before = db.prepare('SELECT count(*) AS n FROM signup_notifications').get().n;
        if (before !== ${i}) throw new Error('restart lost queue');
        createSession('persistent', 'restart@example.com', 'Restart');
        const after = db.prepare('SELECT count(*) AS n FROM signup_notifications').get().n;
        if (after !== 1) throw new Error('duplicate or missing queue');
        db.close();
      `], { cwd: process.cwd(), env, stdout: 'pipe', stderr: 'pipe' });
      expect(result.exitCode).toBe(0);
    }
  } finally { rmSync(directory, { recursive: true }); }
});

test('worker escapes bounded fields, confirms delivery, prevents overlaps and tolerates deletion during fetch', async () => {
  const oldUrl = Bun.env.DISCORD_SIGNUP_WEBHOOK_URL;
  const oldRedirect = Bun.env.GOOGLE_REDIRECT_URI;
  const originalFetch = globalThis.fetch;
  try {
    Bun.env.DISCORD_SIGNUP_WEBHOOK_URL = webhook;
    Bun.env.GOOGLE_REDIRECT_URI = production;
    db.exec('DELETE FROM signup_notifications');
    const name = '[click](https://evil.test) <https://evil.test> @everyone <@123> **`text`** ';
    const { user } = createSession('notify-payload', `${name.repeat(40)}@example.com`, name);
    const created = db.prepare('SELECT created_at FROM users WHERE id = ?').get(user.id) as { created_at: number };
    let resolve!: (response: Response) => void;
    let calls = 0;
    globalThis.fetch = (async (input, init) => {
      calls++;
      expect(String(input)).toBe(`${webhook}?wait=true`);
      expect(init?.redirect).toBe('error');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      const payload = JSON.parse(String(init?.body));
      expect(payload.allowed_mentions).toEqual({ parse: [] });
      expect(payload.username).toBe('Comment Lookout');
      expect(payload.embeds[0].timestamp).toBe(new Date(created.created_at * 1000).toISOString());
      expect(payload.embeds[0].fields[2]).toEqual({ name: 'Environment', value: 'Production' });
      for (const field of payload.embeds[0].fields.slice(0, 2)) {
        expect(field.value.length).toBeLessThanOrEqual(1024);
        expect(field.value).toContain('\\[click\\]\\(https:\u200b/\u200b/\u200bevil.\u200btest\\)');
        expect(field.value).not.toContain('@everyone');
        expect(field.value).not.toContain('<https://');
        expect(field.value).not.toContain('<@123>');
      }
      expect(payload.embeds[0].url).toBeUndefined();
      expect(payload.avatar_url).toBeUndefined();
      return await new Promise<Response>((done) => { resolve = done; });
    }) as typeof fetch;
    const first = sendSignupNotification();
    await sendSignupNotification();
    expect(calls).toBe(1);
    expect(pending(user.id)?.delivered_at).toBeNull();
    resolve(Response.json({ id: '12345' }));
    await first;
    expect(pending(user.id)?.delivered_at).toBeGreaterThan(0);
    await sendSignupNotification();
    expect(calls).toBe(1);

    const deleted = createSession('notify-deleted-in-flight', 'deleted@example.com', 'Deleted').user;
    globalThis.fetch = (async (_input: RequestInfo | URL) => await new Promise<Response>((done) => { resolve = done; })) as typeof fetch;
    const inflight = sendSignupNotification();
    db.prepare('DELETE FROM users WHERE id = ?').run(deleted.id);
    resolve(Response.json({ id: '6789' }));
    await inflight;
    expect(pending(deleted.id)).toBeNull();
  } finally {
    globalThis.fetch = originalFetch;
    if (oldUrl === undefined) delete Bun.env.DISCORD_SIGNUP_WEBHOOK_URL; else Bun.env.DISCORD_SIGNUP_WEBHOOK_URL = oldUrl;
    if (oldRedirect === undefined) delete Bun.env.GOOGLE_REDIRECT_URI; else Bun.env.GOOGLE_REDIRECT_URI = oldRedirect;
  }
});

test('failures retry with redacted logs, cooldown, rate limits, URL validation and redirect protection', async () => {
  const oldUrl = Bun.env.DISCORD_SIGNUP_WEBHOOK_URL;
  const oldRedirect = Bun.env.GOOGLE_REDIRECT_URI;
  const originalFetch = globalThis.fetch;
  let clock = Date.now();
  const time = spyOn(Date, 'now').mockImplementation(() => clock);
  const log = spyOn(console, 'error').mockImplementation(() => {});
  try {
    Bun.env.GOOGLE_REDIRECT_URI = production;
    const cases = [
      { status: 429, body: { retry_after: 120.5 }, minimum: 120_500 },
      { status: 429, body: { retry_after: -1 }, header: '180.25', minimum: 180_250 },
      { status: 429, body: { retry_after: 'Infinity' }, header: '90', minimum: 90_000 },
      { status: 429, body: { retry_after: null }, header: '-1', minimum: 60_000 },
      { status: 429, body: { retry_after: 0 }, minimum: 60_000 },
      { status: 500, body: { secret: 'private-response' }, minimum: 60_000 },
      { status: 404, body: {}, minimum: 3_600_000 },
      { status: 200, body: {}, minimum: 60_000 },
      { status: 302, body: {}, minimum: 60_000 },
      { status: 0, body: {}, minimum: 60_000 },
    ];
    for (const scenario of cases) {
      clock += 7_200_000;
      db.exec('DELETE FROM signup_notifications');
      Bun.env.DISCORD_SIGNUP_WEBHOOK_URL = webhook;
      const { user } = createSession(crypto.randomUUID(), 'private-email@example.com', 'Private name');
      let calls = 0;
      globalThis.fetch = (async (_input, init) => {
        calls++;
        expect(init?.redirect).toBe('error');
        if (!scenario.status) throw new Error(`${webhook} private-exception`);
        return Response.json(scenario.body, { status: scenario.status,
          headers: scenario.header ? { 'retry-after': scenario.header } : {} });
      }) as typeof fetch;
      await sendSignupNotification();
      const job = pending(user.id)!;
      expect(job.delivered_at).toBeNull();
      expect(job.attempts).toBe(1);
      expect(job.next_attempt_at).toBeGreaterThanOrEqual(clock + scenario.minimum);
      clock = job.next_attempt_at - 1;
      await sendSignupNotification();
      expect(calls).toBe(1);
      clock++;
      await sendSignupNotification();
      expect(calls).toBe(2);
      expect(pending(user.id)?.attempts).toBe(2);
      expect(pending(user.id)!.next_attempt_at).toBeGreaterThanOrEqual(clock + 120_000);
      clock = pending(user.id)!.next_attempt_at;
      db.prepare('UPDATE signup_notifications SET attempts = 99 WHERE user_id = ?').run(user.id);
      await sendSignupNotification();
      expect(pending(user.id)!.next_attempt_at).toBe(clock + 3_600_000);
      clock = pending(user.id)!.next_attempt_at;
      globalThis.fetch = (async (_input: RequestInfo | URL) => Response.json({ id: '999' })) as typeof fetch;
      await sendSignupNotification();
      expect(pending(user.id)?.delivered_at).toBe(clock);
    }
    for (const url of ['bad-url', 'http://discord.com/api/webhooks/123/test-token',
      'https://discord.com.evil.test/api/webhooks/123/test-token', 'https://user:pass@discord.com/api/webhooks/123/test-token',
      `${webhook}#fragment`, 'https://discord.com/api/users/123/test-token', 'https://discord.com:444/api/webhooks/123/test-token']) {
      clock += 7_200_000;
      db.exec('DELETE FROM signup_notifications');
      Bun.env.DISCORD_SIGNUP_WEBHOOK_URL = url;
      const { user } = createSession(crypto.randomUUID(), 'private-email@example.com', 'Private name');
      let calls = 0;
      globalThis.fetch = (async (_input: RequestInfo | URL): Promise<Response> => { calls++; throw new Error('must not fetch'); }) as typeof fetch;
      await sendSignupNotification();
      await sendSignupNotification();
      expect(calls).toBe(0);
      expect(pending(user.id)?.attempts).toBe(1);
      expect(pending(user.id)!.next_attempt_at).toBeGreaterThanOrEqual(clock + 3_600_000);
    }
    clock += 7_200_000;
    let calls = 0;
    globalThis.fetch = (async (_input: RequestInfo | URL): Promise<Response> => { calls++; throw new Error('must not fetch'); }) as typeof fetch;
    Bun.env.DISCORD_SIGNUP_WEBHOOK_URL = webhook;
    Bun.env.GOOGLE_REDIRECT_URI = 'http://localhost:3000/callback';
    await sendSignupNotification();
    Bun.env.GOOGLE_REDIRECT_URI = production;
    delete Bun.env.DISCORD_SIGNUP_WEBHOOK_URL;
    await sendSignupNotification();
    expect(calls).toBe(0);
    const logged = JSON.stringify(log.mock.calls);
    for (const secret of ['private-email', 'Private name', 'private-exception', 'private-response', 'test-token', 'user:pass']) {
      expect(logged).not.toContain(secret);
    }
    expect(logged).toContain('invalid configuration');
    expect(logged).toContain('rate limited');
    expect(logged).toContain('webhook unavailable');
  } finally {
    globalThis.fetch = originalFetch;
    time.mockRestore();
    log.mockRestore();
    if (oldUrl === undefined) delete Bun.env.DISCORD_SIGNUP_WEBHOOK_URL; else Bun.env.DISCORD_SIGNUP_WEBHOOK_URL = oldUrl;
    if (oldRedirect === undefined) delete Bun.env.GOOGLE_REDIRECT_URI; else Bun.env.GOOGLE_REDIRECT_URI = oldRedirect;
  }
});
