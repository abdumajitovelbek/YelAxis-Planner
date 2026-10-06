# Features and everyday workflows

The four main destinations are **Today**, **Plan**, **Axis** and **Review**. **Capture**, **Inbox**,
**Search**, **Notifications** and **Settings** support that planning loop. You choose placements,
relationships, order and changes; the planner does not assign priorities or schedule work for you.

## Capture and Inbox

Capture makes an Action with a stable identity. A trimmed title is required; a note, estimate,
energy and priority are optional. A due date is separate from a planned date or exact scheduled
time.

Inbox holds Actions that still need a decision. You can **Do** on a chosen Day, **Plan** for a Day,
Week or Month, keep the content as a lightweight Note or Project idea, archive it, or leave it in
Inbox. Linking to a Project or Milestone is explicit. Ordering and bulk decisions use normal
commands and offer grouped Undo where supported.

Action detail lets you edit fields, place or schedule work, set a reminder, link it to a Project,
complete or cancel it, and archive it. Completing a Time Block and completing its Action are
separate choices. Notes stay lightweight; they are not a separate knowledge-base system.

## Plan across horizons

| Horizon | Use it for                                                                                   |
| ------- | -------------------------------------------------------------------------------------------- |
| Year    | Direction text, Outcomes, Milestones and target windows. Actions are not listed here.        |
| Month   | A theme, Outcomes and Milestones, with weekly planned duration and counts.                   |
| Week    | Fixed work, flexible placements, Backlog, carry-forward choices and up to three commitments. |
| Day     | Exact blocks and Routine Occurrences alongside flexible Actions.                             |

A placement names a period; it does not imply an exact time. Time Blocks hold fixed UTC instants and
their authoring zone. A Commitment represents fixed work; moving its block preserves its identity.
Backlog contains unfinished work without an active placement or planned block. Carry-forward shows
unfinished work from an earlier period and moves it only after your choice.

At wider desktop sizes, Week shows a Backlog sidebar and seven-day schedule. At narrower sizes or
higher text zoom it uses an agenda/day-card presentation. Buttons provide the same move and schedule
operations as pointer dragging.

Availability and capacity provide neutral guidance. Unknown availability stays unknown. Overlapping
windows are merged for available time; overlapping scheduled work counts fully toward load and
appears as a separate conflict. Choose **Move**, **Shorten**, **Keep overlap** or **Cancel**.
Keeping an overlap requires an explicit acknowledgement.

Month themes and Year directions are editable text, with no score or productivity grade.

## Routines and Templates

Routines support repeating work through a shared occurrence engine: daily intervals, selected
weekdays, weekly counts and monthly rules. Timed routines resolve wall time using an explicit zone
policy and daylight-saving policies. A dated occurrence can be completed, skipped or changed on its
own. **This and future** changes preserve prior history. Pause/resume use chosen effective dates and
never backfill missed periods.

New repeating capture creates a Routine and occurrences. Adding repetition to an existing Action
keeps that one-off Action and begins a new Routine afterward. Time passing never completes work.

Templates provide reusable structure. Applying one asks for an anchor date and zone, previews the
resolved records and times, and requires conflict choices before one atomic creation. You can
unselect items when their required relationships remain valid. Customize a built-in template by
copying it to a user-owned Template. Saving a Week as a Template copies its placed/scheduled
Actions, not their completion or history. [Time rules](contracts/time-and-recurrence.md) describe
edge cases.

## Axis and alignment

| Object    | Meaning                                                                         |
| --------- | ------------------------------------------------------------------------------- |
| Axis      | A long-term direction that can contain related Outcomes, Projects and Routines. |
| Outcome   | A desired result with a success definition and optional target window.          |
| Milestone | A measurable checkpoint belonging to exactly one Outcome.                       |
| Project   | A body of work with a desired result and an ordered list of Actions.            |
| Action    | A concrete item you can choose, place, schedule and complete.                   |

Links are typed and explicit. Projects may name one primary Outcome and supporting Outcomes.
Milestones can connect to Projects and Actions. Replacing a single-valued relationship is previewed;
linking across Axes needs confirmation where applicable. Links do not imply placements.

Outcome progress can be a manually entered percentage, transparent milestone completion text, or no
percentage. Milestone mode shows **N of M milestones completed**; canceled milestones are shown
separately and archived milestones are excluded. A Project's next Action comes from your saved
order.

The Alignment Map is optional. The relationship list offers the same operations and remains usable
with the keyboard. Centering or selecting the map changes its presentation only.

Archive preserves the object and history. Restoring does not silently restore every linked setting.
Permanent deletion has a preview and typed confirmation, may be blocked by references or unsettled
sync, and has no Undo. See [deletion scopes](data-and-privacy.md#archive-and-delete).

## Today and Focus

Today follows the planning time zone. A fresh launch or Today navigation entry opens the current
day; choosing another date is preserved within the existing Back/Forward navigation context.
Scheduled and flexible work are shown separately.

Choose up to three focus items explicitly. Items are never ranked, preselected or automatically
refilled. A finished or changed item remains visible until you remove it. Earlier focus selections
are history. Focus does not change an item's lifecycle state.

Focus mode provides one item at a time and a timer with Pause, Resume, Reset and Add 5 minutes. The
timer is temporary presentation state, resets on exit/reload, and has no sound, wake lock or
automatic completion. Complete an Action explicitly, choosing whether its Time Block is completed as
well.

## End Day and Reviews

End Day is the daily review. Decide what to complete, carry, move, cancel or leave for later, record
an optional note and energy label, and draft the next day's focus. **Decide later** is the default.
Scheduled carry/move choices state their block consequences before applying them.

Weekly reviews inspect recent work, Inbox and Projects, capacity and fixed work, then choose
commitments and focus. Monthly reviews support Outcome, Milestone and Project decisions and the next
month's theme. Yearly reviews hold a retrospective, Outcome decisions and direction choices.

**Save for later** keeps a draft without applying planning decisions. **Skip** applies none.
**Finish** saves and applies all accepted decisions in one command with one grouped Undo. Reviews
work offline and after restart. Completed reviews remain in history; due notices are quiet and never
block planning. Changing time zone or first weekday does not rewrite historical review periods.

## Search and reminders

Search uses a local word-prefix index over planning prose. Filter by type, state, date, Axis,
Project and archive status, then open detail. Search stays available offline and stores no query
history. It does not rank your work.

Reminder definitions can target Actions, Time Blocks, timed Routines and saved reviews. Alerts start
disabled. Browser permission is requested only after your explicit action; generic notification
content is the default, with title exposure an opt-in choice.

Due reminders are delivered while the app is open. Background timers and the OS may delay them;
closed-browser delivery is not supported. Missed reminders remain in **Notifications** after
reopening. Finished, removed or changed targets cannot be opened from stale notifications. Denied
permission does not remove the saved reminder.

## Accounts, files and settings

Optional [accounts](accounts-and-sync.md) replicate committed local edits and expose queued work,
conflicts and retries. Builds without backend configuration stay local-only.

**Settings → Data** provides JSON backup, previewed Merge or Restore/Replace import, CSV, Review
Markdown, Template files and retained recovery state. These files have different completeness and
privacy boundaries; read [data and recovery](data-and-privacy.md) before replacement or deletion.

Settings also provides light/dark/system theme, motion preferences and a preview/download of safe
support metadata. English is the shipped interface language; date/number presentation follows the
device locale. [Accessibility and localization](accessibility-and-localization.md) explains current
coverage and limits.
