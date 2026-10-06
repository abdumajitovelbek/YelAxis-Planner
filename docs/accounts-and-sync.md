# Optional accounts and synchronization

Local planning needs no account. Accounts are offered only when the build has a configured backend.
A local-only build says account support is unavailable. [Self-hosting](self-hosting.md) explains how
to configure a local test backend or operate your own instance.

## Sign in and first upload

The account interface uses email/password authentication. With an empty local plan, signing in opens
an isolated account replica and pulls its plan. If you already have meaningful local work, first
upload previews record counts, whether the account already has data, and sensitive Context
inclusion. It makes and verifies a backup before changing ownership.

First upload preserves planning object IDs, remaps owner/Profile references and queues ordinary sync
operations. It is not a timestamp-based overwrite. Existing account collisions become explicit
conflicts. Interruption resumes with the same operation IDs; cancel before linkage restores local
ownership and keeps edits made during the upload.

## Local edits first

Every accepted edit commits locally before synchronization. The durable outbox waits through network
outages. Sync pushes complete command groups and pulls pages into SQLite; the cloud replica is never
the UI's planning authority.

The Account page explains **First upload**, **Syncing**, **Queued offline**, **Synced**, **Needs
attention**, **Sign in again**, **Server unavailable** and **Deletion pending** when they matter.
Use **Sync now** or the offered retry after the underlying problem is resolved. Expired sessions
pause network work while the local plan remains available. Rejected changes are retained.

## Conflicts

Disjoint edits may merge only when the combined record satisfies normal rules. Different edits to
the same field or related semantic group, ordering, Context, Review notes and delete-versus-edit
produce explicit conflicts. No last-write-wins policy chooses between them.

Open the conflict and choose this device's version, the other version or field-level details where
offered. Delete-versus-edit offers keeping deletion or restoring edited content. Resolution is a
normal command with a new base. Unrelated queued work can continue while affected work waits.

## Sign out and remove a device copy

Before sign-out, review queued changes, conflicts, the last successful sync and export options.
Continuing with pending changes requires acknowledgement: they remain on this device until the same
account signs in again. Sign-out clears the session and returns to a local plan; it does not delete
the account replica.

**Remove this account from this device** clears the session and, with separate confirmation, removes
its local replica. It does not delete the cloud account. Unsynchronized work requires export or an
explicit data-loss acknowledgement before removal.

## Delete an account

Account deletion asks for the password again and previews separate scopes: cloud plan and sign-in
account, this device's copy, exports outside application control and provider backups. Deleting the
local copy is selected by default; you can choose to keep it as a local-only plan.

While deletion is pending, pushes are frozen so queued edits cannot recreate the cloud plan.
Recoverable failures preserve the local copy and offer retry/cancel. A confirmed server deletion
clears authentication and applies the saved local-copy choice, even if an acknowledgement was lost.
Provider backup expiry is an operator policy, not instant erasure. Other offline device copies and
user-created files remain separate copies.

See [data and deletion](data-and-privacy.md) and the
[identity contract](contracts/identity-and-ownership.md) for details.

## Authentication and privacy

The browser receives a public backend URL and public client key. Sessions are stored in site
`localStorage`, separate from SQLite, exports, diagnostics and service-worker caches. This is not
encrypted storage. Server functions bind access to the authenticated owner, with row-level security
and relationship owner checks. [Sync protocol](contracts/sync-protocol.md) describes the limits and
recovery guarantees.

Hosted email delivery, recovery, retention and deployed policy enforcement require checks by the
operator. No production backend or service commitment is provided by this source release.
