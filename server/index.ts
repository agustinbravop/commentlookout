import { Hono } from 'hono';
import { serveStatic } from 'hono/bun';
import { auth } from './auth';
import { zernio } from './zernio';
import { syncComments, syncWebhookWork } from './sync';
import { webhooks } from './webhooks';
import { setupWebhooks } from './webhook-setup';
import { replies } from './replies';
import { analyzeComments } from './analyze';
import { moderateComments, moderation } from './moderate';
import { sendSignupNotification } from './notifications';
import { events } from './events';

const app = new Hono();

app.get('/api/health', (c) => c.json({ status: 'ok' }));
app.route('/', events);
app.route('/', auth);
app.route('/', zernio);
app.route('/', replies);
app.route('/', moderation);
app.route('/', webhooks);
app.all('/api/*', (c) => c.notFound());
app.get('/home', (c) => c.redirect(`/app${new URL(c.req.url).search}`, 301));
app.get('/index.html', (c) => c.redirect('/', 301));
app.get('/', serveStatic({ path: './dist/index.html' }));
app.get('/app', (c, next) => { c.header('X-Robots-Tag', 'noindex'); return next(); }, serveStatic({ path: './dist/app.html' }));
app.get('/app/posts', (c, next) => { c.header('X-Robots-Tag', 'noindex'); return next(); }, serveStatic({ path: './dist/app.html' }));
app.get('/app/settings', (c, next) => { c.header('X-Robots-Tag', 'noindex'); return next(); }, serveStatic({ path: './dist/app.html' }));
app.use('/*', serveStatic({ root: './dist' }));
app.get('*', (c) => c.notFound());

Bun.serve({ fetch: app.fetch, port: Number(Bun.env.PORT || 3000), hostname: '0.0.0.0', idleTimeout: 30 });

let syncing = false;
async function runSync(webhookOnly = false) {
  if (syncing) return;
  syncing = true;
  try { if (!webhookOnly) await syncComments(); await syncWebhookWork(); }
  catch { console.error('Zernio sync pending'); }
  finally { syncing = false; }
}
void runSync();
// Reconcile platform gaps even when webhook delivery is enabled.
setInterval(() => { void runSync(); }, 10 * 60_000);
setInterval(() => { void runSync(true); }, 15_000);
void setupWebhooks();
setInterval(() => { void setupWebhooks(); }, 15_000);

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

void sendSignupNotification();
setInterval(() => { void sendSignupNotification(); }, 15_000);
