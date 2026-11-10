# Plan 001: Make uncertain replies recoverable without duplicate sends

> Executor: run `git diff --stat 2929209..HEAD -- server/db.ts server/replies.ts server/zernio.ts server/replies.test.ts src/workspace.tsx` and compare the excerpts below with live code. Stop on unexplained drift. Preserve unrelated changes; never reset, push, or send real comments. Update `plans/README.md` when done.

## Status

- Priority P1; effort M; risk MED; depends on none; category correctness/UX.
- Planned at `2929209`, 2026-11-09.

## Context and constraints

`server/replies.ts:72` inserts a `comment_replies` row with `status = 'pending'` and a generated idempotency key before the POST. `server/replies.ts:96` marks a confirmed response `sent`; the catch at line 100 marks ambiguous responses `unknown`. `server/db.ts:145` constrains statuses to `pending`, `sent`, `unknown`. A process crash can leave `pending` forever; `src/workspace.tsx:75` treats all non-sent statuses as unconfirmed, and no resolution is available.

Zernio comment reads can be cached; a missing owner reply is **not** proof of non-delivery. Never automatically send a reply, never reset an unknown attempt solely because an owner reply was not found, never permit a second Send without an explicit user decision. Recheck ownership and scope every request by session/user/account/comment. The user must always click Send to post. Keep existing idempotency keys and messages. Do not fetch URLs from comments. Match Bun/Hono/SQLite and React patterns in `server/replies.test.ts` and `src/workspace.tsx`; use existing shadcn components and `DESIGN.md`.

## Scope

In: `server/db.ts`, `server/replies.ts`, `server/zernio.ts`, `server/replies.test.ts`, `src/workspace.tsx`, `src/workspace.css`, `README.md`, `plans/README.md`. Out: `chrome-extension/`, provider credentials, other workspaces, automatic retries, unrelated UI.

## Steps

1. Add characterization tests to `server/replies.test.ts`: pending surviving restart/reload; unknown delivery; user/workspace isolation; repeated Send remains blocked. Use in-memory SQLite and mocked `fetch`. Run `bun test server/replies.test.ts` → pass.
2. Add a minimal, user-controlled resolution flow for an existing pending/unknown attempt. Expose structured status and its saved reply text only to its owner. Offer explicit actions “I found my reply” (record resolved/sent only when user confirms) and “I checked; it was not sent” (clear the block but **do not send**). Require origin and session checks, guard the update by the expected pending/unknown status, and keep the original message available until the user resolves it. A fresh subsequent Send remains a separate click. Handle two concurrent resolutions with a conditional update and 409 on the loser. Avoid claiming the provider confirmed a user-asserted outcome; represent that distinction in the UI or stored status.
3. Update `src/workspace.tsx` to render those options and unambiguous warnings. Return machine-readable status rather than matching English error strings; preserve existing API behavior for other clients. Test zero automatic provider POSTs on resolution, conflicting resolution, invalid origin, missing auth, and cross-workspace attempts. Verify `bun test server/replies.test.ts` → pass.
4. If a schema migration is required, add an additive migration in `server/db.ts` following the `PRAGMA table_info` checks, preserving every existing row and defaulting legacy pending/unknown to unconfirmed. Add a test against a temporary old-schema database; never alter the user's real database. Update README with reconciliation behavior.

## Verification and done

`bun run test`, `bun run check`, and `bun run build` must exit 0. Tests prove no resolution sends or retries, stale pending remains visible, unconfirmed delivery never becomes provider-confirmed without evidence, and no workspace can read or mutate another's attempt. Check `git diff --stat` for scope. There is no configured lint script.

## STOP / maintenance

Stop if the provider requires a live write to establish safety, if resolving an attempt would require deleting unsent text before user confirmation, or if product policy for user-asserted delivery is unclear. Don't use a live user comment in tests. Maintain the difference between provider confirmation and user assertion on future status changes; idempotency-key lifetime is not a guarantee of permanent replay safety.
