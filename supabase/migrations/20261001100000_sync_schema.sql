-- Cloud replica schema with ownership checks and explicit conflicts.
--
-- The cloud holds an owner-scoped replica of canonical record documents, an append-only change
-- log, idempotency receipts, conflict candidates, replicas, and the account deletion ledger. The
-- schema is not exposed through the Data API. Clients have no privilege on any table: every read
-- and write goes through the `public` functions in the next migration, which run the work as the
-- `yelaxis_sync_api` role. That role has no BYPASSRLS, so the owner policies below bind every row
-- it touches to `auth.uid()` even inside the functions.

create extension if not exists pg_jsonschema with schema extensions;

create schema if not exists yelaxis_sync;

revoke all on schema yelaxis_sync from public, anon, authenticated, service_role;

do $$
begin
  if not exists (select 1 from pg_catalog.pg_roles where rolname = 'yelaxis_sync_api') then
    create role yelaxis_sync_api nologin noinherit nobypassrls;
  end if;
end
$$;

-- `postgres` may hand function ownership to the role (it needs SET), but never inherits from it.
grant yelaxis_sync_api to postgres with inherit false, set true;

alter default privileges in schema yelaxis_sync revoke all on tables from public;
alter default privileges in schema yelaxis_sync revoke all on sequences from public;
alter default privileges in schema yelaxis_sync revoke all on functions from public;
alter default privileges in schema yelaxis_sync revoke all on types from public;

-- The canonical entity types that replicate (`syncEntityTypes` in packages/sync/src/protocol.ts).
create domain yelaxis_sync.entity_type as text
  check (
    value in (
      'profile', 'axis', 'outcome', 'milestone', 'project', 'action', 'note', 'commitment',
      'time_block', 'routine', 'routine_occurrence', 'routine_action_defaults', 'template',
      'review', 'review_item', 'reminder', 'context', 'constraint', 'planning_placement',
      'focus_selection', 'theme', 'direction', 'project_secondary_outcome', 'milestone_project',
      'milestone_action'
    )
  );

/* ───────────────────────── Contract tables (no owner) ───────────────────────── */

-- JSON Schema of each entity type's document, generated from the record codecs.
create table yelaxis_sync.document_schemas (
  entity_type yelaxis_sync.entity_type primary key,
  json_schema jsonb not null check (pg_catalog.jsonb_typeof(json_schema) = 'object')
);

-- Every id-valued document field and the entity type it names. `enforced` rows mirror the SQLite
-- foreign keys: the target must exist for the same owner, and a referenced target cannot be
-- deleted.
create table yelaxis_sync.reference_map (
  entity_type yelaxis_sync.entity_type not null,
  field_path text[] not null check (pg_catalog.cardinality(field_path) between 1 and 8),
  target_entity_type yelaxis_sync.entity_type not null,
  when_path text[],
  when_value text,
  enforced boolean not null,
  primary key (entity_type, field_path, target_entity_type),
  check ((when_path is null) = (when_value is null))
);

/* ───────────────────────── Owner tables ───────────────────────── */

-- The current server state of every record: a document, or a content-cleared tombstone. A
-- tombstone is never removed, so a deleted id can never be created again.
create table yelaxis_sync.records (
  owner_id uuid not null references auth.users (id) on delete cascade,
  entity_type yelaxis_sync.entity_type not null,
  entity_id uuid not null,
  server_revision bigint not null check (server_revision >= 1),
  document jsonb check (document is null or pg_catalog.jsonb_typeof(document) = 'object'),
  deleted_at timestamptz,
  -- `change_log.seq` of the latest accepted change to this record; pull pages by it.
  last_seq bigint not null check (last_seq >= 1),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  primary key (owner_id, entity_type, entity_id),
  check ((document is null) = (deleted_at is not null))
);

create index records_owner_last_seq on yelaxis_sync.records (owner_id, last_seq);
-- Finds live documents that still name a record before it is deleted.
create index records_document_paths on yelaxis_sync.records using gin (document jsonb_path_ops);

