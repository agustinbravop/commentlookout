import { db } from '../server/db';
import { accessToken, decrypt, ownerId, zernioGet } from '../server/zernio';
import { prepareWebhookBinding, ZERNIO_WEBHOOK_EVENTS } from '../server/webhooks';

// Operator-only: credentials and endpoint secrets never leave the server except to Zernio.
export async function configureWebhook(userId: string, origin: string, action: 'register' | 'test' | 'activate' | 'disable' = 'register') {
  const activate = action === 'activate';
  const base = new URL(origin);
  if (base.protocol !== 'https:' || base.username || base.password || base.pathname !== '/' || base.search || base.hash) throw new Error('A public HTTPS origin is required');
  const connection = db.prepare('SELECT owner_id FROM zernio_connections WHERE user_id = ?').get(userId) as { owner_id: string } | null;
  if (!connection) throw new Error('Current owner connection required');
  let binding = db.prepare('SELECT id, encrypted_secret FROM webhook_bindings WHERE user_id = ? AND owner_id = ? ORDER BY rowid LIMIT 1')
    .get(userId, connection.owner_id) as { id: string; encrypted_secret: string } | null;
  // Local rollback must work even if OAuth or the provider is unavailable.
  if (action === 'disable' && binding) db.transaction(() => {
    db.prepare('UPDATE webhook_bindings SET enabled = 0 WHERE id = ?').run(binding!.id);
    db.prepare("UPDATE webhook_setup SET status = 'disabled' WHERE binding_id = ?").run(binding!.id);
  })();
  const token = await accessToken(userId);
  if (!token || await ownerId(token) !== connection.owner_id) throw new Error('Current owner connection required');
  const settings = await zernioGet(token, '/webhooks/settings') as { webhooks?: { _id: string; url: string; isActive: boolean; events?: string[] }[] };
  if (!Array.isArray(settings.webhooks)) throw new Error('Invalid webhook settings');
  if (!binding) {
    if (action !== 'register') throw new Error('Register and verify a test delivery first');
    const id = prepareWebhookBinding(userId, crypto.randomUUID() + crypto.randomUUID());
    binding = db.prepare('SELECT id, encrypted_secret FROM webhook_bindings WHERE id = ?').get(id) as NonNullable<typeof binding>;
  }
  const url = `${base.origin}/api/webhooks/zernio/${binding.id}`;
  const remote = settings.webhooks.find((hook) => hook.url === url);
  if (action !== 'register' && action !== 'disable' && !remote) throw new Error('Register and verify a test delivery first');
  if (action === 'disable') {
    if (remote) {
      const response = await fetch('https://zernio.com/api/v1/webhooks/settings', {
        method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ webhookId: remote._id, isActive: false }), signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok || (await response.json() as { success?: boolean }).success !== true) throw new Error('Provider deactivation not confirmed');
    }
    return { bindingId: binding.id, url, active: false };
  }
  if (activate && !db.prepare("SELECT 1 FROM webhook_events WHERE binding_id = ? AND (event_type = 'webhook.test' OR is_test = 1)").get(binding.id)) throw new Error('A signed test delivery is required before activation');
  const events = [...new Set([...(remote?.events ?? []), ...ZERNIO_WEBHOOK_EVENTS])];
  const updateEvents = action === 'register' && remote && ZERNIO_WEBHOOK_EVENTS.some((event) => !remote.events?.includes(event));
  if (!remote || activate || updateEvents) {
    const response = await fetch('https://zernio.com/api/v1/webhooks/settings', {
      method: remote ? 'PUT' : 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(remote ? { webhookId: remote._id, events, ...(activate ? { isActive: true } : {}) } : {
        name: 'Comment Lookout', url, secret: decrypt(binding.encrypted_secret), events, isActive: false,
      }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Webhook configuration returned ${response.status}; inspect settings before retrying`);
    const result = await response.json() as { success?: boolean };
    if (result.success !== true) throw new Error('Webhook configuration not confirmed; inspect settings before retrying');
  }
  if (!db.prepare(`UPDATE webhook_bindings SET enabled = 1 WHERE id = ? AND owner_id = ?
    AND EXISTS (SELECT 1 FROM zernio_connections WHERE user_id = ? AND owner_id = ?)`).run(binding.id, connection.owner_id, userId, connection.owner_id).changes) throw new Error('Connection changed; disable the remote webhook');
  if (action === 'register') db.prepare("UPDATE webhook_setup SET status = 'pending', next_attempt_at = 0 WHERE binding_id = ?").run(binding.id);
  if (activate) db.prepare("UPDATE webhook_setup SET status = 'active', test_verified = 1 WHERE binding_id = ?").run(binding.id);
  if (action === 'test') {
    const response = await fetch('https://zernio.com/api/v1/webhooks/test', {
      method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ webhookId: remote!._id }), signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok) throw new Error(`Webhook test returned ${response.status}`);
    if (!db.prepare("SELECT 1 FROM webhook_events WHERE binding_id = ? AND event_type = 'webhook.test'").get(binding.id)) throw new Error('Signed test not received; check public ingress and retry');
  }
  return { bindingId: binding.id, url, active: activate || remote?.isActive === true };
}

if (import.meta.main) {
  const [userId, origin, mode, ...extra] = Bun.argv.slice(2);
  if (!userId || !origin || (mode !== undefined && mode !== '--activate' && mode !== '--test' && mode !== '--disable') || extra.length) {
    console.error('Usage: bun scripts/zernio-webhook.ts <workspace-user-id> <https-origin> [--test|--activate|--disable]');
    process.exitCode = 1;
  } else {
    try { console.log(await configureWebhook(userId, origin, mode === '--activate' ? 'activate' : mode === '--test' ? 'test' : mode === '--disable' ? 'disable' : 'register')); }
    catch (error) { console.error(mode === '--disable' ? 'Could not complete disable; local intake may already be off. Check Zernio for remote deactivation.' : error instanceof Error ? error.message : 'Webhook setup failed'); process.exitCode = 1; }
  }
}
