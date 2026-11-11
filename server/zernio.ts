import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { Hono } from 'hono';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import * as oauth from 'openid-client';
import { db, getUser, queueWebhookSetup } from './db';

const redirectUri = Bun.env.ZERNIO_REDIRECT_URI;
const appOrigin = Bun.env.APP_ORIGIN;
const key = Bun.env.ZERNIO_TOKEN_KEY ? Buffer.from(Bun.env.ZERNIO_TOKEN_KEY, 'base64') : null;
if (key && key.length !== 32) throw new Error('ZERNIO_TOKEN_KEY must be 32 bytes encoded as base64');
if (redirectUri && !redirectUri.startsWith('https://') && !redirectUri.startsWith('http://localhost:')) {
  throw new Error('ZERNIO_REDIRECT_URI must use HTTPS or localhost');
}
const cookieOptions = { httpOnly: true, secure: redirectUri?.startsWith('https://') ?? false, sameSite: 'Lax' as const, path: '/' };
const now = () => Math.floor(Date.now() / 1000);
const destination = () => appOrigin ? `${new URL(appOrigin).origin}/app` : '/app';

export function encrypt(value: string) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key!, iv);
  return Buffer.concat([iv, cipher.update(value), cipher.final(), cipher.getAuthTag()]).toString('base64');
}

export function decrypt(value: string) {
  const bytes = Buffer.from(value, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key!, bytes.subarray(0, 12));
  decipher.setAuthTag(bytes.subarray(bytes.length - 16));
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString();
}

async function clientId() {
  const existing = db.prepare('SELECT client_id FROM zernio_clients WHERE redirect_uri = ?')
    .get(redirectUri!) as { client_id: string } | null;
  if (existing) return existing.client_id;
  const response = await fetch('https://zernio.com/api/oauth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_name: 'Comment Lookout', redirect_uris: [redirectUri], token_endpoint_auth_method: 'none' }),
  });
  if (!response.ok) throw new Error(`Zernio registration failed: ${response.status}`);
  const client = await response.json() as { client_id?: string; token_endpoint_auth_method?: string };
  if (!client.client_id || client.token_endpoint_auth_method !== 'none') throw new Error('Unsupported Zernio client registration');
  db.prepare('INSERT INTO zernio_clients VALUES (?, ?)').run(redirectUri!, client.client_id);
  return client.client_id;
}

type Connection = { access_token: string; refresh_token: string; expires_at: number; owner_id: string };
const tokenRequests = new Map<string, Promise<string | null>>();
export async function accessToken(userId: string) {
  const pending = tokenRequests.get(userId);
  if (pending) return pending;
  const request = readAccessToken(userId);
  tokenRequests.set(userId, request);
  try { return await request; }
  finally { tokenRequests.delete(userId); }
}

async function readAccessToken(userId: string) {
  const connection = db.prepare('SELECT * FROM zernio_connections WHERE user_id = ?').get(userId) as Connection | null;
  if (!connection) return null;
  if (connection.expires_at > now() + 60) return decrypt(connection.access_token);
  const response = await fetch('https://zernio.com/api/oauth/token', {
    method: 'POST', signal: AbortSignal.timeout(15_000), headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'refresh_token', client_id: await clientId(), refresh_token: decrypt(connection.refresh_token) }),
  });
  if (!response.ok) {
    const failure = await response.json().catch(() => null) as { error?: unknown } | null;
    throw Object.assign(new Error(`Zernio token refresh failed: ${response.status}`), {
      status: response.status, code: failure?.error === 'invalid_grant' ? 'invalid_grant' : undefined,
    });
  }
  const tokens = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
  if (!tokens.access_token || !tokens.refresh_token || !tokens.expires_in) throw new Error('Incomplete Zernio token refresh');
  if (!db.prepare(`UPDATE zernio_connections SET access_token = ?, refresh_token = ?, expires_at = ?
    WHERE user_id = ? AND owner_id = ? AND refresh_token = ?`)
    .run(encrypt(tokens.access_token), encrypt(tokens.refresh_token), now() + tokens.expires_in, userId, connection.owner_id, connection.refresh_token).changes) throw new Error('Connection changed during token refresh');
  return tokens.access_token;
}