-- Append-only: one row per accepted change. `seq` is the opaque, monotonic pull cursor.
create table yelaxis_sync.change_log (
  seq bigint generated always as identity primary key,
  owner_id uuid not null references auth.users (id) on delete cascade,
  entity_type yelaxis_sync.entity_type not null,
  entity_id uuid not null,
  server_revision bigint not null check (server_revision >= 1),
  change_kind text not null check (change_kind in ('create', 'update', 'restore', 'delete')),
  mutation_group_id uuid not null,
  operation_id uuid not null,
  replica_id uuid not null,
  created_at timestamptz not null default pg_catalog.now()
);

create index change_log_owner_seq on yelaxis_sync.change_log (owner_id, seq);

create function yelaxis_sync.reject_change_log_update()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception using errcode = '55000', message = 'change_log_is_append_only';
end;
$$;

revoke all on function yelaxis_sync.reject_change_log_update() from public;

create trigger change_log_append_only
before update on yelaxis_sync.change_log
for each row execute function yelaxis_sync.reject_change_log_update();

-- The stored acknowledgment of every accepted operation, keyed by its idempotency id.
create table yelaxis_sync.idempotency_receipts (
  owner_id uuid not null references auth.users (id) on delete cascade,
  operation_id uuid not null,
  mutation_group_id uuid not null,
  sequence integer not null check (sequence between 0 and 499),
  entity_type yelaxis_sync.entity_type not null,
  entity_id uuid not null,
  operation_kind text not null check (operation_kind in ('create', 'update', 'delete')),
  -- Hash of the pushed document, so a reused operation id with other content is refused.
  document_hash text,
  acknowledgment jsonb not null,
  group_cursor bigint not null check (group_cursor >= 0),
  created_at timestamptz not null default pg_catalog.now(),
  primary key (owner_id, operation_id)
);

create index idempotency_receipts_group
  on yelaxis_sync.idempotency_receipts (owner_id, mutation_group_id, sequence);

-- Owner-scoped conflict candidates kept until the person resolves them. Candidate documents are
-- cleared when a conflict is resolved or superseded; only metadata remains.
create table yelaxis_sync.conflicts (
  conflict_id uuid primary key default pg_catalog.gen_random_uuid(),
  owner_id uuid not null references auth.users (id) on delete cascade,
  entity_type yelaxis_sync.entity_type not null,
  entity_id uuid not null,
  conflict_kind text not null check (
    conflict_kind in ('stale_base', 'edit_versus_delete', 'delete_versus_edit', 'create_collision')
  ),
  operation_id uuid not null,
  blocked_mutation_group_id uuid not null,
  base_server_revision bigint not null check (base_server_revision >= 0),
  local_deleted boolean not null,
  local_document jsonb,
  remote_server_revision bigint not null check (remote_server_revision >= 0),
  remote_deleted boolean not null,
  remote_document jsonb,
  state text not null default 'open' check (state in ('open', 'resolved', 'superseded')),
  resolution text check (
    resolution in ('keep_local', 'keep_remote', 'merge', 'keep_deleted', 'restore_edited')
  ),
  created_at timestamptz not null default pg_catalog.now(),
  updated_at timestamptz not null default pg_catalog.now(),
  closed_at timestamptz,
  check ((state = 'resolved') = (resolution is not null)),
  check ((state = 'open') = (closed_at is null)),
  check (state = 'open' or (local_document is null and remote_document is null))
);

create unique index conflicts_open_operation
  on yelaxis_sync.conflicts (owner_id, operation_id)
  where state = 'open';
create index conflicts_owner_state on yelaxis_sync.conflicts (owner_id, state, created_at);

-- Replicas seen for each owner (a replica id is never a credential).
create table yelaxis_sync.replicas (
  owner_id uuid not null references auth.users (id) on delete cascade,
  replica_id uuid not null,
  first_seen_at timestamptz not null default pg_catalog.now(),
  last_push_at timestamptz,
  last_pull_at timestamptz,
  last_pulled_cursor bigint check (last_pulled_cursor >= 0),
  primary key (owner_id, replica_id)
);

-- One row per deleted account. It deliberately outlives the auth user (no foreign key), so a
-- still-valid session or a queued push can never recreate data for that owner.
create table yelaxis_sync.account_deletions (
  owner_id uuid primary key,
  requested_at timestamptz not null default pg_catalog.now(),
  completed_at timestamptz
);

