export type DataAdapterErrorCode =
  | 'capability_expired'
  | 'concurrent_transaction'
  | 'identity_ambiguous'
  | 'invalid_canonical_document'
  | 'invalid_identity_record'
  | 'invalid_json_payload'
  | 'invalid_persisted_record'
  | 'unsupported_entity_type'
  | 'write_conflict';

/** Static, content-free adapter failure safe to cross the application boundary. */
export class DataAdapterError extends Error {
  readonly code: DataAdapterErrorCode;

  constructor(code: DataAdapterErrorCode) {
    super('YelAxis Planner data operation failed.');
    this.name = 'DataAdapterError';
    this.code = code;
  }
}
