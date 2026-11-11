import { createHmac, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { db } from './db';
import { decrypt, encrypt } from './zernio';

type Binding = { id: string; user_id: string; owner_id: string; encrypted_secret: string };
export const ZERNIO_WEBHOOK_EVENTS = ['comment.received', 'post.external.created', 'account.connected', 'account.disconnected', 'account.permissions_changed'];
export function prepareWebhookBinding(userId: string, secret: string) {
  if (secret.length < 32 || secret.length > 1024) throw new Error('Invalid endpoint secret');
  const connection = db.prepare('SELECT owner_id FROM zernio_connections WHERE user_id = ?').get(userId) as { owner_id: string } | null;
  if (!connection) throw new Error('Current connection required');
  const id = crypto.randomUUID();
  db.prepare('INSERT INTO webhook_bindings (id, user_id, owner_id, encrypted_secret) VALUES (?, ?, ?, ?)')
    .run(id, userId, connection.owner_id, encrypt(secret));
  return id;
}
const currentBinding = (id: string) => db.prepare(`SELECT b.* FROM webhook_bindings b JOIN zernio_connections z
  ON z.user_id = b.user_id AND z.owner_id = b.owner_id WHERE b.id = ? AND b.enabled = 1`).get(id) as Binding | null;
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const identifier = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\x00-\x20\x7f]/.test(value);

