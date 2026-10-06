# Browser storage and migrations contract

SQLite is the canonical plan. `wa-sqlite` runs in a dedicated module worker with an in-memory VFS;
the worker owns SQL, snapshots, migration/recovery and durable browser storage. UI never issues SQL.
The browser and installed PWA use the same adapter.

## Durable acknowledgement

Application commands atomically update canonical rows, minimized events, Undo where supported,
command receipts and required outbox. The worker saves the resulting complete SQLite image in one
IndexedDB transaction before acknowledging a write. Private rollback images remain until durable
settlement; failure restores the previous acknowledged image. A successful SQLite COMMIT alone is
not a successful durable write.

Current persistence writes a strict `sqlite-gzip-v1` envelope with exact image length and streaming
compressed bytes. Compression and bounded chunk hashing run in the worker. Decode refuses overflow,
truncation, corrupt compression and unknown formats. Legacy ArrayBuffer, Uint8Array and Blob images
remain readable. Standard SQLite export bytes and portable JSON files are not this storage envelope.
Compression provides no encryption.

IndexedDB version 2 adds checked-image metadata. Full integrity/foreign-key results may be reused
only after matching all image bytes by SHA-256, exact length, engine and build/policy. Every
changed, unrecognized, migrated or mismatching image receives full checks. Malformed/failed optional
metadata falls back to full validation. Import and migration validation do not trust external health
proofs. Digest metadata is not protection from arbitrary same-origin code or a retention promise.

## Ownership and serialization

One exclusive Web Lock owns each database. Startup allows a bounded closing-worker ownership
transfer, then fails `database_busy`; it never steals another tab's lock. Canceled/late grants
cannot open a store. Proxy, application façades and the shared driver serialize operations around
the worker's one connection. Closed handles/worker-owned temporary buffers can be retired only after
dependent bytes have settled; independent exports and durable snapshots remain intact.

Each identity has an isolated database. Browser-managed storage can be cleared or evicted.
Persistence requests are bounded and best effort. Native compression and modern worker/IndexedDB/
Web Lock support are required. These controls do not imply encryption or permanent retention.

## Migration ledger

Migrations **1–19** are ordered and forward-only. `_schema_migrations` stores version, name,
checksum and application time; `PRAGMA user_version` agrees with the ledger. Missing, changed,
out-of-order or newer migration history fails closed. Every migration runs transactionally and
checks foreign keys; failed work preserves the prior ledger and data.

Add a new migration rather than altering an applied checksum. Test fresh initialization, upgrade
from relevant prior schemas, exact row/reference preservation, ownership, interrupted/failing
migration, rollback and reopen. Never repair by dropping/recreating/resetting the user's database.
Migration 19 compacts derived Search document storage; it preserves canonical rows and the same
search documents/tokens and schema guarantees.

## Table responsibilities

| Group                  | Main records                                                                    |
| ---------------------- | ------------------------------------------------------------------------------- |
| Identity               | planning identities, Profile                                                    |
| Work and alignment     | Axis, Outcome, Project, Milestone, Action, Note and typed joins                 |
| Placement and emphasis | placements, Week selections, focus, Month themes, Year directions               |
| Time and repetition    | Routines, generations/defaults/occurrences, Commitments, Time Blocks            |
| Reflection and reuse   | Reviews/items, Templates, Reminders                                             |
| Context                | Context and Constraints                                                         |
| Command history        | minimized events, Undo, receipts and deletion ledger                            |
| Replication            | base snapshots, outbox, conflicts, checkpoints and account deletion state       |
| Derived/device state   | Search projections, alert receipts/preferences, import journals/recovery copies |

Queries use owner scopes, prepared bindings, stable ordering, indexes and keyset pages. Derived
projections can be rebuilt; they never become a second canonical plan. Relevant planning records are
not silently capped to fit a viewport.

## Import, recovery and rollback

Import keeps a recovery image, validates the candidate and atomically replaces the active image;
startup restores interrupted low-level replacement. The application also keeps a preview journal and
verified canonical pre-import backup for explicit resume/restore. Validation failure preserves the
prior database.

A rollback artifact must understand current migrations, IndexedDB and compressed snapshots. Older
readers are not automatically compatible because the shell looks similar. Prefer a forward fix;
never downgrade a schema or reset a profile. See [operations](../release/operations.md).
