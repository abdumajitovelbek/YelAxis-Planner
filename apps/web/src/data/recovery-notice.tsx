import { message as uiMessage } from '../messages';
import { useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { ImportApplication } from '@yelaxis/application';
import { planChangedEvent } from '../plan/planning-context';

export function ImportRecoveryNotice({
  application,
}: {
  readonly application: ImportApplication;
}): ReactNode {
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let active = true;
    const read = (): void => {
      void application.pending().then(
        (journal) => {
          if (active) {
            setPending(journal !== null);
            setFailed(false);
          }
        },
        () => {
          if (active) setFailed(true);
        },
      );
    };
    read();
    window.addEventListener(planChangedEvent, read);
    return () => {
      active = false;
      window.removeEventListener(planChangedEvent, read);
    };
  }, [application]);
  return pending || failed ? (
    <div className="setup-banner" role="status">
      <span>
        {pending ? uiMessage('data.recovery-notice.889') : uiMessage('data.recovery-notice.890')}
      </span>
      <Link className="inline-button" to="/data">
        {uiMessage('data.recovery-notice.891')}
      </Link>
    </div>
  ) : null;
}
