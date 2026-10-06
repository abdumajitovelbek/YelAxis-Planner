import { useEffect, useRef, useState, type ReactNode } from 'react';

import { saveFile } from '../account/download';
import { diagnosticText as text } from './diagnostics-copy';
import { inspectDiagnosticCapabilities, type DiagnosticReport } from './diagnostics';

export function DiagnosticsPanel(): ReactNode {
  const [report, setReport] = useState<DiagnosticReport | null>(null);
  const [status, setStatus] = useState<string | null>(null);
  const previewButton = useRef<HTMLButtonElement>(null);
  const previewContent = useRef<HTMLPreElement>(null);
  const restoreFocus = useRef(false);
  useEffect(() => {
    if (report !== null) previewContent.current?.focus();
    else if (restoreFocus.current) {
      previewButton.current?.focus();
      restoreFocus.current = false;
    }
  }, [report]);
  return (
    <section className="settings-section diagnostics-section" aria-labelledby="diagnostics-heading">
      <h2 id="diagnostics-heading">{text('heading')}</h2>
      <p>{text('explanation')}</p>
      {report === null ? (
        <button
          ref={previewButton}
          type="button"
          onClick={() => {
            setReport(inspectDiagnosticCapabilities());
            setStatus(null);
          }}
        >
          {text('preview')}
        </button>
      ) : (
        <>
          <pre
            ref={previewContent}
            tabIndex={-1}
            style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}
          >
            {JSON.stringify(report, null, 2)}
          </pre>
          <button
            type="button"
            onClick={() => {
              try {
                saveFile({
                  fileName: 'yelaxis-support.json',
                  blob: new Blob([JSON.stringify(report, null, 2) + '\n'], {
                    type: 'application/json',
                  }),
                });
                setStatus(text('handedOff'));
              } catch {
                setStatus(text('failed'));
              }
            }}
          >
            {text('download')}
          </button>
          <button
            type="button"
            onClick={() => {
              restoreFocus.current = true;
              setReport(null);
              setStatus(null);
            }}
          >
            {text('cancel')}
          </button>
        </>
      )}
      <p role="status">{status}</p>
    </section>
  );
}