/* ───────────────────────── Row level security ───────────────────────── */

alter table yelaxis_sync.document_schemas enable row level security;
alter table yelaxis_sync.document_schemas force row level security;
alter table yelaxis_sync.reference_map enable row level security;
alter table yelaxis_sync.reference_map force row level security;
alter table yelaxis_sync.records enable row level security;
alter table yelaxis_sync.records force row level security;
alter table yelaxis_sync.change_log enable row level security;
alter table yelaxis_sync.change_log force row level security;
alter table yelaxis_sync.idempotency_receipts enable row level security;
alter table yelaxis_sync.idempotency_receipts force row level security;
alter table yelaxis_sync.conflicts enable row level security;
alter table yelaxis_sync.conflicts force row level security;
alter table yelaxis_sync.replicas enable row level security;
alter table yelaxis_sync.replicas force row level security;
alter table yelaxis_sync.account_deletions enable row level security;
alter table yelaxis_sync.account_deletions force row level security;

revoke all on all tables in schema yelaxis_sync from public, anon, authenticated, service_role;
revoke all on all sequences in schema yelaxis_sync from public, anon, authenticated, service_role;

-- The authenticated subject, read through `auth.uid()` (the API role has no access to `auth`).
create function yelaxis_sync.request_owner()
returns uuid
language sql
stable
security definer
set search_path = ''
as $$
  select auth.uid();
$$;

revoke all on function yelaxis_sync.request_owner() from public, anon, authenticated, service_role;

grant usage on schema yelaxis_sync to yelaxis_sync_api;
grant usage on schema extensions to yelaxis_sync_api;
grant execute on function yelaxis_sync.request_owner() to yelaxis_sync_api;

grant select on yelaxis_sync.document_schemas, yelaxis_sync.reference_map to yelaxis_sync_api;
grant select, insert, update, delete on yelaxis_sync.records to yelaxis_sync_api;
grant select, insert, delete on yelaxis_sync.change_log to yelaxis_sync_api;
grant usage on sequence yelaxis_sync.change_log_seq_seq to yelaxis_sync_api;
grant select, insert, delete on yelaxis_sync.idempotency_receipts to yelaxis_sync_api;
grant select, insert, update, delete on yelaxis_sync.conflicts to yelaxis_sync_api;
grant select, insert, update, delete on yelaxis_sync.replicas to yelaxis_sync_api;
grant select, insert, update on yelaxis_sync.account_deletions to yelaxis_sync_api;

create policy document_schemas_read on yelaxis_sync.document_schemas
  for select to yelaxis_sync_api using (true);
create policy reference_map_read on yelaxis_sync.reference_map
  for select to yelaxis_sync_api using (true);

create policy records_owner on yelaxis_sync.records
  for all to yelaxis_sync_api
  using (owner_id = (select yelaxis_sync.request_owner()))
  with check (owner_id = (select yelaxis_sync.request_owner()));
create policy change_log_owner on yelaxis_sync.change_log
  for all to yelaxis_sync_api
  using (owner_id = (select yelaxis_sync.request_owner()))
  with check (owner_id = (select yelaxis_sync.request_owner()));
create policy idempotency_receipts_owner on yelaxis_sync.idempotency_receipts
  for all to yelaxis_sync_api
  using (owner_id = (select yelaxis_sync.request_owner()))
  with check (owner_id = (select yelaxis_sync.request_owner()));
create policy conflicts_owner on yelaxis_sync.conflicts
  for all to yelaxis_sync_api
  using (owner_id = (select yelaxis_sync.request_owner()))
  with check (owner_id = (select yelaxis_sync.request_owner()));
create policy replicas_owner on yelaxis_sync.replicas
  for all to yelaxis_sync_api
  using (owner_id = (select yelaxis_sync.request_owner()))
  with check (owner_id = (select yelaxis_sync.request_owner()));
create policy account_deletions_owner on yelaxis_sync.account_deletions
  for all to yelaxis_sync_api
  using (owner_id = (select yelaxis_sync.request_owner()))
  with check (owner_id = (select yelaxis_sync.request_owner()));
