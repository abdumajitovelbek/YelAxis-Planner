# CI investigation pause report

Recorded 2026-10-08. **Historical pause checkpoint.** The owner subsequently authorized resumption.
See [verification](../verification.md) and the [investigation](ci-investigation.md) for later
completed results; the observations below describe the pause, not current release status.

The current code checkpoint is
[`e7cc6f3d3b7a2d52cb6741084cfa6b2212bb9049`](https://github.com/abdumajitovelbek/YelAxis-Planner/commit/e7cc6f3d3b7a2d52cb6741084cfa6b2212bb9049),
pushed to public `main`. No additional workflow was dispatched at this checkpoint. This report is
not a release approval or a claim that the current version passes all required gates.

## Completed investigation and fixes

- The browser account helper still used the faulty CLI JSON handling after the backend verifier had
  been corrected. It now shares the strict codec, with three additional regression tests
  ([`f5824ab`](https://github.com/abdumajitovelbek/YelAxis-Planner/commit/f5824ab)).
- Firefox Horizons restoration correctly saved and restored the position at native activation. The
  test compared an earlier position. It now measures the native event, retaining its 4 px tolerance
  and 5-second timeout
  ([`8a2dd79`](https://github.com/abdumajitovelbek/YelAxis-Planner/commit/8a2dd79)).
- Large account-link fixtures used individual autocommits. Transactional setup retains the rows,
  grouping, rollback/retry assertions and timeout
  ([`736d1dc`](https://github.com/abdumajitovelbek/YelAxis-Planner/commit/736d1dc)).
- An actual Action detail loading race left the previous Action's editable draft visible while
  opening the next route. State is now keyed by Action ID; a deferred-query regression reproduced
  the failure before the fix. All 23 Action UI tests passed locally
  ([`5083854`](https://github.com/abdumajitovelbek/YelAxis-Planner/commit/5083854)).
- Sync's default pull page now uses the existing 500-change protocol cap. Smaller explicitly
  configured pages remain supported. All 31 coordinator/reference tests passed locally
  ([`f65da55`](https://github.com/abdumajitovelbek/YelAxis-Planner/commit/f65da55)).

The [investigation](ci-investigation.md) also records the earlier test-fixture, browser-runner,
Docker mounting and `/tmp` configuration failures. A reported service disruption does not explain
the demonstrated parser, test-expectation or application defects.

## Current substep completed

A 250-operation initial-upload experiment made the CI transfer slower and was rejected. The
checkpoint restores 500-operation groups. Acknowledged outbox operations are now removed with one
prepared, owner-scoped SQLite statement instead of one worker round trip per operation. The existing
application-owned transaction remains intact; no schema migration is needed.

The new real-SQLite regression checks wrong-owner isolation, requested versus unrequested IDs,
duplicates/missing IDs and rollback. Completed local checks for this substep:

| Check                                                          | Result                    |
| -------------------------------------------------------------- | ------------------------- |
| Sync store, sync atomicity and account-link integration        | 3 files / 34 tests passed |
| Account upload-plan tests after restoring 500-operation groups | 1 file / 6 tests passed   |
| Data package TypeScript check                                  | Passed                    |
| Data package lint, zero warnings                               | Passed                    |
| Git whitespace check                                           | Passed                    |

These focused results do **not** establish final browser throughput or a complete repository gate.
Security assertions, fixture cardinality, transaction guarantees and performance thresholds remain
in force.

## Outstanding verification

| Completed GitHub run                                                                                                  | Measured outcome                                                                                                                                                                                           |
| --------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [Full CI on `736d1dc`](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37677877437)                  | Quality passed; 25/29 browser-gate stages passed, including backend 6 files / 61 tests. Firefox conflict convergence failed and led to the Action loading fix.                                             |
| [Account diagnostic on `5083854`](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37682301094)       | Chromium and Firefox sync journeys passed. Large transfer failed its 120-second completion budget.                                                                                                         |
| [Account diagnostic on `f65da55`](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37683924893)       | Both sync journeys passed; transfers converged, but Capture save failed its budget.                                                                                                                        |
| [Performance diagnostic on `5bd6c0e`](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37685344852)   | Upload 108,833 ms; pull 43,262 ms; both clients 10,003 live records. Upload-side Capture save 1,331 ms exceeded 1,000 ms; pull-side save 217 ms. Upload longest task 209 ms was within 250 ms. Run failed. |
| [250-operation experiment on `cdfb809`](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37686776990) | Failed the 120-second upload budget, with only 9,250 cloud records at timeout. Experiment rejected.                                                                                                        |

The new bulk-compaction checkpoint has **not** run the browser/performance diagnostic or complete
final CI. No complete successful set of required checks covers this final code and configuration.
The remaining performance failure cannot be dismissed as a confirmed external service incident.

## Release and workspace state

- `v0.1.0-beta.1` remains published and fixed at `69f76baf7a7613e623fa5c751ac075ad4ed33823`.
- Workspace package versions are prepared as `0.1.0-beta.2`. **No beta 2 tag or release exists.**
- The disposable public-project backend was stopped successfully. Other project stacks and the
  original private repository/worktrees were not altered.
- No workflow was launched for this pause checkpoint. The latest diagnostic runs inspected were
  completed failures, not unfinished runs counted as passes.
- Manual screen-reader, physical-device/OS-notification and hosted deployment observations remain
  unperformed. This checkpoint does not change their status.

## Resume checklist

1. Run the focused sync-performance diagnostic on the bulk-compaction code and examine its actual
   completion result, metrics and artifacts. Fix demonstrated failures without widening bounds.
2. Obtain a complete successful required CI set on the final code and workflow configuration,
   including repository, backend, browser, performance and release gates.
3. Update measured verification records and release notes using completed results. Publish a
   subsequent beta 2 for the runtime fixes; preserve beta 1's tag.

Work stops at this checkpoint. The broader CI-verification task remains open.
