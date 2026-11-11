import { Hono } from 'hono';
import { getCookie } from 'hono/cookie';
import { streamSSE } from 'hono/streaming';
import { getUser } from './db';

// shortcut: in-process invalidation assumes one replica; use shared fanout before scaling out.
const subscribers = new Map<string, Set<() => void>>();
let total = 0;
export function notifyWorkspace(userId: string) {
  for (const notify of subscribers.get(userId) || []) notify();
}

export const events = new Hono();
events.use('/api/*', async (c, next) => {
  const user = c.req.method === 'GET' ? null : getUser(getCookie(c, 'cl_session'));
  await next();
  if (user && ![401, 403, 404].includes(c.res.status)) notifyWorkspace(user.id);
});

events.get('/api/events', (c) => {
  const token = getCookie(c, 'cl_session');
  const user = getUser(token);
  if (!user) return c.json({ error: 'Unauthenticated' }, 401);
  const origin = c.req.header('origin');
  const allowed = [new URL(c.req.url).origin];
  for (const value of [Bun.env.APP_ORIGIN, Bun.env.GOOGLE_REDIRECT_URI]) {
    if (value) allowed.push(new URL(value).origin);
  }
  if (c.req.header('sec-fetch-site') === 'cross-site' || (origin && !allowed.includes(origin))) return c.json({ error: 'Invalid origin' }, 403);
  const listeners = subscribers.get(user.id) || new Set<() => void>();
  if (total >= 200 || listeners.size >= 3) return c.json({ error: 'Too many live connections' }, 429);
  const response = streamSSE(c, async (stream) => {
    let stopped = false;
    let dirty = true;
    let wake: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notify = () => { dirty = true; wake?.(); };
    const abort = () => stream.abort();
    const stop = () => {
      if (stopped) return;
      stopped = true;
      clearTimeout(timer);
      wake?.();
      listeners.delete(notify);
      if (!listeners.size) subscribers.delete(user.id);
      total--;
      c.req.raw.signal.removeEventListener('abort', abort);
    };
    listeners.add(notify);
    subscribers.set(user.id, listeners);
    total++;
    stream.onAbort(stop);
    c.req.raw.signal.addEventListener('abort', abort, { once: true });
    if (c.req.raw.signal.aborted) abort();
    try {
      while (!stopped) {
        const valid = getUser(token)?.id === user.id;
        const event = !valid ? 'session-ended' : dirty ? 'refresh' : 'heartbeat';
        dirty = false;
        const deadline = setTimeout(abort, 5000);
        try { await stream.writeSSE({ event, data: '{}', retry: 3000 }); }
        finally { clearTimeout(deadline); }
        if (!valid || stopped) break;
        await new Promise<void>(resolve => {
          wake = () => { clearTimeout(timer); wake = undefined; resolve(); };
          timer = setTimeout(wake, 15_000);
          if (dirty) wake();
        });
      }
    } catch { /* Reconnect refetches authoritative data; never expose stream errors. */ }
    finally { stop(); }
  });
  response.headers.set('Cache-Control', 'no-store, no-transform');
  response.headers.set('X-Accel-Buffering', 'no');
  return response;
});
