# CI failure investigation

Failed-run emails covered several different revisions and causes. The existing `v0.1.0-beta.1` tag
remains fixed at `69f76baf7a7613e623fa5c751ac075ad4ed33823`. The runtime fixes below belong to the
subsequent beta 2 source release.

## Confirmed causes and fixes

| Failure evidence                                                                                                                                                                                                 | Cause and correction                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| [Initial quality run](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37607971330) and [account-link fixture run](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37655297398) | Test setup inserted thousands of rows as individual autocommits. Identical fixtures now seed in one transaction. Cardinality, grouping, rollback/retry assertions and timeouts remain.                                                                                                                                                                                                                                                                       |
| [Bare-runner Firefox](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37622600389)                                                                                                              | The enabled handbook button received no native pointer event. The pinned browser image passed the same trusted-click assertion in [the focused run](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37627446971).                                                                                                                                                                                                                           |
| [Container lifecycle](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37628096050) and [Chromium startup](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37640202645)         | Workflow configuration lacked the Docker client and replaced `/tmp` with unsuitable permissions. Mount the client/socket and restore writable sticky-directory semantics.                                                                                                                                                                                                                                                                                    |
| [Backend catalog](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37629716420) and [full CI on `83f5850`](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37643421585)         | The CLI helper selected the wrong output option and stripped the opening JSON array bracket. Backend and browser account helpers now share a strict codec and explicit non-agent query JSON. Malformed/failed output is rejected without echoing it. Backend [6 files / 61 tests passed](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37639560337); three additional browser-helper regressions bring scanner/configuration tests to 36. |
| [Firefox Horizons](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37653233128)                                                                                                                 | The test expected pre-activation scroll 1,003 px; native activation, saved position and restoration were all 997 px. Compare the native navigation position, retaining the 4 px tolerance, 5-second timeout and native-event assertion. [Focused verification passed](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37654925853).                                                                                                         |
| [Firefox conflict convergence](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37677877437)                                                                                                     | An application loading race retained the previous Action's editable draft under the next route. A deferred-query regression reproduced it. Key detail state by Action ID and show loading until the next record arrives (`5083854`). Subsequent account diagnostics passed both Chromium and Firefox sync journeys.                                                                                                                                          |
| [Large transfer](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37682301094)                                                                                                                   | All 10,002 records reached the server, with no conflicts or failed RPCs, while the client continued durable pull work. Default pull pages now use the existing 500-change protocol cap (`f65da55`); smaller explicit pages remain supported.                                                                                                                                                                                                                 |
| [Foreground responsiveness](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37685344852)                                                                                                        | Upload/pull completed in 108,833/43,262 ms and both clients held 10,003 live records, but upload Capture save took 1,331 ms, exceeding 1,000 ms. This was a genuine failed performance gate.                                                                                                                                                                                                                                                                 |
| [250-operation experiment](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37686776990)                                                                                                         | Smaller upload groups failed the 120-second budget with only 9,250 cloud records. The experiment was rejected; `e7cc6f3` restores 500-operation groups and compacts accepted outbox IDs in one prepared, owner-scoped SQLite statement.                                                                                                                                                                                                                      |
| [Bulk-compaction diagnostic](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37783703358)                                                                                                       | All 10,002 records reached the cloud, but upload still exceeded 120 seconds while finishing pull. Logs and the synthetic screenshot agree. Worker profiling then identified repeated snapshot compression as the dominant local transaction cost; bulk compaction alone was insufficient.                                                                                                                                                                    |

Historical transport/service errors are distinct from the demonstrated parser, test, runner and
runtime failures. A service incident is not used to explain an application exception or a
performance-budget failure.

## Measured snapshot bottleneck

The unchanged bulk-compaction runtime was profiled locally with aggregate worker timing only.
Transaction begin/commit took 19,807/21,451 ms combined, versus 2,314 ms for 40,052 Action reads.
This directed the fix toward compression rather than a speculative change to record reconciliation.
The [investigation measurements](sync-performance-investigation.json) preserve the failed GitHub
outcome and complete local report; environments differ, so they are not a controlled speedup ratio.

`dad7818` retains one compressed image in the SQLite worker, indexed by the exact image's SHA-256
digest and length. Identical images reuse compression; changed images compress afresh. Callers get
independently owned bytes, so retiring a rollback copy cannot detach the cached or durable image.
The cache is cleared on database close/replacement. Hash failure falls back to ordinary compression;
compression failure still rejects. SQLite transactions, IndexedDB durable writes, migrations, owner
scoping, reconciliation, cursor handling, fixture sizes and performance limits remain intact.

Five regressions cover exact-byte bounds, changed images, independent rollback ownership,
retirement, hash failure and propagation of compression failure. The original rollback/recovery
checks remain. Worker timing is test instrumentation only and records no SQL, parameters, planning
content or keys.

## Pull responsiveness follow-up

The
[full run on `dad7818`](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37786565720)
passed repository checks, backend 61/61 and 26 browser stages, then failed sync performance: upload
69,076 ms and pull 30,547 ms converged to 10,003 live records, but pull-side Capture save took 1,323
ms. Upload-side save was 822 ms.

This new evidence requires smaller cold-pull transactions. `1a6142b` keeps first-upload pages at 500
changes and uses 250 by default for normal pulls that may create every received row. The protocol
cap remains 500, explicit smaller pages remain supported, and each page still applies atomically
with its cursor. The existing page-size regression now covers both states and the explicit cap. No
foreground or transfer budget changed.

## Verification

The
[focused diagnostic](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37785958539)
completed successfully on `dad78186755e026a489f7b8f4bdf9cf18ff48aaf`: upload 47,795 ms, pull 21,332
ms, Capture saves 834/828 ms and longest upload main-thread task 137 ms. Both canonical plans
converged to 10,003 live records.
[The complete measured report](sync-performance-ci-37785958539.json) retains all asserted budgets
and worker aggregates.

The
[focused diagnostic on `1a6142b`](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37791163153)
passed with upload 84,789 ms, pull 42,453 ms, Capture saves 834/815 ms and longest upload
main-thread task 229 ms. Both clients held 10,003 live records.
[Its measured report](sync-performance-ci.json) covers the final pull defaults.

The
[complete required CI run](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37791860197)
passed both jobs on `1a6142b3fdb6bceaa142193b3ac9a39e37e8fe7c`: repository checks, backend, all 27
browser suites and six release suites. See [verification](../verification.md) and
[measured results](ci-verification-results.json) for exact counts and metrics. The
[pause report](ci-progress-report.md) is a historical checkpoint, superseded by resumed work.

Manual screen-reader, physical input/OS-notification and hosted deployment observations remain
unperformed. Automated results do not establish stable-release readiness.
