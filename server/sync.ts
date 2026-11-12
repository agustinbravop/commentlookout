import { accountPaused, db } from './db';
import { accessToken, ownerId, zernioGet } from './zernio';
import { notifyWorkspace } from './events';

type Account = { _id: string; platform: string };
type Post = { id: string; accountId: string; platform: string; content?: string; picture?: unknown; createdTime?: string; commentCount: number };
type NativePost = { id: string; platform: string; message: string; picture?: unknown; createdTime: string; commentCount: number };
type Comment = {
  id: string; message: string; createdTime: string; from?: { name?: string; isOwner?: boolean };
  isHidden?: boolean; replyCount?: number; replies?: Comment[];
};
const cutoff = () => new Date(Date.now() - 365 * 86400_000).toISOString();
function pictureUrl(value: unknown) {
  if (typeof value !== 'string' || value.length > 4096) return null;
  try { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password && url.hostname.includes('.') && !url.hostname.endsWith('.local') && !/^[\d.]+$/.test(url.hostname) ? url.href : null; }
  catch { return null; }
}
const connected = (userId: string, owner: string, accountId: string) => !accountPaused(userId, accountId) && !!db.prepare('SELECT 1 FROM zernio_connections WHERE user_id = ? AND owner_id = ?').get(userId, owner);

async function discoverBackfill(userId: string, owner: string, token: string, account: Account) {
  db.prepare('INSERT OR IGNORE INTO backfill_accounts VALUES (?, ?, 0)').run(userId, account._id);
  const state = db.prepare('SELECT selected FROM backfill_accounts WHERE user_id = ? AND account_id = ?')
    .get(userId, account._id) as { selected: number };
  if (state.selected && !db.prepare(`SELECT 1 FROM backfill_posts b JOIN monitored_posts p USING (user_id, account_id, post_id)
    WHERE b.user_id = ? AND b.account_id = ? AND (p.picture IS NULL OR p.created_at IS NULL) LIMIT 1`).get(userId, account._id)) return;
  const listed = await zernioGet(token, `/accounts/${encodeURIComponent(account._id)}/posts`) as { status?: string; posts?: NativePost[] };
  if (listed.status !== 'success' || !Array.isArray(listed.posts)) throw new Error('Could not list recent posts');
  const posts = listed.posts;
  if (state.selected) {
    db.transaction(() => {
      if (!connected(userId, owner, account._id)) return;
      const save = db.prepare(`UPDATE monitored_posts SET picture = COALESCE(picture, ?), created_at = COALESCE(created_at, ?)
        WHERE user_id = ? AND account_id = ? AND post_id = ?
        AND EXISTS (SELECT 1 FROM backfill_posts WHERE user_id = ? AND account_id = ? AND post_id = ?)`);
      for (const post of posts) {
        if (!post.id || post.platform !== account.platform) continue;
        const picture = pictureUrl(post.picture);
        const createdAt = Number.isFinite(Date.parse(post.createdTime)) ? new Date(post.createdTime).toISOString() : null;
        if (picture || createdAt) save.run(picture, createdAt, userId, account._id, post.id, userId, account._id, post.id);
      }
    })();
    return;
  }
  const recent = [...posts].sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime))
    .filter((post, index, posts) => posts.findIndex((item) => item.id === post.id) === index).slice(0, 3);
  if (recent.some((post) => !post.id || post.platform !== account.platform || !Number.isFinite(Date.parse(post.createdTime)) ||
      typeof post.message !== 'string' || !Number.isSafeInteger(post.commentCount) || post.commentCount < 0)) throw new Error('Invalid recent posts');
  db.transaction(() => {
    if (!connected(userId, owner, account._id)) return;
    const selectedAt = new Date().toISOString();
    for (const post of recent) {
      db.prepare(`INSERT INTO monitored_posts (user_id, account_id, post_id, content, pending, picture, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(user_id, account_id, post_id) DO UPDATE SET content = excluded.content, picture = COALESCE(excluded.picture, picture), created_at = COALESCE(excluded.created_at, created_at), pending = 1`)
        .run(userId, account._id, post.id, post.message, pictureUrl(post.picture), new Date(post.createdTime).toISOString());
      db.prepare('INSERT OR IGNORE INTO backfill_posts VALUES (?, ?, ?, ?, ?, NULL)')
        .run(userId, account._id, post.id, post.commentCount, selectedAt);
    }
    db.prepare('UPDATE backfill_accounts SET selected = 1 WHERE user_id = ? AND account_id = ?').run(userId, account._id);
  })();
  notifyWorkspace(userId);
}

