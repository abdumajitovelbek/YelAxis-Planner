# Contributing to YelAxis Planner

Small fixes, reproducible bug reports, accessibility feedback and documentation improvements are
welcome. The project uses [Apache-2.0](LICENSE); preserve project and third-party attribution.
Discuss substantial product or architecture changes before implementation.

Read [AGENTS.md](AGENTS.md), the [architecture](docs/architecture.md), and the
[relevant decisions](docs/decisions/README.md). The [development guide](docs/development.md) covers
setup, common changes and checks.

## Before changing code

Inspect the branch, working tree, lockfile and existing tests. Preserve unrelated work. Describe the
user-visible outcome, rules that must hold, data impact and evidence that will demonstrate the
result. Keep each change small enough to review end to end.

Use existing package owners. Routes render queries and invoke application use cases; the application
owns writes and transactions; the domain stays pure. SQLite is the canonical plan. SQL and durable
browser storage run in the worker. Do not add a parallel client store or persistence path.

Add domain tests before changing business rules and migration tests before changing persisted
schema. Applied migrations and checksums are immutable. Validate forms, imports, deep links and sync
payloads before writes. Document decisions that change product rules or architectural boundaries.

## Product and privacy

Preserve manual offline planning, explicit user decisions, owner isolation and recoverable errors.
Do not silently rank, schedule, complete or resolve planning work. Keep archive as the normal
removal path and permanent deletion explicit and conservative.

Use synthetic fixtures and disposable browser profiles. Keep planning content, credentials, tokens
and private exports out of source, logs, issues and screenshots. Do not promise permanent browser
retention or encryption. Changes involving production resources, telemetry, credential handling or
retention need the owner's explicit authorization.

## Verification and pull requests

Run focused checks first, then:

```sh
pnpm run check
```

Run applicable browser/backend checks for runtime, data, sync or PWA changes. Release changes also
need `pnpm run release:verify`. [Testing guidance](docs/development.md#testing) explains
prerequisites and suite selection. Record commands that actually finished, their results and any
unperformed observations; do not infer a pass from compilation or an unfinished process.

UI changes need keyboard and non-pointer paths, logical visible focus, labels/roles/errors, both
themes, contrast, color-independent state, text reflow and reduced motion. Distinguish DOM
assertions from spoken screen-reader output and physical input/OS observations.

Describe what changed, why, how it was tested, and any data or compatibility consequences. Update
relevant guides/contracts and [verification evidence](docs/verification.md) with measured facts
only. Keep third-party notices intact. Do not commit secrets, publish artifacts, deploy, provision
resources or merge on behalf of the owner without authorization.
