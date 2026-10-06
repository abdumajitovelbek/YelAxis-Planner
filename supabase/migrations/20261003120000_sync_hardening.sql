-- Account synchronization validation and lifecycle hardening.
--
-- 1. `account_delete` deletes a sign-in account only for an access token that records a password
-- sign-in from the last five minutes (`amr`). A token refreshed from an older sign-in keeps that
-- sign-in's time and is refused. Confirming a deletion that already happened needs no sign-in.
-- 2. Deleting the sign-in account also deletes the auth service's audit entries that name it.
-- 3. `sync_pull` accepts only 0 or a change-log position of this owner as its cursor. Any other
-- cursor (another owner's, or one from a reset server) expires, and reconciliation restarts.
-- 4. Canonical JSON writes every number the way JavaScript's `JSON.stringify` writes the same
-- value, so a document stored as `30.0` hashes like the `30` every client reads back.
-- 5. An operation id that meets its open conflict again must be the same operation: the same
-- group, record, and kind, and while the remote is unchanged the same base and local candidate.
-- Anything else is `invalid_payload`, never a reused or superseded conflict.
--
-- Errors added (HTTP status through PostgREST):
-- 42501 reauthentication_required `account_delete` without a recent password sign-in (403)
--
-- The helpers owned by `postgres` are replaced directly. The implementations owned by
-- `yelaxis_sync_api` are replaced as that role, which keeps their owner and privileges.

/* ───────────────────────── Canonical numbers ───────────────────────── */

-- A JSON number as JavaScript's `JSON.stringify` writes the double nearest to it: the shortest
-- digits that read back as that double, positional from 1e-6 up to 1e21 and exponential outside,
-- `null` for a value beyond the doubles (JavaScript reads it as Infinity) and `0` for one that
-- reads as zero. A safe integer, the only kind of number the document schemas accept, is written
-- with its digits whatever its scale (`30.0` is `30`). Never raises.
create function yelaxis_sync.json_number_text(value numeric)
returns text
language plpgsql
immutable
strict
parallel safe
set search_path = ''
-- A double's text is its shortest round-trip form only with extra digits enabled.
set extra_float_digits = 1
as $$
declare
  v_integer numeric := pg_catalog.trim_scale(value);
  v_magnitude double precision;
  v_text text;
  v_exponent integer := 0;
  v_digits text;
  v_point integer;
  v_count integer;
  v_prefix numeric;
  v_candidate text;
  v_written text;
begin
  if pg_catalog.scale(v_integer) = 0 and pg_catalog.abs(v_integer) <= 9007199254740991 then
    return v_integer::text;
  end if;
  -- Read as JavaScript reads it: the nearest double, ties to even. Beyond the doubles it reads
  -- Infinity, which JSON.stringify writes as null, or zero.
  v_text := pg_catalog.abs(value)::text;
  if not pg_catalog.pg_input_is_valid(v_text, 'double precision') then
    return case when pg_catalog.abs(value) > 1 then 'null' else '0' end;
  end if;
  v_magnitude := v_text::double precision;

  -- Its shortest digits, positional (`123.456`) or exponential (`1.5e-05`); the value is
  -- 0.<v_digits> x 10^v_point once leading and trailing zeros are dropped.
  v_text := v_magnitude::text;
  if pg_catalog.strpos(v_text, 'e') > 0 then
    v_exponent := pg_catalog.split_part(v_text, 'e', 2)::integer;
    v_text := pg_catalog.split_part(v_text, 'e', 1);
  end if;
  v_point := v_exponent + case
    when pg_catalog.strpos(v_text, '.') = 0 then pg_catalog.length(v_text)
    else pg_catalog.strpos(v_text, '.') - 1
  end;
  v_digits := pg_catalog.replace(v_text, '.', '');
  v_point := v_point
    - (pg_catalog.length(v_digits) - pg_catalog.length(pg_catalog.ltrim(v_digits, '0')));
  v_digits := pg_catalog.rtrim(pg_catalog.ltrim(v_digits, '0'), '0');
  v_count := pg_catalog.length(v_digits);

  -- PostgreSQL's shortest digits stay strictly inside the double's rounding interval. JavaScript
  -- also takes the interval's edge when it still reads back as the same double (a tie that goes
  -- to even), which can be shorter: 7.25e21 rather than 7.249999999999999e21.
  <<shorter>>
  for v_length in 1..v_count - 1 loop
    v_prefix := pg_catalog.left(v_digits, v_length)::numeric;
    foreach v_candidate in array array[v_prefix::text, (v_prefix + 1)::text] loop
      v_written := v_candidate || 'e' || (v_point - v_length);
      if pg_catalog.pg_input_is_valid(v_written, 'double precision')
         and v_written::double precision = v_magnitude then
        v_point := v_point - v_length + pg_catalog.length(v_candidate);
        v_digits := pg_catalog.rtrim(v_candidate, '0');
        v_count := pg_catalog.length(v_digits);
        exit shorter;
      end if;
    end loop;
  end loop shorter;

  -- ECMAScript Number::toString(10), with n = v_point and k = v_count.
  v_text := case
    when v_count <= v_point and v_point <= 21
      then v_digits || pg_catalog.repeat('0', v_point - v_count)
    when 0 < v_point and v_point <= 21
      then pg_catalog.left(v_digits, v_point) || '.' || pg_catalog.substr(v_digits, v_point + 1)
    when -6 < v_point and v_point <= 0
      then '0.' || pg_catalog.repeat('0', -v_point) || v_digits
    else pg_catalog.left(v_digits, 1)
      || case when v_count > 1 then '.' || pg_catalog.substr(v_digits, 2) else '' end
      || 'e' || case when v_point > 0 then '+' else '-' end
      || pg_catalog.abs(v_point - 1)::text
  end;
  return case when value < 0 then '-' || v_text else v_text end;
