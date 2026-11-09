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

Vite proxies `/api` to the Bun/Hono service. Bun loads `.env` automatically. Copy `.env.example` to `.env`, create a Google OAuth web client, and register `GOOGLE_REDIRECT_URI` as an authorized redirect URI. Set `APP_ORIGIN=http://localhost:5173` in your existing `.env` for frontend development: Google returns to the API on port 3000, then the API redirects to the web client on port 5173. Visit `http://localhost:5173/`: Get Started opens Google sign-in or, for an existing session, `/home`. Old `/app` links redirect to `/home`. In production, omit `APP_ORIGIN` and use the built app at port 3000. `/api/me` returns the current user.

For Zernio, set `ZERNIO_REDIRECT_URI=http://localhost:3000/api/zernio/callback` and `ZERNIO_TOKEN_KEY` to a fresh 32-byte base64 key (`openssl rand -base64 32`). The app dynamically registers itself with Zernio on the first Connect click, obtains delegated OAuth tokens, stores them encrypted in SQLite, and reads the Instagram/YouTube account list. Keep the same encryption key across restarts/deployments or stored tokens cannot be read. For iteration zero, the Zernio sign-in must be the **team owner** so we can identify the team and avoid assigning it to two workspaces. Disconnecting stops access locally; revoke the app in Zernio too if you want to withdraw its grant. Monitoring is read-only except for manual replies explicitly sent from the app; no automatic moderation or replies are active. Delegated account-post listing worked live for both platforms, and one Instagram comment page worked; live reply sending, YouTube thread reads, moderation permissions and webhook access still need tests.

The old read-only `/api/zernio/preview` diagnostic remains available, but **Check comments** is no longer part of the workspace. It checks up to three recent pages (30 posts each) and skips zero-comment posts; it is separate from the automatic three-post historical scan.

The API runs a read-only sync on startup and every ten minutes. For each account, the first sync records a starting time for future-post monitoring and automatically selects up to its three most recent platform posts, even if none have comments. It reads every comment and reply on those posts with pagination and no comment cap. Selection and pending thread work are saved before reads; failures stay pending for retry, and a completed scan is not repeated on restart. Accounts with 0–2 posts complete normally. Historical comments are marked **review-only**, never automatically moderated, and only comments from the past 90 days are retained. The account list shows posts scanned, saved historical comments, and rough expected volume; `GET /api/backfill` returns workspace-scoped progress. `GET /api/comments` returns the signed-in workspace's saved comments newest-first (50 per page; follow `nextCursor` with `?before=...`). Replies carry `parentId`. All comments includes unreviewed and historical comments; Hidden comments lists those marked hidden, showing a known reason when available; Needs a reply lists visible comments without a recorded owner/app reply. Without AI it does not distinguish questions. Zernio's cached inbox feed can lag by up to ten minutes; YouTube thread reads and webhook delivery still need live verification.

For this Zernio integration test, OpenAI classification and draft generation are paused even if `OPENAI_API_KEY` is set. Existing drafts and assessments remain stored but draft editing is temporarily absent from the UI. To test a real reply, open a visible comment in All comments or Needs a reply, type a short message, and click **Send reply**. This is the only posting action. A confirmed reply displays Replied; if delivery cannot be confirmed, check Zernio before doing anything else: the app blocks a second Send to avoid duplicate posts. The delegated Zernio reply grant and real Instagram/YouTube posting have not yet been verified. No commenter URLs are fetched, and automatic hiding/rejection still requires onboarding consent and live permission verification.

The app's controls use shadcn/ui with a theme based on [DESIGN.md](DESIGN.md). Account profile images come from Zernio's `profilePicture` when hosted on known Instagram/YouTube image domains; other URLs and missing images fall back to platform icons. The browser never fetches URLs found in comments.

```sh
bun run check
bun run test
bun run build
bun run start  # serves the built frontend and API together on PORT (default 3000)
```

`docker build -t comment-lookout .` builds the same single-service image. In Kubernetes, set the Google variables via a Secret and mount a persistent volume at `/app/data`. The image runs as the unprivileged `bun` user, so the volume must be writable by it. For the deployed URL, register the exact HTTPS callback in Google and set `GOOGLE_REDIRECT_URI` to it.

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

The browser will never receive Zernio credentials or the OpenAI key. One Google user owns one workspace and one Zernio connection; Zernio manages the social connections. The three-post backfill starts automatically and stays review-only for automatic moderation. Automatic actions still require onboarding confirmation; OAuth permissions for replies, moderation and webhook setup need live verification.
