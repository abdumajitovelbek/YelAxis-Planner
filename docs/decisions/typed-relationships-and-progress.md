# Typed relationships and transparent progress

**Status: implemented decision.**

Canonical relations use typed foreign keys and join tables. A Milestone has exactly one Outcome; a
Project can have primary/supporting Outcomes; Actions remain valid without alignment. Linking never
owns both endpoint lifecycles. Replacing single-valued relations and cross-Axis Action/Project links
require explicit confirmation.

The optional Alignment Map reads the same relations as the accessible list and introduces no hidden
score. A Project's next Action follows saved order. Outcome milestone progress is **N of M
milestones completed**, where M counts active and completed milestones; canceled counts appear
separately and archived milestones are excluded. It does not invent a percentage for this mode.

Archive preserves children and links. Permanent delete is confirmed, conservative and non-cascading;
references or unsettled sync can block it. Review history can retain decisions with a cleared
Deleted object reference. See [planning model](../contracts/planning-model.md) and
[privacy](../data-and-privacy.md#archive-and-delete).
