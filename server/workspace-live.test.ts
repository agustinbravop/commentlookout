import { expect, test } from 'bun:test';

const fixture = `
  import assert from 'node:assert/strict';
  import { subscribeWorkspace, loadWindow } from './src/workspace-live';
  const timers = new Map(), intervals = new Map();
  let sequence = 0, redirected = '';
  globalThis.window = new EventTarget();
  globalThis.document = Object.assign(new EventTarget(), { hidden: false });
  globalThis.location = { replace(value) { redirected = value; } };
  globalThis.setTimeout = (fn, delay) => { const id = ++sequence; timers.set(id, { fn, delay }); return id; };
  globalThis.clearTimeout = id => timers.delete(id);
  globalThis.setInterval = (fn, delay) => { const id = ++sequence; intervals.set(id, { fn, delay }); return id; };
  globalThis.clearInterval = id => intervals.delete(id);
  class Source extends EventTarget {
    static last;
    closed = false;
    constructor(url) { super(); assert.equal(url, '/api/events'); Source.last = this; }
    close() { this.closed = true; }
    open() { this.onopen?.(new Event('open')); }
    poke() { this.dispatchEvent(new Event('refresh')); }
  }
  globalThis.EventSource = Source;
  const microtasks = async () => { for(let i=0;i<10;i++) await Promise.resolve(); };
  const tick = async () => {
    const pending = [...timers.values()]; timers.clear();
    pending.forEach(timer => timer.fn()); await microtasks();
  };
`;
function run(code: string) {
  const result = Bun.spawnSync([process.execPath, '-e', fixture + code], { cwd: process.cwd(), stdout: 'pipe', stderr: 'pipe', timeout: 10_000 });
  expect({ code: result.exitCode, error: result.stderr.toString() }).toEqual({ code: 0, error: '' });
}

test('client coalesces SSE pokes, defers edits, serializes refreshes, and retains updates arriving during a fetch', () => run(`
  let calls = 0, editing = true, release;
  let gate = null;
  const stop = subscribeWorkspace(async () => { calls++; if(gate) await gate; }, () => editing);
  Source.last.open(); Source.last.poke(); Source.last.poke();
  assert.equal(timers.size, 1);
  await tick(); assert.equal(calls, 0);
  editing = false;
  await tick(); assert.equal(calls, 1);
  gate = new Promise(resolve => { release = resolve; });
  Source.last.poke(); await tick(); assert.equal(calls, 2);
  Source.last.poke(); Source.last.poke();
  assert.equal(timers.size, 0);
  release(); gate = null; await microtasks();
  assert.equal(timers.size, 1);
  await tick(); assert.equal(calls, 3);
  stop(); Source.last.poke();
  assert.equal(timers.size, 0);
  assert.equal(Source.last.closed, true);
`));

test('client refreshes after reconnect/focus, pauses hidden tabs, falls back on stream errors, and closes revoked sessions', () => run(`
  let calls = 0;
  const stop = subscribeWorkspace(async () => { calls++; }, () => false);
  document.hidden = true;
  Source.last.poke(); await tick(); assert.equal(calls, 0);
  document.hidden = false; document.dispatchEvent(new Event('visibilitychange'));
  await tick(); assert.equal(calls, 1);
  Source.last.onerror(new Event('error')); Source.last.onerror(new Event('error'));
  assert.equal(intervals.size, 1);
  await tick(); assert.equal(calls, 2);
  assert.equal([...intervals.values()][0].delay, 60000);
  Source.last.open(); assert.equal(intervals.size, 0);
  await tick(); assert.equal(calls, 3);
  window.dispatchEvent(new Event('focus')); await tick(); assert.equal(calls, 4);
  Source.last.dispatchEvent(new Event('session-ended'));
  assert.equal(redirected, '/');
  assert.equal(Source.last.closed, true);
  window.dispatchEvent(new Event('focus'));
  assert.equal(timers.size, 0);
  stop();
`));

test('client retries failed refreshes and works without EventSource support', () => run(`
  globalThis.EventSource = undefined;
  let fail = true, calls = 0;
  const stop = subscribeWorkspace(async () => { calls++; if(fail) throw new Error('offline'); }, () => false);
  await tick(); assert.equal(calls, 1);
  assert.equal([...timers.values()][0].delay, 5000);
  fail = false; await tick(); assert.equal(calls, 2);
  stop(); assert.equal(intervals.size, 0); assert.equal(timers.size, 0);
`));

test('background pagination retains the loaded window and filters, while ordinary loads fetch just one page', () => run(`
  const requests = [];
  globalThis.fetch = async input => {
    const url = new URL(input, 'http://fixture'); requests.push(url);
    const before = url.searchParams.get('before');
    return Response.json({ comments: before ? ['c', 'd'] : ['a', 'b'], nextCursor: before ? 'page-three' : 'page-two' });
  };
  const page = await loadWindow('/api/comments?view=replies&sort=oldest', 'comments', 4);
  assert.deepEqual(page.rows, ['a','b','c','d']);
  assert.equal(page.nextCursor, 'page-three');
  assert.equal(requests.length, 2);
  assert.equal(requests[1].searchParams.get('before'), 'page-two');
  assert.equal(requests[1].searchParams.get('view'), 'replies');
  assert.equal(requests[1].searchParams.get('sort'), 'oldest');
  requests.length = 0;
  await loadWindow('/api/comments?before=page-two', 'comments', 0);
  assert.equal(requests.length, 1);
  globalThis.fetch = async () => Response.json({ comments: [], nextCursor: 'same-cursor' });
  await assert.rejects(loadWindow('/api/comments', 'comments', 10), /cursor/);
  globalThis.fetch = async () => new Response('', { status: 401 });
  await assert.rejects(loadWindow('/api/comments', 'comments', 0), /Session ended/);
  assert.equal(redirected, '/');
`));
