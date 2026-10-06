-- Account and synchronization functions; protocol shapes live in packages/sync/src/protocol.ts.
--
-- Clients call only the six `public` functions: `sync_push`, `sync_pull`, `sync_open_conflicts`,
-- `sync_close_conflict`, `account_status`, and `account_delete`. Each is SECURITY DEFINER with an
-- empty search path, executable by `authenticated` only, and fails closed without an
-- authenticated subject. Each delegates to an implementation in `yelaxis_sync` owned by
-- `yelaxis_sync_api`, so the owner policies apply to every statement. Responses use the exact
-- camelCase shapes of the protocol; nothing here logs or returns planning content except the
-- caller's own documents.
--
-- Errors (HTTP status through PostgREST):
-- 42501 not_authenticated no subject (401 for anon without EXECUTE, 403 otherwise)
-- 22023 invalid_payload a malformed pull or close request, or a push without a valid
-- `mutationGroupId` (400); every other push failure is a structured
-- `rejected` response
-- PT404 conflict_not_found closing a conflict this owner does not have (404)

/* ───────────────────────── Pure helpers ───────────────────────── */

-- The protocol's id form: lowercase, RFC 4122 version 1-8, variant 8-b.
create function yelaxis_sync.is_protocol_uuid(value text)
returns boolean
language sql
immutable
parallel safe
return value ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$';

-- A JSON number that is an integer within [minimum, maximum], or null.
create function yelaxis_sync.json_integer(value jsonb, minimum numeric, maximum numeric)
returns numeric
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
declare
  v_number numeric;
