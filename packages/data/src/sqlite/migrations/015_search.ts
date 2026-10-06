import { defineMigration } from './migration';

const columns =
  'owner_id, kind, entity_id, title, text_value, state, archived, axis_id, project_id, created_at, updated_at, due_date, review_type, review_key';

/** A normalized, rebuildable read projection; canonical tables remain the only authority. */
const sources = [
  [
    'actions',
    'action',
    "title, coalesce(note_text, ''), state, archived_at IS NOT NULL, axis_id, project_id, created_at, updated_at, coalesce(due_date, substr(due_at_utc, 1, 10)), NULL, NULL",
  ],
  [
    'notes',
    'note',
    "coalesce(title, 'Untitled Note'), coalesce(body, ''), state, archived_at IS NOT NULL, axis_id, project_id, created_at, updated_at, NULL, NULL, NULL",
  ],
  [
    'axes',
    'axis',
    "title, coalesce(purpose, ''), state, archived_at IS NOT NULL, id, NULL, created_at, updated_at, NULL, NULL, NULL",
  ],
  [
    'outcomes',
    'outcome',
    'title, success_definition, state, archived_at IS NOT NULL, axis_id, NULL, created_at, updated_at, target_end_date, NULL, NULL',
  ],
  [
    'projects',
    'project',
    "title, coalesce(description, '') || char(10) || coalesce(desired_result, '') || char(10) || coalesce(notes, ''), state, archived_at IS NOT NULL, axis_id, id, created_at, updated_at, target_end_date, NULL, NULL",
  ],
  [
    'milestones',
    'milestone',
    'title, measurable_checkpoint, state, archived_at IS NOT NULL, (SELECT axis_id FROM outcomes WHERE owner_id = milestones.owner_id AND id = milestones.outcome_id AND deleted_at IS NULL), NULL, created_at, updated_at, target_end_date, NULL, NULL',
  ],
  [
    'routines',
    'routine',
    "title, coalesce(description, ''), state, archived_at IS NOT NULL, axis_id, NULL, created_at, updated_at, NULL, NULL, NULL",
  ],
  [
    'review_checkpoints',
    'review',
    "review_type || ' review: ' || period_key, coalesce(notes, '') || char(10) || coalesce(theme_text, '') || char(10) || coalesce(direction_text, ''), state, archived_at IS NOT NULL, NULL, NULL, created_at, updated_at, NULL, review_type, period_key",
  ],
] as const;

function refresh(table: string, kind: string): string {
  const insert = `INSERT INTO search_documents (${columns}) SELECT ${columns} FROM search_source_documents WHERE kind = '${kind}' AND owner_id = NEW.owner_id AND entity_id = NEW.id;`;
  const remove = `DELETE FROM search_documents WHERE kind = '${kind}' AND owner_id = OLD.owner_id AND entity_id = OLD.id;`;
  const upsert = insert.replace(
    ';',
    ` ON CONFLICT(owner_id, kind, entity_id) DO UPDATE SET
    ${columns
      .split(', ')
      .filter((column) => !['owner_id', 'kind', 'entity_id'].includes(column))
      .map((column) => `${column} = excluded.${column}`)
      .join(', ')};`,
  );
  return `CREATE TRIGGER trg_search_${table}_insert AFTER INSERT ON ${table} BEGIN ${insert} END;
    CREATE TRIGGER trg_search_${table}_update AFTER UPDATE ON ${table} BEGIN
      DELETE FROM search_documents WHERE kind = '${kind}' AND owner_id = OLD.owner_id AND entity_id = OLD.id
        AND (OLD.owner_id <> NEW.owner_id OR OLD.id <> NEW.id OR NEW.deleted_at IS NOT NULL);
      ${upsert}
    END;
    CREATE TRIGGER trg_search_${table}_delete AFTER DELETE ON ${table} BEGIN ${remove} END;`;
}

const dependencies = [
  ['actions', 'action_id'],
  ['projects', 'project_id'],
  ['outcomes', 'outcome_id'],
  ['milestones', 'milestone_id'],
  ['routines', 'routine_id'],
] as const;
function refreshDecisions(table: string, targetColumn: string): string {
  const update = (
    event: string,
  ) => `CREATE TRIGGER trg_search_${table}_decision_${event} AFTER ${event.toUpperCase()} ON ${table} BEGIN
    DELETE FROM search_documents WHERE kind = 'review_decision' AND owner_id = OLD.owner_id
      AND entity_id IN (SELECT id FROM review_items WHERE owner_id = OLD.owner_id AND ${targetColumn} = OLD.id);
    INSERT INTO search_documents (${columns}) SELECT ${columns} FROM search_source_documents
      WHERE kind = 'review_decision' AND owner_id = OLD.owner_id
      AND entity_id IN (SELECT id FROM review_items WHERE owner_id = OLD.owner_id AND ${targetColumn} = OLD.id);
  END;`;
  return update('update') + update('delete');
}

