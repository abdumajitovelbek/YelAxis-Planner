# Verification and known limits

This beta source release distinguishes implemented safeguards, automated evidence and observations
that have not been performed. The presence of tests is not a claim that a particular public revision
passed them.

## Public verification record

Final checks of the prepared public tree and a clean-clone quickstart are pending. Record completed
commands, revision/artifact, UTC timing, environment and results here after they finish. Use
synthetic data and redact credentials. Screenshots illustrate the product; they do not substitute
for gate results or manual accessibility observations.

| Check                                                | Public result |
| ---------------------------------------------------- | ------------- |
| Frozen install and quickstart from a clean clone     | Pending       |
| Focused tests and `pnpm run check`                   | Pending       |
| Browser and backend verification                     | Pending       |
| Build, artifact, dependency and release verification | Pending       |

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
