# Verification and known limits

This beta source release distinguishes implemented safeguards, automated evidence and observations
that have not been performed. The presence of tests is not a claim that a particular public revision
passed them.

## Public verification record

Completed on 2026-10-07 against public code `8c8dd383af9a5f936d1768b7e0693ba0a3dc2b89`. The
subsequent evidence and report-label changes leave application, dependency, database and build
inputs unchanged. Exact UTC starts/finishes, exits, package counts, per-suite reports, artifact file
digests and measured bounds are in [verification-results.json](release/verification-results.json).

Environment: Linux x86_64, Node 24.20.0, pnpm 11.9.0, Playwright 1.62.0, Chromium 151.0.7922.34 and
Firefox 153.0. Tests use managed headless browsers; notification permission checks use full managed
Chromium. The independent `yelaxis-planner` backend uses API port 57421 and synthetic data. Physical
and hosted observations below remain unperformed.

| Check                                            | Completed result                                                                                                    |
| ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------- |
| Fresh checkout, frozen install, production build | Exit 0; no environment file or private account needed                                                               |
| `pnpm run dev` and `pnpm run preview`            | Local onboarding, acknowledged Action and reload passed; preview reopened offline; zero browser errors              |
| `pnpm run check`                                 | Exit 0; 212 files / 3,076 workspace tests and 32 scanner/configuration tests; policy, format, lint and types passed |
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
| chromium | 1425.1                  | 874.1      | 890                 | 852.1                   | 957919232      |
| firefox  | 3972.8                  | 1937.7     | 2013.5              | 1967.3                  | 1445666816     |

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
  1,937.7 ms. Integrity, foreign-key, byte/engine/policy checks and fixture sizes are retained.

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
