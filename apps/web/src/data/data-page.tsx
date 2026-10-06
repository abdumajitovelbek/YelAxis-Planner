import { message as uiMessage } from '../messages';
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  readTemplateExport,
  type ExportApplication,
  type ExportPreview,
  type ImportApplication,
  type PlanningApplication,
} from '@yelaxis/application';

import { saveFile } from '../account/download';
import { ImportPanel } from '../import/import-panel';
import { notifyPlanChanged } from '../plan/planning-context';
import { templateErrorMessage } from '../plan/template-editor';
import './data.css';

const download = (text: string, fileName: string, type: string): void =>
  saveFile({ fileName, blob: new Blob([text], { type }) });

export function DataPage({
  exports,
  imports,
  planning,
  durability,
  onImported,
}: {
  readonly exports: ExportApplication;
  readonly imports: ImportApplication;
  readonly planning: PlanningApplication;
  readonly durability: 'best-effort' | 'persistent';
  readonly onImported: () => void;
}): ReactNode {
  const [preview, setPreview] = useState<ExportPreview | null>(null);
  const [includeSensitive, setIncludeSensitive] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState('');
  const run = async (operation: () => Promise<void>): Promise<void> => {
    setBusy(true);
    setError(null);
    setMessage('');
    try {
      await operation();
    } catch {
      setError(uiMessage('data.data-page.846'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="content-section data-page" aria-labelledby="data-heading" aria-busy={busy}>
      <Link className="back-link" to="/settings">
        {uiMessage('data.data-page.847')}
      </Link>
      <p className="eyebrow">{uiMessage('data.data-page.848')}</p>
      <h1 id="data-heading">{uiMessage('data.data-page.849')}</h1>
      <p>{uiMessage('data.data-page.850')}</p>
      <p>{uiMessage('data.data-page.851')}</p>
      <p role="status">{message}</p>
      {error !== null && <p role="alert">{error}</p>}
      <section className="settings-section data-section" aria-labelledby="export-heading">
        <h2 id="export-heading">{uiMessage('data.data-page.852')}</h2>
        <p>{uiMessage('data.data-page.853')}</p>
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void run(async () => {
              const result = await exports.preview();
              if (!result.ok) {
                setPreview(null);
                throw new Error(result.code);
              }
              setPreview(result.value);
              setIncludeSensitive(true);
              setMessage(uiMessage('data.data-page.854'));
            })
          }
        >
          {uiMessage('data.data-page.855')}
        </button>
        {preview !== null && (
          <div className="export-preview">
            <h3>{uiMessage('data.data-page.856')}</h3>
            <p>
              {preview.recordCount}
              {uiMessage('data.data-page.857')}
              {preview.exportedAt}
            </p>
            <dl>
              {Object.entries(preview.counts)
                .filter(([, count]) => count > 0)
                .map(([section, count]) => (
                  <div key={section}>
                    <dt>{section.replaceAll('_', ' ')}</dt>
                    <dd>{count}</dd>
                  </div>
                ))}
            </dl>
            <p>
              {preview.syncWasPending
                ? uiMessage('data.data-page.858')
                : uiMessage('data.data-page.859')}
            </p>
            <label className="toggle-row">
              <input
                type="checkbox"
                checked={includeSensitive}
                onChange={(event) => setIncludeSensitive(event.target.checked)}
              />
              {uiMessage('data.data-page.860')}
              {preview.sensitiveContextCount}
              {uiMessage('data.data-page.861')}
              {preview.includesSensitiveConflict ? uiMessage('data.data-page.862') : ''})
            </label>
            <p>{uiMessage('data.data-page.863')}</p>
            <div className="dialog-actions">
              <button
                className="primary-button"
                type="button"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await exports.backup(includeSensitive);
                    if (!result.ok) throw new Error(result.code);
                    download(
                      result.value.text,
                      `yelaxis-${includeSensitive ? 'backup' : 'reduced'}-${result.value.exportedAt.slice(0, 10)}.json`,
                      'application/json;charset=utf-8',
                    );
                    setMessage(uiMessage('data.data-page.864'));
                  })
                }
              >
                {uiMessage('data.data-page.865')}
              </button>
              {(
                [
                  ['actions', uiMessage('data.data-page.866'), 'actions.csv'],
                  ['blocks', uiMessage('data.data-page.867'), 'time-blocks.csv'],
                  ['reviews', uiMessage('data.data-page.868'), 'reviews.md'],
                ] as const
              ).map(([kind, label, file]) => (
                <button
                  key={kind}
                  disabled={busy}
                  type="button"
                  onClick={() =>
                    void run(async () => {
                      const result = await exports.convenience(kind);
                      if (!result.ok) throw new Error(result.code);
                      download(
                        result.value,
                        file,
                        kind === 'reviews'
                          ? 'text/markdown;charset=utf-8'
                          : 'text/csv;charset=utf-8',
                      );
                      setMessage(uiMessage('data.data-page.869', { value0: label }));
                    })
                  }
                >
                  {uiMessage('data.data-page.870')}
                  {label}
                </button>
              ))}
            </div>
            <p>{uiMessage('data.data-page.871')}</p>
          </div>
        )}
      </section>
      <ImportPanel
        application={imports}
        onChanged={() => {
          setPreview(null);
          notifyPlanChanged();
          onImported();
        }}
        onDownload={(text, fileName) => download(text, fileName, 'application/json;charset=utf-8')}
      />
      <TemplateImport planning={planning} />
      <section className="settings-section data-section" aria-labelledby="storage-heading">
        <h2 id="storage-heading">{uiMessage('data.data-page.872')}</h2>
        <p>
          {uiMessage('data.data-page.873')}{' '}
          {durability === 'persistent'
            ? uiMessage('data.data-page.874')
            : uiMessage('data.data-page.875')}
          {uiMessage('data.data-page.876')}
        </p>
        <p>{uiMessage('data.data-page.877')}</p>
        <p>{uiMessage('data.data-page.878')}</p>
        <p>{uiMessage('data.data-page.879')}</p>
      </section>
    </section>
  );
}