async function syncAccount(userId: string, owner: string, token: string, account: Account) {
  if (!connected(userId, owner, account._id)) return;
  db.prepare('INSERT OR IGNORE INTO monitored_accounts VALUES (?, ?, ?, ?)')
    .run(userId, account._id, account.platform, new Date().toISOString());
  const { started_at: startedAt } = db.prepare('SELECT started_at FROM monitored_accounts WHERE user_id = ? AND account_id = ?')
    .get(userId, account._id) as { started_at: string };
  try { await discoverBackfill(userId, owner, token, account); }
  catch (error) { console.error('Zernio backfill discovery pending', { platform: account.platform, reason: error instanceof Error ? error.message : 'Unknown error' }); }
  let cursor: string | undefined;
  try {
  do {
    const query = new URLSearchParams({ accountId: account._id, platform: account.platform, since: startedAt, limit: '100' });
    if (cursor) query.set('cursor', cursor);
    const feed = await zernioGet(token, `/inbox/comments?${query}`) as {
      data?: Post[]; pagination?: { hasMore?: boolean; nextCursor?: string | null };
      meta?: { accountsFailed?: number };
    };
    if (!Array.isArray(feed.data) || feed.meta?.accountsFailed) throw new Error('Could not list posts');
    if (!connected(userId, owner, account._id)) return;
    for (const post of feed.data) {
      if (post.accountId !== account._id || post.platform !== account.platform ||
          !post.createdTime || !Number.isFinite(Date.parse(post.createdTime)) ||
          Date.parse(post.createdTime) < Date.parse(startedAt) || !post.id || post.commentCount <= 0) continue;
      db.prepare(`INSERT INTO monitored_posts (user_id, account_id, post_id, content, pending, picture, created_at) VALUES (?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT(user_id, account_id, post_id) DO UPDATE SET content = excluded.content, picture = COALESCE(excluded.picture, picture), created_at = COALESCE(excluded.created_at, created_at), pending = 1`)
      .run(userId, account._id, post.id, post.content ?? null, pictureUrl(post.picture), new Date(post.createdTime).toISOString());
    }
    notifyWorkspace(userId);
    if (feed.pagination?.hasMore && (!feed.pagination.nextCursor || feed.pagination.nextCursor === cursor)) throw new Error('Invalid post cursor');
    cursor = feed.pagination?.hasMore ? feed.pagination.nextCursor! : undefined;
  } while (cursor);
  } finally {
    if (connected(userId, owner, account._id)) await retryPending(userId, owner, token, account);
  }
}

async function retryPending(userId: string, owner: string, token: string, account: Account) {
  const pending = db.prepare('SELECT post_id FROM monitored_posts WHERE user_id = ? AND account_id = ? AND pending = 1')
    .all(userId, account._id) as { post_id: string }[];
  for (const post of pending) {
    if (!connected(userId, owner, account._id)) break;
    try {
      await syncThread(userId, owner, token, account, post.post_id);
    } catch (error) {
      // Keep the persisted post pending; never log post IDs, comment text or provider URLs.
      console.error('Zernio comment sync thread pending', { platform: account.platform, reason: error instanceof Error ? error.message : 'Unknown error' });
    }
  }
}

