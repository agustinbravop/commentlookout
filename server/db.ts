import { Database } from 'bun:sqlite';
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const path = Bun.env.DATABASE_PATH || './data/comment-lookout.sqlite';
if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
export const db = new Database(path, { create: true });
db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;');
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    google_sub TEXT NOT NULL UNIQUE,
    email TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS login_attempts (
    state_hash TEXT PRIMARY KEY,
    verifier TEXT NOT NULL,
    nonce TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS zernio_clients (
    redirect_uri TEXT PRIMARY KEY,
    client_id TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS zernio_attempts (
    state_hash TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    verifier TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS zernio_connections (
    user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    owner_id TEXT NOT NULL UNIQUE,
    access_token TEXT NOT NULL,
    refresh_token TEXT NOT NULL,
    expires_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS monitored_accounts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    platform TEXT NOT NULL,
    started_at TEXT NOT NULL,
    PRIMARY KEY (user_id, account_id)
  );
  CREATE TABLE IF NOT EXISTS moderation_preferences (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    owner_id TEXT NOT NULL,
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    confirmed_at TEXT NOT NULL,
    PRIMARY KEY (user_id, account_id)
  );
  CREATE TABLE IF NOT EXISTS moderation_jobs (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, account_id, comment_id),
    FOREIGN KEY (user_id, account_id, comment_id) REFERENCES synced_comments(user_id, account_id, comment_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS monitored_posts (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    content TEXT,
    pending INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (user_id, account_id, post_id),
    FOREIGN KEY (user_id, account_id) REFERENCES monitored_accounts(user_id, account_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS backfill_accounts (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    selected INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, account_id),
    FOREIGN KEY (user_id, account_id) REFERENCES monitored_accounts(user_id, account_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS backfill_posts (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    expected_comments INTEGER NOT NULL,
    selected_at TEXT NOT NULL,
    completed_at TEXT,
    PRIMARY KEY (user_id, account_id, post_id),
    FOREIGN KEY (user_id, account_id, post_id) REFERENCES monitored_posts(user_id, account_id, post_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS synced_comments (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    post_id TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    parent_id TEXT,
    message TEXT NOT NULL,
    author TEXT NOT NULL,
    created_at TEXT NOT NULL,
    is_hidden INTEGER NOT NULL,
    PRIMARY KEY (user_id, account_id, comment_id),
    FOREIGN KEY (user_id, account_id, post_id) REFERENCES monitored_posts(user_id, account_id, post_id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS synced_comments_recent ON synced_comments(user_id, created_at DESC, comment_id DESC);
  CREATE TABLE IF NOT EXISTS backfill_comments (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    PRIMARY KEY (user_id, account_id, comment_id),
    FOREIGN KEY (user_id, account_id, comment_id) REFERENCES synced_comments(user_id, account_id, comment_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS comment_assessments (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    classified_message TEXT,
    category TEXT,
    reason TEXT,
    needs_reply INTEGER NOT NULL DEFAULT 0,
    draft TEXT,
    draft_edited INTEGER NOT NULL DEFAULT 0,
    dismissed INTEGER NOT NULL DEFAULT 0,
    next_attempt_at INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (user_id, account_id, comment_id),
    FOREIGN KEY (user_id, account_id, comment_id) REFERENCES synced_comments(user_id, account_id, comment_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS brand_voices (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    instructions TEXT NOT NULL,
    PRIMARY KEY (user_id, account_id)
  );
  CREATE TABLE IF NOT EXISTS archived_drafts (
    user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    account_id TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    draft TEXT NOT NULL,
    PRIMARY KEY (user_id, account_id, comment_id)
  );
  CREATE TABLE IF NOT EXISTS comment_replies (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    message TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'unknown')),
    reply_id TEXT,
    PRIMARY KEY (user_id, account_id, comment_id),
    FOREIGN KEY (user_id, account_id, comment_id) REFERENCES synced_comments(user_id, account_id, comment_id) ON DELETE CASCADE
  );
  CREATE TABLE IF NOT EXISTS owner_replies (
    user_id TEXT NOT NULL,
    account_id TEXT NOT NULL,
    comment_id TEXT NOT NULL,
    PRIMARY KEY (user_id, account_id, comment_id),
    FOREIGN KEY (user_id, account_id, comment_id) REFERENCES synced_comments(user_id, account_id, comment_id) ON DELETE CASCADE
  );
`);
db.exec("DELETE FROM brand_voices WHERE account_id = '*'");
if (!db.prepare('PRAGMA table_info(monitored_posts)').all().some((column) => (column as { name: string }).name === 'picture')) {
  db.exec('ALTER TABLE monitored_posts ADD COLUMN picture TEXT');
}
if (!db.prepare('PRAGMA table_info(monitored_posts)').all().some((column) => (column as { name: string }).name === 'created_at')) {
  db.exec('ALTER TABLE monitored_posts ADD COLUMN created_at TEXT');
}
if (!db.prepare('PRAGMA table_info(users)').all().some((column) => (column as { name: string }).name === 'picture')) {
  db.exec('ALTER TABLE users ADD COLUMN picture TEXT');
}
if (!db.prepare('PRAGMA table_info(comment_assessments)').all().some((column) => (column as { name: string }).name === 'dismissed')) {
  db.exec('ALTER TABLE comment_assessments ADD COLUMN dismissed INTEGER NOT NULL DEFAULT 0');
}
if (!db.prepare('PRAGMA table_info(moderation_preferences)').all().some((column) => (column as { name: string }).name === 'backfill_confirmed')) {
  db.exec('ALTER TABLE moderation_preferences ADD COLUMN backfill_confirmed INTEGER NOT NULL DEFAULT 0');
}
if (!db.prepare('PRAGMA table_info(comment_replies)').all().some((column) => (column as { name: string }).name === 'started_at')) {
  db.exec('ALTER TABLE comment_replies ADD COLUMN started_at INTEGER');
}
if (!db.prepare('PRAGMA table_info(moderation_jobs)').all().some((column) => (column as { name: string }).name === 'restore_token')) {
  db.exec('ALTER TABLE moderation_jobs ADD COLUMN restore_token TEXT');
}
db.exec("UPDATE moderation_jobs SET restore_token = lower(hex(randomblob(16))) WHERE status = 'restore_pending' AND restore_token IS NULL");
if (!db.prepare('PRAGMA table_info(moderation_jobs)').all().some((column) => (column as { name: string }).name === 'restore_started_at')) {
  db.exec('ALTER TABLE moderation_jobs ADD COLUMN restore_started_at INTEGER');
}
if (!db.prepare('PRAGMA table_info(moderation_jobs)').all().some((column) => (column as { name: string }).name === 'action_at')) {
  db.exec('ALTER TABLE moderation_jobs ADD COLUMN action_at TEXT');
}
if (!db.prepare('PRAGMA table_info(moderation_jobs)').all().some((column) => (column as { name: string }).name === 'visibility_uncertain')) {
  db.exec('ALTER TABLE moderation_jobs ADD COLUMN visibility_uncertain INTEGER NOT NULL DEFAULT 0');
}
if (!db.prepare('PRAGMA table_info(moderation_jobs)').all().some((column) => (column as { name: string }).name === 'observed_at')) {
  db.exec('ALTER TABLE moderation_jobs ADD COLUMN observed_at TEXT');
}
if (!db.prepare('PRAGMA table_info(moderation_jobs)').all().some((column) => (column as { name: string }).name === 'claim_token')) {
  db.exec('ALTER TABLE moderation_jobs ADD COLUMN claim_token TEXT');
}
if (!db.prepare('PRAGMA table_info(moderation_jobs)').all().some((column) => (column as { name: string }).name === 'claim_expires_at')) {
  db.exec('ALTER TABLE moderation_jobs ADD COLUMN claim_expires_at INTEGER');
}

const hash = (value: string) => createHash('sha256').update(value).digest('hex');
export const newToken = () => randomBytes(32).toString('base64url');
const now = () => Math.floor(Date.now() / 1000);

export function startLogin(state: string, verifier: string, nonce: string) {
  db.prepare('DELETE FROM login_attempts WHERE expires_at < ?').run(now());
  db.prepare('INSERT INTO login_attempts VALUES (?, ?, ?, ?)').run(hash(state), verifier, nonce, now() + 600);
}

export function finishLogin(state: string) {
  const attempt = db.prepare('DELETE FROM login_attempts WHERE state_hash = ? AND expires_at >= ? RETURNING verifier, nonce')
    .get(hash(state), now()) as { verifier: string; nonce: string } | null;
  return attempt;
}

export function createSession(sub: string, email: string, name: string, picture: string | null = null) {
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now());
  const id = crypto.randomUUID();
  db.prepare(`INSERT INTO users (id, google_sub, email, name, created_at, picture) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(google_sub) DO UPDATE SET email = excluded.email, name = excluded.name, picture = excluded.picture`)
    .run(id, sub, email, name, now(), picture);
  const user = db.prepare('SELECT id, email, name, picture FROM users WHERE google_sub = ?')
    .get(sub) as { id: string; email: string; name: string; picture: string | null };
  const token = newToken();
  db.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(hash(token), user.id, now() + 60 * 60 * 24 * 7);
  return { token, user };
}

export function getUser(token?: string) {
  if (!token) return null;
  return db.prepare(`SELECT users.id, users.email, users.name, users.picture FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE token_hash = ? AND expires_at > ?`).get(hash(token), now()) as
    { id: string; email: string; name: string; picture: string | null } | null;
}

export function endSession(token?: string) {
  if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash(token));
}
