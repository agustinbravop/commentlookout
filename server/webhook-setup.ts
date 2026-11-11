import { randomBytes } from 'node:crypto';
import { db, queueWebhookSetup } from './db';
import { accessToken, decrypt, encrypt, ownerId } from './zernio';
import { ZERNIO_WEBHOOK_EVENTS } from './webhooks';
import { notifyWorkspace } from './events';

type Remote = { _id: string; url: string; isActive: boolean; events: string[] };
type Job = { binding_id: string; user_id: string; owner_id: string; encrypted_secret: string; callback_url: string;
  webhook_id: string | null; status: string; test_verified: number; attempts: number };
const now = () => Math.floor(Date.now() / 1000);
let running = false;

export function webhookOrigin() {
  try {
    const url = new URL(Bun.env.GOOGLE_REDIRECT_URI || '');
    return url.protocol === 'https:' && !url.username && !url.password && url.hostname !== 'localhost' ? url.origin : null;
  } catch { return null; }
}

async function request(token: string, method: string, path: string, body?: unknown) {
  const response = await fetch(`https://zernio.com/api/v1${path}`, {
    method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw Object.assign(new Error('Webhook provider request failed'), { status: response.status });
  const result = await response.json() as { success?: boolean; webhooks?: unknown };
  if (method !== 'GET' && result.success !== true) throw new Error('Webhook write unconfirmed');
  return result;
}

async function subscriptions(token: string) {
  const result = await request(token, 'GET', '/webhooks/settings');
  if (!Array.isArray(result.webhooks) || result.webhooks.some((hook) => !hook || typeof hook._id !== 'string' ||
    !hook._id || typeof hook.url !== 'string' || typeof hook.isActive !== 'boolean' ||
    !Array.isArray(hook.events) || hook.events.some((event: unknown) => typeof event !== 'string'))) throw new Error('Invalid webhook settings');
  return result.webhooks as Remote[];
}

const current = (job: Job) => !!db.prepare(`SELECT 1 FROM webhook_setup s JOIN webhook_bindings b ON b.id = s.binding_id
  JOIN zernio_connections z ON z.user_id = b.user_id AND z.owner_id = b.owner_id
  WHERE s.binding_id = ? AND b.user_id = ? AND b.owner_id = ? AND s.status != 'disabled' AND s.callback_url = ?`)
  .get(job.binding_id, job.user_id, job.owner_id, job.callback_url);

// Cleanup records contain resource IDs/URLs, never credentials. Revoked grants wait for a same-owner reconnect.
export async function cleanupWebhookSubscriptions(userId: string, owner: string, token: string) {
  const jobs = db.prepare('SELECT binding_id, callback_url FROM webhook_cleanup WHERE user_id = ? AND owner_id = ? AND next_attempt_at <= ? LIMIT 5')
    .all(userId, owner, now()) as { binding_id: string; callback_url: string }[];
  if (!jobs.length) return;
  for (const job of jobs) db.prepare('UPDATE webhook_cleanup SET next_attempt_at = ? WHERE binding_id = ?').run(now() + 60, job.binding_id);
  if (await ownerId(token) !== owner) throw new Error('Cleanup owner changed');
  const hooks = await subscriptions(token);
  for (const job of jobs) {
    for (const hook of hooks.filter((hook) => hook.url === job.callback_url)) {
      await request(token, 'DELETE', `/webhooks/settings?webhookId=${encodeURIComponent(hook._id)}`);
    }
    db.prepare('DELETE FROM webhook_cleanup WHERE binding_id = ?').run(job.binding_id);
  }
}

async function provision(job: Job) {
  let token: string | null = null;
  let remote: Remote | undefined;
  try {
    token = await accessToken(job.user_id);
    if (!token || !current(job) || await ownerId(token) !== job.owner_id) throw new Error('Connection changed');
    const hooks = await subscriptions(token);
    if (!current(job)) return;
    const matches = hooks.filter((hook) => hook.url === job.callback_url);
    if (matches.length > 1) throw new Error('Duplicate callback configuration');
    remote = matches[0];
    if (job.status === 'active' && job.test_verified && remote?.isActive && remote._id === job.webhook_id &&
      ZERNIO_WEBHOOK_EVENTS.every((event) => remote!.events.includes(event))) {
      db.prepare('UPDATE webhook_setup SET next_attempt_at = ?, attempts = 0 WHERE binding_id = ?').run(now() + 600, job.binding_id);
      return;
    }
    db.prepare("UPDATE webhook_setup SET status = 'pending', test_verified = 0 WHERE binding_id = ?").run(job.binding_id);
    db.prepare('UPDATE webhook_bindings SET enabled = 0 WHERE id = ?').run(job.binding_id);
    const events = [...new Set([...(remote?.events ?? []), ...ZERNIO_WEBHOOK_EVENTS])];
    await request(token, remote ? 'PUT' : 'POST', '/webhooks/settings', {
      ...(remote ? { webhookId: remote._id } : { name: 'Comment Lookout', url: job.callback_url }),
      secret: decrypt(job.encrypted_secret), events, isActive: false,
    });
    if (!current(job)) return;
    // Reconcile by the durable callback URL, including after an ambiguous creation response or pod restart.
    const registered = (await subscriptions(token)).filter((hook) => hook.url === job.callback_url);
    if (!current(job)) return;
    if (registered.length !== 1 || registered[0]!.isActive) throw new Error('Inactive subscription not confirmed');
    remote = registered[0]!;
    db.transaction(() => {
      db.prepare(`UPDATE webhook_setup SET webhook_id = ?, status = 'testing', test_started_at = ?, test_verified = 0 WHERE binding_id = ?`)
        .run(remote!._id, Math.floor(Date.now() / 1000) * 1000, job.binding_id);
      db.prepare('UPDATE webhook_bindings SET enabled = 1 WHERE id = ?').run(job.binding_id);
    })();
    await request(token, 'POST', '/webhooks/test', { webhookId: remote._id });
    if (!current(job)) return;
    const proof = db.prepare("SELECT 1 FROM webhook_setup WHERE binding_id = ? AND status = 'testing' AND test_verified = 1").get(job.binding_id);
    if (!proof) throw new Error('Signed test not received');
    await request(token, 'PUT', '/webhooks/settings', { webhookId: remote._id, isActive: true });
    if (!current(job)) return;
    db.prepare("UPDATE webhook_setup SET status = 'active', next_attempt_at = ?, attempts = 0 WHERE binding_id = ?")
      .run(now() + 600, job.binding_id);
  } catch (error) {
    if (current(job)) {
      const reconnect = !!error && typeof error === 'object' &&
        (('status' in error && [401, 403].includes(Number(error.status))) || ('code' in error && error.code === 'invalid_grant'));
      db.prepare(`UPDATE webhook_setup SET status = ?, attempts = attempts + 1, next_attempt_at = ? WHERE binding_id = ?`)
        .run(reconnect ? 'reconnect' : 'pending', now() + Math.min(60 * 2 ** Math.min(job.attempts, 6), 3600), job.binding_id);
      db.prepare('UPDATE webhook_bindings SET enabled = 0 WHERE id = ?').run(job.binding_id);
      console.error('Zernio webhook setup pending', { reason: reconnect ? 'reauthorization required' : 'setup or delivery unconfirmed' });
    }
  } finally {
    notifyWorkspace(job.user_id);
    if (token && !current(job)) {
      // A disconnect/disable during a provider write must not leave a late activation behind.
      try {
        if (remote) await request(token, 'PUT', '/webhooks/settings', { webhookId: remote._id, isActive: false });
        await cleanupWebhookSubscriptions(job.user_id, job.owner_id, token);
      } catch { console.error('Zernio webhook cleanup pending'); }
    }
  }
}

export async function setupWebhooks() {
  const origin = webhookOrigin();
  if (running || !origin) return;
  running = true;
  try {
    const connections = db.prepare('SELECT user_id, owner_id FROM zernio_connections').all() as { user_id: string; owner_id: string }[];
    for (const connection of connections) {
      if (db.prepare(`SELECT 1 FROM webhook_setup s JOIN webhook_bindings b ON b.id = s.binding_id
        WHERE b.user_id = ? AND b.owner_id = ?`).get(connection.user_id, connection.owner_id)) continue;
      db.transaction(() => queueWebhookSetup(connection.user_id, encrypt(randomBytes(32).toString('base64url'))))();
    }
    const jobs = db.prepare(`SELECT s.*, b.user_id, b.owner_id, b.encrypted_secret FROM webhook_setup s
      JOIN webhook_bindings b ON b.id = s.binding_id JOIN zernio_connections z ON z.user_id = b.user_id AND z.owner_id = b.owner_id
      WHERE s.status != 'disabled' AND s.next_attempt_at <= ? ORDER BY s.next_attempt_at LIMIT 5`).all(now()) as Job[];
    for (const job of jobs) {
      const callback = `${origin}/api/webhooks/zernio/${job.binding_id}`;
      if (job.callback_url && job.callback_url !== callback) {
        db.transaction(() => {
          db.prepare('DELETE FROM webhook_bindings WHERE id = ?').run(job.binding_id);
          queueWebhookSetup(job.user_id, encrypt(randomBytes(32).toString('base64url')));
        })();
        continue;
      }
      if (!db.prepare(`UPDATE webhook_setup SET callback_url = ?, next_attempt_at = ? WHERE binding_id = ?
        AND status != 'disabled' AND next_attempt_at <= ?`).run(callback, now() + 300, job.binding_id, now()).changes) continue;
      job.callback_url = callback;
      await provision(job);
    }
    for (const connection of connections) {
      if (!db.prepare('SELECT 1 FROM webhook_cleanup WHERE user_id = ? AND owner_id = ? AND next_attempt_at <= ?')
        .get(connection.user_id, connection.owner_id, now())) continue;
      try {
        const token = await accessToken(connection.user_id);
        if (token) await cleanupWebhookSubscriptions(connection.user_id, connection.owner_id, token);
      } catch { console.error('Zernio webhook cleanup pending'); }
    }
  } catch { console.error('Zernio webhook setup pending'); }
  finally { running = false; }
}
