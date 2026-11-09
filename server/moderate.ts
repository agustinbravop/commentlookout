import { db } from './db';
import { accessToken, ownerId, zernioGet } from './zernio';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { getUser } from './db';

export const moderation = new Hono();
moderation.post('/api/comments/:accountId/:commentId/restore', async (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  if (![new URL(c.req.url).origin, Bun.env.APP_ORIGIN && new URL(Bun.env.APP_ORIGIN).origin].includes(c.req.header('origin'))) return c.json({ error: 'Invalid origin' }, 403);
  const { accountId, commentId } = c.req.param();
  const comment = db.prepare(`SELECT c.post_id, m.platform, z.owner_id FROM synced_comments c
    JOIN monitored_accounts m USING (user_id, account_id) JOIN zernio_connections z ON z.user_id = c.user_id
    WHERE c.user_id = ? AND c.account_id = ? AND c.comment_id = ? AND c.is_hidden = 1`).get(user.id, accountId, commentId) as { post_id: string; platform: string; owner_id: string } | null;
  if (!comment || comment.platform !== 'instagram') return c.json({ error: 'Hidden Instagram comment not found' }, 404);
  try {
    const token = await accessToken(user.id);
    if (!token || await ownerId(token) !== comment.owner_id) throw new Error('Connection changed');
    const accounts = await zernioGet(token, `/accounts?${new URLSearchParams({ search: accountId, platforms: 'instagram', status: 'connected', limit: '1' })}`) as { accounts?: { _id: string; platform: string }[] };
    if (!accounts.accounts?.some((account) => account._id === accountId && account.platform === 'instagram')) throw new Error('Account unavailable');
    if (!db.prepare('SELECT 1 FROM zernio_connections WHERE user_id = ? AND owner_id = ?').get(user.id, comment.owner_id)) throw new Error('Connection changed');
    db.prepare(`INSERT INTO moderation_jobs (user_id, account_id, comment_id, status) VALUES (?, ?, ?, 'restore_pending')
      ON CONFLICT(user_id, account_id, comment_id) DO UPDATE SET status = 'restore_pending'`).run(user.id, accountId, commentId);
    const query = new URLSearchParams({ accountId });
    const response = await fetch(`https://zernio.com/api/v1/inbox/comments/${encodeURIComponent(comment.post_id)}/${encodeURIComponent(commentId)}/hide?${query}`, {
      method: 'DELETE', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Zernio restore returned ${response.status}`);
    const result = await response.json() as { hidden?: boolean; commentId?: string };
    if (result.hidden !== false || result.commentId !== commentId) throw new Error('Restore not confirmed');
    db.transaction(() => {
      db.prepare("UPDATE moderation_jobs SET status = 'restored' WHERE user_id = ? AND account_id = ? AND comment_id = ?").run(user.id, accountId, commentId);
      db.prepare('UPDATE synced_comments SET is_hidden = 0 WHERE user_id = ? AND account_id = ? AND comment_id = ?').run(user.id, accountId, commentId);
    })();
    return c.json({ restored: true });
  } catch { return c.json({ error: 'Could not confirm restoration. Check Instagram before trying again.' }, 502); }
});

export async function moderateComments() {
  db.exec(`INSERT OR IGNORE INTO moderation_jobs (user_id, account_id, comment_id)
    SELECT c.user_id, c.account_id, c.comment_id FROM synced_comments c
    JOIN comment_assessments a USING (user_id, account_id, comment_id)
    JOIN monitored_accounts m USING (user_id, account_id)
    JOIN zernio_connections z ON z.user_id = c.user_id
    JOIN moderation_preferences p ON p.user_id = c.user_id AND p.account_id = c.account_id AND p.owner_id = z.owner_id
    WHERE p.enabled = 1 AND p.backfill_confirmed = 1 AND m.platform = 'instagram' AND c.is_hidden = 0
      AND (c.created_at >= m.started_at OR EXISTS (SELECT 1 FROM backfill_comments b WHERE b.user_id = c.user_id AND b.account_id = c.account_id AND b.comment_id = c.comment_id))
      AND a.classified_message = c.message AND a.category IN ('spam', 'scam', 'profanity')`);
  const jobs = db.prepare(`SELECT j.user_id, j.account_id, j.comment_id, c.post_id, c.message, z.owner_id
    FROM moderation_jobs j JOIN synced_comments c USING (user_id, account_id, comment_id)
    JOIN comment_assessments a USING (user_id, account_id, comment_id)
    JOIN monitored_accounts m USING (user_id, account_id)
    JOIN zernio_connections z ON z.user_id = j.user_id
    JOIN moderation_preferences p ON p.user_id = j.user_id AND p.account_id = j.account_id AND p.owner_id = z.owner_id
    WHERE j.status = 'pending' AND j.next_attempt_at <= ? AND p.enabled = 1 AND p.backfill_confirmed = 1
      AND m.platform = 'instagram' AND c.is_hidden = 0 AND a.classified_message = c.message
      AND (c.created_at >= m.started_at OR EXISTS (SELECT 1 FROM backfill_comments b WHERE b.user_id = c.user_id AND b.account_id = c.account_id AND b.comment_id = c.comment_id))
      AND a.category IN ('spam', 'scam', 'profanity') LIMIT 20`).all(Math.floor(Date.now() / 1000)) as {
        user_id: string; account_id: string; comment_id: string; post_id: string; message: string; owner_id: string;
      }[];
  for (const job of jobs) {
    try {
      const token = await accessToken(job.user_id);
      if (!token || await ownerId(token) !== job.owner_id) throw new Error('Connection ownership changed');
      const listed = await zernioGet(token, `/accounts?${new URLSearchParams({ search: job.account_id, platforms: 'instagram', status: 'connected', limit: '1' })}`) as { accounts?: { _id: string; platform: string }[] };
      if (!listed.accounts?.some((account) => account._id === job.account_id && account.platform === 'instagram')) throw new Error('Account unavailable');
      if (!db.prepare(`SELECT 1 FROM moderation_preferences p JOIN zernio_connections z ON z.user_id = p.user_id AND z.owner_id = p.owner_id
        JOIN synced_comments c ON c.user_id = p.user_id AND c.account_id = p.account_id
        JOIN comment_assessments a ON a.user_id = c.user_id AND a.account_id = c.account_id AND a.comment_id = c.comment_id
        WHERE p.user_id = ? AND p.account_id = ? AND p.owner_id = ? AND p.enabled = 1 AND p.backfill_confirmed = 1
          AND c.comment_id = ? AND c.message = ? AND c.is_hidden = 0 AND a.classified_message = c.message AND a.category IN ('spam', 'scam', 'profanity')`)
        .get(job.user_id, job.account_id, job.owner_id, job.comment_id, job.message)) continue;
      const response = await fetch(`https://zernio.com/api/v1/inbox/comments/${encodeURIComponent(job.post_id)}/${encodeURIComponent(job.comment_id)}/hide`, {
        method: 'POST', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: job.account_id }),
      });
      if (!response.ok) throw new Error(`Zernio hide returned ${response.status}`);
      const result = await response.json() as { hidden?: boolean; commentId?: string };
      if (result.hidden !== true || result.commentId !== job.comment_id) throw new Error('Hide not confirmed');
      db.transaction(() => {
        db.prepare("UPDATE moderation_jobs SET status = 'done' WHERE user_id = ? AND account_id = ? AND comment_id = ?").run(job.user_id, job.account_id, job.comment_id);
        db.prepare('UPDATE synced_comments SET is_hidden = 1 WHERE user_id = ? AND account_id = ? AND comment_id = ?').run(job.user_id, job.account_id, job.comment_id);
      })();
    } catch (error) {
      db.prepare('UPDATE moderation_jobs SET next_attempt_at = ? WHERE user_id = ? AND account_id = ? AND comment_id = ?')
        .run(Math.floor(Date.now() / 1000) + 600, job.user_id, job.account_id, job.comment_id);
      console.error('Comment moderation pending', { reason: error instanceof Error ? error.message : 'Unknown error' });
    }
  }
}
