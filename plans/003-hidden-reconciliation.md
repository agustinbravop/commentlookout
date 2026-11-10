# Plan 003: Reconcile app visibility with provider observations

> Executor: complete 002 first. Run `git diff --stat 2929209..HEAD -- server/sync.ts server/moderate.ts server/zernio.ts server/db.ts server/sync.test.ts src/workspace.tsx`; compare the excerpt below and reconcile expected changes from 002. Stop on unexplained drift. Do not mutate live comments. Update `plans/README.md` after completion.

## Status

Priority P1; effort M; risk MED; depends on 002; category correctness/UX. Planned at `2929209`, 2026-11-09.

## Current behavior and intended result

`server/sync.ts:105` upserts comment visibility with `CASE WHEN EXISTS (... moderation_jobs ... status = 'done') THEN 1 ELSE excluded.is_hidden END`. This preserves a successful hide against stale reads but also means a later external unhide can never appear locally. Conversely, Instagram Facebook Login can omit hidden comments; omission is not an unhide. Zernio comment pages may be cached up to ten minutes. The app must distinguish provider-confirmed hide/restore, stale observation, and unknown without silently changing a user's decision or re-hiding a restored comment.

## Scope

`server/sync.ts`, `server/moderate.ts`, `server/zernio.ts`, `server/db.ts`, `server/sync.test.ts`, `src/workspace.tsx`, `README.md`, `plans/README.md`. Keep other platforms unchanged; do not edit `chrome-extension/`, alter Zernio permissions, or backfill provider writes.

## Steps

1. In `server/sync.test.ts`, characterize hide success followed by stale visible read, later genuinely visible read, explicit external hidden read, omitted comment, restore success followed by stale hidden read, and retry/restart. Use mocked provider data and fake timestamps. Run `bun test server/sync.test.ts` → pass.
2. Replace the unconditional `done => hidden` rule with bounded reconciliation using persisted action/observation timestamps and provider freshness metadata **only if the response reliably exposes it**. Positive explicit observations older than a confirmed local action cannot override that action; absent comments never imply visibility. Do not invent freshness from local fetch time when the upstream cached timestamp is unavailable. When freshness cannot be established, preserve the last confirmed value and surface `needs checking` rather than reporting a definite current platform state. Preserve restored-job suppression against automatic re-hide.
3. Add additive migration and tests for databases created before the new fields; keep original comment text and action states. Update `/api/comments` and the UI only as needed to show confirmed versus uncertain state. Do not make All comments exclude anything. Run `bun test server/sync.test.ts` → pass.
4. Update README to describe provider caching and external changes. Do not assert live verification not performed.

## Verification and done

`bun run test`, `bun run check`, and `bun run build` exit 0. Tests demonstrate that stale cached reads and omitted comments do not override known actions, fresh positive evidence can reconcile where available, unknown freshness is visible, and no restoration leads to automatic re-hide. Check diff scope. No lint script is configured.

## STOP / maintenance

If provider responses cannot provide trustworthy freshness or positive visibility evidence, stop rather than claiming external restoration can be detected; report the gap and retain the last known state with a visible uncertainty indicator. Do not use a live hide/unhide for testing without explicit user approval. Coordinate status semantics with 002 and 004.