export async function zernioGet(token: string, path: string) {
  const response = await fetch(`https://zernio.com/api/v1${path}`, { signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token}` } });
  if (!response.ok) {
    const body = await response.json().catch(() => null) as {
      code?: unknown;
      platform?: unknown;
      platformError?: { code?: unknown; subcode?: unknown; error_subcode?: unknown; type?: unknown };
    } | null;
    const endpoint = path.split('?')[0].replace(/\/inbox\/comments\/.+/, '/inbox/comments/{postId}');
    console.error('Zernio request failed', {
      endpoint, status: response.status,
      code: typeof body?.code === 'string' ? body.code.slice(0, 80) : undefined,
      platform: typeof body?.platform === 'string' ? body.platform.slice(0, 32) : undefined,
      providerCode: typeof body?.platformError?.code === 'number' ? body.platformError.code : undefined,
      providerSubcode: typeof body?.platformError?.subcode === 'number' ? body.platformError.subcode :
        typeof body?.platformError?.error_subcode === 'number' ? body.platformError.error_subcode : undefined,
      requestId: response.headers.get('x-request-id'),
    });
    throw new Error(`Zernio API returned ${response.status}`);
  }
  return response.json();
}

export async function ownerId(token: string) {
  // shortcut: Zernio does not expose a team id here; require the owner until a stable team identity is available.
  const data = await zernioGet(token, '/users') as { currentUserId?: string; users?: { _id: string; role: string }[] };
  const owner = data.users?.find((user) => user.role === 'owner');
  if (!owner || owner._id !== data.currentUserId) throw new Error('Connect as the Zernio team owner');
  return owner._id;
}

function cleanupRetired(userId: string, connection: Connection | null) {
  if (!connection || connection.expires_at <= now() + 30) return;
  // Use only an already-valid token in memory; never retain old credentials for cleanup.
  void import('./webhook-setup').then(({ cleanupWebhookSubscriptions }) =>
    cleanupWebhookSubscriptions(userId, connection.owner_id, decrypt(connection.access_token)))
    .catch(() => console.error('Zernio webhook cleanup pending'));
}

export const zernio = new Hono();
zernio.use('*', async (c, next) => { await next(); c.header('Cache-Control', 'no-store'); });

zernio.get('/api/zernio/connect', async (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.redirect('/api/auth/google');
  const webhooks = c.req.queries('webhooks');
  if (webhooks && (webhooks.length !== 1 || webhooks[0] !== '1')) return c.text('Invalid webhook permission request', 400);
  if (!redirectUri || !key) return c.text('Zernio connection is not configured', 503);
  try {
    const state = oauth.randomState();
    const verifier = oauth.randomPKCECodeVerifier();
    const challenge = await oauth.calculatePKCECodeChallenge(verifier);
    const url = new URL('https://zernio.com/oauth/authorize');
    url.search = new URLSearchParams({ response_type: 'code', client_id: await clientId(), redirect_uri: redirectUri,
      scope: 'accounts:read posts:read messaging:write automations:write', state, code_challenge: challenge, code_challenge_method: 'S256' }).toString();
    db.prepare('DELETE FROM zernio_attempts WHERE expires_at < ?').run(now());
    db.prepare('INSERT INTO zernio_attempts VALUES (?, ?, ?, ?)').run(Bun.CryptoHasher.hash('sha256', state, 'hex'), user.id, verifier, now() + 600);
    setCookie(c, 'cl_zernio_oauth', state, { ...cookieOptions, maxAge: 600 });
    return c.redirect(url.href);
  } catch {
    return c.text('Could not start Zernio connection; try again', 502);
  }
});

zernio.get('/api/zernio/callback', async (c) => {
  const state = c.req.query('state');
  const user = getUser(getCookie(c, 'cl_session'));
  if (!state || !user || state !== getCookie(c, 'cl_zernio_oauth')) return c.text('Invalid Zernio connection attempt', 400);
  deleteCookie(c, 'cl_zernio_oauth', cookieOptions);
  const attempt = db.prepare(`DELETE FROM zernio_attempts WHERE state_hash = ? AND user_id = ? AND expires_at >= ? RETURNING verifier`)
    .get(Bun.CryptoHasher.hash('sha256', state, 'hex'), user.id, now()) as { verifier: string } | null;
  if (!attempt) return c.text('Connection expired; try again', 400);
  if (!c.req.query('code')) return c.text('Zernio connection was not approved', 400);
  try {
    const response = await fetch('https://zernio.com/api/oauth/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: c.req.query('code')!,
        client_id: await clientId(), redirect_uri: redirectUri!, code_verifier: attempt.verifier }),
    });
    if (!response.ok) throw new Error(`Zernio token exchange failed: ${response.status}`);
    const tokens = await response.json() as { access_token?: string; refresh_token?: string; expires_in?: number };
    if (!tokens.access_token || !tokens.refresh_token || !tokens.expires_in) throw new Error('Incomplete Zernio token response');
    const owner = await ownerId(tokens.access_token);
    const occupied = db.prepare('SELECT user_id FROM zernio_connections WHERE owner_id = ?').get(owner) as { user_id: string } | null;
    if (occupied && occupied.user_id !== user.id) return c.text('This Zernio team is already connected to another workspace', 409);
    const { access_token, refresh_token, expires_in } = tokens;
    const previous = db.prepare('SELECT * FROM zernio_connections WHERE user_id = ?').get(user.id) as Connection | null;
    db.transaction(() => {
      db.prepare('DELETE FROM webhook_bindings WHERE user_id = ?').run(user.id);
      db.prepare(`INSERT INTO zernio_connections VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(user_id) DO UPDATE SET owner_id = excluded.owner_id, access_token = excluded.access_token,
        refresh_token = excluded.refresh_token, expires_at = excluded.expires_at`)
        .run(user.id, owner, encrypt(access_token), encrypt(refresh_token), now() + expires_in);
      queueWebhookSetup(user.id, encrypt(randomBytes(32).toString('base64url')));
    })();
    cleanupRetired(user.id, previous);
    return c.redirect(destination());
  } catch {
    return c.text('Could not connect Zernio. Confirm that your Zernio account owns the team, then try again.', 502);
  }
});

zernio.get('/api/zernio', async (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  const connected = db.prepare('SELECT owner_id FROM zernio_connections WHERE user_id = ?').get(user.id) as { owner_id: string } | null;
  if (!connected) return c.json({ connected: false, accounts: [] });
  try {
    const token = (await accessToken(user.id))!;
    if (await ownerId(token) !== connected.owner_id) throw new Error('Zernio team ownership changed');
    const accounts: { id: string; platform: string; username: string; profilePicture: string | null }[] = [];
    let cursor: string | undefined;
    do {
      const query = new URLSearchParams({ platforms: 'instagram,youtube', status: 'connected', limit: '500' });
      if (cursor) query.set('cursor', cursor);
      const data = await zernioGet(token, `/accounts?${query}`) as {
        accounts?: { _id: string; platform: string; username?: string; profilePicture?: string | null }[];
        pagination?: { nextCursor?: string | null };
      };
      if (!Array.isArray(data.accounts)) throw new Error('Invalid Zernio accounts response');
      accounts.push(...data.accounts.map((account) => {
        let profilePicture: string | null = null;
        try {
          const url = new URL(account.profilePicture || '');
          if (url.protocol === 'https:' && ['fbcdn.net', 'cdninstagram.com', 'googleusercontent.com', 'ytimg.com', 'ggpht.com']
            .some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`))) profilePicture = url.href;
        } catch { /* No profile image supplied. */ }
        return { id: account._id, platform: account.platform, username: account.username || account._id, profilePicture };
      }));
      cursor = data.pagination?.nextCursor || undefined;
    } while (cursor);
    const voices = db.prepare("SELECT account_id, instructions FROM brand_voices WHERE user_id = ? AND account_id != '*'").all(user.id) as { account_id: string; instructions: string }[];
    const preferences = db.prepare('SELECT account_id, enabled FROM moderation_preferences WHERE user_id = ? AND owner_id = ? AND backfill_confirmed = 1').all(user.id, connected.owner_id) as { account_id: string; enabled: number }[];
    const accountIssues = db.prepare(`SELECT s.account_id AS accountId, s.platform, s.status FROM webhook_account_state s
      JOIN webhook_bindings b ON b.id = s.binding_id WHERE b.user_id = ? AND b.owner_id = ?`).all(user.id, connected.owner_id);
    const webhook = db.prepare(`SELECT s.status FROM webhook_setup s JOIN webhook_bindings b ON b.id = s.binding_id
      WHERE b.user_id = ? AND b.owner_id = ? ORDER BY b.rowid LIMIT 1`).get(user.id, connected.owner_id) ?? { status: 'pending' };
    return c.json({ connected: true, accounts, voices: Object.fromEntries(voices.map((voice) => [voice.account_id, voice.instructions])),
      moderation: Object.fromEntries(preferences.map((preference) => [preference.account_id, !!preference.enabled])), accountIssues, webhook });
  } catch {
    return c.json({ error: 'Could not read Zernio accounts. Reconnect Zernio if the problem continues.' }, 502);
  }
});

