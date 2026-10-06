# Security policy

YelAxis Planner is a beta. There is no promised security response or remediation service level.

## Reporting a vulnerability

Use the repository host's private vulnerability reporting or security advisory feature when it is
available. Otherwise contact the repository owner through an existing private channel to arrange a
reporting route. Do not put exploit details, credentials, private planning content, raw databases or
unredacted exports in public issues.

Include the affected revision/browser, impact, a synthetic reproduction, the ownership or recovery
boundary involved, and a mitigation if known. Review attachments and remove tokens and private data.

## Security boundaries

Issues of particular concern include cross-account access; forged ownership; missing row-level
security or relationship owner checks; silent overwrite or data loss during migration, import, sync,
Undo or deletion; credentials in browser bundles or caches; unvalidated external payloads; planning
content in logs or telemetry; and writes that bypass normal application commands.

SQLite and persistence run in a dedicated worker. A Web Lock permits one active tab per database.
Acknowledged writes include an atomic durable snapshot commit; failures preserve the previous image.
Imports validate before replacement and retain recovery state. These safeguards do not protect
against browser/OS compromise, arbitrary same-origin code, site-data clearing or storage eviction.

Local storage and exports are not encrypted. The service worker caches static application assets
only. Account sessions use site `localStorage`; sessions do not enter SQLite, portable backups,
service-worker caches or diagnostics. Public browser configuration contains only the backend URL and
public client key. Service-role keys, signing material and database passwords belong only in
protected operator/server environments.

## Development and operations

Validate runtime inputs and owner relationships on both sides of sync. Keep stable operation IDs,
base revisions, explicit conflicts, tombstones, a durable outbox and atomic pull checkpoints. Use
synthetic accounts and fixtures. Report dependency findings with the advisory, affected dependency
path and shipped configuration.

The repository includes source/secret scanners, an artifact check, a dependency advisory gate and
browser security journeys. Scans cannot detect every secret representation or unsafe behavior.
Production builds omit source maps and emit a reviewed header policy; an operator must verify that
the chosen host actually enforces it. [Self-hosting](docs/self-hosting.md) and
[release operations](docs/release/operations.md) explain those checks.

Settings provides a deliberate metadata-only support preview and download. It performs no automatic
upload. Read [support and troubleshooting](docs/development.md#troubleshooting) before sharing it.
[Data and privacy](docs/data-and-privacy.md) explains deletion, exports and provider retention.
