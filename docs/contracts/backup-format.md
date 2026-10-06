# Portable backup and import format

The canonical portable backup is human-readable JSON. CSV and Review Markdown are convenience
exports and cannot restore a full plan. Device SQLite snapshots are an internal persistence format,
not a portable account authority.

## JSON bundle version 1

```json
{
  "format": "yelaxis.backup",
  "formatVersion": 1,
  "bundleId": "uuid",
  "exportedAt": "RFC3339 UTC instant",
  "appVersion": "informational version",
  "manifest": {
    "sections": ["profile", "actions"],
    "recordCounts": { "actions": 0 },
    "sourceMode": "local",
    "containsSensitiveContext": false,
    "syncWasPending": false,
    "dataSha256": "hex digest of canonical data"
  },
  "data": {}
}
```

`sourceMode` is local or account and grants no authority. Planning records use
`{id, revision, document}` with stable versioned record codecs. Sections cover Profile/preferences,
Axes, Outcomes, Projects, Milestones, Actions, Notes, Commitments, placements/typed joins,
focus/Week selections, themes/directions, Time Blocks, Routines/occurrences, Templates,
Reviews/items, Reminders and Context/Constraints. Supported optional history and tombstone sections
preserve minimized visible history and deletion state; legacy version-1 files without them remain
supported.

`profile_settings` preserves supported device-local settings/setup state. `conflict_candidates`
preserves unresolved base/local/remote content without server/replica authority. Source ownership
and Profile references are remapped to the destination. Records sort by type/stable ID. SHA-256
covers the canonical data serialization; export verifies counts and digest before offering a file.
It reads one consistent local snapshot, including queued edits with truthful `syncWasPending`.

## Privacy exclusions

Bundles never include sessions/tokens, email/password claims, service-role/signing credentials,
replica/device IDs, cursor, outbox attempts, command receipts, derived Search, alert preferences/
receipts/cursors, OS notification IDs or diagnostic traces. Stable planning IDs/revisions can remain
for collision detection and do not assert authorization.

Complete backup includes sensitive Context only after preview. Reduced export removes sensitive
Context, dependent Constraints, related history/tombstones/conflict candidates and affected
unfinished setup references together. Files are readable private data and are not encrypted.

## Bounded decoding

Only plain JSON is accepted: maximum **50 MiB UTF-8**, **depth 40**, **100,000 records**, **100,000
characters per string** and **1,000,000 tree nodes**. Template files have a separate **1 MiB**
limit. Files are not decompressed or interpreted as filesystem paths.

Reject unsupported versions/types, unknown fields, prototype/authority keys, duplicate/invalid IDs,
invalid dates/instants/zones/enums and malformed relationships/invariants. Do not guess future
formats. A format interpretation change needs a new version and explicitly tested migration path;
the original file is not rewritten in place.

## Preview and application

1. Decode, verify digest and graph, then build creates/duplicate skips/collisions and sensitive-data
   preview without canonical writes.
2. Default to Merge. Equivalent same-ID content skips; changed same-ID content requires Keep
   current, Use imported or Duplicate imported. Duplication remaps its dependency component.
3. Restore/Replace requires a valid graph, verified pre-import backup and typed confirmation.
   Account-linked replacement additionally previews ordinary synchronized changes.
4. Apply through normal application transaction/codecs/import actor and outbox. Validate references
   before atomic commit; failure preserves the previous plan.

Imported unresolved candidates become local recovery conflicts and cannot assert server authority.
Tombstones do not delete live destination content without an explicit conflict decision. Required
parents apply before dependent records; unresolved graph issues block application.

A device-only journal retains preview across restart. Resume refreshes stale state; discard removes
staging. One verified pre-import backup per owner is replaced only by a later verified copy. Failed
backup prevents mutation. These private recovery copies share browser storage limits and are not
synchronized or portable sections. Replacement clears obsolete owner alert receipts/cursors while
retaining device alert preferences.

## CSV, Markdown and Templates

CSV is UTF-8 with CRLF rows, RFC 4180 quoting, stable ID sorting and empty null fields. Formula-like
string cells beginning with `=`, `+`, `-` or `@`, including after whitespace, get an apostrophe;
numeric cells remain numbers.

`actions.csv` headers:

```text
id,title,state,note,axis_id,project_id,due_date,due_at_utc,due_time_zone,estimate_minutes,energy,priority,completed_at_utc,archived_at_utc
```

`time-blocks.csv` headers:

```text
id,title,state,target_kind,action_id,commitment_id,routine_occurrence_id,starts_at_utc,ends_at_utc,time_zone,note,archived_at_utc
```

Time Block note/archive columns are reserved and empty in the current schema. Linked block targets
use kind/ID instead of duplicating their titles. CSV omits full relationships, recurrence, Context,
history, reminders, conflicts and credentials.

Review Markdown sorts chronologically by exact period and stable ID, includes type/state/notes/item
decisions and escapes Markdown/HTML controls. It omits unrelated planning and operational metadata.
Neither CSV nor Markdown is an accepted backup import.

`yelaxis.template` format version 1 contains only `title` and a validated blueprint version 1 or 2.
It copies no source IDs, completion/history, Context, account or sync state. Import saves a normal
user Template; applying it still uses the Plan preview.