end;
$$;

-- Canonical JSON text: object keys sorted by code point, no insignificant whitespace, strings
-- escaped like JSON.stringify, and numbers as JSON.stringify writes them (`json_number_text`).
-- A client computes the same text with sorted keys and JSON.stringify.
create or replace function yelaxis_sync.canonical_json(value jsonb)
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
                 when pg_catalog.jsonb_typeof(member.value) = 'number'
                   then yelaxis_sync.json_number_text(member.value::numeric)
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
                 when pg_catalog.jsonb_typeof(element.value) = 'number'
                   then yelaxis_sync.json_number_text(element.value::numeric)
                 else element.value::text
               end,
               ',' order by element.position), '') || ']'
        into v_result
        from pg_catalog.jsonb_array_elements(value) with ordinality as element(value, position);
    when 'number' then
      v_result := yelaxis_sync.json_number_text(value::numeric);
    else
      v_result := value::text;
  end case;
  return v_result;
end;
$$;

/* ───────────────────────── Auth helpers (owned by postgres) ───────────────────────── */

-- Whether the access token records a password sign-in from the last five minutes. The auth service
-- writes the sign-in's time into `amr` and keeps it when the token is refreshed, so only signing in
-- again with the password counts. A minute of clock difference with the auth service is tolerated.
create function yelaxis_sync.request_signed_in_recently()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(pg_catalog.bool_or(
           (entry ->> 'method') = 'password'
           and pg_catalog.jsonb_typeof(entry -> 'timestamp') = 'number'
           and extract(epoch from pg_catalog.now()) - (entry ->> 'timestamp')::numeric
               between -60 and 300
         ), false)
    from pg_catalog.jsonb_array_elements(
           case
             when pg_catalog.jsonb_typeof(auth.jwt() -> 'amr') = 'array' then auth.jwt() -> 'amr'
             else '[]'::jsonb
           end
         ) as entry;
$$;

-- Deletes the sign-in account of the authenticated subject, and only that one, with the audit
-- entries that name it. Every owner table cascades from `auth.users`.
create or replace function yelaxis_sync.delete_request_user()
returns integer
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_user uuid := auth.uid();
  v_deleted integer;
begin
  if v_user is null then
    raise exception using errcode = '42501', message = 'not_authenticated';
  end if;
  delete from auth.users as account where account.id = v_user;
  get diagnostics v_deleted = row_count;
  -- The audit trail names the account by id: as the actor of its own sign-ins, sign-outs, and
  -- refreshes (with its email), and in the traits of a change an administrator made to it.
  delete from auth.audit_log_entries as entry
   where entry.payload ->> 'actor_id' = v_user::text
      or entry.payload -> 'traits' ->> 'user_id' = v_user::text;
  return v_deleted;