zernio.put('/api/accounts/:accountId/moderation', async (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  if (![new URL(c.req.url).origin, appOrigin && new URL(appOrigin).origin].includes(c.req.header('origin'))) return c.json({ error: 'Invalid origin' }, 403);
  const body = await c.req.json().catch(() => null) as { enabled?: unknown } | null;
  const accountId = c.req.param('accountId');
  if (typeof body?.enabled !== 'boolean' || !/^[a-f\d]{24}$/i.test(accountId)) return c.json({ error: 'Invalid setting' }, 400);
  const connection = db.prepare('SELECT owner_id FROM zernio_connections WHERE user_id = ?').get(user.id) as { owner_id: string } | null;
  if (!connection) return c.json({ error: 'Connect Zernio first' }, 409);
  try {
    const token = await accessToken(user.id);
    if (!token || await ownerId(token) !== connection.owner_id) throw new Error('Connection changed');
    const listed = await zernioGet(token, `/accounts?${new URLSearchParams({ search: accountId, platforms: 'instagram,youtube', status: 'connected', limit: '1' })}`) as {
      accounts?: { _id: string; platform: string; status?: string }[];
    };
    if (!listed.accounts?.some((account) => account._id === accountId && ['instagram', 'youtube'].includes(account.platform) && (!account.status || account.status === 'connected'))) return c.json({ error: 'Account not found' }, 404);
  } catch { return c.json({ error: 'Could not verify Zernio account. No setting was saved.' }, 502); }
  if (!db.prepare('SELECT 1 FROM zernio_connections WHERE user_id = ? AND owner_id = ?').get(user.id, connection.owner_id)) return c.json({ error: 'Connection changed' }, 409);
  db.prepare(`INSERT INTO moderation_preferences (user_id, account_id, owner_id, enabled, confirmed_at, backfill_confirmed) VALUES (?, ?, ?, ?, ?, 1) ON CONFLICT(user_id, account_id)
    DO UPDATE SET owner_id = excluded.owner_id, enabled = excluded.enabled, confirmed_at = excluded.confirmed_at, backfill_confirmed = 1`)
    .run(user.id, accountId, connection.owner_id, Number(body.enabled), new Date().toISOString());
  return c.json({ enabled: body.enabled });
});

