# Explicit manual planning and focus

**Status: implemented decision.**

The person chooses relationships, placements, order, schedules, overlap decisions and completion.
Capacity is neutral guidance. The planner never silently refills focus, ranks work, schedules it,
resolves overlaps or completes it because time passed.

Day focus is separate from lifecycle and placement, with at most three ordered items. Focus mode has
no Start command: entering it or running a timer leaves the Action state unchanged. Completing an
Action and its block are explicit choices. The timer is temporary presentation state with no stored
productivity measurement, sound or lock-in.

End Day is the daily review. Saved choices are drafts until Finish; Finish applies them through
normal rules in one command with grouped Undo. Due review notices do not block use. Completed
periods remain history after zone/week-start changes.

This keeps manual control clear while imposing a small focus set. See the
[user guide](../user-guide.md) and [planning contract](../contracts/planning-model.md).
