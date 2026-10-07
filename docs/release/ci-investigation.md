# CI failure investigation

**Paused 2026-10-08 at the owner's request. Final CI verification remains incomplete.** See the
[pause report](ci-progress-report.md) for the current code checkpoint, later failed diagnostics,
completed focused checks and exact resumption steps.

The failed email notifications cover several different revisions. They do not all describe a failure
in the current application. Existing beta tag `v0.1.0-beta.1` remains at `69f76ba`; its source
snapshot and recorded local verification are preserved.

## Failure classification

| Run / revision                                                                                                          | Concrete failure and evidence                                                                                                                                                                                                                                                | Classification and resolution                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| [37607971330](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37607971330), initial beta documentation | Today query fixture exceeded its test timeout while inserting over 3,000 individual autocommits.                                                                                                                                                                             | Test setup: identical rows now seed in one transaction. Original cardinality, ownership assertions and timeout remain. Subsequent quality jobs pass.                                                                                                                                                                                                                                               |
| [37622600389](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37622600389), bare-runner Firefox        | The handbook button was visible/enabled, but the captured native pointer-event list was empty.                                                                                                                                                                               | Runner/browser environment: the pinned image passed the trusted-click check in [37627446971](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37627446971). Full run `83f5850` also passed Firefox persistence.                                                                                                                                                                    |
| [37628096050](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37628096050), first container setup      | The stack wrapper could not start or stop the disposable backend inside the image.                                                                                                                                                                                           | Workflow configuration: mount the Docker client as well as the job's daemon socket. Subsequent backend runs start, migrate, verify and stop successfully.                                                                                                                                                                                                                                          |
| [37629716420](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37629716420), catalog verifier           | 31 backend tests passed; 30 catalog checks failed with the old CLI result handling.                                                                                                                                                                                          | Test tooling: select explicit query JSON, retain complete arrays/envelopes, and reject unsupported output instead of treating it as an empty result. [37639560337](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37639560337) passed all 61 tests.                                                                                                                              |
| [37640202645](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37640202645), container connectivity     | Chromium renderer crashed during service-worker startup.                                                                                                                                                                                                                     | Workflow filesystem: the artifact mount replaced `/tmp` with ordinary directory permissions. Restore writable sticky-directory semantics. [37642924504](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37642924504) passed genuine offline blocking/reload/recovery.                                                                                                             |
| [37643421585](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37643421585), `83f5850`                  | Workspace checks and 24 browser-gate stages passed, including backend 6 files / 61 tests. Sync then threw a JSON parsing exception after synthetic sign-in. Its screenshot shows the expected first-upload choice; the test helper still stripped the opening array bracket. | Unresolved at the previous delivery, now corrected in the browser account helper using the same strict codec as the backend verifier. Three additional regressions preserve typed/empty results and reject malformed or failed CLI output without echoing it.                                                                                                                                      |
| [37650713330](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37650713330), parser fix                 | Chromium and Firefox sync journeys passed. The following 10,000-Action upload did not reach `Synced` within 120 seconds.                                                                                                                                                     | Observed transfer-budget failure, not attributed to a service incident. The isolated diagnostic [37652347677](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37652347677) passed unchanged bounds: upload 97,990 ms, pull 44,122 ms, 10,003 live records on both clients; longest upload task 132 ms. Local full Chromium also passed. A complete combined run remains required. |

| [37653233128](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37653233128),
follow-up combined run | Firefox scroll restoration expected 1,003 px, while diagnostics show
pointer activation at 997 px, saved 997 px and restored 997 px. | Test expectation: compare the
position at native navigation, not the earlier pre-activation position. The 4 px tolerance and
5-second timeout remain unchanged; the test also requires the native pointer event. |

| [37655297398](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37655297398),
quality gate | Large account-link grouping and rollback tests exceeded 5 seconds while seeding 1,100
and 600 Actions as individual autocommits. | Test setup: identical fixtures now use one transaction.
All 14 account-link tests pass locally; 500-operation group sizes, whole-link rollback/retry
assertions and the timeout remain unchanged. |

| [37677877437](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37677877437),
Firefox conflict sequence | Both clients synced, but the screenshot shows the saved title
`Sync betaBeta from B`. A deferred-query regression reproduces the prior Action's editable form
remaining visible under the next Action's route. | Application loading race: Action detail now owns
state and draft by route ID, showing its opening state until the next record loads. The regression
verifies the correct next ID/revision and fields. This runtime fix is prepared as beta 2; beta 1
remains fixed. |

| [37682301094](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37682301094),
beta-2 account diagnostic | Both sync journeys passed. The 10,000-Action test timed out with all
10,002 records uploaded, no conflicts or server errors, and 30 pull responses while still
`first_upload`. | Runtime throughput: use the existing 500-change protocol cap instead of 200-change
default pages, reducing repeated durable page/checkpoint commits. Smaller configured pages and all
protocol/cursor/transaction constraints remain. Coordinator and reference regressions pass; transfer
and UI budgets are unchanged. |

GitHub's [reported incident](https://www.githubstatus.com/incidents/djlmxz2zd0j7) explains the
observed transport/server disruptions during the previous delivery. It does **not** explain the
`83f5850` JSON exception. The actual completed run supersedes the earlier in-progress status record.

## Verification scope

The verification fixes affect test helpers and workflow diagnostics. The Action-loading race,
pull-page throughput and bulk outbox compaction also require runtime fixes and a subsequent beta 2
release. No planning rule, database schema, security check, fixture size or performance threshold
changed. The beta 1 tag remains fixed; no unperformed manual check is marked as passed.

The latest performance diagnostics failed; the bulk-compaction checkpoint has only focused local
verification. No complete final CI pass or beta 2 release is claimed. The complete result must be
recorded in the verification guide after all required jobs pass. Manual screen-reader, physical
input/OS notification and hosted deployment observations remain unperformed.
