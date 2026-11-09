import { db } from './db';
import { accessToken, ownerId, zernioGet } from './zernio';

type Account = { _id: string; platform: string };
type Post = { id: string; accountId: string; platform: string; content?: string; createdTime?: string; commentCount: number };
type NativePost = { id: string; platform: string; message: string; createdTime: string; commentCount: number };
type Comment = {
  id: string; message: string; createdTime: string; from?: { name?: string; isOwner?: boolean };
  isHidden?: boolean; replyCount?: number; replies?: Comment[];
};
const cutoff = () => new Date(Date.now() - 90 * 86400_000).toISOString();
const connected = (userId: string, owner: string) => !!db.prepare('SELECT 1 FROM zernio_connections WHERE user_id = ? AND owner_id = ?').get(userId, owner);

async function discoverBackfill(userId: string, owner: string, token: string, account: Account) {
  db.prepare('INSERT OR IGNORE INTO backfill_accounts VALUES (?, ?, 0)').run(userId, account._id);
  const state = db.prepare('SELECT selected FROM backfill_accounts WHERE user_id = ? AND account_id = ?')
    .get(userId, account._id) as { selected: number };
  if (state.selected) return;
  const listed = await zernioGet(token, `/accounts/${encodeURIComponent(account._id)}/posts`) as { status?: string; posts?: NativePost[] };
  if (listed.status !== 'success' || !Array.isArray(listed.posts)) throw new Error('Could not list recent posts');
  const recent = [...listed.posts].sort((a, b) => Date.parse(b.createdTime) - Date.parse(a.createdTime))
    .filter((post, index, posts) => posts.findIndex((item) => item.id === post.id) === index).slice(0, 3);
  if (recent.some((post) => !post.id || post.platform !== account.platform || !Number.isFinite(Date.parse(post.createdTime)) ||
      typeof post.message !== 'string' || !Number.isSafeInteger(post.commentCount) || post.commentCount < 0)) throw new Error('Invalid recent posts');
  db.transaction(() => {
    if (!connected(userId, owner)) return;
    const selectedAt = new Date().toISOString();
    for (const post of recent) {
      db.prepare(`INSERT INTO monitored_posts VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(user_id, account_id, post_id) DO UPDATE SET content = excluded.content, pending = 1`)
        .run(userId, account._id, post.id, post.message);
      db.prepare('INSERT OR IGNORE INTO backfill_posts VALUES (?, ?, ?, ?, ?, NULL)')
        .run(userId, account._id, post.id, post.commentCount, selectedAt);
    }
    db.prepare('UPDATE backfill_accounts SET selected = 1 WHERE user_id = ? AND account_id = ?').run(userId, account._id);
  })();
}

async function syncAccount(userId: string, owner: string, token: string, account: Account) {
  if (!connected(userId, owner)) return;
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
    if (!connected(userId, owner)) return;
    for (const post of feed.data) {
      if (post.accountId !== account._id || post.platform !== account.platform ||
          !post.createdTime || !Number.isFinite(Date.parse(post.createdTime)) ||
          Date.parse(post.createdTime) < Date.parse(startedAt) || !post.id || post.commentCount <= 0) continue;
      db.prepare(`INSERT INTO monitored_posts VALUES (?, ?, ?, ?, 1)
        ON CONFLICT(user_id, account_id, post_id) DO UPDATE SET content = excluded.content, pending = 1`)
        .run(userId, account._id, post.id, post.content ?? null);
    }
    if (feed.pagination?.hasMore && (!feed.pagination.nextCursor || feed.pagination.nextCursor === cursor)) throw new Error('Invalid post cursor');
    cursor = feed.pagination?.hasMore ? feed.pagination.nextCursor! : undefined;
  } while (cursor);
  } finally {
    if (connected(userId, owner)) await retryPending(userId, owner, token, account);
  }
}