zernio.get('/api/zernio/preview', async (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  const accountId = c.req.query('accountId');
  if (!accountId || !/^[a-f\d]{24}$/i.test(accountId)) return c.json({ error: 'Invalid account' }, 400);
  const connection = db.prepare('SELECT owner_id FROM zernio_connections WHERE user_id = ?').get(user.id) as { owner_id: string } | null;
  if (!connection) return c.json({ error: 'Connect Zernio first' }, 409);
  let stage = 'verify connection';
  let platform: string | undefined;
  try {
    const token = (await accessToken(user.id))!;
    if (await ownerId(token) !== connection.owner_id) throw new Error('Zernio team ownership changed');
    stage = 'verify account';
    const listed = await zernioGet(token, `/accounts?${new URLSearchParams({ search: accountId, platforms: 'instagram,youtube', limit: '1' })}`) as {
      accounts?: { _id: string; platform: string }[];
    };
    const account = listed.accounts?.find((item) => item._id === accountId && ['instagram', 'youtube'].includes(item.platform));
    if (!account) return c.json({ error: 'Account not found in your Zernio connection' }, 404);
    platform = account.platform;
    stage = 'list commented posts';
    const posts: { id: string; content?: string; commentCount: number; createdTime?: string }[] = [];
    let cursor: string | undefined;
    let olderPostsMayHaveComments = false;
    let pagesChecked = 0;
    let lastUpdated: string | undefined;
    for (let page = 0; page < 3 && posts.length < 3; page++) {
      const query = new URLSearchParams({ accountId, platform: account.platform, limit: '30', minComments: '1', sortBy: 'date' });
      if (cursor) query.set('cursor', cursor);
      const feed = await zernioGet(token, `/inbox/comments?${query}`) as {
        data?: { id: string; content?: string; commentCount: number; createdTime?: string }[];
        meta?: { accountsFailed?: number; failedAccounts?: { code?: string }[]; lastUpdated?: string };
        pagination?: { hasMore?: boolean; nextCursor?: string | null };
      };
      if (feed.meta?.accountsFailed) {
        console.error('Zernio account read failed', { codes: feed.meta.failedAccounts?.map((failed) => failed.code).filter(Boolean) });
        throw new Error('Zernio could not list commented posts');
      }
      if (!Array.isArray(feed.data)) throw new Error('Invalid Zernio post feed');
      pagesChecked++;
      lastUpdated = feed.meta?.lastUpdated;
      for (const post of feed.data) {
        if (post.commentCount > 0 && !posts.some((item) => item.id === post.id)) posts.push(post);
        if (posts.length === 3) break;
      }
      olderPostsMayHaveComments = feed.pagination?.hasMore === true;
      if (!olderPostsMayHaveComments || !feed.pagination?.nextCursor || feed.pagination.nextCursor === cursor) break;
      cursor = feed.pagination.nextCursor;
    }
    if (!posts.length) {
      console.info('Zernio comment preview empty', { platform, pagesChecked, olderPostsMayHaveComments, lastUpdated });
      return c.json({ posts, comments: [], olderPostsMayHaveComments });
    }
    stage = 'read post comments';
    const thread = await zernioGet(token, `/inbox/comments/${encodeURIComponent(posts[0].id)}?${new URLSearchParams({ accountId, limit: '10' })}`) as {
      comments?: { id: string; message: string; from?: { name?: string; isOwner?: boolean }; replies?: { id: string; message: string }[] }[];
    };
    if (!Array.isArray(thread.comments)) throw new Error('Invalid Zernio comment response');
    return c.json({ posts, comments: thread.comments.map(({ id, message, from, replies }) => ({ id, message, author: from?.name || 'Commenter', isOwner: from?.isOwner || false,
      replies: (replies || []).map(({ id, message }) => ({ id, message })) })) });
  } catch (error) {
    console.error('Zernio comment preview failed', { stage, reason: error instanceof Error ? error.message : 'Unknown error' });
    if (platform === 'youtube' && stage === 'read post comments') {
      try {
        const health = await zernioGet((await accessToken(user.id))!, `/accounts/${accountId}/health`) as {
          tokenStatus?: { valid?: boolean };
          needsReconnect?: boolean;
          permissions?: { optional?: { scope: string; granted: boolean }[] };
        };
        const scope = health.permissions?.optional?.find((permission) => permission.scope.endsWith('youtube.force-ssl'));
        console.error('Zernio YouTube comment access', {
          commentScopeGranted: scope?.granted ?? null,
          tokenValid: health.tokenStatus?.valid ?? null,
          needsReconnect: health.needsReconnect ?? null,
        });
        if (scope?.granted === false) {
          return c.json({ error: 'YouTube comments access was not granted to Zernio. Reconnect your YouTube account in Zernio and allow its comments permission.' }, 502);
        }
      } catch {
        console.error('Zernio YouTube account health check failed');
      }
    }
    return c.json({ error: 'Could not read comments with this Zernio connection. No changes were made.' }, 502);
  }
});

