import { db, getUser } from './db';
import { accessToken, ownerId, zernioGet } from './zernio';
import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';

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
  let attempt: string | undefined;
  let claimed = false;
  try {
    const token = await accessToken(user.id);
    if (!token || await ownerId(token) !== comment.owner_id) throw new Error('Connection changed');
    const accounts = await zernioGet(token, `/accounts?${new URLSearchParams({ search: accountId, platforms: 'instagram', status: 'connected', limit: '1' })}`) as { accounts?: { _id: string; platform: string }[] };
    if (!accounts.accounts?.some((account) => account._id === accountId && account.platform === 'instagram')) throw new Error('Account unavailable');
    if (!db.prepare('SELECT 1 FROM zernio_connections WHERE user_id = ? AND owner_id = ?').get(user.id, comment.owner_id)) throw new Error('Connection changed');
    attempt = crypto.randomUUID();
    const claim = db.prepare(`INSERT INTO moderation_jobs (user_id, account_id, comment_id, status, restore_token, restore_started_at) VALUES (?, ?, ?, 'restore_pending', ?, ?)
      ON CONFLICT(user_id, account_id, comment_id) DO UPDATE SET status = 'restore_pending', restore_token = excluded.restore_token, restore_started_at = excluded.restore_started_at
      WHERE moderation_jobs.status IN ('done', 'restored')`).run(user.id, accountId, commentId, attempt, Math.floor(Date.now() / 1000));
    if (!claim.changes) return c.json({ error: 'Another moderation action needs checking first.' }, 409);
    claimed = true;
    const query = new URLSearchParams({ accountId });
    const response = await fetch(`https://zernio.com/api/v1/inbox/comments/${encodeURIComponent(comment.post_id)}/${encodeURIComponent(commentId)}/hide?${query}`, {
      method: 'DELETE', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}` },
    });
    if (!response.ok) throw new Error(`Zernio restore returned ${response.status}`);
    const result = await response.json() as { hidden?: boolean; commentId?: string };
    if (result.hidden !== false || result.commentId !== commentId) throw new Error('Restore not confirmed');
    db.transaction(() => {
      const updated = db.prepare("UPDATE moderation_jobs SET status = 'restored', action_at = ?, visibility_uncertain = 0 WHERE user_id = ? AND account_id = ? AND comment_id = ? AND status = 'restore_pending' AND restore_token = ?").run(new Date().toISOString(), user.id, accountId, commentId, attempt!);
      if (!updated.changes) throw new Error('Restore state changed');
      db.prepare('UPDATE synced_comments SET is_hidden = 0 WHERE user_id = ? AND account_id = ? AND comment_id = ?').run(user.id, accountId, commentId);
    })();
    return c.json({ restored: true });
  } catch {
    if (claimed) db.prepare("UPDATE moderation_jobs SET status = 'restore_unknown' WHERE user_id = ? AND account_id = ? AND comment_id = ? AND status = 'restore_pending' AND restore_token = ?").run(user.id, accountId, commentId, attempt!);
    return c.json({ status: claimed ? 'restore_unknown' : undefined, error: claimed ? 'Restoration unconfirmed. Check Instagram before deciding.' : 'Could not verify the account. Nothing was sent.' }, 502);
  }
});

moderation.post('/api/comments/:accountId/:commentId/restore/resolve', async (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  if (![new URL(c.req.url).origin, Bun.env.APP_ORIGIN && new URL(Bun.env.APP_ORIGIN).origin].includes(c.req.header('origin'))) return c.json({ error: 'Invalid origin' }, 403);
  const body = await c.req.json().catch(() => null) as { resolution?: unknown; attempt?: unknown } | null;
  if (!body || !['restored', 'hidden'].includes(String(body.resolution)) || typeof body.attempt !== 'string') return c.json({ error: 'Invalid resolution' }, 400);
  const attempt = body.attempt;
  const { accountId, commentId } = c.req.param();
  const changed = db.transaction(() => {
    const result = db.prepare(`UPDATE moderation_jobs SET status = ?, restore_token = NULL, action_at = ?, visibility_uncertain = 1 WHERE user_id = ? AND account_id = ? AND comment_id = ? AND restore_token = ?
      AND status IN ('restore_pending', 'restore_unknown') AND (status = 'restore_unknown' OR restore_started_at IS NULL OR restore_started_at <= ?)`)
      .run(body.resolution === 'restored' ? 'restored' : 'done', new Date().toISOString(), user.id, accountId, commentId, attempt, Math.floor(Date.now() / 1000) - 60);
    if (result.changes && body.resolution === 'restored') db.prepare('UPDATE synced_comments SET is_hidden = 0 WHERE user_id = ? AND account_id = ? AND comment_id = ?').run(user.id, accountId, commentId);
    return result.changes;
  })();
  return changed ? c.json({ status: body.resolution }) : c.json({ error: 'Attempt changed or may still be running. Refresh and check again.' }, 409);
});

moderation.post('/api/comments/:accountId/:commentId/hide/resolve', async (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  if (![new URL(c.req.url).origin, Bun.env.APP_ORIGIN && new URL(Bun.env.APP_ORIGIN).origin].includes(c.req.header('origin'))) return c.json({ error: 'Invalid origin' }, 403);
  const body = await c.req.json().catch(() => null) as { resolution?: unknown; attempt?: unknown } | null;
  if (!body || !['hidden', 'visible'].includes(String(body.resolution)) || typeof body.attempt !== 'string') return c.json({ error: 'Invalid resolution' }, 400);
  const { accountId, commentId } = c.req.param();
  const attempt = body.attempt;
  const changed = db.transaction(() => {
    const updated = db.prepare("UPDATE moderation_jobs SET status = ?, claim_token = NULL, claim_expires_at = NULL, action_at = ?, visibility_uncertain = 1, next_attempt_at = 0 WHERE user_id = ? AND account_id = ? AND comment_id = ? AND status = 'hide_unknown' AND claim_token = ?")
      .run(body.resolution === 'hidden' ? 'done' : 'pending', new Date().toISOString(), user.id, accountId, commentId, attempt);
    if (updated.changes) db.prepare('UPDATE synced_comments SET is_hidden = ? WHERE user_id = ? AND account_id = ? AND comment_id = ?').run(Number(body.resolution === 'hidden'), user.id, accountId, commentId);
    return updated.changes;
  })();
  return changed ? c.json({ status: body.resolution }) : c.json({ error: 'Attempt changed. Refresh and check again.' }, 409);
});

export async function moderateComments() {
  db.prepare("UPDATE moderation_jobs SET status = 'hide_unknown', visibility_uncertain = 1 WHERE status = 'hiding' AND claim_expires_at <= ?").run(Math.floor(Date.now() / 1000));
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
    const claim = crypto.randomUUID();
    const claimed = db.prepare(`UPDATE moderation_jobs SET status = 'hiding', claim_token = ?, claim_expires_at = ?
      WHERE user_id = ? AND account_id = ? AND comment_id = ? AND status = 'pending' AND next_attempt_at <= ?`).run(claim, Math.floor(Date.now() / 1000) + 60, job.user_id, job.account_id, job.comment_id, Math.floor(Date.now() / 1000));
    if (!claimed.changes) continue;
    let dispatched = false;
    try {
      const token = await accessToken(job.user_id);
      if (!token || await ownerId(token) !== job.owner_id) throw new Error('Connection ownership changed');
      const listed = await zernioGet(token, `/accounts?${new URLSearchParams({ search: job.account_id, platforms: 'instagram', status: 'connected', limit: '1' })}`) as { accounts?: { _id: string; platform: string }[] };
      if (!listed.accounts?.some((account) => account._id === job.account_id && account.platform === 'instagram')) throw new Error('Account unavailable');
      if (!db.prepare(`SELECT 1 FROM moderation_preferences p JOIN zernio_connections z ON z.user_id = p.user_id AND z.owner_id = p.owner_id
        JOIN synced_comments c ON c.user_id = p.user_id AND c.account_id = p.account_id
        JOIN comment_assessments a ON a.user_id = c.user_id AND a.account_id = c.account_id AND a.comment_id = c.comment_id
        JOIN moderation_jobs j ON j.user_id = c.user_id AND j.account_id = c.account_id AND j.comment_id = c.comment_id
        WHERE p.user_id = ? AND p.account_id = ? AND p.owner_id = ? AND p.enabled = 1 AND p.backfill_confirmed = 1
          AND c.comment_id = ? AND c.message = ? AND c.is_hidden = 0 AND a.classified_message = c.message AND a.category IN ('spam', 'scam', 'profanity')
          AND j.status = 'hiding' AND j.claim_token = ? AND j.claim_expires_at > ?`)
        .get(job.user_id, job.account_id, job.owner_id, job.comment_id, job.message, claim, Math.floor(Date.now() / 1000))) {
        db.prepare("UPDATE moderation_jobs SET status = 'pending', claim_token = NULL, claim_expires_at = NULL WHERE user_id = ? AND account_id = ? AND comment_id = ? AND status = 'hiding' AND claim_token = ?").run(job.user_id, job.account_id, job.comment_id, claim);
        continue;
      }
      dispatched = true;
      const response = await fetch(`https://zernio.com/api/v1/inbox/comments/${encodeURIComponent(job.post_id)}/${encodeURIComponent(job.comment_id)}/hide`, {
        method: 'POST', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ accountId: job.account_id }),
      });
      if (!response.ok) {
        if ([400, 401, 403, 404, 422, 429].includes(response.status)) dispatched = false;
        throw new Error(`Zernio hide returned ${response.status}`);
      }
      const result = await response.json() as { hidden?: boolean; commentId?: string };
      if (result.hidden !== true || result.commentId !== job.comment_id) throw new Error('Hide not confirmed');
      db.transaction(() => {
        const updated = db.prepare("UPDATE moderation_jobs SET status = 'done', action_at = ?, visibility_uncertain = 0, claim_token = NULL, claim_expires_at = NULL WHERE user_id = ? AND account_id = ? AND comment_id = ? AND status = 'hiding' AND claim_token = ?").run(new Date().toISOString(), job.user_id, job.account_id, job.comment_id, claim);
        if (updated.changes) db.prepare('UPDATE synced_comments SET is_hidden = 1 WHERE user_id = ? AND account_id = ? AND comment_id = ?').run(job.user_id, job.account_id, job.comment_id);
      })();
    } catch (error) {
      db.prepare("UPDATE moderation_jobs SET status = ?, next_attempt_at = ?, visibility_uncertain = ? WHERE user_id = ? AND account_id = ? AND comment_id = ? AND status = 'hiding' AND claim_token = ?")
        .run(dispatched ? 'hide_unknown' : 'pending', Math.floor(Date.now() / 1000) + 600, Number(dispatched), job.user_id, job.account_id, job.comment_id, claim);
      console.error('Comment moderation pending', { reason: error instanceof Error ? error.message : 'Unknown error' });
    }
  }
}
