import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { db, getUser } from './db';
import { accessToken, ownerId, zernioGet } from './zernio';

type ThreadComment = { id: string; isHidden?: boolean; replyCount?: number; from?: { isOwner?: boolean }; replies?: ThreadComment[] };

async function hasOwnerReply(token: string, platform: string, accountId: string, postId: string, commentId: string) {
  let cursor: string | undefined;
  do {
    const query = new URLSearchParams({ accountId, limit: '100' });
    if (platform === 'instagram') query.set('commentId', commentId);
    if (cursor) query.set('cursor', cursor);
    const page = await zernioGet(token, `/inbox/comments/${encodeURIComponent(postId)}?${query}`) as {
      comment?: ThreadComment; comments?: ThreadComment[]; pagination?: { hasMore?: boolean; cursor?: string | null };
    };
    if (!Array.isArray(page.comments)) throw new Error('Invalid thread');
    if (platform === 'instagram') {
      if (page.comment?.id !== commentId || page.comment.isHidden) throw new Error('Comment unavailable');
      if (page.comments.some((reply) => reply.from?.isOwner)) return true;
    } else {
      const parent = page.comments.find((comment) => comment.id === commentId);
      if (parent) {
        if (parent.isHidden || (parent.replyCount ?? 0) > (parent.replies?.length ?? 0)) throw new Error('Cannot verify all replies');
        return parent.replies?.some((reply) => reply.from?.isOwner) ?? false;
      }
    }
    if (page.pagination?.hasMore && (!page.pagination.cursor || page.pagination.cursor === cursor)) throw new Error('Invalid thread cursor');
    cursor = page.pagination?.hasMore ? page.pagination.cursor! : undefined;
  } while (cursor);
  if (platform !== 'instagram') throw new Error('Comment unavailable');
  return false;
}