async function syncThread(userId: string, owner: string, token: string, account: Account, postId: string) {
  const backfill = db.prepare('SELECT selected_at FROM backfill_posts WHERE user_id = ? AND account_id = ? AND post_id = ?')
    .get(userId, account._id, postId) as { selected_at: string } | null;
  function savePage(comments: { comment: Comment; parentId: string | null }[], lastUpdated?: string) {
    db.transaction(() => {
      if (!connected(userId, owner, account._id)) return;
      for (const { comment, parentId } of comments) {
        if (comment.from?.isOwner) {
          if (parentId) db.prepare(`INSERT OR IGNORE INTO owner_replies
            SELECT user_id, account_id, comment_id FROM synced_comments WHERE user_id = ? AND account_id = ? AND comment_id = ?`)
            .run(userId, account._id, parentId);
          continue;
        }
        if (!comment.id || typeof comment.message !== 'string' ||
            !Number.isFinite(Date.parse(comment.createdTime))) continue;
        const createdAt = new Date(comment.createdTime).toISOString();
        if (createdAt < cutoff()) continue;
        const existing = db.prepare(`SELECT c.is_hidden, j.status, j.action_at, j.observed_at FROM synced_comments c LEFT JOIN moderation_jobs j USING (user_id, account_id, comment_id)
          WHERE c.user_id = ? AND c.account_id = ? AND c.comment_id = ?`).get(userId, account._id, comment.id) as { is_hidden: number; status: string | null; action_at: string | null; observed_at: string | null } | null;
        let hidden = comment.isHidden ? 1 : 0;
        if (existing && ['done', 'restored', 'restore_pending', 'restore_unknown'].includes(existing.status || '')) {
          const observed = Date.parse(lastUpdated || '');
          const fresh = typeof comment.isHidden === 'boolean' && !!existing.action_at && Number.isFinite(observed) && observed > Date.parse(existing.action_at) && (!existing.observed_at || observed > Date.parse(existing.observed_at));
          const unsettled = existing.status === 'restore_pending' || existing.status === 'restore_unknown';
          if (!fresh || unsettled) {
            db.prepare('UPDATE moderation_jobs SET visibility_uncertain = 1 WHERE user_id = ? AND account_id = ? AND comment_id = ?').run(userId, account._id, comment.id);
            hidden = existing.is_hidden;
          } else {
            db.prepare('UPDATE moderation_jobs SET visibility_uncertain = 0, observed_at = ? WHERE user_id = ? AND account_id = ? AND comment_id = ?').run(new Date(observed).toISOString(), userId, account._id, comment.id);
          }
        }
        db.prepare(`INSERT INTO synced_comments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, account_id, comment_id) DO UPDATE SET
            message = excluded.message, author = excluded.author, is_hidden = excluded.is_hidden`)
          .run(userId, account._id, postId, comment.id, parentId, comment.message, comment.from?.name || 'Commenter', createdAt, hidden);
        if (backfill && createdAt <= backfill.selected_at) db.prepare('INSERT OR IGNORE INTO backfill_comments VALUES (?, ?, ?)')
          .run(userId, account._id, comment.id);
      }
    })();
    notifyWorkspace(userId);
  }
  async function readPages(commentId?: string) {
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ accountId: account._id, limit: '100' });
      if (commentId) query.set('commentId', commentId);
      if (cursor) query.set('cursor', cursor);
      const page = await zernioGet(token, `/inbox/comments/${encodeURIComponent(postId)}?${query}`) as {
        comments?: Comment[]; pagination?: { hasMore?: boolean; cursor?: string | null }; meta?: { lastUpdated?: string };
      };
      if (!Array.isArray(page.comments)) throw new Error('Invalid comment page');
      const batch: { comment: Comment; parentId: string | null }[] = [];
      for (const comment of page.comments) {
        batch.push({ comment, parentId: commentId ?? null });
        if (!commentId) for (const reply of comment.replies ?? []) batch.push({ comment: reply, parentId: comment.id });
      }
      savePage(batch, page.meta?.lastUpdated);
      if (!connected(userId, owner, account._id)) return;
      if (!commentId && account.platform === 'instagram') for (const comment of page.comments) {
        if ((comment.replyCount ?? 0) > (comment.replies?.length ?? 0)) await readPages(comment.id);
      }
      if (page.pagination?.hasMore && (!page.pagination.cursor || page.pagination.cursor === cursor)) throw new Error('Invalid comment cursor');
      cursor = page.pagination?.hasMore ? page.pagination.cursor! : undefined;
    } while (cursor);
  }
  await readPages();
  db.transaction(() => {
    if (!connected(userId, owner, account._id)) return;
    if (backfill) db.prepare('UPDATE backfill_posts SET completed_at = COALESCE(completed_at, ?) WHERE user_id = ? AND account_id = ? AND post_id = ?')
      .run(new Date().toISOString(), userId, account._id, postId);
    db.prepare('UPDATE monitored_posts SET pending = 0 WHERE user_id = ? AND account_id = ? AND post_id = ?')
      .run(userId, account._id, postId);
  })();
  notifyWorkspace(userId);
}

