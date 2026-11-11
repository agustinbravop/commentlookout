import { db, signupNotificationsEnabled } from './db';

// Break automatic links as well as escaping Discord markdown and mention syntax.
function plain(value: string) {
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 300)
    .replace(/([\\`*_~|\[\]()<>])/g, '\\$1').replace(/([@.:/])/g, '$1\u200b');
}

let running = false;
let cooldownUntil = 0;

// shortcut: one service replica, add durable claiming before running multiple replicas.
export async function sendSignupNotification() {
  if (running || !signupNotificationsEnabled() || Date.now() < cooldownUntil) return;
  running = true;
  try {
    const job = db.prepare(`SELECT n.user_id, n.attempts, u.name, u.email, u.created_at
      FROM signup_notifications n JOIN users u ON u.id = n.user_id
      WHERE n.delivered_at IS NULL AND n.next_attempt_at <= ? ORDER BY n.next_attempt_at, u.created_at LIMIT 1`)
      .get(Date.now()) as { user_id: string; attempts: number; name: string; email: string; created_at: number } | null;
    if (!job) return;
    let delay = Math.min(60_000 * 2 ** Math.min(job.attempts, 6), 3_600_000);
    let reason = 'invalid configuration';
    try {
      const url = new URL(Bun.env.DISCORD_SIGNUP_WEBHOOK_URL!);
      if (url.protocol !== 'https:' || url.hostname !== 'discord.com' || url.port || url.username || url.password || url.hash
        || !/^\/api\/webhooks\/\d+\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
        throw new Error('Invalid configuration');
      }
      url.search = '?wait=true';
      reason = 'delivery failed';
      const response = await fetch(url, {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(10_000),
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          username: 'Comment Lookout', allowed_mentions: { parse: [] },
          embeds: [{ title: 'New signup', timestamp: new Date(job.created_at * 1000).toISOString(), fields: [
            { name: 'Name', value: plain(job.name) || '(empty)' },
            { name: 'Email', value: plain(job.email) || '(empty)' },
            { name: 'Environment', value: 'Production' },
          ] }],
        }),
      });
      const body = await response.json().catch(() => null);
      if (response.ok && typeof body?.id === 'string' && /^\d+$/.test(body.id)) {
        // An account deleted during the request must not recreate its outbox entry.
        db.prepare('UPDATE signup_notifications SET delivered_at = ?, attempts = attempts + 1 WHERE user_id = ?')
          .run(Date.now(), job.user_id);
        return;
      }
      if (response.status === 429) {
        const validDelay = (value: unknown) => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '')
          && Number.isFinite(Number(value) * 1000) && Number(value) >= 0 ? Number(value) * 1000 : null;
        const retry = validDelay(body?.retry_after) ?? validDelay(response.headers.get('retry-after'));
        if (retry !== null && Number.isFinite(retry) && Number.isFinite(Date.now() + retry)) delay = Math.max(delay, retry);
        reason = 'rate limited';
      } else if (response.status === 401 || response.status === 403 || response.status === 404) {
        reason = 'webhook unavailable';
        delay = Math.max(delay, 3_600_000);
      }
    } catch {
      // Never log webhook credentials, user fields, response bodies or exception messages.
    }
    if (reason === 'invalid configuration') delay = Math.max(delay, 3_600_000);
    cooldownUntil = Date.now() + delay;
    db.prepare('UPDATE signup_notifications SET attempts = attempts + 1, next_attempt_at = ? WHERE user_id = ?')
      .run(cooldownUntil, job.user_id);
    console.error('Discord signup notification pending', { reason });
  } catch {
    cooldownUntil = Date.now() + 60_000;
    console.error('Discord signup notification pending', { reason: 'queue unavailable' });
  } finally { running = false; }
}