async function retryPending(userId: string, owner: string, token: string, account: Account) {
  const pending = db.prepare('SELECT post_id FROM monitored_posts WHERE user_id = ? AND account_id = ? AND pending = 1')
    .all(userId, account._id) as { post_id: string }[];
  for (const post of pending) {
    if (!connected(userId, owner)) break;
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
  function savePage(comments: { comment: Comment; parentId: string | null }[]) {
    db.transaction(() => {
      if (!connected(userId, owner)) return;
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
        db.prepare(`INSERT INTO synced_comments VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(user_id, account_id, comment_id) DO UPDATE SET
            message = excluded.message, author = excluded.author, is_hidden = excluded.is_hidden`)
          .run(userId, account._id, postId, comment.id, parentId, comment.message, comment.from?.name || 'Commenter', createdAt, comment.isHidden ? 1 : 0);
        if (backfill && createdAt <= backfill.selected_at) db.prepare('INSERT OR IGNORE INTO backfill_comments VALUES (?, ?, ?)')
          .run(userId, account._id, comment.id);
      }
    })();
  }
  async function readPages(commentId?: string) {
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ accountId: account._id, limit: '100' });
      if (commentId) query.set('commentId', commentId);
      if (cursor) query.set('cursor', cursor);
      const page = await zernioGet(token, `/inbox/comments/${encodeURIComponent(postId)}?${query}`) as {
        comments?: Comment[]; pagination?: { hasMore?: boolean; cursor?: string | null };
      };
      if (!Array.isArray(page.comments)) throw new Error('Invalid comment page');
      const batch: { comment: Comment; parentId: string | null }[] = [];
      for (const comment of page.comments) {
        batch.push({ comment, parentId: commentId ?? null });
        if (!commentId) for (const reply of comment.replies ?? []) batch.push({ comment: reply, parentId: comment.id });
      }
      savePage(batch);
      if (!connected(userId, owner)) return;
      if (!commentId && account.platform === 'instagram') for (const comment of page.comments) {
        if ((comment.replyCount ?? 0) > (comment.replies?.length ?? 0)) await readPages(comment.id);
      }
      if (page.pagination?.hasMore && (!page.pagination.cursor || page.pagination.cursor === cursor)) throw new Error('Invalid comment cursor');
      cursor = page.pagination?.hasMore ? page.pagination.cursor! : undefined;
    } while (cursor);
  }
  await readPages();
  db.transaction(() => {
    if (!connected(userId, owner)) return;
    if (backfill) db.prepare('UPDATE backfill_posts SET completed_at = COALESCE(completed_at, ?) WHERE user_id = ? AND account_id = ? AND post_id = ?')
      .run(new Date().toISOString(), userId, account._id, postId);
    db.prepare('UPDATE monitored_posts SET pending = 0 WHERE user_id = ? AND account_id = ? AND post_id = ?')
      .run(userId, account._id, postId);
  })();
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
          try { await syncAccount(connection.user_id, connection.owner_id, token, account); }
          catch (error) { console.error('Zernio comment sync account pending', { platform: account.platform, reason: error instanceof Error ? error.message : 'Unknown error' }); }
        }
        if (page.pagination?.nextCursor === cursor) throw new Error('Invalid account cursor');
        cursor = page.pagination?.nextCursor || undefined;
      } while (cursor);
    } catch (error) {
      console.error('Zernio comment sync connection pending', { reason: error instanceof Error ? error.message : 'Unknown error' });
    }
  }
  archiveOldComments();
}

export function archiveOldComments() {
  db.transaction(() => {
    db.prepare(`INSERT OR IGNORE INTO archived_drafts
      SELECT c.user_id, c.account_id, c.comment_id, a.draft FROM synced_comments c
      JOIN comment_assessments a USING (user_id, account_id, comment_id)
      WHERE c.created_at < ? AND a.draft IS NOT NULL`).run(cutoff());
    db.prepare('DELETE FROM synced_comments WHERE created_at < ?').run(cutoff());
  })();
}