begin
  if value is null or pg_catalog.jsonb_typeof(value) <> 'number' then
    return null;
  end if;
  v_number := (value #>> '{}')::numeric;
  if v_number <> pg_catalog.trunc(v_number) or v_number < minimum or v_number > maximum then
    return null;
  end if;
  return v_number;
end;
$$;

-- Canonical JSON text: object keys sorted by code point, no insignificant whitespace, strings
-- escaped like JSON.stringify, numbers in their shortest decimal form (documents hold integers).
-- A client computes the same text with sorted keys and JSON.stringify.
create function yelaxis_sync.canonical_json(value jsonb)
returns text
language plpgsql
immutable
strict
parallel safe
set search_path = ''
as $$
declare
  v_result text;
begin
  case pg_catalog.jsonb_typeof(value)
    when 'object' then
      select '{' || coalesce(pg_catalog.string_agg(
               pg_catalog.to_jsonb(member.key)::text || ':' ||
               case
                 when pg_catalog.jsonb_typeof(member.value) in ('object', 'array')
                   then yelaxis_sync.canonical_json(member.value)
                 else member.value::text
               end,
               ',' order by member.key collate "C"), '') || '}'
        into v_result
        from pg_catalog.jsonb_each(value) as member;
    when 'array' then
      select '[' || coalesce(pg_catalog.string_agg(
               case
                 when pg_catalog.jsonb_typeof(element.value) in ('object', 'array')
                   then yelaxis_sync.canonical_json(element.value)
                 else element.value::text
               end,
               ',' order by element.position), '') || ']'
        into v_result
        from pg_catalog.jsonb_array_elements(value) with ordinality as element(value, position);
    else
      v_result := value::text;
  end case;
  return v_result;
end;
$$;

-- Snapshot hash of a document: lowercase hex SHA-256 of its UTF-8 canonical JSON text.
create function yelaxis_sync.document_hash(document jsonb)
returns text
language sql
immutable
strict
parallel safe
return pg_catalog.encode(
  pg_catalog.sha256(pg_catalog.convert_to(yelaxis_sync.canonical_json(document), 'UTF8')),
  'hex'
);

-- Serialized (canonical) size in bytes. `jsonb::text` adds at most one byte per separator, so
-- the exact size is only computed near the limit.
create function yelaxis_sync.json_size_exceeds(value jsonb, limit_bytes integer)
returns boolean
language plpgsql
immutable
strict
parallel safe
set search_path = ''
as $$
declare
  v_text_bytes bigint := pg_catalog.octet_length(value::text);
begin
  if v_text_bytes <= limit_bytes then
    return false;
  end if;
  if v_text_bytes > 2::bigint * limit_bytes then
    return true;
  end if;
  return pg_catalog.octet_length(yelaxis_sync.canonical_json(value)) > limit_bytes;
end;
$$;

-- `{"a": {"b": leaf}}` for the path {a,b}; used for containment probes of references.
create function yelaxis_sync.path_object(path text[], leaf jsonb)
returns jsonb
language plpgsql
immutable
strict
parallel safe
set search_path = ''
as $$
declare
  v_result jsonb := leaf;
  v_index integer;
begin
  for v_index in reverse pg_catalog.cardinality(path)..1 loop
    v_result := pg_catalog.jsonb_build_object(path[v_index], v_result);
  end loop;
  return v_result;
end;
$$;

-- The sorted keys of a JSON object, or null for any other value (never raises).
create function yelaxis_sync.object_keys(value jsonb)
returns text[]
language plpgsql
immutable
parallel safe
set search_path = ''
as $$
begin
  if value is null or pg_catalog.jsonb_typeof(value) <> 'object' then
    return null;
  end if;
  return (
    select coalesce(pg_catalog.array_agg(key order by key collate "C"), '{}')
      from pg_catalog.jsonb_object_keys(value) as key
  );
end;
$$;

create function yelaxis_sync.owner_lock_key(owner_id uuid)
returns bigint
language sql
immutable
strict
parallel safe
return pg_catalog.hashtextextended('yelaxis_sync:' || owner_id::text, 0);

create function yelaxis_sync.push_rejected(group_id uuid, code text, operation_id uuid default null)
returns jsonb
language sql
immutable
parallel safe
return pg_catalog.jsonb_strip_nulls(pg_catalog.jsonb_build_object(
  'status', 'rejected',
  'mutationGroupId', group_id,
  'code', code,
  'operationId', operation_id
));

create function yelaxis_sync.utc_text(value timestamptz)
returns text
language sql
immutable
strict
parallel safe
return pg_catalog.to_char(value at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');

/* ───────────────────────── Auth helpers (owned by postgres) ───────────────────────── */

-- Whether the authenticated subject still has a sign-in account. A deleted account's access
-- token stays valid until it expires; this check makes such calls fail closed.
create function yelaxis_sync.request_user_exists()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from auth.users as account where account.id = auth.uid());
$$;

-- Deletes the sign-in account of the authenticated subject, and only that one. Every owner
-- table cascades from `auth.users`.
create function yelaxis_sync.delete_request_user()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_deleted integer;
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  delete from auth.users as account where account.id = auth.uid();
  get diagnostics v_deleted = row_count;
  return v_deleted;
end;
$$;

/* ───────────────────────── Push ───────────────────────── */

create type yelaxis_sync.push_operation as (
  operation_id uuid,
  sequence integer,
  entity_type text,
  entity_id uuid,
  kind text,
  base_revision bigint,
  base_hash text,
  document jsonb
);

create function yelaxis_sync.push(request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := yelaxis_sync.request_owner();
  v_group uuid;
  v_replica uuid;
  v_item jsonb;
  v_index integer;
  v_offender uuid;
  v_revision numeric;
  v_sequence numeric;
  v_op yelaxis_sync.push_operation;
  v_ops yelaxis_sync.push_operation[] := '{}';
  v_count integer;
  v_receipts integer;
  v_schemas jsonb;
  v_current yelaxis_sync.records;
  v_found boolean;
  v_decisions text[] := '{}';
  v_decision text;
  v_position integer;
  v_conflicts jsonb := '[]';
  v_conflict_id uuid;
  v_existing yelaxis_sync.conflicts;
  v_acks jsonb := '[]';
  v_ack jsonb;
  v_new_revision bigint;
  v_seq bigint;
  v_last_seq bigint;
  v_cursor bigint;
  v_reference yelaxis_sync.reference_map;
  v_target text;
  v_missing uuid;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if request is null
     or pg_catalog.jsonb_typeof(request) <> 'object'
     or pg_catalog.jsonb_typeof(request -> 'mutationGroupId') is distinct from 'string'
     or not yelaxis_sync.is_protocol_uuid(request ->> 'mutationGroupId') then
    raise exception using errcode = '22023', message = 'invalid_payload';
  end if;
  v_group := (request ->> 'mutationGroupId')::uuid;

  -- One writer per owner: change-log sequence order is commit order for every owner.
  perform pg_catalog.pg_advisory_xact_lock(yelaxis_sync.owner_lock_key(v_owner));

  if exists (select 1 from yelaxis_sync.account_deletions where owner_id = v_owner)
     or not yelaxis_sync.request_user_exists() then
    return yelaxis_sync.push_rejected(v_group, 'deletion_pending');
  end if;

  if (request -> 'protocolVersion') is distinct from '1'::jsonb then
    return yelaxis_sync.push_rejected(v_group, 'unsupported_protocol');
  end if;

  if yelaxis_sync.json_size_exceeds(request, 2097152) then
    return yelaxis_sync.push_rejected(v_group, 'limit_exceeded');
  end if;

  /* Shape: exactly the protocol keys and types, operations in sequence order. */
  if yelaxis_sync.object_keys(request)
     is distinct from array['mutationGroupId', 'operations', 'protocolVersion', 'replicaId']
     or pg_catalog.jsonb_typeof(request -> 'replicaId') is distinct from 'string'
     or not yelaxis_sync.is_protocol_uuid(request ->> 'replicaId')
     or pg_catalog.jsonb_typeof(request -> 'operations') is distinct from 'array' then
    return yelaxis_sync.push_rejected(v_group, 'invalid_payload');
  end if;
  v_replica := (request ->> 'replicaId')::uuid;
  v_count := pg_catalog.jsonb_array_length(request -> 'operations');
  if v_count = 0 then
    return yelaxis_sync.push_rejected(v_group, 'invalid_payload');
  end if;
  if v_count > 500 then
    return yelaxis_sync.push_rejected(v_group, 'limit_exceeded');
  end if;

  for v_item, v_index in
    select element.value, (element.position - 1)::integer
      from pg_catalog.jsonb_array_elements(request -> 'operations')
        with ordinality as element(value, position)
  loop
    v_offender := null;
    if pg_catalog.jsonb_typeof(v_item) = 'object'
       and pg_catalog.jsonb_typeof(v_item -> 'operationId') = 'string'
       and yelaxis_sync.is_protocol_uuid(v_item ->> 'operationId') then
      v_offender := (v_item ->> 'operationId')::uuid;
    end if;
    if v_offender is null
       or yelaxis_sync.object_keys(v_item)
          is distinct from array[
            'baseServerRevision', 'baseSnapshotHash', 'document', 'entityId', 'entityType', 'kind',
            'operationId', 'sequence'
          ] then
      return yelaxis_sync.push_rejected(v_group, 'invalid_payload', v_offender);
    end if;
    v_sequence := yelaxis_sync.json_integer(v_item -> 'sequence', 0, 499);
    v_revision := yelaxis_sync.json_integer(v_item -> 'baseServerRevision', 0, 9007199254740991);
    if v_sequence is distinct from v_index
       or v_revision is null
       or pg_catalog.jsonb_typeof(v_item -> 'entityType') <> 'string'
       or not pg_catalog.pg_input_is_valid(v_item ->> 'entityType', 'yelaxis_sync.entity_type')
       or pg_catalog.jsonb_typeof(v_item -> 'entityId') <> 'string'
       or not yelaxis_sync.is_protocol_uuid(v_item ->> 'entityId')
       or pg_catalog.jsonb_typeof(v_item -> 'kind') <> 'string'
       or (v_item ->> 'kind') not in ('create', 'update', 'delete')
       or not (
         pg_catalog.jsonb_typeof(v_item -> 'baseSnapshotHash') = 'null'
         or (
           pg_catalog.jsonb_typeof(v_item -> 'baseSnapshotHash') = 'string'
           and pg_catalog.char_length(v_item ->> 'baseSnapshotHash') between 1 and 128
         )
       )
       or pg_catalog.jsonb_typeof(v_item -> 'document')
          <> (case when (v_item ->> 'kind') = 'delete' then 'null' else 'object' end)
       or (
         (v_item ->> 'kind') = 'create'
         and (v_revision <> 0 or pg_catalog.jsonb_typeof(v_item -> 'baseSnapshotHash') <> 'null')
       ) then
      return yelaxis_sync.push_rejected(v_group, 'invalid_payload', v_offender);
    end if;
    v_op := row(
      v_offender,
      v_index,
      v_item ->> 'entityType',
      (v_item ->> 'entityId')::uuid,
      v_item ->> 'kind',
      v_revision::bigint,
      v_item ->> 'baseSnapshotHash',
      case when (v_item ->> 'kind') = 'delete' then null else v_item -> 'document' end
    )::yelaxis_sync.push_operation;
    v_ops := v_ops || v_op;
  end loop;

  -- One operation per id and per record, as one local command produces.
  select op.operation_id into v_offender
    from pg_catalog.unnest(v_ops) as op
   where exists (
     select 1 from pg_catalog.unnest(v_ops) as other
      where other.sequence < op.sequence
        and (other.operation_id = op.operation_id
             or (other.entity_type = op.entity_type and other.entity_id = op.entity_id))
   )
   order by op.sequence
   limit 1;
  if found then
    return yelaxis_sync.push_rejected(v_group, 'invalid_payload', v_offender);
  end if;

  /* Idempotency: a repeated group returns its stored acknowledgment. */
  select pg_catalog.count(*)::integer into v_receipts
    from yelaxis_sync.idempotency_receipts as receipt
   where receipt.owner_id = v_owner
     and receipt.operation_id in (select op.operation_id from pg_catalog.unnest(v_ops) as op);
  if v_receipts > 0 then
    if v_receipts = v_count
       and (select pg_catalog.count(*) from yelaxis_sync.idempotency_receipts as receipt
             where receipt.owner_id = v_owner and receipt.mutation_group_id = v_group) = v_count
       and not exists (
         select 1
           from pg_catalog.unnest(v_ops) as op
           join yelaxis_sync.idempotency_receipts as receipt
             on receipt.owner_id = v_owner and receipt.operation_id = op.operation_id
          where receipt.mutation_group_id <> v_group
             or receipt.sequence <> op.sequence
             or receipt.entity_type <> op.entity_type
             or receipt.entity_id <> op.entity_id
             or receipt.operation_kind <> op.kind
             or receipt.document_hash is distinct from yelaxis_sync.document_hash(op.document)
       ) then
      return (
        select pg_catalog.jsonb_build_object(
          'status', 'accepted',
          'mutationGroupId', v_group,
          'acknowledgments', pg_catalog.jsonb_agg(receipt.acknowledgment order by receipt.sequence),
          'cursor', pg_catalog.max(receipt.group_cursor)::text
        )
          from yelaxis_sync.idempotency_receipts as receipt
         where receipt.owner_id = v_owner and receipt.mutation_group_id = v_group
      );
    end if;
    select op.operation_id into v_offender
      from pg_catalog.unnest(v_ops) as op
      left join yelaxis_sync.idempotency_receipts as receipt
        on receipt.owner_id = v_owner and receipt.operation_id = op.operation_id
     order by (receipt.operation_id is null), op.sequence
     limit 1;
    return yelaxis_sync.push_rejected(v_group, 'invalid_payload', v_offender);
  end if;
  if exists (
    select 1 from yelaxis_sync.idempotency_receipts as receipt
     where receipt.owner_id = v_owner and receipt.mutation_group_id = v_group
  ) then
    -- A group id that was accepted with other operations.
    return yelaxis_sync.push_rejected(v_group, 'invalid_payload', (v_ops[1]).operation_id);
  end if;

  /* Limits and document schemas. */
  select op.operation_id into v_offender
    from pg_catalog.unnest(v_ops) as op
   where op.document is not null and yelaxis_sync.json_size_exceeds(op.document, 65536)
   order by op.sequence
   limit 1;
  if found then
    return yelaxis_sync.push_rejected(v_group, 'limit_exceeded', v_offender);
  end if;

  select coalesce(pg_catalog.jsonb_object_agg(schema_row.entity_type, schema_row.json_schema), '{}')
    into v_schemas
    from yelaxis_sync.document_schemas as schema_row
   where schema_row.entity_type in (
     select op.entity_type from pg_catalog.unnest(v_ops) as op where op.document is not null
   );
  select op.operation_id into v_offender
    from pg_catalog.unnest(v_ops) as op
   where op.document is not null
     and (
       (v_schemas -> op.entity_type) is null
       or not extensions.jsonb_matches_schema((v_schemas -> op.entity_type)::json, op.document)
     )
   order by op.sequence
   limit 1;
  if found then
    return yelaxis_sync.push_rejected(v_group, 'schema_mismatch', v_offender);
  end if;

  /* Compare every base with the current server record. */
  foreach v_op in array v_ops loop
    select * into v_current
      from yelaxis_sync.records as record
     where record.owner_id = v_owner
       and record.entity_type = v_op.entity_type
       and record.entity_id = v_op.entity_id
     for update;
    v_found := found;
    v_decision := case
      when v_op.kind = 'create' then case
        when not v_found then 'insert'
        when v_current.document is not null and v_current.document = v_op.document then 'noop'
        else 'conflict:create_collision'
      end
      when not v_found then 'reject'
      when v_op.kind = 'update' then case
        -- An edit made with the tombstone as its base is an explicit restore (Restore edited).
        when v_current.document is null and v_op.base_revision = v_current.server_revision
          then 'restore'
        when v_current.document is null then 'conflict:edit_versus_delete'
        when v_op.base_revision = v_current.server_revision
             and v_op.base_hash is not distinct from yelaxis_sync.document_hash(v_current.document)
          then 'update'
        else 'conflict:stale_base'
      end
      else case
        when v_current.document is null and v_op.base_revision = v_current.server_revision
          then 'noop'
        when v_current.document is null then 'conflict:stale_base'
        when v_op.base_revision = v_current.server_revision
             and v_op.base_hash is not distinct from yelaxis_sync.document_hash(v_current.document)
          then 'delete'
        else 'conflict:delete_versus_edit'
      end
    end;
    if v_decision = 'reject' then
      -- An edit or delete of a record the server never had.
      return yelaxis_sync.push_rejected(v_group, 'invalid_payload', v_op.operation_id);
    end if;
    v_decisions := v_decisions || v_decision;
  end loop;

  if exists (select 1 from pg_catalog.unnest(v_decisions) as decision where decision like 'conflict:%') then
    for v_position in 1..v_count loop
      continue when v_decisions[v_position] not like 'conflict:%';
      v_op := v_ops[v_position];
      select * into v_current
        from yelaxis_sync.records as record
       where record.owner_id = v_owner
         and record.entity_type = v_op.entity_type
         and record.entity_id = v_op.entity_id;
      select * into v_existing
        from yelaxis_sync.conflicts as conflict
       where conflict.owner_id = v_owner
         and conflict.operation_id = v_op.operation_id
         and conflict.state = 'open';
      if found
         and v_existing.blocked_mutation_group_id = v_group
         and v_existing.conflict_kind = pg_catalog.substr(v_decisions[v_position], 10)
         and v_existing.remote_server_revision = v_current.server_revision then
        v_conflict_id := v_existing.conflict_id;
      else
        if found then
          update yelaxis_sync.conflicts
             set state = 'superseded', local_document = null, remote_document = null,
                 closed_at = pg_catalog.now(), updated_at = pg_catalog.now()
           where conflict_id = v_existing.conflict_id;
        end if;
        insert into yelaxis_sync.conflicts (
          owner_id, entity_type, entity_id, conflict_kind, operation_id, blocked_mutation_group_id,
          base_server_revision, local_deleted, local_document, remote_server_revision,
          remote_deleted, remote_document
        ) values (
          v_owner, v_op.entity_type, v_op.entity_id, pg_catalog.substr(v_decisions[v_position], 10),
          v_op.operation_id, v_group, v_op.base_revision, v_op.kind = 'delete', v_op.document,
          v_current.server_revision, v_current.document is null, v_current.document
        )
        returning conflict_id into v_conflict_id;
      end if;
      v_conflicts := v_conflicts || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'conflictId', v_conflict_id,
        'operationId', v_op.operation_id,
        'entityType', v_op.entity_type,
        'entityId', v_op.entity_id,
        'kind', pg_catalog.substr(v_decisions[v_position], 10),
        'baseServerRevision', v_op.base_revision,
        'remote', pg_catalog.jsonb_build_object(
          'serverRevision', v_current.server_revision,
          'deleted', v_current.document is null,
          'document', v_current.document
        )
      ));
    end loop;
    insert into yelaxis_sync.replicas as replica (owner_id, replica_id, last_push_at)
    values (v_owner, v_replica, pg_catalog.now())
    on conflict (owner_id, replica_id) do update set last_push_at = excluded.last_push_at;
    return pg_catalog.jsonb_build_object(
      'status', 'conflict',
      'mutationGroupId', v_group,
      'conflicts', v_conflicts
    );
  end if;

  /* Apply the whole group, then check references as deferred constraints; any failure undoes
     every write of the group. */
  begin
    for v_position in 1..v_count loop
      v_op := v_ops[v_position];
      v_decision := v_decisions[v_position];
      v_new_revision := null;
      if v_decision = 'insert' then
        v_new_revision := 1;
        insert into yelaxis_sync.change_log (
          owner_id, entity_type, entity_id, server_revision, change_kind, mutation_group_id,
          operation_id, replica_id
        ) values (
          v_owner, v_op.entity_type, v_op.entity_id, v_new_revision, 'create', v_group,
          v_op.operation_id, v_replica
        )
        returning seq into v_seq;
        insert into yelaxis_sync.records (
          owner_id, entity_type, entity_id, server_revision, document, deleted_at, last_seq
        ) values (
          v_owner, v_op.entity_type, v_op.entity_id, v_new_revision, v_op.document, null, v_seq
        );
        v_last_seq := v_seq;
      elsif v_decision in ('update', 'restore', 'delete') then
        select * into v_current
          from yelaxis_sync.records as record
         where record.owner_id = v_owner
           and record.entity_type = v_op.entity_type
           and record.entity_id = v_op.entity_id;
        v_new_revision := v_current.server_revision + 1;
        insert into yelaxis_sync.change_log (
          owner_id, entity_type, entity_id, server_revision, change_kind, mutation_group_id,
          operation_id, replica_id
        ) values (
          v_owner, v_op.entity_type, v_op.entity_id, v_new_revision, v_decision, v_group,
          v_op.operation_id, v_replica
        )
        returning seq into v_seq;
        update yelaxis_sync.records as record
           set server_revision = v_new_revision,
               document = v_op.document,
               deleted_at = case when v_decision = 'delete' then pg_catalog.now() end,
               last_seq = v_seq,
               updated_at = pg_catalog.now()
         where record.owner_id = v_owner
           and record.entity_type = v_op.entity_type
           and record.entity_id = v_op.entity_id;
        v_last_seq := v_seq;
      else
        select record.server_revision into v_new_revision
          from yelaxis_sync.records as record
         where record.owner_id = v_owner
           and record.entity_type = v_op.entity_type
           and record.entity_id = v_op.entity_id;
      end if;
      v_acks := v_acks || pg_catalog.jsonb_build_array(pg_catalog.jsonb_build_object(
        'operationId', v_op.operation_id,
        'entityType', v_op.entity_type,
        'entityId', v_op.entity_id,
        'serverRevision', v_new_revision
      ));
    end loop;

    -- Every id a written document names must be a live record of this owner.
    for v_position in 1..v_count loop
      continue when v_decisions[v_position] not in ('insert', 'update', 'restore');
      v_op := v_ops[v_position];
      for v_reference in
        select * from yelaxis_sync.reference_map as reference
         where reference.entity_type = v_op.entity_type and reference.enforced
      loop
        v_target := v_op.document #>> v_reference.field_path;
        continue when v_target is null;
        continue when v_reference.when_path is not null
          and (v_op.document #>> v_reference.when_path) is distinct from v_reference.when_value;
        if not yelaxis_sync.is_protocol_uuid(v_target) then
          v_missing := v_op.operation_id;
          raise exception using errcode = 'YX001', message = 'missing_reference';
        end if;
        if not exists (
          select 1 from yelaxis_sync.records as target
           where target.owner_id = v_owner
             and target.entity_type = v_reference.target_entity_type
             and target.entity_id = v_target::uuid
             and target.document is not null
        ) then
          v_missing := v_op.operation_id;
          raise exception using errcode = 'YX001', message = 'missing_reference';
        end if;
      end loop;
    end loop;

    -- A deleted record must not be named by any live document of this owner.
    for v_position in 1..v_count loop
      continue when v_decisions[v_position] <> 'delete';
      v_op := v_ops[v_position];
      for v_reference in
        select * from yelaxis_sync.reference_map as reference
         where reference.target_entity_type = v_op.entity_type and reference.enforced
      loop
        if exists (
          select 1 from yelaxis_sync.records as source
           where source.owner_id = v_owner
             and source.entity_type = v_reference.entity_type
             and source.document is not null
             and source.document @> yelaxis_sync.path_object(
               v_reference.field_path, pg_catalog.to_jsonb(v_op.entity_id::text)
             )
             and (
               v_reference.when_path is null
               or (source.document #>> v_reference.when_path) = v_reference.when_value
             )
        ) then
          v_missing := v_op.operation_id;
          raise exception using errcode = 'YX001', message = 'missing_reference';
        end if;
      end loop;
    end loop;
  exception
    when sqlstate 'YX001' then
      return yelaxis_sync.push_rejected(v_group, 'missing_reference', v_missing);
  end;

  v_cursor := coalesce(
    v_last_seq,
    (select pg_catalog.max(log.seq) from yelaxis_sync.change_log as log where log.owner_id = v_owner),
    0
  );

  for v_position in 1..v_count loop
    v_op := v_ops[v_position];
    v_ack := v_acks -> (v_position - 1);
    insert into yelaxis_sync.idempotency_receipts (
      owner_id, operation_id, mutation_group_id, sequence, entity_type, entity_id, operation_kind,
      document_hash, acknowledgment, group_cursor
    ) values (
      v_owner, v_op.operation_id, v_group, v_op.sequence, v_op.entity_type, v_op.entity_id,
      v_op.kind, yelaxis_sync.document_hash(v_op.document), v_ack, v_cursor
    );
  end loop;

  insert into yelaxis_sync.replicas as replica (owner_id, replica_id, last_push_at)
  values (v_owner, v_replica, pg_catalog.now())
  on conflict (owner_id, replica_id) do update set last_push_at = excluded.last_push_at;

  return pg_catalog.jsonb_build_object(
    'status', 'accepted',
    'mutationGroupId', v_group,
    'acknowledgments', v_acks,
    'cursor', v_cursor::text
  );
end;
$$;

/* ───────────────────────── Pull ───────────────────────── */

create function yelaxis_sync.pull(request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := yelaxis_sync.request_owner();
  v_after numeric;
  v_after_seq bigint;
  v_limit integer;
  v_replica uuid;
  v_head bigint;
  v_rows jsonb;
  v_size integer;
  v_has_more boolean;
  v_next bigint;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if request is null
     or pg_catalog.jsonb_typeof(request) <> 'object'
     or yelaxis_sync.object_keys(request)
        is distinct from array['afterCursor', 'limit', 'protocolVersion', 'replicaId']
     or (request -> 'protocolVersion') is distinct from '1'::jsonb
     or pg_catalog.jsonb_typeof(request -> 'replicaId') is distinct from 'string'
     or not yelaxis_sync.is_protocol_uuid(request ->> 'replicaId')
     or yelaxis_sync.json_integer(request -> 'limit', 1, 500) is null
     or not (
       pg_catalog.jsonb_typeof(request -> 'afterCursor') = 'null'
       or (
         pg_catalog.jsonb_typeof(request -> 'afterCursor') = 'string'
         and (request ->> 'afterCursor') ~ '^[0-9]{1,19}$'
       )
     ) then
    raise exception using errcode = '22023', message = 'invalid_payload';
  end if;
  v_replica := (request ->> 'replicaId')::uuid;
  v_limit := yelaxis_sync.json_integer(request -> 'limit', 1, 500)::integer;
  v_after := coalesce((request ->> 'afterCursor')::numeric, 0);

  if exists (select 1 from yelaxis_sync.account_deletions where owner_id = v_owner)
     or not yelaxis_sync.request_user_exists() then
    return pg_catalog.jsonb_build_object(
      'status', 'page', 'changes', '[]'::jsonb, 'nextCursor', v_after::text, 'hasMore', false
    );
  end if;

  -- A cursor this owner was never issued (forged, foreign, or from a reset server) restarts
  -- reconciliation from the beginning; it never selects anything.
  select coalesce(pg_catalog.max(log.seq), 0) into v_head
    from yelaxis_sync.change_log as log
   where log.owner_id = v_owner;
  if v_after > v_head then
    return pg_catalog.jsonb_build_object('status', 'cursor_expired');
  end if;
  v_after_seq := v_after::bigint;

  -- One entry per record with its latest state, ordered by the sequence of that state.
  select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
           'cursor', page.last_seq::text,
           'entityType', page.entity_type,
           'entityId', page.entity_id,
           'serverRevision', page.server_revision,
           'deleted', page.document is null,
           'document', page.document
         ) order by page.last_seq), '[]'),
         pg_catalog.count(*)::integer,
         pg_catalog.max(page.last_seq)
    into v_rows, v_size, v_next
    from (
      select record.last_seq, record.entity_type, record.entity_id, record.server_revision,
             record.document
        from yelaxis_sync.records as record
       where record.owner_id = v_owner and record.last_seq > v_after_seq
       order by record.last_seq
       limit v_limit + 1
    ) as page;

  v_has_more := v_size > v_limit;
  if v_has_more then
    v_rows := v_rows - v_limit;
    v_next := (v_rows -> (v_limit - 1) ->> 'cursor')::bigint;
  end if;
  v_next := coalesce(v_next, v_after_seq);

  insert into yelaxis_sync.replicas as replica (owner_id, replica_id, last_pull_at, last_pulled_cursor)
  values (v_owner, v_replica, pg_catalog.now(), v_next)
  on conflict (owner_id, replica_id) do update
    set last_pull_at = excluded.last_pull_at, last_pulled_cursor = excluded.last_pulled_cursor;

  return pg_catalog.jsonb_build_object(
    'status', 'page',
    'changes', v_rows,
    'nextCursor', v_next::text,
    'hasMore', v_has_more
  );
