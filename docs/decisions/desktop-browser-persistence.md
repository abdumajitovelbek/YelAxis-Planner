# Desktop browser persistence

**Status: implemented decision.**

The product is a desktop website and installable Chromium PWA, with Firefox website support. React,
semantic HTML, TypeScript, Vite and a static service worker provide one application rather than a
separate installed planning model.

SQLite stays canonical. `wa-sqlite` runs in a dedicated worker and saves complete images atomically
to IndexedDB. This preserves relational constraints, migrations and application transactions across
the supported browser targets. A Web Lock allows one active tab; a competing tab fails safely.

Whole-image persistence has size-dependent write and memory costs. Streaming gzip snapshots, bounded
hashing and retirement of private settled buffers reduce those costs without weakening
acknowledgement or rollback. Legacy formats remain readable. Browser storage is best effort and
unencrypted, so independent portable backups remain necessary.

The service worker caches static assets only, and updates require explicit activation. See
[storage](../contracts/storage-and-migrations.md) and [operations](../release/operations.md) for
compatibility and recovery rules.
