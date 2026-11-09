# Comment Lookout: iteration-zero decisions

Agreed during the product discussion on 9 November 2026. The interview is finished; change these boundaries only for a discovered blocker or a new product decision.

## Product and identity

- **Comment Lookout** is the demo name. A cute, capable lookout with binoculars is the mascot. Working line: **“Catch the junk. Find the conversations.”** Name/domain/trademark clearance has not been completed.
- Standalone, multi-user comment moderation and reply app for Instagram and YouTube. Deliver a working app deployed on an `agusbravo.dev` subdomain and an explainer video. The Chrome extension is separate work.

## Users and connections

- Google-only app sign-in for iteration zero, with open sign-up for this temporary demo. More sign-in methods may come later; no Supabase unless the lightweight Google flow proves problematic.
- Each user has a private workspace with **one Zernio OAuth connection**. One workspace owns each Zernio team; a second user cannot connect an already-owned team. The user's Zernio account contains all social accounts to monitor.
- Users connect social accounts **in Zernio**, not in our app. If none are connected, link to Zernio and offer refresh on return. No user-supplied Zernio API keys.
- Disconnecting Zernio immediately stops monitoring and actions while retaining drafts and unexpired history for reconnecting. Deleting the app account removes its stored data.

## Intake and consent

- Monitor comments on future Instagram and YouTube posts whether published via Zernio or directly on the platform, including replies in comment threads; skip comments by the connected account itself. Zernio's discovery of platform-native posts and YouTube comment delivery may be delayed.
- Prefer Zernio webhooks; use light polling for platform gaps, account discovery (approximately every 10 minutes), and recovery. Persist and deduplicate incoming work before processing.
- New-post monitoring begins automatically. The per-social-account **automatic hide/reject toggle defaults on**, but automatic actions cannot begin until the user sees the setting and confirms onboarding.
- Automatically scan **every comment and reply** on up to the three most recent posts **per social account**; accounts with zero, one, or two posts are fine. No separate approval is required. Run it paginated in the background with visible progress and an expected-volume/cost warning; there is no silent comment cap. Backfill is **review-only**: never automatically hide or reject historical comments.

## Decisions and actions

- Fixed conservative policy in iteration zero: act automatically only on clear spam, scams/phishing, and explicit profanity. Uncertain cases go to review. Moderation takes priority over reply drafting. Do not open commenter-provided URLs.
- Instagram: hide and unhide. YouTube: reject and publish. Never permanently delete. Record reasons, show history, and offer restoration.
- Flag questions, mentions, and enthusiastic/testimonial comments as candidates for a reply. Draft using comment text, parent comment when relevant, and post caption/title. Do not analyze video or commenter profiles in iteration zero.
- Brand-voice instructions are editable **per social account**, without a shared default. They affect reply style, not the fixed moderation safety rules; treat user text as untrusted model input.
- Drafts are editable and require an explicit **Send** click. Detect replies made directly on the platform and resolve corresponding drafts; recheck a thread before sending to reduce duplicates. Never report a reply as sent until Zernio confirms it.
- If OpenAI or Zernio is unavailable, leave work visible as Pending and retry. Incomplete classification never triggers hiding/rejection.

## Implementation and data

- One Dockerized TypeScript service: React/Vite frontend, Bun/Hono API, SQLite-backed data and jobs via `bun:sqlite`, background worker in the same service, one Kubernetes replica with a persistent volume. Deploy using the homelab's GHCR/ArgoCD pattern.
- OpenAI credits via a **server-side API key** are the default for AI tasks; evaluate specialist models only where they clearly help. No model runs on the cluster. Keep OAuth tokens and the OpenAI key off clients.
- Retain moderation history, including comment text, for **90 days**. Keep unsent drafts until sent or dismissed. Encrypted off-cluster backups and user-customizable moderation prompts are **post-demo** work. The volume alone is not a backup.

## Verification gates

- Live-test that delegated Zernio OAuth can discover accounts and posts, read comments/replies, configure webhooks, hide/reject and restore comments, and send replies. Document any platform or OAuth gaps; fall back to server-side polling if OAuth cannot configure webhooks.
- Verify Google OAuth redirect and team ownership before enabling automatic actions. Do not claim native-post or YouTube delivery is instantaneous.
- Current integration restricts Zernio connection to the team owner because the available `/v1/users` response exposes an owner ID, not a stable team ID. Revisit if Zernio exposes team identity or team ownership changes; do not enable automatic actions on a stale ownership check.
