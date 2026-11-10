# Implementation plans

Prepared 2026-11-09 against `2929209`. These plans cover the four highest-priority state-machine findings. Read each plan completely; preserve existing user data and update status as work proceeds.

| Plan | Priority | Effort | Depends on | Status |
|---|---|---|---|---|
| [001 Reply recovery](001-reply-recovery.md) | P1 | M | None | DONE |
| [002 Restore recovery](002-restore-recovery.md) | P1 | M | None | DONE |
| [003 Reconcile hidden state](003-hidden-reconciliation.md) | P1 | M | 002 | DONE |
| [004 Claim moderation jobs](004-moderation-claim.md) | P1 | M | 002, 003 | DONE |

Execute 001, 002, 003, 004 in order to minimize overlapping edits. Plans 002–004 change the same moderation state machine; reconcile their tests and migration decisions rather than introducing separate competing states.

## Considered and rejected

- A general state-machine library: unnecessary for the current Bun/SQLite app; explicit guarded transitions and tests address the immediate risks with fewer dependencies.
- Automatic resend of uncertain replies: rejected because duplicate public replies are harmful and provider reads can be stale.