function TemplateImport({ planning }: { readonly planning: PlanningApplication }): ReactNode {
  const [candidate, setCandidate] = useState<
    Extract<ReturnType<typeof readTemplateExport>, { ok: true }>['value'] | null
  >(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const activeRead = useRef(0);
  useEffect(
    () => () => {
      activeRead.current += 1;
    },
    [],
  );
  return (
    <section className="settings-section data-section" aria-labelledby="template-import-heading">
      <h2 id="template-import-heading">{uiMessage('data.data-page.880')}</h2>
      <p>{uiMessage('data.data-page.881')}</p>
      <label className="form-field">
        {uiMessage('data.data-page.882')}
        <input
          type="file"
          accept="application/json,.json"
          disabled={busy}
          onChange={(event) => {
            const token = ++activeRead.current;
            const file = event.target.files?.[0];
            setCandidate(null);
            setMessage(null);
            if (file === undefined) return;
            if (file.size > 1_048_576) {
              setMessage(uiMessage('data.data-page.883'));
              return;
            }
            void file.text().then(
              (text) => {
                if (activeRead.current !== token) return;
                const result = readTemplateExport(text);
                if (result.ok) setCandidate(result.value);
                else setMessage(uiMessage('data.data-page.884'));
              },
              () => {
                if (activeRead.current === token) setMessage(uiMessage('data.data-page.885'));
              },
            );
          }}
        />
      </label>
      {message !== null && <p role="status">{message}</p>}
      {candidate !== null && (
        <div>
          <h3>{candidate.title}</h3>
          <ul>
            {candidate.blueprint.items.map((item) => (
              <li key={item.templateKey}>
                {item.kind}: {item.title}
              </li>
            ))}
          </ul>
          <button
            disabled={busy}
            type="button"
            onClick={() => {
              setBusy(true);
              void planning
                .saveTemplate({ title: candidate.title, blueprint: candidate.blueprint })
                .then(
                  (result) => {
                    setMessage(
                      result.ok
                        ? uiMessage('data.data-page.886')
                        : templateErrorMessage(result.error),
                    );
                    if (result.ok) {
                      setCandidate(null);
                      notifyPlanChanged();
                    }
                  },
                  () => setMessage(uiMessage('data.data-page.887')),
                )
                .finally(() => setBusy(false));
            }}
          >
            {uiMessage('data.data-page.888')}
          </button>
        </div>
      )}
    </section>
  );
}
