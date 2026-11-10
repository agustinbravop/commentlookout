# Plan 002: Recover uncertain restore attempts safely

> Executor: run `git diff --stat 2929209..HEAD -- server/db.ts server/moderate.ts server/zernio.ts server/sync.test.ts src/workspace.tsx` and compare excerpts below; account for the completed plan 001 only where it overlaps. Stop on unexplained drift. No real provider writes; update `plans/README.md` when done.

## Status

Priority P1; effort M; risk MED; depends on none; category correctness/UX. Planned at `2929209`, 2026-11-09.

## Current behavior

`server/moderate.ts:23` upserts `moderation_jobs.status = 'restore_pending'`, then calls Zernio; `:32` sets `restored` and `synced_comments.is_hidden = 0` only after confirmation. Its catch at `:37` returns a generic error but leaves `restore_pending` indefinitely. The automatic worker only selects `pending`, so it does not re-hide the comment, but the inbox only displays the pending-hide state (`src/workspace.tsx:229`). The schema has free-text moderation status (`server/db.ts:61`). The existing mock test is in `server/sync.test.ts:129`.

The restore operation must remain explicit and workspace-scoped; keep account-owner verification and origin checks. A failed request may have reached Instagram: do not claim it did or did not, and do not re-hide or automatically retry it. A successful restore must continue to prevent future automatic re-hiding. Instagram OAuth behavior must be verified live only with a user-selected comment and explicit consent; tests here must never write to a live provider.

## Scope

`server/db.ts`, `server/moderate.ts`, `server/zernio.ts`, `server/sync.test.ts`, `src/workspace.tsx`, `src/workspace.css`, `README.md`, `plans/README.md`. Never edit `chrome-extension/`, credentials, unrelated product policy, or user data.

## Steps

1. Add mocked tests for failure before request, provider rejection, timeout after write, malformed success, process restart with `restore_pending`, and two concurrent restore requests. Each must retain enough information to avoid automatic re-hide. Include session/origin/cross-workspace rejection. Run `bun test server/sync.test.ts` → pass.
2. Distinguish pre-write failure (no state change) from an uncertain restore after request starts. Guard transitions using conditional SQLite writes, preserve preexisting job records, and make duplicate/in-flight requests return a safe conflict. Preserve existing `done`/`restored` records and `is_hidden` until evidence supports a change. Use an additive, tested migration if a new timestamp/status field is required.
3. Expose a typed restore outcome to `/api/comments` and the Hidden comments view. For uncertain delivery say to check Instagram; permit an explicit recheck or user-confirmed resolution, never silently mark restored from a missing comment because Instagram can omit hidden comments. Confirmed provider success remains the only automatic transition to restored. Test that restoring never calls the hide endpoint and never schedules an automatic re-hide.
4. Update `README.md` with the unconfirmed-delivery behavior and the fact that live restore permission still needs testing. Run `bun test server/sync.test.ts` → pass.

## Verification and done

`bun run test`, `bun run check`, `bun run build` all exit 0. Tests exercise crash/restart, concurrency, missing provider confirmation, and isolation. Verify only scoped files changed. No lint script exists.

## STOP / maintenance

Stop if a safe recovery cannot distinguish unavailable/omitted Instagram data from a positive visible-state observation, or requires testing by modifying a real comment without explicit approval. Plan 003 handles read-state reconciliation; plan 004 handles worker claims. Keep their state transitions compatible.
