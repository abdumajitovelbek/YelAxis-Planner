import { message as uiMessage } from '../messages';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import type {
  BundleConflictCandidate,
  ImportApplication,
  ImportChoice,
  ImportErrorCode,
  ImportJournal,
  ImportMode,
  ImportPreview,
  ImportRecoveryBackup,
} from '@yelaxis/application';
import { notifyPlanChanged } from '../plan/planning-context';

const fileLimit = 50 * 1024 * 1024;
const errors: Readonly<Record<ImportErrorCode, string>> = {
  invalid_bundle: uiMessage('import.import-panel.892'),
  input_limit: uiMessage('import.import-panel.893'),
  unsupported_format: uiMessage('import.import-panel.894'),
  digest_mismatch: uiMessage('import.import-panel.895'),
  invalid_record: uiMessage('import.import-panel.896'),
  invalid_graph: uiMessage('import.import-panel.897'),
  conflicts_unresolved: uiMessage('import.import-panel.898'),
  preview_missing: uiMessage('import.import-panel.899'),
  preview_stale: uiMessage('import.import-panel.900'),
  confirmation_required: uiMessage('import.import-panel.901'),
  backup_failed: uiMessage('import.import-panel.902'),
  storage_failed: uiMessage('import.import-panel.903'),
};

export function ImportPanel({
  application,
  onChanged,
  onDownload,
}: {
  readonly application: ImportApplication;
  readonly onChanged: () => void;
  readonly onDownload: (text: string, fileName: string) => void;
}): ReactNode {
  const [text, setText] = useState<string | null>(null);
  const [mode, setMode] = useState<ImportMode>('merge');
  const [choices, setChoices] = useState<readonly ImportChoice[]>([]);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [pending, setPending] = useState<ImportJournal | null>(null);
  const [backup, setBackup] = useState<ImportRecoveryBackup | null>(null);
  const [candidates, setCandidates] = useState<readonly BundleConflictCandidate[]>([]);
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState<string | null>(null);
  const messageRef = useRef<HTMLParagraphElement>(null);
  const previewRef = useRef<HTMLHeadingElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const activeRead = useRef(0);
  const loadRecovery = async (): Promise<void> => {
    const [journal, retained, conflicts] = await Promise.all([
      application.pending(),
      application.recoveryBackup(),
      application.recoveryConflicts(),
    ]);
    setPending(journal);
    setBackup(retained);
    setCandidates(conflicts);
  };
  useEffect(() => {
    let active = true;
    void Promise.all([
      application.pending(),
      application.recoveryBackup(),
      application.recoveryConflicts(),
    ]).then(
      ([journal, retained, conflicts]) => {
        if (active) {
          setPending(journal);
          setBackup(retained);
          setCandidates(conflicts);
        }
      },
      () => {
        if (active) setError(uiMessage('import.import-panel.904'));
      },
    );
    return () => {
      active = false;
      activeRead.current += 1;
    };
  }, [application]);
  useEffect(() => {
    if (message !== '' || error !== null) messageRef.current?.focus();
  }, [message, error]);
  useEffect(() => {
    if (preview !== null) previewRef.current?.focus();
  }, [preview]);

  const run = async (work: () => Promise<void>): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await work();
    } catch {
      setError(errors.storage_failed);
    } finally {
      setBusy(false);
    }
  };
  const makePreview = async (
    candidate: string,
    nextMode: ImportMode,
    nextChoices: readonly ImportChoice[],
  ): Promise<void> => {
    const result = await application.preview(candidate, { mode: nextMode, decisions: nextChoices });
    if (!result.ok) {
      setPreview(null);
      setError(errors[result.code]);
      return;
    }
    setPreview(result.value);
    setPending(null);
    setConfirmation('');
    notifyPlanChanged();
  };
  const choose = (choice: ImportChoice): void => {
    if (text === null) return;
    const next = [
      ...choices.filter((current) => current.type !== choice.type || current.id !== choice.id),
      choice,
    ];
    setChoices(next);
    void run(() => makePreview(text, mode, next));
  };
  const readFile = (file: File | undefined): void => {
    const token = ++activeRead.current;
    setPreview(null);
    setText(null);
    setChoices([]);
    setConfirmation('');
    setError(null);
    setMessage('');
    if (file === undefined) return;
    if (file.size > fileLimit) {
      setError(uiMessage('import.import-panel.905'));
      return;
    }
    void run(async () => {
      const value = await file.text();
      if (activeRead.current !== token) return;
      setText(value);
      await makePreview(value, mode, []);
    });
  };

  return (
    <section
      className="settings-section data-section"
      aria-labelledby="import-heading"
      aria-busy={busy}
    >
      <h2 id="import-heading">{uiMessage('import.import-panel.906')}</h2>
      <p>{uiMessage('import.import-panel.907')}</p>
      <p ref={messageRef} tabIndex={-1} role={error !== null ? 'alert' : 'status'}>
        {error ?? message}
      </p>
      {pending !== null && (
        <div className="validation-summary" role="status">
          <h3>{uiMessage('import.import-panel.908')}</h3>
          <p>{uiMessage('import.import-panel.909')}</p>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await application.resume();
                if (!result.ok) {
                  setError(errors[result.code]);
                  return;
                }
                setText(pending.text);
                setMode(pending.mode);
                setChoices(pending.decisions);
                setPreview(result.value);
                setPending(null);
              })
            }
          >
            {uiMessage('import.import-panel.910')}
          </button>{' '}
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void run(async () => {
                const result = await application.discard();
                if (!result.ok) {
                  setError(errors[result.code]);
                  return;
                }
                setPending(null);
                setMessage(uiMessage('import.import-panel.911'));
                notifyPlanChanged();
              })
            }
          >
            {uiMessage('import.import-panel.912')}
          </button>
        </div>
      )}
      <fieldset disabled={busy}>
        <legend>{uiMessage('import.import-panel.913')}</legend>
        <label>
          <input
            type="radio"
            name="import-mode"
            value="merge"
            checked={mode === 'merge'}
            onChange={() => {
              setMode('merge');
              setPreview(null);
              if (text !== null) void run(() => makePreview(text, 'merge', choices));
            }}
          />{' '}
          {uiMessage('import.import-panel.914')}
        </label>{' '}
        <label>
          <input
            type="radio"
            name="import-mode"
            value="replace"
            checked={mode === 'replace'}
            onChange={() => {
              setMode('replace');
              setPreview(null);
              if (text !== null) void run(() => makePreview(text, 'replace', choices));
            }}
          />{' '}
          {uiMessage('import.import-panel.915')}
        </label>
      </fieldset>
      <label className="form-field">
        {uiMessage('import.import-panel.916')}
        <input
          ref={inputRef}
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(event) => readFile(event.target.files?.[0])}
        />
      </label>
      {preview !== null && (
        <div className="import-preview">
          <h3 ref={previewRef} tabIndex={-1}>
            {uiMessage('import.import-panel.917')}
          </h3>
          <dl>
            <div>
              <dt>{uiMessage('import.import-panel.918')}</dt>
              <dd>{preview.creates}</dd>
            </div>
            <div>
              <dt>{uiMessage('import.import-panel.919')}</dt>
              <dd>{preview.updates}</dd>
            </div>
            <div>
              <dt>{uiMessage('import.import-panel.920')}</dt>
              <dd>{preview.deletes}</dd>
            </div>
            <div>
              <dt>{uiMessage('import.import-panel.921')}</dt>
              <dd>{preview.identicalSkips}</dd>
            </div>
            <div>
              <dt>{uiMessage('import.import-panel.922')}</dt>
              <dd>{preview.keeps}</dd>
            </div>
          </dl>
          <p>
            {preview.sensitiveContextCount}
            {uiMessage('import.import-panel.923')}
            {preview.recoveryConflicts} {uiMessage('import.import-panel.924')}{' '}
            {Math.ceil(preview.expectedStorageBytes / 1024)}
            {uiMessage('import.import-panel.925')}
          </p>
          {preview.backupRequired && <p>{uiMessage('import.import-panel.926')}</p>}
          {preview.accountLinked && <p>{uiMessage('import.import-panel.927')}</p>}
          {mode === 'replace' && <p>{uiMessage('import.import-panel.928')}</p>}
          {preview.conflicts.length > 0 && (
            <div>
              <h4>{uiMessage('import.import-panel.929')}</h4>
              {preview.conflicts.map((conflict) => (
                <fieldset key={`${conflict.type}:${conflict.id}`} disabled={busy}>
                  <legend>
                    {conflict.title} ·{' '}
                    {conflict.reason === 'id_collision'
                      ? uiMessage('import.import-panel.930')
                      : conflict.reason === 'deleted_here'
                        ? uiMessage('import.import-panel.931')
                        : uiMessage('import.import-panel.932')}
                  </legend>
                  <Candidate
                    side={conflict.current}
                    label={uiMessage('import.import-panel.933')}
                    links={conflict.linkTitles}
                  />
                  <Candidate
                    side={conflict.imported}
                    label={uiMessage('import.import-panel.934')}
                    links={conflict.linkTitles}
                  />
                  {conflict.choices.map((decision) => (
                    <button
                      key={decision}
                      type="button"
                      onClick={() => choose({ type: conflict.type, id: conflict.id, decision })}
                    >
                      {decision === 'keep_current'
                        ? uiMessage('import.import-panel.935')
                        : decision === 'use_imported'
                          ? uiMessage('import.import-panel.936')
                          : uiMessage('import.import-panel.937')}
                    </button>
                  ))}
                </fieldset>
              ))}
            </div>
          )}
          {preview.problems.length > 0 && (
            <div role="alert">
              <h4>{uiMessage('import.import-panel.938')}</h4>
              <ul>
                {preview.problems.map((problem, index) => (
                  <li key={`${problem.code}:${index}`}>{problemText(problem.code)}</li>
                ))}
              </ul>
            </div>
          )}
          {mode === 'replace' && (
            <label className="form-field">
              {uiMessage('import.import-panel.939')}
              <input
                autoComplete="off"
                value={confirmation}
                disabled={busy}
                onChange={(event) => setConfirmation(event.target.value)}
              />
            </label>
          )}
          <div className="dialog-actions">
            <button
              type="button"
              className="primary-button"
              disabled={
                busy ||
                !preview.canApply ||
                (mode === 'replace' && confirmation !== 'REPLACE MY PLAN')
              }
              onClick={() =>
                void run(async () => {
                  const result = await application.apply(preview.previewId, confirmation);
                  if (!result.ok) {
                    setError(errors[result.code]);
                    await loadRecovery();
                    return;
                  }
                  setPreview(null);
                  setText(null);
                  setChoices([]);
                  setConfirmation('');
                  if (inputRef.current) inputRef.current.value = '';
                  setMessage(uiMessage('import.import-panel.940'));
                  onChanged();
                  await loadRecovery();
                })
              }
            >
              {mode === 'replace'
                ? uiMessage('import.import-panel.941')
                : uiMessage('import.import-panel.942')}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  const result = await application.discard();
                  if (!result.ok) {
                    setError(errors[result.code]);
                    return;
                  }
                  setPreview(null);
                  setText(null);
                  setChoices([]);
                  if (inputRef.current) inputRef.current.value = '';
                  setMessage(uiMessage('import.import-panel.943'));
                  notifyPlanChanged();
                })
              }
            >
              {uiMessage('import.import-panel.944')}
            </button>
          </div>
        </div>
      )}
      {backup !== null && (
        <div>
          <h3>{uiMessage('import.import-panel.945')}</h3>
          <p>
            {backup.recordCount}
            {uiMessage('import.import-panel.946')}
            {backup.createdAt}
            {uiMessage('import.import-panel.947')}
          </p>
          <button
            disabled={busy}
            type="button"
            onClick={() => {
              try {
                onDownload(backup.text, `yelaxis-pre-import-${backup.createdAt.slice(0, 10)}.json`);
                setMessage(uiMessage('import.import-panel.948'));
              } catch {
                setError(uiMessage('import.import-panel.949'));
              }
            }}
          >
            {uiMessage('import.import-panel.950')}
          </button>{' '}
          <button
            disabled={busy}
            type="button"
            onClick={() =>
              void run(async () => {
                setMode('replace');
                setText(backup.text);
                setChoices([]);
                await makePreview(backup.text, 'replace', []);
              })
            }
          >
            {uiMessage('import.import-panel.951')}
          </button>
        </div>
      )}
      {candidates.length > 0 && (
        <div>
          <h3>{uiMessage('import.import-panel.952')}</h3>
          <p>{uiMessage('import.import-panel.953')}</p>
          {candidates.map((candidate) => (
            <fieldset key={candidate.conflictId} disabled={busy}>
              <legend>
                {candidate.entityType.replaceAll('_', ' ')}
                {uiMessage('import.import-panel.954')}
              </legend>
              <Candidate side={candidate.local} label={uiMessage('import.import-panel.955')} />
              <Candidate side={candidate.remote} label={uiMessage('import.import-panel.956')} />
              {(
                [
                  ['keep_current', uiMessage('import.import-panel.957')],
                  ['use_local', uiMessage('import.import-panel.958')],
                  ['use_remote', uiMessage('import.import-panel.959')],
                ] as const
              ).map(([choice, label]) => (
                <button
                  key={choice}
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      const result = await application.resolveRecovery(
                        candidate.conflictId,
                        choice,
                      );
                      if (!result.ok) {
                        setError(errors[result.code]);
                        return;
                      }
                      setMessage(uiMessage('import.import-panel.960'));
                      onChanged();
                      await loadRecovery();
                    })
                  }
                >
                  {label}
                </button>
              ))}
            </fieldset>
          ))}
        </div>
      )}
    </section>
  );
}

