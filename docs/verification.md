# Verification and known limits

This beta source release distinguishes implemented safeguards, automated evidence and observations
that have not been performed. The presence of tests is not a claim that a particular public revision
passed them.

## Public verification record

Final local verification completed on 2026-10-07 against the runtime tree delivered at
`83f58504f43967b01ce64ac331b31c34d130c7d4`. The repository, browser and release gates retain their
actual revisions (`4205274`, `c018646` and `83f5850`) in
[publication-verification.json](release/publication-verification.json); intervening changes affect
browser launch and CI configuration only. Exact exits, UTC times, suite reports, artifact digests
and measured bounds are recorded there. The initial beta snapshot's completed measurements remain
available in [verification-results.json](release/verification-results.json).

Environment: Linux x86_64, Node 24.20.0, pnpm 11.9.0, Playwright 1.62.0, Chromium 151.0.7922.34 and
Firefox 153.0. Tests use managed headless browsers; notification permission checks use full managed
Chromium. The independent `yelaxis-planner` backend uses API port 57421 and synthetic data. Physical
and hosted observations below remain unperformed.

| Check                                            | Completed result                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Fresh checkout, frozen install, production build | Exit 0; no environment file or private account needed                                                               |
| `pnpm run dev` and `pnpm run preview`            | Local onboarding, acknowledged Action and reload passed; preview reopened offline; zero browser errors              |
| `pnpm run check`                                 | Exit 0; 213 files / 3,079 workspace tests and 33 scanner/configuration tests; policy, format, lint and types passed |
| `pnpm run web:verify`                            | Exit 0; 27 browser suites and backend 6 files / 61 tests                                                            |
| `pnpm run release:verify`                        | Exit 0; build/artifact/audit plus six Chromium/Firefox accessibility, performance and security suites               |
| Artifact and dependency checks                   | Zero source-boundary findings, private-secret patterns, source maps and reported dependency advisories              |
| Compatibility and attribution                    | All 19 SQLite migration objects preserved exactly; original dependency notice bodies and inventory preserved        |

All required stages finished; an unfinished log is not counted as success. The browser set covers
connectivity, persistence, onboarding, Actions, horizons, PWA, alignment, Today/Focus, Reviews,
Search, notifications, sync and portable recovery. The full final browser run supersedes the earlier
partial runs.

### Measured release performance

Times are milliseconds; RSS is bytes for the owned browser process tree, including workers.

| Browser  | First full-check render | Warm Today | Offline cold render | Worst of 48 navigations | Peak owned RSS |
| -------- | ----------------------- | ---------- | ------------------- | ----------------------- | -------------- |
| chromium | 1411.3                  | 866.3      | 890.2               | 859.5                   | 975355904      |
| firefox  | 3972.9                  | 1972       | 1975.6              | 1967.1                  | 1402490880     |

Unchanged bounds: first/offline cold 5,000 ms; warm/reopen/navigation 2,500 ms; query 300 ms;
acknowledged write 1,500 ms; eight queued writes 12,000 ms; heartbeat gap 100 ms; main-thread
LongTask 250 ms; retained growth 64 MiB; Chromium JS/backing 256 MiB; owned RSS 1,536 MiB. The full
reports retain every asserted metric, fixture count, index plan, final durable count and memory
sample. Firefox's heap/LongTasks metrics are unavailable, not passes.

### Demonstrated failures corrected

- A service-worker reload reset the test browser's navigator signal while requests stayed blocked.
  The harness now maintains explicit synthetic connectivity, and a two-browser regression verifies
  genuinely blocked uncached traffic, Chromium offline reload and online recovery.
- Headless Shell exposed notification denial while the browser permission state was prompt. The
  permission suite now uses full managed Chromium and passes native denial/grant; notification
  display remains a labeled API double rather than an OS observation.
- Default builds omitted optional Git metadata, disabling exact-image health reuse. Firefox warm
  Today repeatedly exceeded 2,500 ms (2,952.3 and 2,938.3 ms). Production now derives its policy
  from actual runtime/build inputs; development still checks fully. The final warm measurement is
  1,972 ms. Integrity, foreign-key, byte/engine/policy checks and fixture sizes are retained.

### Repository and CI hardening

The final local repository gate on `420527453cd7a0157fa4862675f9be8476cccd80` completed with exit 0:
**213 files / 3,079 workspace tests and 33 scanner/configuration tests**. The dedicated backend
diagnostic on the same revision completed **6 files / 61 tests**, including catalog and RLS
assertions, and stopped its disposable stack. Its
[completed run](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37639560337) is
separate from the full CI gate.

Concrete verification failures were corrected without changing product rules or test bounds:

- The dense Today query fixture seeded over 3,000 individual autocommits and exceeded the hosted
  runner's test timeout. The identical rows now use one setup transaction; cardinality, ownership,
  query assertions and the original timeout are retained.
