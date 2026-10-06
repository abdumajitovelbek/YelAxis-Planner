# Local Supabase and self-hosting

You can run the static planner without accounts, or configure a Supabase-compatible account backend.
No managed production instance is included with the source release. An operator chooses hosting,
auth/email delivery, credentials, costs and retention and verifies the deployed behavior.

## Local account development

Docker and the repository-pinned Supabase CLI are required. The independent local stack is named
`yelaxis-planner` and uses ports **57420–57429**, with API **http://127.0.0.1:57421**. Use only
synthetic accounts and data in this disposable stack.

```sh
pnpm run supabase:start
pnpm run supabase:reset
pnpm run test:backend
```

The first start may download container images. `supabase:reset` clears and rebuilds this local
stack's database from its migrations and seed; use it only for the dedicated disposable development
stack. It is never a hosted upgrade or repair command. `pnpm run supabase:stop` stops this stack.
Check port conflicts instead of stopping or resetting an unrelated stack.

For browser account development, populate the ignored web environment file safely:

```sh
pnpm run supabase:configure-web
pnpm run dev
```

The helper reads the chosen local stack in memory and writes only public client configuration to
`apps/web/.env.local`, without printing key values or full status output. The equivalent public
configuration is:

```dotenv
VITE_YELAXIS_SUPABASE_URL=http://127.0.0.1:57421
VITE_YELAXIS_SUPABASE_ANON_KEY=<the local stack's public client key>
VITE_YELAXIS_RELEASE_TARGET=local
```

Do not print or share the full Supabase status output, which includes privileged credentials. Test
helpers read stack status in memory, pass only the public URL/key to the browser build and retain
privileged cleanup credentials in the Node test process. No service-role key, signing key, database
password or session token belongs in a `VITE_` value.

The backend/browser test helpers accept `YELAXIS_TEST_STACK_WORKDIR=/path/to/local-stack` as an
explicit override for another dedicated disposable local test stack. They validate that its API is
loopback-only. This is for test isolation, not selecting a hosted target or authorizing a reset.
Without it, tests use this repository's local stack.

## Build a static instance

A build with both account values absent stays fully local-only. To expose configured accounts, set
both the backend URL and public client key before building. Hosted targets require HTTPS origins;
custom HTTPS origins for a self-hosted Supabase backend are supported. Public configuration is
embedded in the static artifact and is not a secret store.

```sh
pnpm run build
```

Serve **apps/web/dist** from the origin root, with HTTPS, correct JavaScript/WASM MIME types and SPA
fallback to `index.html`. Subpath hosting is not a supported layout. `pnpm run preview` is for local
artifact inspection, not a production server.

The build emits `_headers`. Configure the host to enforce that reviewed Content Security Policy,
no-framing, no-referrer, nosniff and cache rules; some hosts do not read this file automatically.
Ensure account traffic reaches only the configured backend origin. Preserve static-only
service-worker caching. Verify deep links, offline reload and explicit update activation at the
actual origin.

## Operate an account backend

Use an independent Supabase deployment with PostgreSQL, Auth, REST/gateway services and the database
extensions required by the checked-in migrations, including `pg_jsonschema`. Apply all ordered
`supabase/migrations` through a controlled forward migration process. Do not reset an existing or
hosted database.

The schema includes owner-bound RPC functions, forced RLS, generated document schemas and
relationship owner validation. Preserve these controls; do not replace them with direct client table
access. Use protected server/deployment credentials and expose only the public client configuration.
Set the Auth site URL and exact allowed redirects to your origin. Configure and test confirmation,
password recovery and any SMTP delivery your deployment offers; the local development auth defaults
are not a production email configuration.

Before admitting real accounts, verify synthetic cross-owner reads/writes and links, malformed
payloads, idempotent push, pull cursor recovery, two-client offline conflicts, sign-out/device
removal, export and account deletion. Local tests do not establish that a particular deployed server
has the same schema, policies or configuration.

## Retention and updates

Publish your actual account data, sync history, logs and backup retention. Account deletion removes
active owner records and authentication through the application protocol; it does not promise
instant provider-backup erasure or remove files and offline copies elsewhere. Do not assume the
local stack's lack of scheduled backups describes a hosted provider.

Keep a compatible previous artifact, migration/storage compatibility report and backup/recovery
procedure. Prefer a forward fix when an older artifact cannot read current data. See
[release operations](release/operations.md), [security](../SECURITY.md) and
[verification limits](verification.md). This guide provisions nothing and establishes no production
service, price, region or retention commitment.