function problemText(code: ImportPreview['problems'][number]['code']): string {
  switch (code) {
    case 'missing_reference':
      return uiMessage('import.import-panel.961');
    case 'focus_limit':
      return uiMessage('import.import-panel.962');
    case 'invalid_period':
      return uiMessage('import.import-panel.963');
    case 'duplicate_target':
      return uiMessage('import.import-panel.964');
    case 'relationship_mismatch':
      return uiMessage('import.import-panel.965');
    case 'routine_mismatch':
      return uiMessage('import.import-panel.966');
    case 'required_profile':
      return uiMessage('import.import-panel.967');
    case 'unconfirmed_sync':
      return uiMessage('import.import-panel.968');
    case 'destination_conflicts':
      return uiMessage('import.import-panel.969');
  }
}

function Candidate({
  side,
  label,
  links = {},
}: {
  readonly side: BundleConflictCandidate['local'];
  readonly label: string;
  readonly links?: Readonly<Record<string, string>>;
}): ReactNode {
  const display = (value: unknown): string => {
    if (typeof value === 'string')
      return /^[0-9a-f-]{36}$/u.test(value)
        ? (links[value] ?? uiMessage('import.import-panel.970'))
        : value;
    if (Array.isArray(value)) return value.map(display).join('; ');
    if (value !== null && typeof value === 'object')
      return Object.entries(value)
        .map(
          ([field, child]) =>
            `${field.replace(/([A-Z])/gu, ' $1').toLowerCase()}: ${display(child)}`,
        )
        .join(', ');
    return value === null || value === undefined
      ? uiMessage('import.import-panel.971')
      : typeof value === 'number' || typeof value === 'boolean'
        ? String(value)
        : '';
  };
  return (
    <div>
      <h4>{label}</h4>
      {side.deleted ? (
        <p>{uiMessage('import.import-panel.972')}</p>
      ) : (
        <dl>
          {Object.entries(side.document ?? {}).map(([field, value]) => (
            <div key={field}>
              <dt>{field.replace(/([A-Z])/gu, ' $1').toLowerCase()}</dt>
              <dd>{display(value)}</dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}