end;
$$;

/* ───────────────────────── Conflicts ───────────────────────── */

create function yelaxis_sync.open_conflicts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := yelaxis_sync.request_owner();
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  return (
    select coalesce(pg_catalog.jsonb_agg(pg_catalog.jsonb_build_object(
             'conflictId', conflict.conflict_id,
             'entityType', conflict.entity_type,
             'entityId', conflict.entity_id,
             'kind', conflict.conflict_kind,
             'baseServerRevision', conflict.base_server_revision,
             'local', pg_catalog.jsonb_build_object(
               'deleted', conflict.local_deleted,
               'document', conflict.local_document
             ),
             'remote', pg_catalog.jsonb_build_object(
               'serverRevision', conflict.remote_server_revision,
               'deleted', conflict.remote_deleted,
               'document', conflict.remote_document
             ),
             'blockedMutationGroupId', conflict.blocked_mutation_group_id,
             'createdAt', yelaxis_sync.utc_text(conflict.created_at)
           ) order by conflict.created_at, conflict.conflict_id), '[]')
      from (
        select *
          from yelaxis_sync.conflicts as open_conflict
         where open_conflict.owner_id = v_owner and open_conflict.state = 'open'
         order by open_conflict.created_at, open_conflict.conflict_id
         limit 500
      ) as conflict
  );
