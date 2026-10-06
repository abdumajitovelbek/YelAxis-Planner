# Planning model contract

Planning objects, relationships, placement, exact time and focus are separate concepts. An unaligned
Action is valid. Linking never creates or deletes either endpoint. All endpoints belong to the
active identity; sync checks both owners on the server as well.

## Objects and lifecycle

| Object                    | Persisted states                                                                    |
| ------------------------- | ----------------------------------------------------------------------------------- |
| Axis                      | `active`, `archived`                                                                |
| Outcome                   | `active`, `paused`, `achieved`, `abandoned`, `archived`                             |
| Milestone                 | `active`, `completed`, `canceled`, `archived`                                       |
| Project                   | `idea`, `active`, `blocked`, `paused`, `completed`, `archived`                      |
| Action                    | `inbox`, `planned`, `scheduled`, `in_progress`, `completed`, `canceled`, `archived` |
| Note / Context / Template | `active`, `archived`                                                                |
| Commitment                | `planned`, `completed`, `canceled`, `archived`                                      |
| Time Block                | `planned`, `completed`, `skipped`, `canceled`                                       |
| Routine                   | `active`, `paused`, `archived`                                                      |
| Routine Occurrence        | `planned`, `completed`, `skipped`                                                   |
| Review                    | `draft`, `skipped`, `completed`, `archived`                                         |
| Reminder                  | `scheduled`, `delivered`, `canceled`                                                |

Legal transitions are defined in `packages/domain/src/states.ts` and feature rules. Not every domain
transition is exposed as a UI command: Focus mode has no Start command and completed reviews have no
ordinary Reopen control. Overdue, capacity, conflict and sync attention are derived conditions, not
lifecycle states. Time passing never completes a record.

Archive records the prior state; restore revalidates required relationships and uses a valid prior
state or conservative fallback. An idea Project has no required result; activation requires one.
Permanent deletion has no ordinary Undo and is distinct from a transition to archived.

## Typed relationships

| Relationship                 | Cardinality / rule                                                             |
| ---------------------------- | ------------------------------------------------------------------------------ |
| Axis membership              | Outcome, Project, Routine, Action and Note each name at most one explicit Axis |
| Outcome → Milestone          | Every Milestone has exactly one Outcome; reparenting is explicit               |
| Primary Outcome → Project    | A Project names at most one primary Outcome                                    |
| Supporting Outcome ↔ Project | Many-to-many; cannot duplicate its primary relationship                        |
| Project → Action / Note      | Each Action or Note names at most one Project                                  |
| Project → Routine defaults   | Optional Project per recurrence generation                                     |
| Milestone ↔ Project / Action | Typed many-to-many supporting links                                            |
| Time Block target            | Exactly one supported target kind or a titled custom block                     |
| Reminder target              | Exactly one Action, Time Block, timed Routine or saved Review                  |

There is no generic canonical object-to-object edge table. Typed directions and foreign keys prevent
arbitrary hierarchy cycles. Optional Action Axis can differ from its Project Axis only after
explicit confirmation. An absent Action Axis may display the Project Axis as derived context; moving
the Project never copies an Axis into child Actions.

Link commands validate type pair, existence, owner, cardinality, archive state and revisions.
Replacing single-valued links is previewed. Required relations cannot be unlinked into invalid
objects. Join links use stable derived IDs; unlink marks them inactive and relink revives them.

## Placement and selection

| Object    | Allowed direct horizons |
| --------- | ----------------------- |
| Outcome   | Year, Month             |
| Project   | Year, Month, Week       |
| Milestone | Month, Week             |
| Action    | Month, Week, Day        |

At most one direct active placement exists per object. More-specific periods contribute to broader
views without duplicate rows. Placing Inbox work makes it planned; removing an unscheduled
unfinished placement leaves planned Backlog work. Due values and target windows create no placement.

Scheduling an Action creates/replaces its Day placement at the block's local start date.
Rescheduling supersedes the old block instead of losing history. Completing/skipping/canceling a
block changes its Action only when a stated compound choice requires that effect.

Day focus is a separate ordered Action/Occurrence selection, capped at three active items. Week
commitments are a separate ordered Action/Project/Milestone selection, also presented as up to three
in the current planning/review interface. Selection never changes priority, lifecycle, placement or
hardness; removing it never deletes its target. Themes and Directions are one optional text record
per Month/Year.

## Deletion and history

Archive normally affects only the selected object. Children and links remain; disabling directly
targeting reminders is an explicit disclosed part of archive, and restore does not silently
re-enable them.

Permanent deletion previews inbound links, children, placements, reminders, pending sync, conflicts
and history. Required children/default references and unsettled replication can block it. An
explicit optional unlink choice may remove support relations and selections, but never another
domain object. Review decisions retain history with a cleared **Deleted object** reference. Private
payloads in settled support copies, audit and Undo are removed/redacted; minimal
deletion-ledger/tombstone metadata prevents resurrection.
[Privacy](../data-and-privacy.md#archive-and-delete) explains copies outside application control.
