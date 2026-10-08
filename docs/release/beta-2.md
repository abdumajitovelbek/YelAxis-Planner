# YelAxis Planner 0.1.0-beta.2

A subsequent Apache-2.0 beta source release. The original `v0.1.0-beta.1` tag is preserved.

## Fixes

- Opening another Action now starts with that record's loading state and draft. The previous
  Action's editable form cannot carry into the new route while its query is pending.
- Large account synchronization retains 500-change first-upload pages, bounds normal pull
  transactions to 250 changes, and uses owner-scoped bulk outbox compaction and compressed-snapshot
  reuse for unchanged images. Transactions, independent rollback copies, durable writes, explicit
  conflicts and normal reconciliation remain intact.
- CI uses a reproducible browser environment, complete CLI JSON parsing, transactional fixture setup
  and the actual Firefox navigation-time scroll position. Original assertions, dataset sizes,
  security checks, timeouts and performance bounds remain.

## Completed verification

The
[complete GitHub CI run](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37791860197)
passed on `1a6142b3fdb6bceaa142193b3ac9a39e37e8fe7c`:

- Repository: **214 files / 3,087 workspace tests**, plus **36 scanner/configuration tests**;
  policy, formatting, lint and types passed.
- Backend: **6 files / 61 tests**, including catalog and owner/RLS assertions.
- Browser: **27 suites**, with all **29/29** build/backend/browser stages complete.
- Release: **six Chromium/Firefox accessibility, performance and security suites**, plus build,
  artifact inspection and dependency audit; no reported advisories or artifact secret findings.

The full run's 10,000-Action transfer measured upload **48,757 ms**, pull **25,254 ms** and Capture
saves **814/823 ms**. The longest upload main-thread task was **133 ms**. Both clients and cloud
converged to **10,003 live records**. All unchanged budgets passed. The
[focused performance run](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37791163153)
also passed on that runtime revision.

The tagged delivery adds measured documentation/evidence only to this verified code and workflow
configuration. [Verification](../verification.md),
[raw measured reports](ci-verification-results.json) and the
[failure investigation](ci-investigation.md) retain exact revisions, environments and limits. Older
failed diagnostics are not described as passes.

## Known limits

This is not a stable-release readiness claim. Spoken screen-reader output, physical input/zoom,
OS-notification behavior and hosted deployment observations remain **unperformed**. Browser storage
is best effort and unencrypted. Reminders deliver while the app is open and recover missed items on
reopening. Publication creates no hosted website or production backend.

No owner intervention remains for these automated CI fixes. A stable or hosted deployment requires
its operator to perform the documented human/hosted checks and resolve its hosting, credential and
retention choices.