export const webhooks = new Hono();
webhooks.post('/api/webhooks/zernio/:bindingId', async (c) => {
  c.header('Cache-Control', 'no-store');
  try {
    const binding = currentBinding(c.req.param('bindingId'));
    if (!binding) return c.json({ error: 'Not available' }, 404);
    const signature = c.req.header('X-Zernio-Signature');
    if (!signature || !/^[a-f0-9]{64}$/.test(signature)) return c.json({ error: 'Invalid signature' }, 401);
    const limit = 128 * 1024;
    const length = c.req.header('Content-Length');
    if (length && (!/^\d+$/.test(length) || Number(length) > limit)) return c.json({ error: 'Body too large' }, 413);
    const reader = c.req.raw.body?.getReader();
    if (!reader) return c.json({ error: 'Invalid event' }, 400);
    const chunks: Uint8Array[] = [];
    let size = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); }, 4000);
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > limit) { void reader.cancel().catch(() => {}); return c.json({ error: 'Body too large' }, 413); }
        chunks.push(chunk.value);
      }
    } finally { clearTimeout(timer); reader.releaseLock(); }
    if (timedOut) return c.json({ error: 'Body deadline exceeded' }, 408);
    const raw = Buffer.concat(chunks);
    const expected = createHmac('sha256', decrypt(binding.encrypted_secret)).update(raw).digest();
    if (!timingSafeEqual(expected, Buffer.from(signature, 'hex'))) return c.json({ error: 'Invalid signature' }, 401);
    if (c.req.header('Content-Type')?.split(';')[0]?.trim().toLowerCase() !== 'application/json') return c.json({ error: 'Invalid event' }, 400);
    let body: unknown;
    try { body = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)); }
    catch { return c.json({ error: 'Invalid event' }, 400); }
    if (!object(body) || !identifier(body.id) || !identifier(body.event) || typeof body.timestamp !== 'string' ||
      !Number.isFinite(Date.parse(body.timestamp)) || (body.test !== undefined && typeof body.test !== 'boolean') ||
      (c.req.header('X-Zernio-Event-Id') !== undefined && c.req.header('X-Zernio-Event-Id') !== body.id) ||
      (c.req.header('X-Zernio-Event') !== undefined && c.req.header('X-Zernio-Event') !== body.event)) return c.json({ error: 'Invalid event' }, 400);
    if (body.test !== true && body.event !== 'webhook.test' && db.prepare("SELECT 1 FROM webhook_setup WHERE binding_id = ? AND status != 'active'").get(binding.id)) {
      return c.json({ error: 'Webhook setup pending' }, 503);
    }
    let accountId: string | null = null;
    let platform: string | null = null;
    let postIds: string[] = [];
    let accountEvent: string | null = null;
    if (body.event === 'comment.received' && body.test !== true) {
      const { account, comment, post } = body;
      if (!object(account) || !object(comment) || (post != null && !object(post))) return c.json({ error: 'Invalid event' }, 400);
      const id = account.accountId ?? account.id;
      const sourcePlatform = account.platform ?? comment.platform;
      if (!identifier(id) || !identifier(sourcePlatform) ||
        (account.id != null && account.id !== id) ||
        (account.platform != null && comment.platform != null && account.platform !== comment.platform)) return c.json({ error: 'Invalid event' }, 400);
      for (const value of [post?.id, comment.postId, post?.platformPostId, comment.platformPostId]) {
        if (value != null && !identifier(value)) return c.json({ error: 'Invalid event' }, 400);
      }
      if ((post?.id != null && comment.postId != null && post.id !== comment.postId) ||
        (post?.platformPostId != null && comment.platformPostId != null && post.platformPostId !== comment.platformPostId)) return c.json({ error: 'Invalid event' }, 400);
      // A team can also contain unsupported platforms; acknowledge without monitoring them.
      accountId = ['instagram', 'youtube'].includes(sourcePlatform) ? id : null;
      platform = sourcePlatform as string;
      postIds = [post?.id ?? comment.postId, post?.platformPostId ?? comment.platformPostId].filter(identifier);
    }
    if (body.test !== true && (body.event === 'post.external.created' ||
      (body.event.startsWith('account.') && ZERNIO_WEBHOOK_EVENTS.includes(body.event)))) {
      const { account, post } = body;
      if (!object(account)) return c.json({ error: 'Invalid event' }, 400);
      const id = account.accountId ?? account.id;
      if (!identifier(id) || !/^[a-f\d]{24}$/i.test(id) || !identifier(account.platform) ||
        (account.id != null && account.id !== id)) return c.json({ error: 'Invalid event' }, 400);
      if (body.event === 'post.external.created' && (!object(post) || !identifier(post.id) || post.source !== 'external')) return c.json({ error: 'Invalid event' }, 400);
      if (['instagram', 'youtube'].includes(account.platform)) {
        accountId = id;
        platform = account.platform;
        if (body.event.startsWith('account.')) accountEvent = body.event;
      }
    }
    const event = body;
    const accepted = db.transaction(() => {
      const current = currentBinding(binding.id);
      if (!current || current.encrypted_secret !== binding.encrypted_secret || current.owner_id !== binding.owner_id || current.user_id !== binding.user_id) return false;
      const knownAccount = accountId && db.prepare('SELECT 1 FROM monitored_accounts WHERE user_id = ? AND account_id = ? AND platform = ?').get(binding.user_id, accountId, platform);
      if (accountId && !accountEvent && !knownAccount) return false;
      const now = Math.floor(Date.now() / 1000);
      db.prepare(`DELETE FROM webhook_events WHERE rowid IN (SELECT rowid FROM webhook_events WHERE received_at < ? ORDER BY received_at LIMIT 100)`).run(now - 7 * 86400);
      if (!db.prepare('INSERT OR IGNORE INTO webhook_events VALUES (?, ?, ?, ?, ?)').run(binding.id, event.id as string, event.event as string, event.test === true ? 1 : 0, now).changes) return true;
      if (event.event === 'webhook.test') db.prepare(`UPDATE webhook_setup SET test_verified = 1 WHERE binding_id = ?
        AND status = 'testing' AND test_started_at IS NOT NULL AND test_started_at <= ?`).run(binding.id, Date.parse(event.timestamp as string));
      if (accountId) {
        const target = postIds.find((id) => db.prepare(`SELECT 1 FROM monitored_posts p JOIN monitored_accounts a USING (user_id, account_id)
          WHERE p.user_id = ? AND p.account_id = ? AND p.post_id = ? AND (julianday(p.created_at) >= julianday(a.started_at)
          OR EXISTS (SELECT 1 FROM backfill_posts b WHERE b.user_id = p.user_id AND b.account_id = p.account_id AND b.post_id = p.post_id))`).get(binding.user_id, accountId, id)) ?? '';
        db.prepare(`INSERT INTO webhook_work (binding_id, account_id, platform, post_id, account_event) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(binding_id, account_id, post_id) DO UPDATE SET generation = generation + 1,
          account_event = COALESCE(excluded.account_event, webhook_work.account_event)`).run(binding.id, accountId, platform, target, accountEvent);
        if (accountEvent && knownAccount) db.prepare(`INSERT INTO webhook_account_state VALUES (?, ?, ?, 'checking')
          ON CONFLICT(binding_id, account_id) DO UPDATE SET status = 'checking'`).run(binding.id, accountId, platform);
      }
      return true;
    })();
    return accepted ? c.json({ received: true }) : c.json({ error: 'Not available' }, 404);
  } catch { return c.json({ error: 'Webhook pending' }, 503); }
});
