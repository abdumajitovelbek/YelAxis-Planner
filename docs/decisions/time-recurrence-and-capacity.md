# Time, recurrence and capacity

**Status: implemented decision.**

Fixed work stores UTC instants plus an IANA authoring zone. Floating recurring work stores wall time
and a fixed/planning-zone policy. Date-only placement, due values and target windows mean different
things and are not silently converted into one another.

One Routine/Occurrence engine handles recurring work. Generations preserve prior history;
deterministic period IDs prevent duplicates. New repeating capture creates a Routine, while adding
repeat to an existing Action keeps that Action and begins afterward. Pause/resume never backfill
missed periods. DST gap/repeated-time policy is explicit and appears in previews.

Capacity merges availability windows, applies upper caps and keeps missing time unknown. Overlap
counts toward load and remains a separate conflict, with Move, Shorten, Keep overlap and Cancel.
Keep overlap needs acknowledgement; no rule picks a resolution for the person.

Templates use an anchor and zone preview, preserve older blueprint interpretation, and apply a
coherent graph atomically. See [time contract](../contracts/time-and-recurrence.md).
