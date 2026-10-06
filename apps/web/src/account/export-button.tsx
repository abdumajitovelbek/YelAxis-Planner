import { message as uiMessage } from '../messages';
/**
 * "Export account data": the export is made from this device's canonical copy,
 * including changes that have not synced, and downloaded at once. The result says when changes
 * were still waiting to sync, as the file itself does.
 */
import { useRef, useState, type ReactNode } from 'react';

import { useAccount } from './account-context';
import type { ExportFile } from './account-service';
import {
  ResultRegion,
  attempt,
  nextMessage,
  useFocusAfter,
  useResultMessage,
  type KeyedMessage,
} from './account-parts';
import { saveFile } from './download';
import { recordsText } from './sync-text';

export function exportedText(file: ExportFile): string {
  return uiMessage('account.export-button.156', {
    value0: recordsText(file.recordCount),
    value1: file.fileName,
    value2: file.syncWasPending ? ' It includes changes that have not synced yet.' : '',
  });
}

export function ExportButton(): ReactNode {
  const { account } = useAccount();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<KeyedMessage | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const result = useResultMessage();
  useFocusAfter(errorRef, error?.key ?? 0);

  const run = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    result.clear();
    const outcome = await attempt(
      () => account.exportAccount(),
      uiMessage('account.export-button.157'),
    );
    setBusy(false);
    if (!outcome.ok) {
      setError((current) => nextMessage(current, outcome.message));
      return;
    }
    try {
      saveFile(outcome.value);
    } catch {
      setError((current) => nextMessage(current, uiMessage('account.export-button.158')));
      return;
    }
    result.show(exportedText(outcome.value));
  };

  return (
    <div className="account-export">
      <div className="account-actions">
        <button type="button" aria-disabled={busy ? true : undefined} onClick={() => void run()}>
          {busy ? uiMessage('account.export-button.159') : uiMessage('account.export-button.160')}
        </button>
      </div>
      {error !== null && (
        <p key={error.key} ref={errorRef} className="validation-summary" role="alert" tabIndex={-1}>
          {error.text}
        </p>
      )}
      <ResultRegion result={result} />
    </div>
  );
}
