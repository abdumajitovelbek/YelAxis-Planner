# Data, privacy and recovery

SQLite is the canonical plan. The dedicated worker saves a complete compressed SQLite image
atomically to IndexedDB after acknowledged writes. Compression is not encryption. React state holds
forms and presentation; optional cloud data is asynchronous replication.

## Where data lives

| Location                   | Contents and boundary                                                                                                               |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| Browser IndexedDB          | Isolated SQLite plan, device import/recovery copies, reminder delivery state and checked-image metadata. Browser-managed retention. |
| Site localStorage          | Account session, identity index and presentation preferences. Sessions do not enter the plan or exports.                            |
| Site sessionStorage        | Navigation presentation such as scroll positions.                                                                                   |
| Service-worker cache       | Static application assets and navigation shell only. No plans, tokens, API responses, backups or imports.                           |
| Configured account backend | Owner-scoped planning replica, sync history/conflicts/receipts and authentication. Operator/provider retention applies.             |
| Downloaded files           | Readable private copies retained wherever you save them, outside application control.                                               |
| OS/browser notifications   | Generic by default; optional title disclosure. Platform settings and retention apply.                                               |

There is no automatic analytics, crash-report upload or remote support upload. Search is local and
records no query history. Support information is previewed before a separate download and contains
only allowlisted build/browser-family, capability, permission and online metadata. It excludes plan
content, account/profile values, stable object IDs, routes, URLs, raw errors and tokens.

## Browser persistence

A granted persistence request reduces some eviction risk; it does not guarantee retention. Clearing
site data, removing the browser profile, browser removal, private browsing policy, quotas or
eviction can remove the plan. A different browser/profile/origin has a different store. Neither
local browser storage nor exported files are encrypted by YelAxis Planner.

Keep an independent JSON backup. Do not clear site data or reset a database to repair a storage,
migration, sync or import problem. One active tab owns each database; close the other tab and retry
if ownership is busy.

## Make a backup

1. Open **Settings → Data** and preview the export.
2. Review counts, sensitive Context and whether sync is pending. A complete backup may contain
   private Context and unresolved conflict candidates. Deselect sensitive Context for a reduced
   copy; dependent Constraints and related recovery data are omitted with it.
3. Download the JSON backup and confirm that the file actually exists at the chosen destination.
4. Keep it in a location whose access and retention you control. Do not attach it to a public issue.

A backup reads one consistent local snapshot and includes queued account edits. Counts and the
canonical-data digest are verified before it is offered. Starting a browser download cannot prove
the OS completed saving. A reduced export cannot restore omitted private data.

| Export                  | Intended use                                                                    | Complete restore?      |
| ----------------------- | ------------------------------------------------------------------------------- | ---------------------- |
| JSON backup             | Full planning graph, supported history/deletion state and recovery candidates   | Yes, for included data |
| Actions/Time Blocks CSV | Spreadsheet exchange with stable headers and formula-safe cells                 | No                     |
| Review Markdown         | Chronological readable review history                                           | No                     |
| Template JSON           | Reusable structure without source history, completion, Context or account state | Template import only   |

[Backup format](contracts/backup-format.md) defines fields, versions and import bounds.

## Import and restore

Import accepts supported plain JSON backups or Template files. It checks format/version, size,
shape, digest, dates/zones, identities and relationships before any canonical change. CSV and
Markdown are export-only. Unknown formats and fields fail safely rather than being guessed.

**Merge** is the default. New IDs create records, equivalent same-ID content skips duplicates, and
changed same-ID content requires **Keep current**, **Use imported** or **Duplicate imported**.
Duplication remaps the selected dependency component to new IDs. Imported ownership never grants
account authority.

**Restore/Replace** requires a complete valid graph, a verified pre-import backup and typed
confirmation. Replacing an account-linked plan also previews the ordinary changes that will sync.
Credentials and account binding are never restored from a file. Replacement is atomic: failure keeps
the prior plan.

## Interrupted work and storage errors

A device-only import journal keeps the validated preview across restart. Resume refreshes it before
application; discard removes staging without resetting the plan. One verified pre-import backup per
owner is retained until a later verified backup replaces it. These recovery copies contain private
data and share browser storage's best-effort retention; they are not independent external backups.

Failed migrations preserve the old image and migration ledger. A newer database requires a
compatible build or forward fix. Failed durable saves restore the previous acknowledged image.
Malformed noncritical notification receipts can be skipped with a count while originals are kept;
canonical corruption fails closed. Keep unsynchronized work and recovery state when reporting a
problem. [Troubleshooting](development.md#troubleshooting) provides safe next steps.

## Archive and delete

Archive is the normal way to remove work from active views while keeping it restorable. Permanent
object deletion is separate, previewed and typed-confirmed, has no Undo, and may be blocked by
required references, unsettled outbox work or open conflicts. It does not cascade into unrelated
planning objects.

Permanent deletion removes owned placements and private support copies, redacts affected undo/audit
payloads and keeps minimal tombstones to prevent resurrection. Review decisions can remain as
**Deleted object** history with their reference cleared. Historical Time Blocks may remain with a
private-safe detached label; the preview explains the exact consequences.

There is currently no whole-local-plan deletion control. Supported planning objects can be
permanently deleted individually. Browser site-data controls can remove the origin's plans, sessions
and caches; that is an external destructive action, so verify an independent backup first. It is not
a migration/import repair strategy. **Remove account from device** removes that replica, not cloud
data. **Delete account** deletes cloud planning rows and authentication, with a separate choice
about this device's copy. Deletion does not remove files you downloaded, independently retained
offline device copies, provider backups before expiry, or OS notification history. Browser/OS
controls are not a promise of forensic erasure.

Account sync, local copying and file export are separate consent and retention boundaries. Read
[accounts](accounts-and-sync.md) before sign-out or account deletion, and verify your operator's
backup/log retention policy before using a hosted account.
