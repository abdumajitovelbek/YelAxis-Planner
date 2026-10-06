# Identity and ownership contract

Local planning and account replication are separate choices. No email or personal profile data is
required to create a local identity. Each plan has one identity, one Profile and an isolated SQLite
store; every syncable row has exactly one owner.

## Local and account stores

A device identity index selects a store but contains no planning prose. A local identity has a
stable random owner and stays usable offline. An account identity binds its owner to the verified
Auth subject. Stable planning IDs survive linkage; the Profile ID maps to one deterministic account
Profile so multiple devices cannot create a second Profile for that account.

Sign-out clears the session, closes/locks the account store and opens the most recently used local
plan. Sign-in can reopen the same account replica with its queued changes. Stores and deep links
must fail closed on foreign-owner references. Unreadable identity index data is preserved for
recovery rather than silently orphaning a database.

## First upload

With meaningful local work, preview source counts, cloud presence, sensitive categories and pending
state. Make and verify a downloadable backup before owner remapping. One local transaction links the
identity, remaps owner/Profile references and queues dependency-ordered ordinary create groups.
Linkage completes only after acknowledgement and a pull checkpoint. Interrupted upload resumes
idempotently; cancellation before linkage reverses ownership and preserves subsequent local edits.
Cloud collisions use normal conflicts, never timestamp overwrite.

Profile planning preferences can sync; setup progress, draft, artifact bookkeeping, preferred name
and display locale are device-local. Backup can preserve supported local settings without granting
account or server authority.

## Sessions and authorization

The Auth adapter holds email/password claims. Domain entities refer to stable IDs. Browser sessions
live in site `localStorage`, never SQLite, caches, URLs, logs, portable backups or support
downloads. Sign-out and device removal clear them. A stored session without an open account store is
cleared on launch, including offline launch. This is not encrypted storage.

Imports, deep links and sync payload owner assertions are untrusted. The server derives the owner
from `auth.uid()` and validates both relationship endpoints. The browser receives only public client
configuration; privileged keys stay server/operator/test-process side.

## Removal and deletion

Sign-out previews queued work, conflicts, last sync and export. Pending work can remain only on this
device after acknowledged sign-out. Device removal is separately confirmed and deletes that replica,
not cloud data; unsent work requires export or explicit data-loss acknowledgement.

Account deletion requires recent password authentication and previews cloud/Auth, local copy,
external exports and provider-backup scopes. Pending deletion freezes pushes. Recoverable failure
preserves local data with retry/cancel. Confirmed deletion clears the session and applies the saved
local-copy choice; a kept copy becomes local-only. Lost acknowledgements and deletion on another
device are checked before cancellation/retry so confirmed deletion cannot be reversed into upload.

There is no whole-local-plan deletion control in the current UI. Browser site-data removal is an
external action affecting the origin's storage; it does not delete cloud accounts. Files, other
offline replicas, OS notification history and provider backups have independent retention.
[Privacy](../data-and-privacy.md) gives user-facing consequences.