zernio.get('/api/backfill', (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  const accounts = db.prepare(`SELECT b.account_id AS accountId, b.selected,
      COUNT(p.post_id) AS posts, SUM(p.completed_at IS NOT NULL) AS completedPosts,
      COALESCE(SUM(p.expected_comments), 0) AS expectedComments,
      (SELECT COUNT(*) FROM backfill_comments comments WHERE comments.user_id = b.user_id AND comments.account_id = b.account_id) AS savedComments
    FROM backfill_accounts b LEFT JOIN backfill_posts p ON p.user_id = b.user_id AND p.account_id = b.account_id
    WHERE b.user_id = ? GROUP BY b.account_id`).all(user.id) as {
      accountId: string; selected: number; posts: number; completedPosts: number; expectedComments: number; savedComments: number;
    }[];
  return c.json({ accounts });
});

zernio.get('/api/posts', (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  const view = c.req.query('view') || 'all';
  const sort = c.req.query('sort') || 'newest';
  if (!['all', 'hidden', 'replies', 'hidden,replies'].includes(view) || !['newest', 'oldest'].includes(sort)) return c.json({ error: 'Invalid query' }, 400);
  let before: string[] | undefined;
  if (c.req.query('before')) {
    try {
      if (c.req.query('before')!.length > 1024) throw new Error();
      const value: unknown = JSON.parse(Buffer.from(c.req.query('before')!, 'base64url').toString());
      if (!Array.isArray(value) || value.length !== 3 || !value.every(part => typeof part === 'string' && part.length <= 256) ||
        !['', '9999-12-31'].includes(value[0]) && !Number.isFinite(Date.parse(value[0]))) throw new Error();
      before = value;
    } catch { return c.json({ error: 'Invalid cursor' }, 400); }
  }
  const unknownDate = sort === 'oldest' ? '9999-12-31' : '';
  const direction = sort === 'oldest' ? 'ASC' : 'DESC';
  const comparison = sort === 'oldest' ? '>' : '<';
  const filters = view.split(',').filter(item => item !== 'all').map(item => item === 'hidden' ? 'hiddenCount > 0' : 'needsReplyCount > 0');
  const rows = db.prepare(`WITH summaries AS (
    SELECT p.account_id AS accountId, p.post_id AS id, a.platform, p.content, p.picture, p.created_at AS createdAt,
      COUNT(c.comment_id) AS commentCount, COALESCE(SUM(c.is_hidden = 1), 0) AS hiddenCount,
      COALESCE(SUM(c.is_hidden = 0 AND assessment.classified_message = c.message AND assessment.category = 'safe'
        AND assessment.needs_reply = 1 AND assessment.dismissed = 0 AND sent.comment_id IS NULL AND owner.comment_id IS NULL), 0) AS needsReplyCount
    FROM monitored_posts p JOIN monitored_accounts a USING (user_id, account_id)
    LEFT JOIN synced_comments c ON c.user_id = p.user_id AND c.account_id = p.account_id AND c.post_id = p.post_id
    LEFT JOIN comment_assessments assessment ON assessment.user_id = c.user_id AND assessment.account_id = c.account_id AND assessment.comment_id = c.comment_id
    LEFT JOIN comment_replies sent ON sent.user_id = c.user_id AND sent.account_id = c.account_id AND sent.comment_id = c.comment_id
    LEFT JOIN owner_replies owner ON owner.user_id = c.user_id AND owner.account_id = c.account_id AND owner.comment_id = c.comment_id
    WHERE p.user_id = ? GROUP BY p.account_id, p.post_id
  ) SELECT * FROM summaries WHERE (COALESCE(createdAt, ?), accountId, id) ${comparison} (?, ?, ?)
    ${filters.length ? `AND (${filters.join(' OR ')})` : ''}
    ORDER BY COALESCE(createdAt, ?) ${direction}, accountId ${direction}, id ${direction} LIMIT 51`)
    .all(user.id, unknownDate, ...(before || [sort === 'oldest' ? '' : '9999-12-31', '', '']), unknownDate) as {
      accountId: string; id: string; platform: string; content: string | null; picture: string | null; createdAt: string | null;
      commentCount: number; hiddenCount: number; needsReplyCount: number;
    }[];
  const page = rows.slice(0, 50), last = page.at(-1);
  return c.json({ posts: page, nextCursor: rows.length > 50 && last ? Buffer.from(JSON.stringify([last.createdAt ?? unknownDate, last.accountId, last.id])).toString('base64url') : null });
});

