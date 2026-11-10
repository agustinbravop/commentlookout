import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { existsSync, mkdtempSync, rmdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

test('old reply attempts survive the started_at migration', () => {
  const dir = mkdtempSync('/tmp/opencode/commentlookout-migration-');
  const path = join(dir, 'old.sqlite');
  try {
    const old = new Database(path);
    old.exec(`CREATE TABLE monitored_posts (user_id TEXT, account_id TEXT, post_id TEXT, content TEXT, pending INTEGER,
      PRIMARY KEY (user_id, account_id, post_id)); INSERT INTO monitored_posts VALUES ('u', 'a', 'p', 'kept', 0);`);
    old.exec(`CREATE TABLE comment_replies (user_id TEXT, account_id TEXT, comment_id TEXT, message TEXT, idempotency_key TEXT,
      status TEXT, reply_id TEXT, PRIMARY KEY (user_id, account_id, comment_id));
      INSERT INTO comment_replies VALUES ('u', 'a', 'c', 'preserved', 'key', 'pending', NULL);`);
    old.exec(`CREATE TABLE moderation_jobs (user_id TEXT, account_id TEXT, comment_id TEXT, status TEXT, next_attempt_at INTEGER,
      PRIMARY KEY (user_id, account_id, comment_id)); INSERT INTO moderation_jobs VALUES ('u', 'a', 'c', 'restore_pending', 0);
      INSERT INTO moderation_jobs VALUES ('u', 'a', 'd', 'done', 0); INSERT INTO moderation_jobs VALUES ('u', 'a', 'e', 'restored', 0);
      INSERT INTO moderation_jobs VALUES ('u', 'a', 'f', 'pending', 0);`);
    old.close();
    const result = Bun.spawnSync(['bun', '-e', `const {db}=await import('./server/db.ts'); console.log(JSON.stringify({ post: db.prepare('SELECT content,picture,created_at FROM monitored_posts').get(), reply: db.prepare('SELECT message,status,started_at FROM comment_replies').get(), restore: db.prepare("SELECT status,restore_token,restore_started_at FROM moderation_jobs WHERE comment_id = 'c'").get(), states: db.prepare('SELECT status FROM moderation_jobs ORDER BY comment_id').all() })); db.close();`], {
      env: { ...process.env, DATABASE_PATH: path }, stdout: 'pipe', stderr: 'pipe',
    });
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toEqual({ post: { content: 'kept', picture: null, created_at: null }, reply: { message: 'preserved', status: 'pending', started_at: null }, restore: { status: 'restore_pending', restore_token: expect.any(String), restore_started_at: null }, states: [{ status: 'restore_pending' }, { status: 'done' }, { status: 'restored' }, { status: 'pending' }] });
  } finally {
    for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) unlinkSync(file);
    rmdirSync(dir);
  }
});
