# Optional accounts and explicit conflicts

**Status: implemented decision.**

Manual local planning stays complete without account configuration. Configured email/password
accounts replicate acknowledged local commands rather than replacing SQLite with a cloud planning
store. Each identity has its own database.

First upload previews counts/cloud presence and verifies a backup before owner remapping. Ordinary
outbox groups handle upload/retry; stable IDs and bases preserve interruption recovery. Sign-out
closes the replica and clears sessions without silently dropping queued work.

Server functions bind access to authenticated ownership, enforce RLS and check typed references.
Idempotent atomic groups and cursor checkpoints handle lost answers. Disjoint valid changes may
merge; same-field/semantic changes and delete-versus-edit require explicit conflicts, never
last-write-wins.

Session storage is site-local and separate from plan/export/cache. Account deletion needs recent
password authentication, freezes pushes and distinguishes cloud, local copy, external files and
provider retention. See [identity](../contracts/identity-and-ownership.md) and
[sync protocol](../contracts/sync-protocol.md).
