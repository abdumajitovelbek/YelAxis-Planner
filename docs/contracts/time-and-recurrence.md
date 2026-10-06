# Time, horizons and recurrence contract

Domain time comes from an injected clock. Instants serialize as RFC 3339 UTC ending in `Z`; fixed
intervals also retain a valid IANA authoring zone. Dates use `YYYY-MM-DD`, wall times `HH:mm`, and
weekdays named values rather than locale-dependent integers.

## Distinct meanings

| Value         | Meaning                                                                   |
| ------------- | ------------------------------------------------------------------------- |
| Placement     | Period in which the user intends to consider or do work                   |
| Target window | Inclusive date-only window for a result; either end may be absent         |
| Due value     | Date-only obligation in the planning zone, or exact UTC instant with zone |
| Time Block    | Fixed exact interval, start strictly before end                           |
| Routine       | Repeating rule in local calendar space with zone/DST policy               |

An Action's date-only and timed due values are mutually exclusive. Date-only work becomes overdue
after its due date, not during it; timed due becomes overdue after the instant. Finished, canceled
and archived Actions are not overdue. A due value never schedules work.

The confirmed Profile planning zone defines Today, date-only due evaluation and new review/placement
periods. Device defaults need no profile data. Fixed block instants and date-only historical intent
remain stable after a zone change. Fresh Today entry selects the current day; in-context navigation
can preserve a chosen date.

Day is one calendar date; Week is an exact inclusive seven-day range plus its creation week-start;
Month is `YYYY-MM`; Year is a Gregorian year. Historical placements and reviews do not silently
rebase when the first weekday changes.

Cross-midnight and long imported intervals remain exact. Views include their intersecting portions;
queries must not hide them through an arbitrary lookback. An Action has at most one planned block.
Rescheduling creates a replacement and cancels/supersedes the old block atomically.

## Capacity and conflicts

Availability merges overlapping windows and measures elapsed time in the planning zone. Week sums
its days. A capacity cap limits known availability to the lower amount; a cap alone is an explicit
limit. Missing availability remains unknown and partial weeks are labeled partial.

Planned and completed scheduled work counts toward load, clipped to the displayed local date;
canceled/skipped work does not. Overlapping work counts fully and is a separate visible conflict.
Touching intervals do not overlap. Move, Shorten, Keep overlap and Cancel are explicit commands.
Keeping an overlap requires acknowledgement on the affected planned items. No capacity calculation
silently changes a plan.

## Shared Routine engine

Recurring capture uses Routine, generation/defaults and Routine Occurrence. Action rows have no
recurrence rule and no parallel engine. Rules are normalized versioned data for daily intervals,
selected weekdays, weekly counts and monthly repetition. IDs derived from stable generation/period
keys make repeated materialization idempotent.

Selected-weekday intervals count seven-day periods from the start date; weekends are included only
when selected. Weekly-count rules name a week and counter, rather than pretending each completion
was a separate one-off Action.

Dated occurrence changes preserve logical identity. **This and future** splits generations from an
explicit effective date without rewriting prior history. Pause/resume do not start in the past and
never backfill missed periods. Weekly-count boundaries use the first day of a week to avoid counting
a period twice. A split/resume is refused if existing later materialized occurrences would be
reinterpreted; choose a later effective date. Exact Undo can retire a trailing unused generation,
not delete generation history.

A Routine can be timed, flexible within a day, or a weekly count according to its validated rule.
Timed generation resolves local dates and wall times in its fixed zone or planning-zone policy. For
a daylight-saving gap, default `shift_forward` moves by the gap and an explicit `skip` can be
stored. For repeated time, default `earlier_offset` selects the first instant and `later_offset` can
be stored. Previews show the chosen policy and zone. Existing materialized intervals preserve
resolved instants.

New repeating capture creates a Routine directly. Adding repeat to an existing Action preserves it
and starts a new Routine afterward. Completion and skipping require commands.

## Templates

Template blueprints version 1 remain decodable; version 2 adds relative day offsets, optional wall
start time and duration. The apply preview uses a chosen anchor date and zone, checks DST,
references and overlaps, and identifies unplaced items as unscheduled. Deselection cannot leave
required relationships dangling. Apply is one command with receipt, Undo and required outbox.

Built-in definitions are a versioned application catalog, not user-owned rows. Customizing
duplicates one first. Saving a Week copies its placed/scheduled Actions with relative offsets and no
completion/history. Template files are structure-only; see [backup formats](backup-format.md).