export async function syncComments() {
  const connections = db.prepare('SELECT user_id, owner_id FROM zernio_connections').all() as { user_id: string; owner_id: string }[];
  for (const connection of connections) {
    try {
      const token = await accessToken(connection.user_id);
      if (!token || await ownerId(token) !== connection.owner_id) throw new Error('Connection ownership changed');
      let cursor: string | undefined;
      do {
        const query = new URLSearchParams({ platforms: 'instagram,youtube', status: 'connected', limit: '500' });
        if (cursor) query.set('cursor', cursor);
        const page = await zernioGet(token, `/accounts?${query}`) as {
          accounts?: Account[]; pagination?: { nextCursor?: string | null };
        };
        if (!Array.isArray(page.accounts)) throw new Error('Invalid accounts page');
        for (const account of page.accounts) {
          if (!['instagram', 'youtube'].includes(account.platform) || !/^[a-f\d]{24}$/i.test(account._id)) continue;
          // A canonical healthy listing also recovers pauses when webhook intake is rolled back.
          db.prepare(`DELETE FROM webhook_account_state WHERE account_id = ? AND binding_id IN
            (SELECT id FROM webhook_bindings WHERE user_id = ? AND owner_id = ?)
            AND (status = 'disconnected' OR binding_id IN (SELECT id FROM webhook_bindings WHERE enabled = 0))`)
            .run(account._id, connection.user_id, connection.owner_id);
          try {
            // Recovery must reread known threads even when an older post is absent from the new-post feed.
            if (connected(connection.user_id, connection.owner_id, account._id)) {
              db.prepare('UPDATE monitored_posts SET pending = 1 WHERE user_id = ? AND account_id = ?')
                .run(connection.user_id, account._id);
            }
            await syncAccount(connection.user_id, connection.owner_id, token, account);
          }
          catch (error) { console.error('Zernio comment sync account pending', { platform: account.platform, reason: error instanceof Error ? error.message : 'Unknown error' }); }
        }
        if (page.pagination?.nextCursor === cursor) throw new Error('Invalid account cursor');
        cursor = page.pagination?.nextCursor || undefined;
      } while (cursor);
    } catch (error) {
      console.error('Zernio comment sync connection pending', { reason: error instanceof Error ? error.message : 'Unknown error' });
    } finally { notifyWorkspace(connection.user_id); }
  }
  archiveOldComments();
}

