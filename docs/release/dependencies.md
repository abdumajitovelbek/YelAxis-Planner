# Dependencies and third-party notices

The [dependency inventory](dependency-inventory.json) lists production and development dependency
licenses and their notice digests. [Original notices](../../apps/web/public/third-party-notices.txt)
retain upstream attribution and license text. Those dependencies retain their own terms. YelAxis
Planner uses [Apache-2.0](../../LICENSE).

Keep notices intact when updating or redistributing dependencies. Review the locked dependency tree,
refresh the inventory/notices when packages change, then run the advisory and full applicable gates.
The dependency gate rejects every reported advisory, including build/test dependencies; no exception
is currently defined. A past clean audit does not establish that a changed lockfile or later audit
is clean.

The inventory includes build tools/data with MPL-2.0, CC-BY-4.0 and Python-2.0 terms in addition to
common permissive licenses. Preserve their notices and attribution. Some developer/native tooling
supplies license metadata without a complete installed notice; obtain upstream notices before
redistributing that tooling as an artifact. The static web distribution and source dependency
metadata are different distribution scopes.

[Public verification](../verification.md) records final results for the prepared tree. Review new
dependencies for runtime privacy effects as well as advisories and license terms.