end;
$$;

create function yelaxis_sync.close_conflict(request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := yelaxis_sync.request_owner();
  v_conflict uuid;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  if request is null
     or pg_catalog.jsonb_typeof(request) <> 'object'
     or yelaxis_sync.object_keys(request) is distinct from array['conflictId', 'resolution']
     or pg_catalog.jsonb_typeof(request -> 'conflictId') is distinct from 'string'
     or not yelaxis_sync.is_protocol_uuid(request ->> 'conflictId')
     or pg_catalog.jsonb_typeof(request -> 'resolution') is distinct from 'string'
     or (request ->> 'resolution') not in (
       'keep_local', 'keep_remote', 'merge', 'keep_deleted', 'restore_edited'
     ) then
    raise exception using errcode = '22023', message = 'invalid_payload';
  end if;
  v_conflict := (request ->> 'conflictId')::uuid;

  perform pg_catalog.pg_advisory_xact_lock(yelaxis_sync.owner_lock_key(v_owner));

  update yelaxis_sync.conflicts as conflict
     set state = 'resolved',
         resolution = request ->> 'resolution',
         local_document = null,
         remote_document = null,
         closed_at = pg_catalog.now(),
         updated_at = pg_catalog.now()
   where conflict.owner_id = v_owner
     and conflict.conflict_id = v_conflict
     and conflict.state = 'open';
  if not found and not exists (
    select 1 from yelaxis_sync.conflicts as conflict
     where conflict.owner_id = v_owner and conflict.conflict_id = v_conflict
  ) then
    raise exception using errcode = 'PT404', message = 'conflict_not_found';
  end if;
  -- Closing an already resolved or superseded conflict is a no-op.
  return pg_catalog.jsonb_build_object('closed', true);
end;
$$;

/* ───────────────────────── Account ───────────────────────── */

create function yelaxis_sync.account_status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := yelaxis_sync.request_owner();
  v_counts jsonb;
  v_total integer;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  select coalesce(pg_catalog.jsonb_object_agg(counted.entity_type, counted.records), '{}'),
         coalesce(pg_catalog.sum(counted.records), 0)::integer
    into v_counts, v_total
    from (
      select record.entity_type, pg_catalog.count(*)::integer as records
        from yelaxis_sync.records as record
       where record.owner_id = v_owner and record.document is not null
       group by record.entity_type
    ) as counted;
  return pg_catalog.jsonb_build_object(
    'recordCounts', v_counts,
    'recordCount', v_total,
    'deletion', case
      when exists (select 1 from yelaxis_sync.account_deletions where owner_id = v_owner)
           or not yelaxis_sync.request_user_exists()
        then 'pending'
      else 'none'
    end
  );
end;
$$;

create function yelaxis_sync.account_delete()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_owner uuid := yelaxis_sync.request_owner();
  v_recorded boolean;
  v_signed_up boolean;
begin
  if v_owner is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(yelaxis_sync.owner_lock_key(v_owner));

  v_recorded := exists (select 1 from yelaxis_sync.account_deletions where owner_id = v_owner);
  v_signed_up := yelaxis_sync.request_user_exists();
  if not v_recorded then
    insert into yelaxis_sync.account_deletions (owner_id) values (v_owner);
  end if;

  -- Every owner row; the auth cascade would remove them too, but deletion never depends on it.
  delete from yelaxis_sync.conflicts where owner_id = v_owner;
  delete from yelaxis_sync.idempotency_receipts where owner_id = v_owner;
  delete from yelaxis_sync.change_log where owner_id = v_owner;
  delete from yelaxis_sync.records where owner_id = v_owner;
  delete from yelaxis_sync.replicas where owner_id = v_owner;
  if v_signed_up then
    perform yelaxis_sync.delete_request_user();
  end if;

  update yelaxis_sync.account_deletions
     set completed_at = coalesce(completed_at, pg_catalog.now())
   where owner_id = v_owner;

  -- Already deleted: by an earlier call, or the sign-in account was removed outside the app.
  return pg_catalog.jsonb_build_object(
    'status', case when v_recorded or not v_signed_up then 'already_deleted' else 'deleted' end
  );
end;
$$;

/* ───────────────────────── Privileges and ownership ───────────────────────── */

revoke all on function yelaxis_sync.is_protocol_uuid(text) from public;
revoke all on function yelaxis_sync.json_integer(jsonb, numeric, numeric) from public;
revoke all on function yelaxis_sync.canonical_json(jsonb) from public;
revoke all on function yelaxis_sync.document_hash(jsonb) from public;
revoke all on function yelaxis_sync.json_size_exceeds(jsonb, integer) from public;
revoke all on function yelaxis_sync.path_object(text[], jsonb) from public;
revoke all on function yelaxis_sync.object_keys(jsonb) from public;
revoke all on function yelaxis_sync.owner_lock_key(uuid) from public;
revoke all on function yelaxis_sync.push_rejected(uuid, text, uuid) from public;
revoke all on function yelaxis_sync.utc_text(timestamptz) from public;
revoke all on function yelaxis_sync.request_user_exists() from public, anon, authenticated, service_role;
revoke all on function yelaxis_sync.delete_request_user() from public, anon, authenticated, service_role;
revoke all on function yelaxis_sync.push(jsonb) from public;
revoke all on function yelaxis_sync.pull(jsonb) from public;
revoke all on function yelaxis_sync.open_conflicts() from public;
revoke all on function yelaxis_sync.close_conflict(jsonb) from public;
revoke all on function yelaxis_sync.account_status() from public;
revoke all on function yelaxis_sync.account_delete() from public;
revoke all on type yelaxis_sync.push_operation from public;

grant execute on function yelaxis_sync.is_protocol_uuid(text) to yelaxis_sync_api;
grant execute on function yelaxis_sync.json_integer(jsonb, numeric, numeric) to yelaxis_sync_api;
grant execute on function yelaxis_sync.canonical_json(jsonb) to yelaxis_sync_api;
grant execute on function yelaxis_sync.document_hash(jsonb) to yelaxis_sync_api;
grant execute on function yelaxis_sync.json_size_exceeds(jsonb, integer) to yelaxis_sync_api;
grant execute on function yelaxis_sync.path_object(text[], jsonb) to yelaxis_sync_api;
grant execute on function yelaxis_sync.object_keys(jsonb) to yelaxis_sync_api;
grant execute on function yelaxis_sync.owner_lock_key(uuid) to yelaxis_sync_api;
grant execute on function yelaxis_sync.push_rejected(uuid, text, uuid) to yelaxis_sync_api;
grant execute on function yelaxis_sync.utc_text(timestamptz) to yelaxis_sync_api;
grant execute on function yelaxis_sync.request_user_exists() to yelaxis_sync_api;
grant execute on function yelaxis_sync.delete_request_user() to yelaxis_sync_api;
grant usage on type yelaxis_sync.push_operation to yelaxis_sync_api;

grant usage on domain yelaxis_sync.entity_type to yelaxis_sync_api;

-- The implementations run as the API role, so the owner policies govern every statement. The
-- role needs CREATE on the schema only while it takes ownership. Grants to the `public` wrappers'
-- owner are made by the new owner, after the transfer.
grant create on schema yelaxis_sync to yelaxis_sync_api;
alter function yelaxis_sync.push(jsonb) owner to yelaxis_sync_api;
alter function yelaxis_sync.pull(jsonb) owner to yelaxis_sync_api;
alter function yelaxis_sync.open_conflicts() owner to yelaxis_sync_api;
alter function yelaxis_sync.close_conflict(jsonb) owner to yelaxis_sync_api;
alter function yelaxis_sync.account_status() owner to yelaxis_sync_api;
alter function yelaxis_sync.account_delete() owner to yelaxis_sync_api;
revoke create on schema yelaxis_sync from yelaxis_sync_api;

set role yelaxis_sync_api;
revoke all on function yelaxis_sync.push(jsonb) from public;
revoke all on function yelaxis_sync.pull(jsonb) from public;
revoke all on function yelaxis_sync.open_conflicts() from public;
revoke all on function yelaxis_sync.close_conflict(jsonb) from public;
revoke all on function yelaxis_sync.account_status() from public;
revoke all on function yelaxis_sync.account_delete() from public;
grant execute on function yelaxis_sync.push(jsonb) to postgres;
grant execute on function yelaxis_sync.pull(jsonb) to postgres;
grant execute on function yelaxis_sync.open_conflicts() to postgres;
grant execute on function yelaxis_sync.close_conflict(jsonb) to postgres;
grant execute on function yelaxis_sync.account_status() to postgres;
grant execute on function yelaxis_sync.account_delete() to postgres;
reset role;

/* ───────────────────────── Client functions ───────────────────────── */

create function public.sync_push(request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  return yelaxis_sync.push(request);
end;
$$;

create function public.sync_pull(request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  return yelaxis_sync.pull(request);
end;
$$;

create function public.sync_open_conflicts()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  return yelaxis_sync.open_conflicts();
end;
$$;

create function public.sync_close_conflict(request jsonb)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  return yelaxis_sync.close_conflict(request);
end;
$$;

create function public.account_status()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  return yelaxis_sync.account_status();
end;
$$;

create function public.account_delete()
returns jsonb
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  return yelaxis_sync.account_delete();
end;
$$;

revoke all on function public.sync_push(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.sync_pull(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.sync_open_conflicts() from public, anon, authenticated, service_role;
revoke all on function public.sync_close_conflict(jsonb) from public, anon, authenticated, service_role;
revoke all on function public.account_status() from public, anon, authenticated, service_role;
revoke all on function public.account_delete() from public, anon, authenticated, service_role;

grant execute on function public.sync_push(jsonb) to authenticated;
grant execute on function public.sync_pull(jsonb) to authenticated;
grant execute on function public.sync_open_conflicts() to authenticated;
grant execute on function public.sync_close_conflict(jsonb) to authenticated;
grant execute on function public.account_status() to authenticated;
grant execute on function public.account_delete() to authenticated;
