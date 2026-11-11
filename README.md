# Comment Lookout

[https://x.com/guirao_pau/status/2119730874057191589](https://x.com/guirao_pau/status/2119730874057191589).

A comment moderation and reply assistant for Instagram and YouTube, powered by Zernio. The standalone app lives at the repository root; [`chrome-extension/`](chrome-extension/) is separate work.

The agreed product scope and safety rules are in [DECISIONS.md](DECISIONS.md).

## Run locally

Requires Bun 1.3.

```sh
bun install --frozen-lockfile
bun run dev:api  # terminal 1: http://localhost:3000
bun run dev:web  # terminal 2: http://localhost:5173
```

Vite proxies `/api` to the Bun/Hono service. Bun loads `.env` automatically. Copy `.env.example` to `.env`, create a Google OAuth web client, and register `GOOGLE_REDIRECT_URI` as an authorized redirect URI. Set `APP_ORIGIN=http://localhost:5173` in your existing `.env` for frontend development: Google returns to the API on port 3000, then the API redirects to the web client on port 5173. Visit `http://localhost:5173/`: Get Started opens Google sign-in or, for an existing session, `/app`. Old `/home` links redirect to `/app`; posts and settings are at `/app/posts` and `/app/settings`. In production, omit `APP_ORIGIN` and use the built app at port 3000. `/api/me` returns the current user.

For Zernio, set `ZERNIO_REDIRECT_URI=http://localhost:3000/api/zernio/callback` and `ZERNIO_TOKEN_KEY` to a fresh 32-byte base64 key (`openssl rand -base64 32`). The app dynamically registers itself with Zernio on the first Connect click, obtains delegated OAuth tokens, stores them encrypted in SQLite, and reads the Instagram/YouTube account list. Keep the same encryption key across restarts/deployments or stored tokens cannot be read. For iteration zero, the Zernio sign-in must be the **team owner** so we can identify the team and avoid assigning it to two workspaces. Disconnecting stops access locally; revoke the app in Zernio too if you want to withdraw its grant. Instagram automatic hiding runs after per-account confirmation; replies require an explicit Send. Delegated account-post listing worked live for both platforms, one Instagram comment page worked, and the user confirmed a reply worked; Instagram hiding has been confirmed live. Webhook settings access was verified after explicit reauthorization on November 10, and signed provider sample delivery passed locally on November 11. Real platform-event delivery, production ingress, YouTube moderation and thread reads still need live tests.

The old read-only `/api/zernio/preview` diagnostic remains available, but **Check comments** is no longer part of the workspace. It checks up to three recent pages (30 posts each) and skips zero-comment posts; it is separate from the automatic three-post historical scan.

The API runs a read-only sync on startup and every ten minutes. For each account, the first sync records a starting time for future-post monitoring and automatically selects up to its three most recent platform posts, even if none have comments. It reads every comment and reply on those posts with pagination and no comment cap. Selection and pending thread work are saved before reads; failures stay pending for retry, and a completed scan is not repeated on restart. Accounts with 0–2 posts complete normally. Comments from the three selected historical posts can be automatically hidden after confirmation; only comments from the past 365 days are retained. The account list shows posts scanned, saved historical comments, and rough expected volume; `GET /api/backfill` returns workspace-scoped progress. `GET /api/comments` returns the signed-in workspace's saved comments newest-first (50 per page; follow `nextCursor` with `?before=...`). Replies carry `parentId`. All comments includes unreviewed and historical comments and displays AI review flags; Hidden comments lists those marked hidden, showing a known reason when available; Needs a reply lists AI-selected, safe comments without a recorded owner/app reply. Zernio's cached inbox feed can lag by up to ten minutes; YouTube thread reads and webhook delivery still need live verification.

Set `OPENAI_API_KEY` server-side to classify saved comments and generate suggested replies. The worker runs every 15 seconds, handles up to 20 jobs at a time, and retries failures. It classifies before drafting: flagged or uncertain comments are for review, neutral comments need no reply, and eligible safe comments receive a draft. AI calls incur OpenAI charges, including for existing and historical comments. Drafts can be edited, saved, dismissed, or sent explicitly via **Send reply**; nothing is posted automatically. If delivery cannot be confirmed, check Zernio before doing anything else: the app blocks a second Send to avoid duplicate posts. A real reply worked in the user's live test. No commenter URLs are fetched; Instagram auto-hiding requires per-account confirmation. Hidden comments omitted by Instagram's Facebook Login cannot appear in the hidden list.

For an unconfirmed reply, All comments shows the attempted text and lets you confirm whether you found it on the platform. Choosing “not sent” only clears the block; sending again always requires a separate click. A missing reply in a cached thread is not proof of non-delivery.

In Your accounts, each connected account has a default-on automatic moderation preference. Confirm or turn it off and confirm; you can change it later. The preference is saved per account and Zernio owner. Confirming enables Instagram hiding for clear spam, scams and profanity, including the three scanned posts; failed hides stay pending for retry. Uncertain comments remain for review. Hidden Instagram comments have a Restore comment button; restored comments will not be hidden automatically again. Restore has mocked coverage but still needs a live permission test. YouTube automatic moderation is not active.

If a restore is unconfirmed, check Instagram and explicitly record whether it is visible or still hidden. The app does not automatically repeat the restore or hide it again while the outcome is unknown.

After a hide or restore, cached provider reads do not override the last confirmed action unless an explicit visibility observation carries a newer provider timestamp. If freshness is unavailable or a cached observation conflicts, the inbox marks visibility as needing a check; a missing comment is never treated as proof it is visible.

Moderation workers claim jobs in SQLite before sending. A claim that expires or a hide whose delivery is unconfirmed is not automatically resent: check Instagram and record the outcome in All comments. Choosing “still visible” allows a retry while the account's automatic moderation is enabled. Definite provider rejections remain pending for retry.

The app's controls use shadcn/ui with a theme based on [DESIGN.md](DESIGN.md). Account profile images come from Zernio's `profilePicture` when hosted on known Instagram/YouTube image domains; other URLs and missing images fall back to platform icons. The browser never fetches URLs found in comments.

```sh
bun run check
bun run test
bun run build
bun run start  # serves the built frontend and API together on PORT (default 3000)
```

`docker build -t comment-lookout .` builds the same single-service image. In Kubernetes, set the Google variables via a Secret and mount a persistent volume at `/app/data`. The image runs as the unprivileged `bun` user, so the volume must be writable by it. For the deployed URL, register the exact HTTPS callback in Google and set `GOOGLE_REDIRECT_URI` to it.

## Zernio webhooks (automatic setup)

Normal Zernio Connect requests webhook management through the provider's consent screen. Its bundled `automations:write` permission also covers contacts, sequences and other automations; it is used here for webhook management. Existing grants are never silently widened. Settings prompts users to review permissions if Zernio rejects webhook access.

After successful OAuth, the connection and a per-workspace setup job are saved atomically. An independent worker in the existing Bun service registers an inactive subscription, enables its local receiver for testing, asks Zernio for a fresh signed `webhook.test`, and activates only after both provider success and persisted signature verification. Real event work stays blocked until setup is active. Setup failures back off from one minute to one hour while polling continues. Pod restarts resume SQLite jobs; ambiguous creation responses are reconciled by the saved callback URL rather than blindly creating another subscription. Active subscriptions are checked every ten minutes, and missing/disabled subscriptions are retested and repaired. Operator-disabled setup stays disabled.

**Kubernetes needs no per-workspace commands, init job, enablement variable or new service.** Keep the existing single replica, writable SQLite PVC, stable `ZERNIO_TOKEN_KEY`, OAuth credentials and public HTTPS ingress. The worker derives its callback origin from the existing `GOOGLE_REDIRECT_URI`, never incoming browser/Host headers. The ingress must forward `/api/webhooks/zernio/*` POSTs without authentication, redirects or an HTML fallback, and acknowledge within five seconds. On startup, existing connections are automatically enrolled if their grants permit webhook management; otherwise the user must approve Reconnect in Settings. With a localhost/non-HTTPS Google redirect, automatic external registration is skipped and polling remains available. No environment mutation is performed by setup.

`POST /api/webhooks/zernio/:bindingId` checks raw-body HMAC-SHA256 with an encrypted, per-connection secret and persists deduplicated work before returning JSON. Samples and `webhook.test` never queue comment work. The worker checks current owner/account access and reads canonical threads; event text and URLs are never imported or fetched. Only future posts and the three selected historical posts qualify; unknown/native post IDs request discovery without expanding historical eligibility. Comment work survives restart, retries after a minute on failure, and preserves deliveries arriving during reads. Event IDs are retained for seven days; older replays can only request another canonical read. Ten-minute reconciliation remains enabled, and webhook work is checked every 15 seconds (not a real-time latency guarantee).

The subscription includes `comment.received`, `post.external.created`, `account.connected`, `account.disconnected`, and `account.permissions_changed`:

- Native-post events request canonical discovery using the original monitoring boundary, never importing a signed historical post directly. Zernio documents detection as roughly hourly, with historical events on first sync; this is not faster-than-polling or instantaneous discovery.
- Account lifecycle events queue a current account check, including for accounts not yet discovered locally. Known accounts pause monitoring, hides, restores and replies while that check is pending. Confirmed disconnections stay paused without deleting drafts/history. A healthy canonical check resumes the account without changing moderation consent or resetting its monitoring start. A delayed disconnect event cannot override a healthy current connection.
- Permission events request the same check. A still-connected account resumes normal comment checks and exposes a `permissions_changed` warning: Zernio currently documents this event for publishing-scope failures on custom OAuth apps, not general loss of comment-read/moderation permissions. It is not a replacement for per-action permission checks.
- `GET /api/zernio` exposes workspace-scoped `accountIssues` (`accountId`, `platform`, `status`: `checking`, `disconnected`, or `permissions_changed`). Dedicated account-warning UI is not included; attempted actions on paused accounts return a connection-check error.

Contracts checked against Zernio's [native post](https://docs.zernio.com/webhooks/social/post-external-created), [connected](https://docs.zernio.com/webhooks/accounts/account-connected), [disconnected](https://docs.zernio.com/webhooks/accounts/account-disconnected), and [permissions](https://docs.zernio.com/webhooks/accounts/account-permissions-changed) documentation. On November 11, delegated creation of an inactive subscription and actual signed provider samples for all five events plus `webhook.test` passed locally through a temporary HTTPS tunnel. Persistence, duplicate replay, body-tamper rejection and receiver-restart deduplication also passed without comment work or actions. The temporary subscription and tunnel were removed. Real platform events and production ingress remain unverified; see [live verification evidence](plans/live-webhook-delivery-2026-11-11.md).

Disconnecting or reauthorizing immediately invalidates the old local binding; a replacement connection queues fresh setup. Callback-origin changes rotate the binding and secret and require another test. Late provider writes from an obsolete job are compensated with deactivation/cleanup. Cleanup records contain endpoint metadata, not retained credentials: removal is attempted using a still-valid token in memory, or retried when the same workspace reconnects as the same verified owner. A revoked grant/provider outage can prevent remote cleanup, but the old endpoint cannot enter the workspace. The app does not retain expired/disconnected credentials just for cleanup.

The runtime image retains `scripts/zernio-webhook.ts` only for optional operator diagnostics and rollback, not normal deployment. `bun scripts/zernio-webhook.ts USER_ID https://YOUR_HOST --disable` disables local intake first, persists the disabled setup state, then attempts provider deactivation. Polling and previously authorized moderation remain independent; in-flight reads may finish. The register/test/activate commands are recovery tools; normal users only connect or personally reauthorize through the UI.

Setup does not change moderation consent or send replies. Local signed provider samples were previously verified through a temporary inactive subscription, which was removed afterward. The automatic lifecycle has mocked integration coverage; production ingress and real platform events still need verification.

## Browser live refresh (SSE)

`GET /api/events` opens one session-cookie-authenticated connection per workspace page. After committed sync pages, AI/moderation jobs, webhook setup, or authenticated API writes, the existing Bun process sends only `event: refresh` with `{}` to that workspace's subscribers. No comment text, account IDs, credentials, cross-workspace broadcasts, database revision table or durable SSE log is involved. The browser refetches the current Comments/Posts view and local backfill progress through the existing APIs; Settings also refreshes connection/setup status. Comments refreshes do not trigger upstream account listing requests. Moderation and Send behavior are unchanged.

The browser coalesces pokes, serializes refreshes, keeps loaded pagination depth and expanded post rows, and defers automatic refresh while there are unsaved edits or in-flight actions. Reply editors are not remounted when drafts change. Hidden tabs wait until visible; reconnect/focus refetches current data, so missed pokes do not need replay. If SSE is unavailable, visible pages fall back to periodic refresh every minute. The old separate 15-second backfill polling loop is removed. Manual Refresh remains available.

Kubernetes uses the same pod, Service, ingress and port 3000; no broker, worker deployment, new secret, environment flag or WebSocket upgrade is required. SSE sends 15-second heartbeats, uses a 30-second Bun idle timeout, disables caching/transformation, and sends `X-Accel-Buffering: no`. Production ingress must stream `/api/events` without response buffering and allow idle periods longer than the heartbeat interval (typically a read timeout of at least 60 seconds). Controller-specific ingress settings have not been verified here. Session validity is rechecked on each send/heartbeat; revoked sessions are told to sign in again. Aborted and slow streams are released; there are limits of three streams per workspace and 200 overall, with browser fallback when exceeded.

Notification delivery is deliberately in-process for the existing single-replica architecture. Adding replicas requires shared fanout as well as the app's existing storage/worker scaling work; sticky sessions alone do not deliver writes from other pods. Optional operator scripts/external SQLite writes do not emit pokes; focus/reconnect/manual refresh still reads their saved changes.

Verification: scoped/session-revoked streams, connection cleanup/limits, client coalescing/reconnect/fallback, and pagination have automated coverage. A real browser test with isolated fixture data confirmed live insertion without reload, preservation of a 60-row loaded window, expanded post threads, and unsent text. No provider action or production deployment was involved; production streaming remains unverified.

## Discord signup alerts (optional)

Create a private Discord server and a private `#comment-lookout` channel. In the channel's **Edit Channel → Integrations → Webhooks**, create a webhook named **Comment Lookout** and copy its URL. Store it only in the production API server's secret environment as `DISCORD_SIGNUP_WEBHOOK_URL`, then restart the existing service; no separate hosting or bot is needed. Never put the URL in client code or Git. Alerts require `GOOGLE_REDIRECT_URI` to have origin `https://commentlookout.agusbravo.dev`; missing configuration and local sign-ins do not enqueue alerts.

Set the channel's notification settings to **All Messages** and enable Discord mobile push notifications (check server mute settings and mobile push inactivity settings too). The webhook sends the signup name, email, stored signup timestamp and Production label. These are personal data: restrict channel access and manage Discord retention separately. Deleting an app account removes its queue entry, not an already posted Discord message or a request already in flight.

Only new users created while enabled enqueue an alert; returning users and historical accounts never cause a signup flood. SQLite persists pending deliveries across restarts. An independent worker sends one due alert every 15 seconds, with bounded exponential backoff, Discord rate-limit delays and a cooldown for revoked webhooks or invalid configuration. Delivery is at least once: a lost response can produce a duplicate. Keep one service replica; add queue claiming before scaling. Rotating/changing the webhook may send pending alerts to the new destination; rotate any leaked webhook. No live alert is sent as part of setup verification without separate approval.

## Public site and search

The public landing page is pre-rendered at build time for `https://commentlookout.agusbravo.dev/`. The `/app` workspace routes serve a separate `noindex` shell; unknown routes return 404. `public/sitemap.xml` lists only the landing page, and `public/robots.txt` advertises it. Keep both the canonical URL and sitemap in sync if the domain changes. Configure HTTPS and redirects from any alternate hostnames at the ingress (outside this repository).

After deployment, verify `https://commentlookout.agusbravo.dev/` in Google Search Console, submit `/sitemap.xml`, inspect the rendered landing page and check indexing/queries there. Search Console ownership and live indexing cannot be configured from this repository alone.

## Intended flow

```text
Browser (React)
  ├─ Google sign-in ──> Bun/Hono API ──> local user/workspace
  └─ read / manual Send ──> Bun/Hono API
                            ├─ SQLite: accounts, comments, reply attempts, saved drafts
                            └─ Zernio OAuth/API ──> Instagram / YouTube
Zernio webhooks ──> Bun/Hono API ──> SQLite jobs ──> worker
                         ↑
          light polling for discovery/recovery
```

The browser will never receive Zernio credentials or the OpenAI key. One Google user owns one workspace and one Zernio connection; Zernio manages the social connections. The three-post backfill starts automatically. Instagram automatic hiding requires explicit confirmation; YouTube moderation and webhook setup still need live verification.
