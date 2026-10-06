# Portable recovery and open-app reminders

**Status: implemented decision.**

JSON is the canonical human-readable portable backup. It is bounded, versioned and digest-verified;
CSV and Markdown are export conveniences. Import validates and previews a coherent graph before
normal application commands. Merge is the default, while replacement requires a verified pre-import
backup and typed confirmation. Journals support restart/resume without resetting the active plan.

Recovery candidates carry content but no server authority. Reduced export removes sensitive Context
and dependent data together. Files are private readable copies with independent retention.

Reminder definitions are canonical; permission/preferences and delivery receipts are device-local.
Alerts begin disabled with generic content. Permission and title exposure each need explicit choice.
Delivery works while the app is open, with missed-reminder recovery after reopening. Background
timers and OS policy can delay delivery; reliable closed-browser delivery is not offered.

Search is a derived word-prefix index because the shipped SQLite engine has no FTS extension. It
remains owner-scoped and local without query history or relevance ranking. See
[backup format](../contracts/backup-format.md) and [user guide](../user-guide.md).
