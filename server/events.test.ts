import { expect, test } from 'bun:test';
import { Hono } from 'hono';

Bun.env.DATABASE_PATH = ':memory:';
const { createSession, db, endSession } = await import('./db');
const { events, notifyWorkspace } = await import('./events');

function connect(token: string, query = '') {
  const abort = new AbortController();
  const response = events.request(`/api/events${query}`, { headers: { Cookie: `cl_session=${token}` }, signal: abort.signal });
  return { abort, response };
}
const text = async (reader: ReadableStreamDefaultReader<Uint8Array>) => new TextDecoder().decode((await reader.read()).value);

test('SSE requires a session and same-origin requests, and sends only workspace-scoped refresh pokes', async () => {
  expect((await events.request('/api/events')).status).toBe(401);
  const a = createSession('sse-a', 'a@example.com', 'A');
  const b = createSession('sse-b', 'b@example.com', 'B');
  const headers = { Cookie: `cl_session=${a.token}`, Origin: 'https://untrusted.example' };
  expect((await events.request('/api/events', { headers })).status).toBe(403);
  expect((await events.request('/api/events', { headers: { Cookie: headers.Cookie, 'Sec-Fetch-Site': 'cross-site' } })).status).toBe(403);
  const first = connect(a.token, `?userId=${b.user.id}`);
  const second = connect(b.token);
  const ar = (await first.response).body!.getReader();
  const response = await second.response;
  const br = response.body!.getReader();
  try {
    expect(response.headers.get('Content-Type')).toContain('text/event-stream');
    expect(response.headers.get('Cache-Control')).toBe('no-store, no-transform');
    expect(response.headers.get('X-Accel-Buffering')).toBe('no');
    expect(await text(ar)).toBe('event: refresh\ndata: {}\nretry: 3000\n\n');
    await text(br);
    let bNotified = false;
    const waiting = br.read().then(value => { bNotified = true; return value; });
    notifyWorkspace(a.user.id);
    expect(await text(ar)).toBe('event: refresh\ndata: {}\nretry: 3000\n\n');
    await new Promise(resolve => setTimeout(resolve, 30));
    expect(bNotified).toBe(false);
    second.abort.abort();
    await waiting;
    endSession(a.token);
    notifyWorkspace(a.user.id);
    expect(await text(ar)).toContain('event: session-ended\ndata: {}');
    expect((await ar.read()).done).toBe(true);
  } finally { first.abort.abort(); second.abort.abort(); await ar.cancel(); await br.cancel(); }
});

test('SSE bounds concurrent streams and releases aborted connections; reconnect always requests a refresh', async () => {
  const session = createSession('sse-limits', 'limits@example.com', 'Limits');
  const streams = [connect(session.token), connect(session.token), connect(session.token)];
  const readers = await Promise.all(streams.map(async stream => (await stream.response).body!.getReader()));
  try {
    await Promise.all(readers.map(text));
    expect((await events.request('/api/events', { headers: { Cookie: `cl_session=${session.token}` } })).status).toBe(429);
    streams[0]!.abort.abort();
    await readers[0]!.cancel();
    const replacement = connect(session.token);
    const response = await replacement.response;
    expect(response.status).toBe(200);
    const reader = response.body!.getReader();
    expect(await text(reader)).toContain('event: refresh');
    replacement.abort.abort();
    await reader.cancel();
  } finally {
    streams.forEach(stream => stream.abort.abort());
    await Promise.all(readers.map(reader => reader.cancel()));
  }
});

test('successful API writes poke the signed-in workspace only after the write has completed', async () => {
  const session = createSession('sse-write', 'write@example.com', 'Before');
  const app = new Hono().route('/', events);
  app.post('/api/test-write', c => {
    db.transaction(() => db.prepare('UPDATE users SET name = ? WHERE id = ?').run('After', session.user.id))();
    return c.json({ saved: true });
  });
  const stream = connect(session.token);
  const reader = (await stream.response).body!.getReader();
  try {
    await text(reader);
    const response = await app.request('/api/test-write', { method: 'POST', headers: { Cookie: `cl_session=${session.token}` } });
    expect(response.status).toBe(200);
    expect(await text(reader)).toContain('event: refresh');
    expect(db.prepare('SELECT name FROM users WHERE id = ?').get(session.user.id)).toEqual({ name: 'After' });
  } finally { stream.abort.abort(); await reader.cancel(); }
});