zernio.get('/api/comments', (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  const view = c.req.query('view') || 'all';
  if (!['all', 'posts', 'hidden', 'replies', 'hidden,replies', 'posts,hidden', 'posts,replies', 'posts,hidden,replies'].includes(view)) return c.json({ error: 'Invalid view' }, 400);
  const postsView = view === 'posts' || view.startsWith('posts,');
  const filters: string[] = [];
  if (view.split(',').includes('hidden')) filters.push('comments.is_hidden = 1');
  if (view.split(',').includes('replies')) filters.push("(comments.is_hidden = 0 AND sent.comment_id IS NULL AND owner.comment_id IS NULL AND assessment.classified_message = comments.message AND assessment.category = 'safe' AND assessment.needs_reply = 1 AND assessment.dismissed = 0)");
  const sort = c.req.query('sort') || 'newest';
  if (!['newest', 'oldest'].includes(sort)) return c.json({ error: 'Invalid sort' }, 400);
  const accountId = c.req.query('accountId'), postId = c.req.query('postId');
  if ((accountId !== undefined || postId !== undefined) && (!accountId || !postId || accountId.length > 256 || postId.length > 256)) return c.json({ error: 'Invalid post' }, 400);
  let before: string[] | undefined;
  if (c.req.query('before')) {
    try {
      if (c.req.query('before')!.length > 1024) throw new Error('Invalid cursor');
      const parsed: unknown = JSON.parse(Buffer.from(c.req.query('before')!, 'base64url').toString());
      if (!Array.isArray(parsed) || parsed.length !== (postsView ? 5 : 3) || !parsed.every((part) => typeof part === 'string' && part.length <= 128) ||
          (postsView ? !['', '9999-12-31'].includes(parsed[0]) && !Number.isFinite(Date.parse(parsed[0])) || !Number.isFinite(Date.parse(parsed[3])) : !Number.isFinite(Date.parse(parsed[0])))) throw new Error('Invalid cursor');
      before = parsed;
    } catch { return c.json({ error: 'Invalid cursor' }, 400); }
  }
  const postDate = sort === 'oldest' ? "COALESCE(posts.created_at, '9999-12-31')" : "COALESCE(posts.created_at, '')";
  const postDirection = sort === 'oldest' ? 'ASC' : 'DESC';
  const cursorValues = postsView
    ? before ? [before[0], ...before] : [sort === 'oldest' ? '' : '9999-12-31', sort === 'oldest' ? '' : '9999-12-31', '', '', '', '']
    : before ?? [sort === 'oldest' ? '' : '9999-12-31', '', ''];
  const rows = db.prepare(`SELECT comments.account_id AS accountId, accounts.platform, comments.post_id AS postId,
        posts.content AS postContent, posts.picture AS postPicture, posts.created_at AS postCreatedAt, comments.comment_id AS id, comments.parent_id AS parentId,
       comments.message, comments.author, comments.created_at AS createdAt, comments.is_hidden AS isHidden,
       CASE WHEN historical.comment_id IS NOT NULL THEN 1 ELSE 0 END AS isBackfill,
       CASE WHEN assessment.classified_message = comments.message THEN assessment.category END AS category,
        CASE WHEN assessment.classified_message = comments.message THEN assessment.reason END AS reason,
         CASE WHEN assessment.classified_message = comments.message AND assessment.category = 'safe' AND assessment.needs_reply = 1 AND assessment.dismissed = 0 THEN assessment.draft END AS draft,
         CASE WHEN assessment.classified_message = comments.message AND assessment.category = 'safe' AND assessment.needs_reply = 1 AND assessment.dismissed = 0 AND comments.is_hidden = 0 AND sent.comment_id IS NULL AND owner.comment_id IS NULL THEN 1 ELSE 0 END AS needsReply,
        CASE WHEN sent.status = 'sent' AND sent.reply_id IS NULL THEN 'user_confirmed' WHEN owner.comment_id IS NOT NULL THEN 'sent' ELSE sent.status END AS replyStatus,
        CASE WHEN sent.status IN ('pending', 'unknown') THEN sent.message END AS replyMessage,
        CASE WHEN sent.status IN ('pending', 'unknown') THEN sent.idempotency_key END AS replyAttempt,
        moderation.status AS moderationStatus, COALESCE(moderation.visibility_uncertain, 0) AS visibilityUncertain,
        CASE WHEN moderation.status IN ('restore_pending', 'restore_unknown') THEN moderation.restore_token END AS restoreAttempt,
        CASE WHEN moderation.status = 'hide_unknown' THEN moderation.claim_token END AS hideAttempt
     FROM synced_comments comments
     JOIN monitored_posts posts ON posts.user_id = comments.user_id AND posts.account_id = comments.account_id AND posts.post_id = comments.post_id
     JOIN monitored_accounts accounts ON accounts.user_id = comments.user_id AND accounts.account_id = comments.account_id
     LEFT JOIN comment_assessments assessment ON assessment.user_id = comments.user_id AND assessment.account_id = comments.account_id AND assessment.comment_id = comments.comment_id
     LEFT JOIN backfill_comments historical ON historical.user_id = comments.user_id AND historical.account_id = comments.account_id AND historical.comment_id = comments.comment_id
     LEFT JOIN comment_replies sent ON sent.user_id = comments.user_id AND sent.account_id = comments.account_id AND sent.comment_id = comments.comment_id
      LEFT JOIN owner_replies owner ON owner.user_id = comments.user_id AND owner.account_id = comments.account_id AND owner.comment_id = comments.comment_id
      LEFT JOIN moderation_jobs moderation ON moderation.user_id = comments.user_id AND moderation.account_id = comments.account_id AND moderation.comment_id = comments.comment_id
          WHERE comments.user_id = ?${accountId ? ' AND comments.account_id = ? AND comments.post_id = ?' : ''}${filters.length ? ` AND (${filters.join(' OR ')})` : ''}
         AND ${postsView ? `(${postDate} ${sort === 'oldest' ? '>' : '<'} ? OR (${postDate} = ? AND (comments.account_id, comments.post_id, comments.created_at, comments.comment_id) < (?, ?, ?, ?)))` : `(comments.created_at, comments.account_id, comments.comment_id) ${sort === 'oldest' ? '>' : '<'} (?, ?, ?)`}
       ORDER BY ${postsView ? `${postDate} ${postDirection}, comments.account_id DESC, comments.post_id DESC,` : ''} comments.created_at ${postsView ? 'DESC' : postDirection}, ${postsView ? '' : `comments.account_id ${postDirection},`} comments.comment_id ${postsView ? 'DESC' : postDirection} LIMIT 51`)
       .all(user.id, ...(accountId ? [accountId, postId!] : []), ...cursorValues) as {
        accountId: string; platform: string; postId: string; postContent: string | null; id: string;
         postPicture: string | null; postCreatedAt: string | null;
        parentId: string | null; message: string; author: string; createdAt: string; isHidden: number; isBackfill: number;
          category: string | null; reason: string | null; draft: string | null; needsReply: number; replyStatus: string | null; replyMessage: string | null; replyAttempt: string | null; moderationStatus: string | null; restoreAttempt: string | null; hideAttempt: string | null; visibilityUncertain: number;
    }[];
  const hasMore = rows.length > 50;
  const page = rows.slice(0, 50);
  const last = page.at(-1);
  return c.json({ comments: page.map(({ isHidden, isBackfill, visibilityUncertain, needsReply, ...comment }) => ({ ...comment, isHidden: !!isHidden, isBackfill: !!isBackfill, visibilityUncertain: !!visibilityUncertain, needsReply: !!needsReply })),
     nextCursor: hasMore && last ? Buffer.from(JSON.stringify(postsView ? [last.postCreatedAt ?? (sort === 'oldest' ? '9999-12-31' : ''), last.accountId, last.postId, last.createdAt, last.id] : [last.createdAt, last.accountId, last.id])).toString('base64url') : null });
});

