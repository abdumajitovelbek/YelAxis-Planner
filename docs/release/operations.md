# Release operations and compatible rollback

A source release and an operated website/backend have different evidence. Publishing source does not
provision production resources or establish hosted auth, headers, email, retention or support.
[Verification](../verification.md) records actual public-tree results and unperformed observations.

## Prepare an artifact

Use a frozen install and pinned source revision. Run focused checks, repository verification and
applicable browser/backend/release gates. Record finished exits, runtime/browser versions, safe
reports and the immutable artifact digest. Preserve project and third-party notices. Keep private
exports, credentials and deployment secrets outside release artifacts.

Local-only and configured-account artifacts are both supported. Hosted targets use HTTPS and can
omit account configuration. Configured accounts require the exact public backend URL/client key;
privileged keys or sessions must fail before output. `apps/web/dist` contains the static website,
manifest, service worker and reviewed `_headers`, with no source maps.

Keep the package versions accurate; exported bundle/client version metadata derives from the web
manifest. Builds generate their health policy from actual runtime inputs even without Git metadata.
An optional `VITE_YELAXIS_RELEASE_REVISION` labels support information and is not the health policy.

## Verify an operated instance

Serve from the origin root with SPA fallback and correct MIME types. Confirm that the chosen host
actually enforces the emitted CSP, no-framing, no-referrer, nosniff and cache rules. Verify
static-only service-worker cache contents, deep links, offline reload, waiting
update/Later/activation, local acknowledged writes, restart, Search and portable recovery at the
actual origin.

For accounts, apply ordered server migrations, exact Auth redirect configuration and independently
managed credentials. Test synthetic owner isolation, malformed payloads, RLS/RPC, two-client
conflicts, recovery/email, deletion and actual backup/log expiry policy. Record what the operator
observed; local test success is not a hosted pass. Do not use reset commands for hosted upgrades.

## Update or roll back

1. Keep the prior immutable artifact, header policy, source revision and migration/storage
   compatibility report before changing the served version.
2. Ask users to save edits and keep an independent backup. A waiting service-worker update offers
   Later or explicit activation rather than replacing the shell silently.
3. Restore an older static artifact only when it can read the current SQLite migrations, sync
   envelopes, IndexedDB version and `sqlite-gzip-v1` snapshots. Compatibility with arbitrary older
   releases is not implied by the shell reversal test.
4. If compatibility is uncertain, ship a reviewed forward fix. Preserve original images, migration
   receipts and import journals; use the explicit in-app recovery workflow when needed.
5. Check acknowledged records, restart/offline behavior, one-tab ownership, Search/export and
   account outbox/conflicts again. Record the outcome without plan content or tokens.

Current storage reads legacy ArrayBuffer, Uint8Array and Blob snapshots, and writes versioned gzip
snapshots. IndexedDB version 2 adds checked-image metadata. Migrations 1–19 are forward-only. A
compatible reader may ignore health metadata and perform full checks; an incompatible reader may not
reset data to make startup succeed. Never run a down migration, clear user storage or silently
replace a plan as a rollback strategy.

## Support

There is no promised support service level. Use synthetic reproductions and the previewed safe
support download. Keep credential/exploit details and private data in a private reporting channel
under [SECURITY.md](../../SECURITY.md). Operator retention policies must distinguish active cloud
records, backups/logs, offline copies and files that users downloaded.
