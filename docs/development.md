# Development, testing and troubleshooting

Use the versions declared in [package.json](../package.json) and the frozen lockfile. From the
repository root:

```sh
pnpm install --frozen-lockfile
pnpm run dev
```

`pnpm run build` creates `apps/web/dist`; `pnpm run preview` serves that artifact locally. No
backend is needed for local-only development. Use a disposable browser profile and a consistent
origin for synthetic plans. [Local account setup](self-hosting.md#local-account-development) adds
Docker and Supabase when needed.

## Common changes

| Change                     | Start here                                             | Preserve and verify                                                                      |
| -------------------------- | ------------------------------------------------------ | ---------------------------------------------------------------------------------------- |
| Route, form or interaction | `apps/web/src` and the feature's use-case façade       | Input validation, loading/empty/error states, focus, keyboard and query reload           |
| Business rule              | `packages/domain`                                      | Pure deterministic rule tests before behavior; no runtime imports                        |
| Multi-record command       | `packages/application`                                 | One local transaction, revisions, events, receipt, Undo and required outbox              |
| Query/projection           | `packages/data`                                        | Owner-scoped prepared SQL, stable keyset pages, complete totals and query-plan indexes   |
| Persisted schema           | `packages/data` migrations/codecs                      | New ordered migration, immutable applied checksums, old-version fixture, rollback/reopen |
| Account protocol           | `packages/sync`, application sync ports and `supabase` | Base snapshots, idempotency, RLS, both endpoint owners, conflicts, tombstones and cursor |
| User-facing text           | `packages/i18n` and feature message calls              | Stable IDs, exact placeholders, English fallback, expanded/RTL layout                    |
| Theme or motion            | `packages/ui` and feature CSS                          | Both themes, contrast, non-color states, visible focus and reduced motion                |
| Portable format            | Application exports/imports and record codecs          | Versioning, bounded decoder, graph preview, digest, old fixtures and recovery            |

The [architecture](architecture.md) explains package ownership and write flow. Read the relevant
[contracts](README.md#stable-contracts) and [decision](decisions/README.md) before changing a
boundary. There is no need to invent a separate store or extension framework for ordinary feature
work.

## Testing

Run the focused package or feature suite first. For example:

```sh
pnpm --filter @yelaxis/domain run test
pnpm --filter @yelaxis/web run test
pnpm --filter @yelaxis/web run test:today
```

The repository gate is:

```sh
pnpm run check
```

It runs documentation/product/source/secret policy, formatting, lint, types and workspace tests. For
browser/backend verification, install the Playwright-managed targets:

```sh
pnpm --filter web exec playwright-core install chromium firefox
```

Install the browser OS libraries required by your distribution if launch reports missing libraries.
Managed Chromium/Firefox are the default. `CHROMIUM_EXECUTABLE_PATH` can select a compatible
installed Chromium executable explicitly; record the version because results depend on it.

```sh
pnpm run test:backend
pnpm run web:verify
pnpm run release:verify
```

Backend checks need the dedicated disposable local stack. `web:verify` includes backend,
both-browser feature journeys, offline/restart/PWA coverage and performance suites. Feature browser
scripts can be selected through their `apps/web/package.json` command; several build a production
artifact first. Account journeys build with the stack's public configuration.

`release:verify` builds and checks the artifact/dependencies, then Chromium/Firefox accessibility,
performance and security/update journeys. Process-tree RSS performance profiling currently requires
Linux. Firefox lacks the Chrome heap/LongTasks APIs, so unavailable metrics remain unavailable. Some
headless/CI environments need explicit browser dependencies and permitted sandbox settings. Do not
treat unsupported profiling as a passed budget.

A complete result records the exact tree/revision, command, exit status, browser/runtime, timing and
safe artifact/report metadata. Use synthetic fixtures; do not attach private plans or environment
output. Broaden tests when new failures or changes justify it. Manual reader, physical input/zoom,
OS notification and hosted deployment observations are separate from automation; see
[verification](verification.md).

## Troubleshooting

| Symptom                                        | Safe next step                                                                                                                               |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Account unavailable                            | A local-only build needs no account config. To develop sync, configure both public values and rebuild.                                       |
| Database busy                                  | Close the other tab using this plan, wait for ownership to release and retry. Do not steal the lock or clear storage.                        |
| Storage denied or quota failure                | Preserve the profile and latest independent backup, close unused contexts and retry. Do not reset site data.                                 |
| Migration/corruption error                     | Keep the original image and error metadata; use a compatible build or forward repair. Never delete/recreate the database to bypass it.       |
| Import cannot apply                            | Read the preview/error, resolve graph conflicts, rebuild a stale preview or resume/discard staging. The existing plan remains authoritative. |
| Queued offline / server unavailable            | Continue locally, restore connectivity and retry/Sync now. Export before device removal or sign-out with pending work.                       |
| Needs attention / conflict                     | Review rejected work or explicit conflicts; do not choose by timestamps or delete the outbox.                                                |
| Reminder not displayed by OS                   | Check open-app state, permission, generic/title preference and OS settings. Missed entries recover internally after reopen.                  |
| Backend gate cannot find stack                 | Start the dedicated local stack, check its ports and explicit local override. Never reset or stop unrelated stacks.                          |
| Browser launch failure                         | Install managed browsers and OS libraries; inspect the safe error and executable/version override.                                           |
| Offline/PWA behaves differently in development | Build and preview the production artifact; use the same origin and wait for static caching.                                                  |
| Old artifact cannot open newer storage         | Use a compatible reader or forward fix. Do not downgrade migrations or reset IndexedDB.                                                      |

Settings offers **Preview support information**, then **Download support information**. Review it
before sharing. The allowlist contains build/browser-family and capability/permission/online
metadata, with no plan/account/profile, IDs, routes, URLs, storage content, raw errors or tokens.
Nothing uploads automatically. Public bug reports should include only a synthetic reproduction;
sensitive findings follow [SECURITY.md](../SECURITY.md).
