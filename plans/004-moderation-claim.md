# Plan 004: Atomically claim moderation work before provider calls

> Executor: complete 002 and 003 first. Run `git diff --stat 2929209..HEAD -- server/db.ts server/moderate.ts server/index.ts server/sync.ts server/zernio.ts server/sync.test.ts src/workspace.tsx`; distinguish expected changes from those plans from unexplained drift. Never run live hide/unhide in tests. Update `plans/README.md` when done.

## Status

Priority P1; effort M; risk MED; depends on 002 and 003; category correctness. Planned at `2929209`, 2026-11-09.

## Current behavior

`server/moderate.ts:41` persists deduplicated jobs. Lines 50–59 select rows where `status = 'pending'`, but do not claim them; lines 74–83 call Zernio and unconditionally write `done`. `server/index.ts:35` uses an in-process boolean, which does not protect separate processes or restarts. Restore can change the same job. User consent and workspace ownership are required, and provider failure must leave work pending for retry. Never act on uncertain classifications; selected historical posts require explicit confirmation. Instagram is the only enabled moderation platform.

## Scope

`server/db.ts`, `server/moderate.ts`, `server/index.ts`, `server/sync.ts`, `server/zernio.ts`, `server/sync.test.ts`, `src/workspace.tsx`, `README.md`, `plans/README.md`. No changes to `chrome-extension/`, YouTube enablement, credentials, or live comments.

## Steps

1. Add tests in `server/sync.test.ts` using two concurrent `moderateComments()` calls and controlled promises to hold provider requests. Assert one hide POST per comment, workspace isolation, consent revocation before dispatch, restore-versus-hide ordering, and no action for uncertain/stale classifications. Add crash/restart recovery and expired claim cases. Run `bun test server/sync.test.ts` → pass.
2. Implement an atomic conditional SQLite claim with a unique claim token and lease expiry, after durable enqueue and before the provider request. Recheck current consent, ownership, account, classification and comment text immediately before dispatch. Finish success/failure only with a matching token and claimed status. An expired or ambiguous claim must not be blindly treated as proof the provider did nothing: reconcile or retain a visible needs-check state. Do not allow a late hide completion to overwrite a restoration. Use bounded retries for definite failures; keep jobs persisted.
3. Add an additive old-database migration and tests preserving existing `pending`, `done`, `restore_pending`, `restored` rows and user choices. Ensure per-process scheduling remains nonoverlapping but does not serve as the correctness mechanism. Expose understandable pending/needs-check state without disclosing provider credentials or comment text in logs.
4. Update README with recovery/lease semantics and any explicit operational limitations. Run `bun test server/sync.test.ts` → pass.

## Verification and done

`bun run test`, `bun run check`, `bun run build` exit 0. Controlled concurrent tests show at most one live hide dispatch per claim, stale completions cannot overwrite newer state, and disabling consent prevents undispatched work. Crash-after-dispatch tests do not cause blind re-dispatch. Verify the diff stays in scope; there is no lint script.

## STOP / maintenance

Stop if safely recovering ambiguous provider writes requires undocumented assumptions about Zernio idempotency or cache freshness; keep such work visible and request a product decision. Never deploy multiple workers as a workaround. Future YouTube moderation must have independently live-verified permissions and its own action semantics.