export async function syncWebhookWork() {
  const jobs = db.prepare(`SELECT w.*, b.user_id, b.owner_id FROM webhook_work w JOIN webhook_bindings b ON b.id = w.binding_id
    JOIN zernio_connections z ON z.user_id = b.user_id AND z.owner_id = b.owner_id
    WHERE b.enabled = 1 AND w.next_attempt_at <= ? AND NOT EXISTS
      (SELECT 1 FROM webhook_setup s WHERE s.binding_id = b.id AND s.status != 'active')
    ORDER BY w.account_event IS NULL, w.next_attempt_at LIMIT 20`).all(Math.floor(Date.now() / 1000)) as {
      binding_id: string; user_id: string; owner_id: string; account_id: string; platform: string; post_id: string; generation: number; account_event: string | null;
    }[];
  for (const job of jobs) {
    const key = [job.binding_id, job.account_id, job.post_id];
    try {
      const token = await accessToken(job.user_id);
      if (!token || await ownerId(token) !== job.owner_id) throw new Error('Connection ownership changed');
      const listed = await zernioGet(token, `/accounts?${new URLSearchParams({ search: job.account_id, platforms: 'instagram,youtube', status: 'connected', limit: '1' })}`) as { accounts?: Account[] };
      if (!Array.isArray(listed.accounts)) throw new Error('Invalid accounts page');
      if (!db.prepare(`SELECT 1 FROM webhook_bindings b WHERE b.id = ? AND b.enabled = 1 AND NOT EXISTS
        (SELECT 1 FROM webhook_setup s WHERE s.binding_id = b.id AND s.status != 'active')`).get(job.binding_id)) continue;
      if (!db.prepare('SELECT 1 FROM webhook_work WHERE binding_id = ? AND account_id = ? AND post_id = ? AND generation = ?').get(...key, job.generation)) continue;
      if (!listed.accounts.some((a) => a._id === job.account_id && a.platform === job.platform)) {
        if (!job.account_event) throw new Error('Account ownership changed');
        // A removed account may no longer be listable; only pause this workspace's known inventory.
        if (db.prepare('SELECT 1 FROM monitored_accounts WHERE user_id = ? AND account_id = ? AND platform = ?').get(job.user_id, job.account_id, job.platform)) {
          db.prepare(`INSERT INTO webhook_account_state VALUES (?, ?, ?, 'disconnected')
            ON CONFLICT(binding_id, account_id) DO UPDATE SET status = 'disconnected'`).run(job.binding_id, job.account_id, job.platform);
        }
        db.prepare('DELETE FROM webhook_work WHERE binding_id = ? AND account_id = ? AND post_id = ? AND generation = ?').run(...key, job.generation);
        continue;
      }
      if (job.account_event) {
        db.prepare('DELETE FROM webhook_account_state WHERE binding_id = ? AND account_id = ?').run(job.binding_id, job.account_id);
        if (job.account_event === 'account.permissions_changed') db.prepare("INSERT INTO webhook_account_state VALUES (?, ?, ?, 'permissions_changed')").run(job.binding_id, job.account_id, job.platform);
      }
      if (accountPaused(job.user_id, job.account_id)) throw new Error('Account check pending');
      if (job.post_id) db.prepare('UPDATE monitored_posts SET pending = 1 WHERE user_id = ? AND account_id = ? AND post_id = ?').run(job.user_id, job.account_id, job.post_id);
      await syncAccount(job.user_id, job.owner_id, token, { _id: job.account_id, platform: job.platform });
      if (accountPaused(job.user_id, job.account_id)) throw new Error('Account check pending');
      if (db.prepare('SELECT 1 FROM monitored_posts WHERE user_id = ? AND account_id = ? AND pending = 1').get(job.user_id, job.account_id)) throw new Error('Thread reads pending');
      // A delivery arriving during a read must survive that read's completion.
      db.prepare('DELETE FROM webhook_work WHERE binding_id = ? AND account_id = ? AND post_id = ? AND generation = ?').run(...key, job.generation);
    } catch {
      db.prepare('UPDATE webhook_work SET next_attempt_at = ? WHERE binding_id = ? AND account_id = ? AND post_id = ?')
        .run(Math.floor(Date.now() / 1000) + 60, ...key);
      console.error('Zernio webhook work pending');
    } finally { notifyWorkspace(job.user_id); }
  }
}

export function archiveOldComments() {
  const affected = db.prepare('SELECT DISTINCT user_id FROM synced_comments WHERE created_at < ?').all(cutoff()) as { user_id: string }[];
  db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO archived_drafts
      SELECT c.user_id, c.account_id, c.comment_id, a.draft FROM synced_comments c
      JOIN comment_assessments a USING (user_id, account_id, comment_id)
      WHERE c.created_at < ? AND a.draft IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM comment_replies r WHERE r.user_id = c.user_id AND r.account_id = c.account_id AND r.comment_id = c.comment_id AND r.status = 'sent')
        AND NOT EXISTS (SELECT 1 FROM owner_replies r WHERE r.user_id = c.user_id AND r.account_id = c.account_id AND r.comment_id = c.comment_id)`).run(cutoff());
    db.prepare('DELETE FROM synced_comments WHERE created_at < ?').run(cutoff());
  })();
  for (const user of affected) notifyWorkspace(user.user_id);
}
