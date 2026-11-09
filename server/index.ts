import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { auth } from './auth';
import { zernio } from './zernio';
import { syncComments } from './sync';
import { replies } from './replies';
import { analyzeComments } from './analyze';
import { moderateComments, moderation } from './moderate';

const app = new Hono();

app.get('/api/health', (c) => c.json({ status: 'ok' }));
app.route('/', auth);
app.route('/', zernio);
app.route('/', replies);
app.route('/', moderation);
app.all('/api/*', (c) => c.notFound());
app.get('/app', (c) => c.redirect('/home', 302));
app.use('/*', serveStatic({ root: './dist' }));
app.get('*', serveStatic({ path: './dist/index.html' }));

Bun.serve({ fetch: app.fetch, port: Number(Bun.env.PORT || 3000), hostname: '0.0.0.0' });

let syncing = false;
async function runSync() {
  if (syncing) return;
  syncing = true;
  try { await syncComments(); }
  finally { syncing = false; }
}
void runSync();
// shortcut: poll every ten minutes; add webhooks when delegated webhook access is verified live.
setInterval(() => { void runSync(); }, 10 * 60_000);

let analyzing = false;
async function runAnalysis() {
  if (analyzing) return;
  analyzing = true;
  try { await analyzeComments(); await moderateComments(); }
  catch (error) { console.error('Comment analysis pending', { reason: error instanceof Error ? error.message : 'Unknown error' }); }
  finally { analyzing = false; }
}
void runAnalysis();
setInterval(() => { void runAnalysis(); }, 15_000);