- The Ubuntu runner's Firefox reported an enabled, visible completion button but delivered no
  trusted pointer event. The pinned Playwright image completed the same journey and native-click
  assertion. Full CI now uses that image and its matching OS libraries.
- The container needed the Docker client as well as the job's daemon socket to operate its own
  disposable backend. Its mounted `/tmp` now retains standard writable sticky-directory permissions,
  preventing Chromium renderer crashes during service-worker startup. Lifecycle failures now expose
  fixed diagnostic codes while discarding credential-bearing CLI output.
- Catalog verification relied on ambient CLI formatting and removed the opening bracket of JSON row
  arrays. It now selects explicit query JSON, disables ambient agent detection and validates
  complete row arrays or envelopes. Three regressions preserve typed/empty results and reject
  malformed output; all 61 real-backend tests pass.

At delivery, the
[full CI run](https://github.com/abdumajitovelbek/YelAxis-Planner/actions/runs/37643421585) has
completed workspace checks successfully; its browser/release job remains unfinished. GitHub reported
a [major Actions incident](https://www.githubstatus.com/incidents/djlmxz2zd0j7) during this run. No
full cloud-browser or cloud-release pass is claimed. Completed focused Firefox, connectivity and
backend diagnostics establish the corrected runner setup; the complete local gates above are green.
If the existing job does not finish after service recovery, rerun this CI revision. The observed
delivery status is recorded in [ci-delivery-status.json](release/ci-delivery-status.json).

## What the automated suites cover

The repository has domain, application, SQLite/worker, UI, scanner and real-backend tests. Browser
journeys exercise onboarding, Actions, planning horizons, alignment, Today/Focus, Reviews, accounts,
sync, Search, notifications, portable files, persistence, restart and PWA updates in Chromium and
Firefox. Synthetic performance fixtures cover large plans, dense visible lists, long intervals,
write acknowledgement, reopen, repeated navigation, outbox transfer and exact convergence.

Security checks cover owner isolation/RLS, malformed payloads, idempotency, tombstones, public build
configuration, dependency advisories, artifact contents, static-only cache behavior and compatible
shell update/reversal. Migration tests exercise rollback and reopening at each stored version.
Accessibility suites inspect names, roles, keyboard paths, focus, validation, themes, contrast,
expanded text, reflow and reduced motion. See [testing](development.md#testing) for commands.

## Unperformed observations and limits

These are honest limits of the available evidence, not a claim that beta source publication requires
production hosting:

- Spoken screen-reader output on real reader/OS combinations has not been recorded.
- Physical mouse/trackpad parity, browser zoom, sleep/resume and OS lock-screen notification
  presentation have not been recorded. Automated DOM/text/reflow checks provide partial evidence.
- Physical disk pressure, canceled/denied OS file destinations and real beta timing/usability have
  not been measured. Starting a browser download does not prove a file was saved.
- No hosted deployment has been verified. HTTPS/headers, hosted auth/email/recovery/RLS, backup/log
  retention and operational rollback need checks by whoever operates an instance.
- Firefox heap/LongTasks APIs are unavailable; process RSS does not replace those measurements.
- Performance on large synthetic fixtures is specific to its recorded environment. It is not a
  universal hardware or storage guarantee.

Browser storage remains best effort and unencrypted; reminders require the app to be open. A
rollback needs a reader compatible with the current migrations, IndexedDB version and compressed
snapshot format. Use a forward fix when compatibility is uncertain; never reset user data.

## Reproducible human checks

Use a disposable profile and synthetic plan, then record actual environment and results:

| Journey                                               | Observe                                                                                             |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Setup → capture → plan → Today                        | Useful first plan, understandable defaults and actual elapsed time                                  |
| Keyboard and screen reader                            | Names/roles/states/errors, dialog focus, conflict choices, Search, review, import and account flows |
| Both themes and 200%/400% zoom                        | Readable content, visible focus, targets, color-independent state and reflow                        |
| Mouse and physical trackpad                           | Same create/move/reorder/archive/Undo effects as keyboard alternatives                              |
| Open-app reminder, denial and reopen                  | Generic privacy, explicit title opt-in, actual OS behavior and deduplication                        |
| Sleep/resume, background and day rollover             | No automatic completion; Today refreshes and Focus resets on exit/reload                            |
| Canceled download, safe test-volume quota and restore | Prior plan survives; errors are truthful; backup file existence is confirmed                        |
| A real planning/review/backup loop                    | Interruptions, confusion, failures and support route with no private content                        |

An unperformed or unsupported observation stays unperformed. Report failures with a synthetic
reproduction through the issue template, or privately under [SECURITY.md](../SECURITY.md) when
sensitive.