end;
$$;

revoke all on function yelaxis_sync.json_number_text(numeric) from public;
revoke all on function yelaxis_sync.request_signed_in_recently()
  from public, anon, authenticated, service_role;

grant execute on function yelaxis_sync.json_number_text(numeric) to yelaxis_sync_api;
grant execute on function yelaxis_sync.request_signed_in_recently() to yelaxis_sync_api;

/* ───────────────────────── Implementations (owned by yelaxis_sync_api) ───────────────────────── */

grant create on schema yelaxis_sync to yelaxis_sync_api;
set role yelaxis_sync_api;

create or replace function yelaxis_sync.push(request jsonb)
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
    -- An operation id waiting in an open conflict comes back as the same operation: the same
    -- group, record, and kind, and while the remote is unchanged the same base and local
    -- candidate. A client rebases the candidate only onto a newer remote (a merge), which then
    -- supersedes the conflict. Anything else reuses the id for other content; checked before
    -- any write.
    for v_position in 1..v_count loop
      continue when v_decisions[v_position] not like 'conflict:%';
      v_op := v_ops[v_position];
      select * into v_existing
        from yelaxis_sync.conflicts as conflict
       where conflict.owner_id = v_owner
         and conflict.operation_id = v_op.operation_id
         and conflict.state = 'open';
      continue when not found;
      select * into v_current
        from yelaxis_sync.records as record
       where record.owner_id = v_owner
         and record.entity_type = v_op.entity_type
         and record.entity_id = v_op.entity_id;
      if v_existing.blocked_mutation_group_id <> v_group
         or v_existing.entity_type <> v_op.entity_type
         or v_existing.entity_id <> v_op.entity_id
         or v_existing.local_deleted <> (v_op.kind = 'delete')
         or (v_existing.conflict_kind = 'create_collision') <> (v_op.kind = 'create')
         or (
           v_existing.remote_server_revision = v_current.server_revision
           and (
             v_existing.base_server_revision <> v_op.base_revision
             or v_existing.local_document is distinct from v_op.document
           )
         ) then
        return yelaxis_sync.push_rejected(v_group, 'invalid_payload', v_op.operation_id);
      end if;
    end loop;

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
      -- The same operation (checked above) meeting the same remote keeps its open conflict; a
      -- newer remote supersedes it.
      if found
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

create or replace function yelaxis_sync.pull(request jsonb)
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

  -- Every cursor this server issues is 0 or one of this owner's change-log positions: a page's
  -- last change, or the request's own cursor again for an empty page. Any other cursor (forged,
  -- another owner's, or from a reset server) would skip or repeat changes, so reconciliation
  -- restarts from the beginning; such a cursor never selects anything.
  if v_after > 9223372036854775807 then
    return pg_catalog.jsonb_build_object('status', 'cursor_expired');
  end if;
  v_after_seq := v_after::bigint;
  if v_after_seq <> 0 and not exists (
    select 1 from yelaxis_sync.change_log as log
     where log.owner_id = v_owner and log.seq = v_after_seq
  ) then
    return pg_catalog.jsonb_build_object('status', 'cursor_expired');
  end if;

  if exists (select 1 from yelaxis_sync.account_deletions where owner_id = v_owner)
     or not yelaxis_sync.request_user_exists() then
    return pg_catalog.jsonb_build_object(
      'status', 'page', 'changes', '[]'::jsonb, 'nextCursor', v_after_seq::text, 'hasMore', false
    );
  end if;

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

create or replace function yelaxis_sync.account_delete()
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
  -- Deleting the sign-in account needs a password sign-in from the last five minutes (identity
  -- contract: recent authentication). Once the account is gone, a retry only confirms it.
  if v_signed_up and not yelaxis_sync.request_signed_in_recently() then
    raise exception using errcode = '42501', message = 'reauthentication_required';
  end if;
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

reset role;
revoke create on schema yelaxis_sync from yelaxis_sync_api;