zernio.put('/api/comments/:accountId/:commentId/draft', async (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  if (![new URL(c.req.url).origin, appOrigin && new URL(appOrigin).origin].includes(c.req.header('origin'))) return c.json({ error: 'Invalid origin' }, 403);
  const body = await c.req.json().catch(() => null) as { draft?: unknown } | null;
  if (typeof body?.draft !== 'string' || body.draft.length > 2000 || !body.draft.trim()) return c.json({ error: 'Invalid draft' }, 400);
  const updated = db.prepare(`UPDATE comment_assessments SET draft = ?, draft_edited = 1 WHERE user_id = ? AND account_id = ? AND comment_id = ?
    AND category = 'safe' AND needs_reply = 1 AND dismissed = 0 AND EXISTS (SELECT 1 FROM synced_comments c WHERE c.user_id = ? AND c.account_id = ? AND c.comment_id = ? AND c.message = classified_message)`)
    .run(body.draft.trim(), user.id, c.req.param('accountId'), c.req.param('commentId'), user.id, c.req.param('accountId'), c.req.param('commentId'));
  return updated.changes ? c.json({ draft: body.draft.trim() }) : c.json({ error: 'Draft not found or comment changed' }, 404);
});

zernio.get('/api/archived-drafts', (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  return c.json({ drafts: db.prepare('SELECT account_id AS accountId, comment_id AS commentId, draft FROM archived_drafts WHERE user_id = ? ORDER BY rowid DESC')
    .all(user.id) });
});

