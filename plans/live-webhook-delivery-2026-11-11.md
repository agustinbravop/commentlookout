# Live signed webhook sample verification — 2026-11-11

## Result

**PASS for local delegated setup and signed provider sample delivery. Production activation and real platform-event verification remain pending.**

The user requested a live test. A callback-only Bun listener on loopback port 3019 was exposed through the already-authenticated ngrok installation. Only a health probe and the exact temporary webhook path were served; the app UI, authentication routes and other APIs were not exposed. No background comment, AI, moderation or reply workers ran.

## Verified live

- The configured database had one Zernio connection. Its expired delegated token was refreshed using the app's existing OAuth flow, without printing credentials. The current owner was verified and webhook settings were accessible. There were zero configured provider endpoints before the test.
- A distinct encrypted local binding and a temporary provider subscription were created. A readback confirmed `isActive: false`; it remained inactive throughout the test.
- `POST /v1/webhooks/test` successfully delivered `webhook.test` and samples of all five subscribed events: `comment.received`, `post.external.created`, `account.connected`, `account.disconnected`, and `account.permissions_changed`.
- Each actual provider delivery passed the current receiver's raw-body signature verification, returned HTTP 200 JSON, and created one SQLite event-ledger record. Samples created zero webhook work jobs and zero account-health changes.
- Resending the captured, unchanged signed comment sample through the public tunnel returned 200 without another ledger record. Appending a space to its body while retaining the signature returned 401 and created no ledger record.
- A separate read-only SQLite process saw all six saved event records. Restarting the callback listener and resending the same sample still returned 200 with no additional record.
- Saved comment count/visibility, assessment count, moderation-job status counts, and reply-attempt status counts were unchanged. No live comment, hide, restore or reply operation was made.

Payloads and signing headers were held only in memory for replay checks. No raw payload, token, personal identifier or endpoint secret was printed or saved in this evidence file.

## Cleanup

The temporary remote subscription was deleted and settings were checked back to zero endpoints. The temporary local binding was deleted, cascading its sample ledger records. The loopback listener and ngrok process were stopped; port 3019 was independently confirmed not listening. The temporary runner script was removed. `.env` and production were not changed; webhook intake remains default-disabled.

## Still required

- Deploy the receiver and verify a signed sample through production ingress before enabling its subscription.
- Verify real Instagram/YouTube comments, replies, account lifecycle events, native-post identifiers and platform-specific delays. Provider samples prove delivery/signing and sample safety, not real account mapping, canonical thread freshness or moderation permissions.
- The restart check covered receiver restart plus independent SQLite readback, not a production pod/PVC restart. The replay check reused an authentic captured sample; provider retry scheduling/dead-letter redelivery was not exercised.
