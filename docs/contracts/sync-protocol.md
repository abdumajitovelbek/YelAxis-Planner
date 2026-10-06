# Synchronization protocol contract

Sync is optional asynchronous replication of committed local commands. SQLite remains canonical. The
application transaction writes required outbox work with canonical rows; sync never makes a network
request a prerequisite for a manual local edit.

## Server boundary

The Supabase schema stores owner-scoped documents keyed by owner/type/stable ID, append-only
changes, idempotency receipts, conflict candidates, replicas and deletion state. All tables have
forced RLS. Clients have no direct table privileges; owner-bound RPCs use the authenticated subject.
Generated JSON Schemas validate record structure, and reference rules validate both endpoint owners.

Server-owned revisions, timestamps and cursors are never trusted from the client. Documents preserve
the same validated record semantics as local codecs. An invalid pulled document is preserved as a
conflict before cursor advancement; an unpreservable page produces Needs attention and retry rather
than discarding it.

## Push and pull

Push sends one atomic command group in local order with operation/idempotency IDs, base revisions
and snapshot hashes. Limits are **500 operations**, **64 KB per document** and **2 MB per request**.
The server checks shape, ownership, reference validity and every base, then commits the whole group
or none. Repeating an accepted operation returns its original acknowledgement. A stale base,
different same-ID create or tombstone collision becomes an explicit candidate.

Pull uses a server-issued opaque monotonic cursor and at most **500 changes per page**. The client
applies the page and advances its checkpoint in one local transaction. Cursor expiry triggers full
reconciliation, never local reset. Tombstones and the deletion ledger prevent resurrecting deleted
IDs; user recovery is an explicit new accepted operation, not bypassing deletion state.

## Merge and conflicts

Compare base/local/remote by fields and semantic groups: fixed interval with zone; recurrence with
zone/DST policy; lifecycle with completion/archive; target windows; order/parent; Constraint
value/strength; Review notes/decisions. A disjoint merge is accepted only when the merged record
passes invariants. Same-field/group differences, Review notes, Context, ordering and
delete-versus-edit remain explicit conflicts. Title, notes, dates, state and endpoints do not use
last-write-wins.

Conflicts preserve candidates and affected groups. The person chooses this device, the other version
or allowed field details; delete-versus-edit chooses keeping deletion or restoring edited content.
Resolution is a normal command against the latest base and closes server state idempotently. Related
queued work waits while unrelated groups continue. A group already sent without an answer is retried
with its original IDs, preserving order and acknowledgement recovery.

## Coordinator and failures

One coordinator runs for the open account store, pushing then pulling. It reacts to launch,
committed changes, online/visibility, a visible periodic cycle and Sync now. Transient failure uses
bounded backoff; requests have a timeout, interrupted `sending` work becomes pending on restart, and
expired sessions pause network work until sign-in. Schema/owner rejection remains Needs attention
instead of a blind retry loop.

Changing the active identity stops the coordinator before closing its store. Successful pulls and
resolutions invalidate queries. User-visible states explain queued offline work, server outage,
authentication, conflicts and deletion without blocking local controls.

Account deletion freezes pushes and uses an idempotent owner-bound server operation with recent
password authentication. Confirmed deletion cannot be undone into background resurrection.
[Identity](identity-and-ownership.md) and [accounts](../accounts-and-sync.md) describe the
lifecycle.

## Change requirements

Protocol changes need client/server codec parity, migration compatibility and real-backend tests for
cross-owner access/links, malformed/oversized input, stale bases, atomicity, lost acknowledgements,
reconciliation, conflicts, tombstones and two-client convergence. Fixture-only server mocks do not
prove RLS or deployed configuration. Hosted verification remains an operator observation.