zernio.put('/api/archived-drafts/:accountId/:commentId', async (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  if (![new URL(c.req.url).origin, appOrigin && new URL(appOrigin).origin].includes(c.req.header('origin'))) return c.json({ error: 'Invalid origin' }, 403);
  const body = await c.req.json().catch(() => null) as { draft?: unknown } | null;
  if (typeof body?.draft !== 'string' || !body.draft.trim() || body.draft.length > 2000) return c.json({ error: 'Invalid draft' }, 400);
  const updated = db.prepare('UPDATE archived_drafts SET draft = ? WHERE user_id = ? AND account_id = ? AND comment_id = ?')
    .run(body.draft.trim(), user.id, c.req.param('accountId'), c.req.param('commentId'));
  return updated.changes ? c.json({ draft: body.draft.trim() }) : c.json({ error: 'Draft not found' }, 404);
});

zernio.delete('/api/drafts/:accountId/:commentId', (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  if (![new URL(c.req.url).origin, appOrigin && new URL(appOrigin).origin].includes(c.req.header('origin'))) return c.json({ error: 'Invalid origin' }, 403);
  const { accountId, commentId } = c.req.param();
  const archived = db.prepare('DELETE FROM archived_drafts WHERE user_id = ? AND account_id = ? AND comment_id = ?')
    .run(user.id, accountId, commentId);
  if (archived.changes) return c.json({ dismissed: true });
  const current = db.prepare(`UPDATE comment_assessments SET dismissed = 1, draft = NULL WHERE user_id = ? AND account_id = ? AND comment_id = ?
    AND needs_reply = 1 AND category = 'safe'`).run(user.id, accountId, commentId);
  return current.changes ? c.json({ dismissed: true }) : c.json({ error: 'Draft not found' }, 404);
});

zernio.put('/api/accounts/:accountId/voice', async (c) => {
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  if (![new URL(c.req.url).origin, appOrigin && new URL(appOrigin).origin].includes(c.req.header('origin'))) return c.json({ error: 'Invalid origin' }, 403);
  const body = await c.req.json().catch(() => null) as { instructions?: unknown } | null;
  if (typeof body?.instructions !== 'string' || body.instructions.length > 2000) return c.json({ error: 'Invalid instructions' }, 400);
  const accountId = c.req.param('accountId');
  if (!db.prepare('SELECT 1 FROM zernio_connections WHERE user_id = ?').get(user.id)) return c.json({ error: 'Connect Zernio first' }, 409);
  if (!/^[a-f\d]{24}$/i.test(accountId)) return c.json({ error: 'Invalid account' }, 400);
  if (!db.prepare('SELECT 1 FROM monitored_accounts WHERE user_id = ? AND account_id = ?').get(user.id, accountId)) {
    try {
      const token = await accessToken(user.id);
      const connection = db.prepare('SELECT owner_id FROM zernio_connections WHERE user_id = ?').get(user.id) as { owner_id: string } | null;
      if (!token || !connection || await ownerId(token) !== connection.owner_id) throw new Error('Connection changed');
      const listed = await zernioGet(token, `/accounts?${new URLSearchParams({ search: accountId, platforms: 'instagram,youtube', limit: '1' })}`) as {
        accounts?: { _id: string; platform: string }[];
      };
      if (!Array.isArray(listed.accounts)) throw new Error('Invalid account list');
      if (!listed.accounts.some((item) => item._id === accountId && ['instagram', 'youtube'].includes(item.platform))) return c.json({ error: 'Account not found' }, 404);
    } catch { return c.json({ error: 'Could not verify Zernio account' }, 502); }
  }
  db.prepare(`INSERT INTO brand_voices VALUES (?, ?, ?) ON CONFLICT(user_id, account_id) DO UPDATE SET instructions = excluded.instructions`)
    .run(user.id, accountId, body.instructions.trim());
  return c.json({ instructions: body.instructions.trim() });
});

zernio.post('/api/zernio/disconnect', (c) => {
  if (c.req.header('origin') !== new URL(redirectUri || c.req.url).origin && c.req.header('origin') !== new URL(appOrigin || c.req.url).origin) return c.text('Invalid origin', 403);
  const user = getUser(getCookie(c, 'cl_session'));
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  const previous = db.prepare('SELECT * FROM zernio_connections WHERE user_id = ?').get(user.id) as Connection | null;
  db.prepare('DELETE FROM zernio_connections WHERE user_id = ?').run(user.id);
  cleanupRetired(user.id, previous);
  return c.json({ connected: false });
});