export const replies = new Hono();
replies.post('/api/comments/:accountId/:commentId/reply', async (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  if (![new URL(c.req.url).origin, Bun.env.APP_ORIGIN && new URL(Bun.env.APP_ORIGIN).origin].includes(c.req.header('origin')))
    return c.json({ error: 'Invalid origin' }, 403);
  const body = await c.req.json().catch(() => null) as { message?: unknown } | null;
  if (typeof body?.message !== 'string' || !body.message.trim() || body.message.length > 2000) return c.json({ error: 'Enter a reply of up to 2,000 characters' }, 400);
  const { accountId, commentId } = c.req.param();
  const comment = db.prepare(`SELECT c.post_id AS postId, c.parent_id AS parentId, c.is_hidden AS isHidden, a.platform, z.owner_id AS ownerId
    FROM synced_comments c JOIN monitored_accounts a ON a.user_id = c.user_id AND a.account_id = c.account_id
    JOIN zernio_connections z ON z.user_id = c.user_id
    WHERE c.user_id = ? AND c.account_id = ? AND c.comment_id = ?`).get(user.id, accountId, commentId) as {
      postId: string; parentId: string | null; isHidden: number; platform: string; ownerId: string;
    } | null;
  if (!comment || !['instagram', 'youtube'].includes(comment.platform)) return c.json({ error: 'Comment not found in your connected account' }, 404);
  if (comment.isHidden) return c.json({ error: 'Unhide this comment before replying' }, 409);
  if (db.prepare('SELECT 1 FROM comment_replies WHERE user_id = ? AND account_id = ? AND comment_id = ?').get(user.id, accountId, commentId) ||
      db.prepare('SELECT 1 FROM owner_replies WHERE user_id = ? AND account_id = ? AND comment_id = ?').get(user.id, accountId, commentId))
    return c.json({ error: 'This reply was already sent or its delivery needs checking' }, 409);
  const targetId = comment.platform === 'youtube' && comment.parentId ? comment.parentId : commentId;
  let token: string;
  try {
    token = (await accessToken(user.id))!;
    if (!token || await ownerId(token) !== comment.ownerId) throw new Error('Connection changed');
    const listed = await zernioGet(token, `/accounts?${new URLSearchParams({ search: accountId, platforms: 'instagram,youtube', limit: '1' })}`) as {
      accounts?: { _id: string; platform: string }[];
    };
    if (!listed.accounts?.some((account) => account._id === accountId && account.platform === comment.platform)) throw new Error('Account unavailable');
    if (await hasOwnerReply(token, comment.platform, accountId, comment.postId, targetId)) {
      db.prepare(`INSERT OR IGNORE INTO owner_replies SELECT user_id, account_id, comment_id FROM synced_comments
        WHERE user_id = ? AND account_id = ? AND comment_id = ?`).run(user.id, accountId, commentId);
      return c.json({ error: 'This thread already has a reply from your account. Refresh the list.' }, 409);
    }
  } catch {
    return c.json({ error: 'Could not verify the comment and connection. Nothing was sent.' }, 502);
  }
  const key = crypto.randomUUID();
  const inserted = db.prepare(`INSERT OR IGNORE INTO comment_replies (user_id, account_id, comment_id, message, idempotency_key, status, started_at) VALUES (?, ?, ?, ?, ?, 'pending', ?)`)
    .run(user.id, accountId, commentId, body.message.trim(), key, Math.floor(Date.now() / 1000));
  if (!inserted.changes) return c.json({ error: 'This reply was already sent or its delivery needs checking' }, 409);
  if (!db.prepare('SELECT 1 FROM zernio_connections WHERE user_id = ? AND owner_id = ?').get(user.id, comment.ownerId)) {
    db.prepare('DELETE FROM comment_replies WHERE user_id = ? AND account_id = ? AND comment_id = ? AND status = ?')
      .run(user.id, accountId, commentId, 'pending');
    return c.json({ error: 'Zernio disconnected before sending. Nothing was sent.' }, 409);
  }
  try {
    const response = await fetch(`https://zernio.com/api/v1/inbox/comments/${encodeURIComponent(comment.postId)}`, {
      method: 'POST', signal: AbortSignal.timeout(30_000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': key },
      body: JSON.stringify({ accountId, commentId: targetId, message: body.message.trim() }),
    });
    if (!response.ok) {
      if ([400, 401, 403, 404, 422].includes(response.status)) {
        db.prepare('DELETE FROM comment_replies WHERE user_id = ? AND account_id = ? AND comment_id = ? AND status = ?')
          .run(user.id, accountId, commentId, 'pending');
        return c.json({ error: `Zernio rejected the reply (${response.status}). Nothing was sent.` }, 502);
      }
      throw new Error(`Zernio reply returned ${response.status}`);
    }
    const result = await response.json() as { success?: boolean; data?: { commentId?: string } };
    if (!result.success || !result.data?.commentId) throw new Error('Zernio did not confirm delivery');
    db.prepare(`UPDATE comment_replies SET status = 'sent', reply_id = ? WHERE user_id = ? AND account_id = ? AND comment_id = ?`)
      .run(result.data.commentId, user.id, accountId, commentId);
    return c.json({ status: 'sent' });
  } catch (error) {
    db.prepare(`UPDATE comment_replies SET status = 'unknown' WHERE user_id = ? AND account_id = ? AND comment_id = ? AND status = 'pending'`)
      .run(user.id, accountId, commentId);
    console.error('Zernio reply unconfirmed', { reason: error instanceof Error ? error.message : 'Unknown error' });
    return c.json({ status: 'unknown', attempt: key, error: 'Delivery unconfirmed. Check Zernio before trying again; this app will not resend automatically.' }, 502);
  }
});

replies.post('/api/comments/:accountId/:commentId/reply/resolve', async (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  if (![new URL(c.req.url).origin, Bun.env.APP_ORIGIN && new URL(Bun.env.APP_ORIGIN).origin].includes(c.req.header('origin'))) return c.json({ error: 'Invalid origin' }, 403);
  const body = await c.req.json().catch(() => null) as { resolution?: unknown; attempt?: unknown } | null;
  if (!body || !['found', 'not_sent'].includes(String(body.resolution)) || typeof body.attempt !== 'string') return c.json({ error: 'Invalid resolution' }, 400);
  const { accountId, commentId } = c.req.param();
  const params = [user.id, accountId, commentId, body.attempt, Math.floor(Date.now() / 1000) - 60] as const;
  const condition = "user_id = ? AND account_id = ? AND comment_id = ? AND idempotency_key = ? AND status IN ('pending', 'unknown') AND (status = 'unknown' OR started_at IS NULL OR started_at <= ?)";
  const result = body.resolution === 'found'
    ? db.prepare(`UPDATE comment_replies SET status = 'sent', reply_id = NULL WHERE ${condition}`).run(...params)
    : db.prepare(`DELETE FROM comment_replies WHERE ${condition}`).run(...params);
  return result.changes ? c.json({ status: body.resolution === 'found' ? 'user_confirmed' : 'ready' }) : c.json({ error: 'Attempt changed or may still be sending. Refresh and check again.' }, 409);
});