// SQLite's shipped WASM has no FTS4/FTS5. Prefix-word lookup uses an owner/token B-tree instead.
// The named pure function is registered by both real drivers before migrations, including restore.
// The projection's UPSERT DO UPDATE uses SQLite's ABORT conflict policy, including nested triggers.
// Deduplicate the input explicitly; an inner INSERT OR IGNORE cannot safely absorb repeated words.
const tokenize = `INSERT INTO search_tokens(owner_id, token, kind, entity_id)
  SELECT DISTINCT NEW.owner_id, word, NEW.kind, NEW.entity_id FROM (
    WITH RECURSIVE words(word, rest) AS (
      SELECT '', yelaxis_search_normalize(NEW.title || ' ' || NEW.text_value) || ' '
      UNION ALL SELECT substr(rest, 1, instr(rest, ' ') - 1), substr(rest, instr(rest, ' ') + 1)
      FROM words WHERE rest <> ''
    ) SELECT word FROM words WHERE word <> ''
  );`;

export const searchMigration = defineMigration(
  15,
  'search',
  `
  CREATE TABLE search_documents (
    owner_id TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
    title TEXT NOT NULL, text_value TEXT NOT NULL, state TEXT NOT NULL,
    archived INTEGER NOT NULL CHECK(archived IN (0, 1)),
    axis_id TEXT, project_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
    due_date TEXT, review_type TEXT, review_key TEXT,
    PRIMARY KEY(owner_id, kind, entity_id)
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX idx_search_documents_owner_updated ON search_documents(owner_id, archived, updated_at DESC, kind, entity_id);
  CREATE INDEX idx_search_documents_owner_state ON search_documents(owner_id, state, archived, updated_at DESC, kind, entity_id);
  CREATE INDEX idx_search_documents_owner_axis ON search_documents(owner_id, axis_id, archived, updated_at DESC, kind, entity_id);
  CREATE INDEX idx_search_documents_owner_project ON search_documents(owner_id, project_id, archived, updated_at DESC, kind, entity_id);
  CREATE INDEX idx_search_documents_owner_created ON search_documents(owner_id, created_at, kind, entity_id);
  CREATE INDEX idx_search_documents_owner_due ON search_documents(owner_id, due_date, kind, entity_id);
  CREATE INDEX idx_search_placements_dates ON planning_placements(owner_id, period_start_date, period_end_date)
    WHERE archived_at IS NULL AND deleted_at IS NULL;
  CREATE TABLE search_tokens (
    owner_id TEXT NOT NULL, token TEXT NOT NULL, kind TEXT NOT NULL, entity_id TEXT NOT NULL,
    PRIMARY KEY(owner_id, token, kind, entity_id),
    FOREIGN KEY(owner_id, kind, entity_id) REFERENCES search_documents(owner_id, kind, entity_id) ON DELETE CASCADE
  ) WITHOUT ROWID, STRICT;
  CREATE INDEX idx_search_tokens_document ON search_tokens(owner_id, kind, entity_id);

  CREATE TRIGGER trg_search_documents_tokens_insert AFTER INSERT ON search_documents BEGIN ${tokenize} END;
  CREATE TRIGGER trg_search_documents_tokens_update AFTER UPDATE ON search_documents
    WHEN OLD.owner_id <> NEW.owner_id OR OLD.kind <> NEW.kind OR OLD.entity_id <> NEW.entity_id
      OR OLD.title <> NEW.title OR OLD.text_value <> NEW.text_value
  BEGIN
    DELETE FROM search_tokens WHERE owner_id = OLD.owner_id AND kind = OLD.kind AND entity_id = OLD.entity_id;
    ${tokenize}
  END;

  CREATE VIEW search_source_documents (${columns}) AS
    ${sources.map(([table, kind, fields]) => `SELECT owner_id, '${kind}', id, ${fields} FROM ${table} WHERE deleted_at IS NULL`).join('\n UNION ALL \n')}
    UNION ALL
    SELECT item.owner_id, 'review_decision', item.id,
      item.decision || ' decision: ' || review.review_type || ' ' || review.period_key,
      coalesce(item.decision_note, ''), review.state,
      item.archived_at IS NOT NULL OR review.archived_at IS NOT NULL,
      coalesce(item.axis_id, action.axis_id, project.axis_id, outcome.axis_id, milestone_outcome.axis_id, routine.axis_id),
      coalesce(item.project_id, action.project_id), item.created_at, item.updated_at, NULL,
      review.review_type, review.period_key
    FROM review_items item
    JOIN review_checkpoints review ON review.owner_id = item.owner_id AND review.id = item.review_id AND review.deleted_at IS NULL
    LEFT JOIN actions action ON action.owner_id = item.owner_id AND action.id = item.action_id AND action.deleted_at IS NULL
    LEFT JOIN projects project ON project.owner_id = item.owner_id AND project.id = item.project_id AND project.deleted_at IS NULL
    LEFT JOIN outcomes outcome ON outcome.owner_id = item.owner_id AND outcome.id = item.outcome_id AND outcome.deleted_at IS NULL
    LEFT JOIN milestones milestone ON milestone.owner_id = item.owner_id AND milestone.id = item.milestone_id AND milestone.deleted_at IS NULL
    LEFT JOIN outcomes milestone_outcome ON milestone_outcome.owner_id = milestone.owner_id AND milestone_outcome.id = milestone.outcome_id AND milestone_outcome.deleted_at IS NULL
    LEFT JOIN routines routine ON routine.owner_id = item.owner_id AND routine.id = item.routine_id AND routine.deleted_at IS NULL
    WHERE item.deleted_at IS NULL;

  ${sources.map(([table, kind]) => refresh(table, kind)).join('\n')}
  ${refresh('review_items', 'review_decision')}
  ${dependencies.map(([table, targetColumn]) => refreshDecisions(table, targetColumn)).join('\n')}
  CREATE TRIGGER trg_search_reviews_dependants_update AFTER UPDATE ON review_checkpoints BEGIN
    DELETE FROM search_documents WHERE kind = 'review_decision' AND owner_id = OLD.owner_id
      AND entity_id IN (SELECT id FROM review_items WHERE owner_id = OLD.owner_id AND review_id = OLD.id);
    INSERT INTO search_documents (${columns}) SELECT ${columns} FROM search_source_documents WHERE kind = 'review_decision' AND owner_id = NEW.owner_id
      AND entity_id IN (SELECT id FROM review_items WHERE owner_id = NEW.owner_id AND review_id = NEW.id);
  END;
  CREATE TRIGGER trg_search_reviews_dependants_delete AFTER DELETE ON review_checkpoints BEGIN
    DELETE FROM search_documents WHERE kind = 'review_decision' AND owner_id = OLD.owner_id
      AND entity_id IN (SELECT id FROM review_items WHERE owner_id = OLD.owner_id AND review_id = OLD.id);
  END;
  CREATE TRIGGER trg_search_outcome_milestones_update AFTER UPDATE OF axis_id, owner_id, deleted_at ON outcomes BEGIN
    DELETE FROM search_documents WHERE kind = 'milestone' AND owner_id = OLD.owner_id
      AND entity_id IN (SELECT id FROM milestones WHERE owner_id = OLD.owner_id AND outcome_id = OLD.id);
    INSERT INTO search_documents (${columns}) SELECT ${columns} FROM search_source_documents WHERE kind = 'milestone' AND owner_id = NEW.owner_id
      AND entity_id IN (SELECT id FROM milestones WHERE owner_id = NEW.owner_id AND outcome_id = NEW.id);
    DELETE FROM search_documents WHERE kind = 'review_decision' AND owner_id = NEW.owner_id
      AND entity_id IN (SELECT item.id FROM review_items item JOIN milestones milestone
        ON milestone.owner_id = item.owner_id AND milestone.id = item.milestone_id
        WHERE milestone.owner_id = NEW.owner_id AND milestone.outcome_id = NEW.id);
    INSERT INTO search_documents (${columns}) SELECT ${columns} FROM search_source_documents WHERE kind = 'review_decision' AND owner_id = NEW.owner_id
      AND entity_id IN (SELECT item.id FROM review_items item JOIN milestones milestone
        ON milestone.owner_id = item.owner_id AND milestone.id = item.milestone_id
        WHERE milestone.owner_id = NEW.owner_id AND milestone.outcome_id = NEW.id);
  END;
  INSERT INTO search_documents (${columns}) SELECT ${columns} FROM search_source_documents;
`,
);
