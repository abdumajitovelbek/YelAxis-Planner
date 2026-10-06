# YelAxis Planner contributor instructions

The active product is a standalone desktop website and installable PWA with optional accounts and
synchronization.

- Preserve manual offline planning, explicit user choices, owner isolation and data integrity.
- SQLite is the canonical plan. Routes render queries and invoke application use cases. The
  application owns atomic writes, minimized events, undo, receipts and outbox work. Domain code is
  pure; adapters depend inward.
- SQL and durable browser storage run in the dedicated worker. One active tab owns each database
  through a Web Lock. Browser persistence is best effort; never promise encryption or permanent
  retention.
- Preserve ordered migrations and compatibility with existing databases. Never reset user data to
  repair migration or import failures. Archive by default; permanent deletion is explicit and
  confirmed.
- Service-worker caches contain only static assets, never planning data, credentials, API responses
  or imported/exported files.
- Validate forms, imports, deep links and sync payloads. Relationships and placements remain
  explicit and typed. Recurring Actions use the Routine/Occurrence engine.
- Target WCAG 2.2 AA. Verify keyboard use, focus, semantics, both themes, contrast, reflow and
  reduced motion; distinguish automated checks from actual screen-reader and OS observations.
- Use synthetic accounts and data. Keep secrets and private content out of source, logs, fixtures
  and screenshots. Do not print process environments or container credentials.
- Preserve unrelated changes. Run focused checks, then repository and applicable
  browser/backend/release gates. Record measured results and limitations accurately.
- Keep public documentation feature-based and consistent with the implemented product. Respect
  original attribution and third-party licenses.
- Production resources, secret handling, retention changes, telemetry and public deployment need
  explicit authorization. Repository publication must satisfy the owner's approved license and
  verification requirements.
