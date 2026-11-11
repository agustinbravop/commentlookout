export function subscribeWorkspace(refresh: () => Promise<void>, blocked: () => boolean) {
  let stopped = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let fallback: ReturnType<typeof setInterval> | undefined;
  let pending = false;
  const schedule = (delay = 300) => {
    if (stopped) return;
    pending = true;
    if (timer === undefined && !running) timer = setTimeout(() => { timer = undefined; void flush(); }, delay);
  };
  const flush = async () => {
    if (stopped || running || document.hidden || !pending) return;
    if (blocked()) { schedule(500); return; }
    pending = false;
    running = true;
    let delay = 300;
    try { await refresh(); }
    catch { pending = true; delay = 5000; }
    finally { running = false; if (pending) schedule(delay); }
  };
  const visible = () => { if (!document.hidden) schedule(); };
  const poll = () => {
    if (fallback !== undefined) return;
    schedule();
    fallback = setInterval(() => schedule(), 60_000);
  };
  const source = typeof EventSource === 'undefined' ? null : new EventSource('/api/events');
  if (source) {
    source.onopen = () => { clearInterval(fallback); fallback = undefined; schedule(); };
    source.onerror = poll;
    source.addEventListener('refresh', () => schedule());
    source.addEventListener('session-ended', () => { stop(); location.replace('/'); });
  } else poll();
  window.addEventListener('focus', visible);
  document.addEventListener('visibilitychange', visible);
  function stop() {
    stopped = true;
    source?.close();
    clearTimeout(timer);
    clearInterval(fallback);
    window.removeEventListener('focus', visible);
    document.removeEventListener('visibilitychange', visible);
  }
  return stop;
}

export async function loadWindow<T>(path: string, field: 'comments' | 'posts', minimum: number) {
  const url = new URL(path, 'http://workspace.local');
  const seen = new Set<string>();
  const initial = url.searchParams.get('before');
  if (initial) seen.add(initial);
  const rows: T[] = [];
  let nextCursor: string | null;
  do {
    const response = await fetch(url.pathname + url.search);
    if (response.status === 401) { location.replace('/'); throw new Error('Session ended'); }
    if (!response.ok) throw new Error('Could not refresh saved data');
    const page = await response.json() as { comments?: T[]; posts?: T[]; nextCursor: string | null };
    const batch = page[field];
    if (!Array.isArray(batch) || (page.nextCursor !== null && (typeof page.nextCursor !== 'string' || !page.nextCursor))) throw new Error('Invalid page');
    rows.push(...batch);
    nextCursor = page.nextCursor;
    if (nextCursor) {
      if (seen.has(nextCursor)) throw new Error('Invalid cursor');
      seen.add(nextCursor);
      url.searchParams.set('before', nextCursor);
    }
  } while (nextCursor && rows.length < minimum);
  return { rows, nextCursor };
}
