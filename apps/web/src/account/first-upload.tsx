import { message as uiMessage } from '../messages';
/**
 * The first upload of a local plan (the identity contract). The choice shows what
 * would upload before anything is sent: counts by kind, whether the account already has data, and
 * the sensitive Context entries included. "Upload this plan" makes and checks a backup first;
 * "Keep this plan on this device" uploads nothing; "Cancel sign-in" backs out, leaving the local
 * plan exactly as it was. While the upload runs (the whole link, also when a conflict, a rejection,
 * or an ended session needs attention), its progress, "Cancel upload", and a download link to the
 * verified backup are shown.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';

import { useAccount } from './account-context';
import type { FirstUploadPreview } from './account-service';
import {
  CountsList,
  Heading,
  attempt,
  nextLevel,
  nextMessage,
  useAccountRead,
  useFocusAfter,
  type HeadingLevel,
  type KeyedMessage,
} from './account-parts';
import { useObjectUrl } from './download';
import { recordsText } from './sync-text';

export const firstUploadTitle = uiMessage('account.first-upload.161');

export function cloudPresenceText(count: number): string {
  return count === 0
    ? uiMessage('account.first-upload.162')
    : uiMessage('account.first-upload.163', { value0: recordsText(count) });
}

export function sensitiveContextText(count: number): string {
  if (count === 0) return uiMessage('account.first-upload.164');
  return count === 1
    ? uiMessage('account.first-upload.165')
    : uiMessage('account.first-upload.166', { value0: String(count) });
}

type ChoiceAction = 'upload' | 'keep' | 'cancel';

export function FirstUploadChoice({
  level,
  onBusyChange,
  onCanceled,
  onKept,
  onStarted,
  preview,
  showTitle,
}: {
  readonly preview: FirstUploadPreview;
  /** The level of the choice's title; its parts sit one level below. */
  readonly level: HeadingLevel;
  /** False inside a dialog whose own title asks the question. */
  readonly showTitle: boolean;
  readonly onStarted: () => void;
  readonly onKept: () => void;
  /** Cancel sign-in: signed out, nothing uploaded, the local plan exactly as it was. */
  readonly onCanceled: () => void;
  /** Whether a choice is being carried out (a dialog does not cancel one that is under way). */
  readonly onBusyChange?: (busy: boolean) => void;
}): ReactNode {
  const { account, setFirstUpload } = useAccount();
  const id = useId();
  const [busy, setBusyState] = useState<ChoiceAction | null>(null);
  const [error, setError] = useState<KeyedMessage | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const introRef = useRef<HTMLParagraphElement>(null);
  useFocusAfter(errorRef, error?.key ?? 0);
  // The choice appears after sign-in: reading starts at its question.
  useEffect(() => {
    (showTitle ? titleRef : introRef).current?.focus();
  }, []);
  const setBusy = (next: ChoiceAction | null): void => {
    setBusyState(next);
    onBusyChange?.(next !== null);
  };

  const choose = async (action: ChoiceAction): Promise<void> => {
    if (busy !== null) return;
    setBusy(action);
    setError(null);
    const result = await attempt(
      () =>
        action === 'upload'
          ? account.startFirstUpload()
          : action === 'keep'
            ? account.declineFirstUpload()
            : account.cancelFirstUpload(),
      action === 'upload'
        ? uiMessage('account.first-upload.167')
        : action === 'keep'
          ? uiMessage('account.first-upload.168')
          : uiMessage('account.first-upload.169'),
    );
    setBusy(null);
    if (!result.ok) {
      setError((current) => nextMessage(current, result.message));
      return;
    }
    if (action === 'upload') {
      setFirstUpload({ phase: 'started' });
      onStarted();
      return;
    }
    setFirstUpload(null);
    if (action === 'keep') onKept();
    else onCanceled();
  };

  const sub = nextLevel(level);
  const titleId = `${id}-title`;
  const content = (
    <>
      {showTitle && (
        <Heading level={level} id={titleId} ref={titleRef} tabIndex={-1}>
          {firstUploadTitle}
        </Heading>
      )}
      <p ref={introRef} tabIndex={-1} className="account-lead">
        {uiMessage('account.first-upload.170', { value0: preview.accountEmail })}
      </p>
      <Heading level={sub}>{uiMessage('account.first-upload.171')}</Heading>
      <p>{uiMessage('account.first-upload.172', { value0: recordsText(preview.local.total) })}</p>
      <CountsList counts={preview.local} label={uiMessage('account.first-upload.173')} />
      <Heading level={sub}>{uiMessage('account.first-upload.174')}</Heading>
      <p>{cloudPresenceText(preview.cloudRecordCount)}</p>
      <Heading level={sub}>{uiMessage('account.first-upload.175')}</Heading>
      <p>{sensitiveContextText(preview.sensitiveContextCount)}</p>
      <Heading level={sub}>{uiMessage('account.first-upload.176')}</Heading>
      <p>{uiMessage('account.first-upload.177')}</p>
      {error !== null && (
        <p key={error.key} ref={errorRef} className="validation-summary" role="alert" tabIndex={-1}>
          {error.text}
        </p>
      )}
      <div className="account-actions">
        <button
          type="button"
          className="primary-button"
          aria-disabled={busy !== null ? true : undefined}
          onClick={() => void choose('upload')}
        >
          {busy === 'upload'
            ? uiMessage('account.first-upload.178')
            : uiMessage('account.first-upload.179')}
        </button>
        <button
          type="button"
          aria-disabled={busy !== null ? true : undefined}
          aria-describedby={`${id}-keep-help`}
          onClick={() => void choose('keep')}
        >
          {busy === 'keep'
            ? uiMessage('account.first-upload.180')
            : uiMessage('account.first-upload.181')}
        </button>
        <button
          type="button"
          aria-disabled={busy !== null ? true : undefined}
          aria-describedby={`${id}-cancel-help`}
          onClick={() => void choose('cancel')}
        >
          {busy === 'cancel'
            ? uiMessage('account.account-page.107')
            : uiMessage('account.first-upload.182')}
        </button>
      </div>
      <p id={`${id}-keep-help`} className="field-help">
        {uiMessage('account.first-upload.183')}
      </p>
      <p id={`${id}-cancel-help`} className="field-help">
        {uiMessage('account.first-upload.184')}
      </p>
    </>
  );
  return showTitle ? (
    <section className="account-section account-first-upload" aria-labelledby={titleId}>
      {content}
    </section>
  ) : (
    <div className="account-section account-first-upload">{content}</div>
  );
}

/** Progress of the first upload, with Cancel upload and the verified backup. */
export function FirstUploadProgress({
  level,
  onCanceled,
  showTitle = true,
}: {
  readonly level: HeadingLevel;
  readonly showTitle?: boolean;
  readonly onCanceled: () => void;
}): ReactNode {
  const { account, setFirstUpload, status } = useAccount();
  const id = useId();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<KeyedMessage | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useFocusAfter(errorRef, error?.key ?? 0);
  // Reported for the whole link, whatever else needs attention meanwhile.
  const progress = status.firstUpload;

  const cancel = async (): Promise<void> => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const result = await attempt(
      () => account.cancelFirstUpload(),
      uiMessage('account.first-upload.185'),
    );
    setBusy(false);
    if (!result.ok) {
      setError((current) => nextMessage(current, result.message));
      return;
    }
    setFirstUpload(null);
    onCanceled();
  };

  const titleId = `${id}-title`;
  const progressId = `${id}-progress`;
  const content = (
    <>
      {showTitle && (
        <Heading level={level} id={titleId}>
          {uiMessage('account.first-upload.186')}
        </Heading>
      )}
      {progress === undefined ? (
        <p>{uiMessage('account.first-upload.187')}</p>
      ) : (
        <div className="account-progress">
          <label htmlFor={progressId}>{uiMessage('account.first-upload.188')}</label>
          <progress
            id={progressId}
            max={Math.max(progress.total, 1)}
            value={Math.min(progress.uploaded, progress.total)}
          />
          <p>
            {uiMessage('account.first-upload.189', {
              value0: String(progress.uploaded),
              value1: recordsText(progress.total),
            })}
          </p>
        </div>
      )}
      <p>{uiMessage('account.first-upload.190')}</p>
      <BackupLink />
      {error !== null && (
        <p key={error.key} ref={errorRef} className="validation-summary" role="alert" tabIndex={-1}>
          {error.text}
        </p>
      )}
      <div className="account-actions">
        <button
          type="button"
          aria-disabled={busy ? true : undefined}
          aria-describedby={`${id}-cancel-help`}
          onClick={() => void cancel()}
        >
          {busy ? uiMessage('account.account-page.107') : uiMessage('account.first-upload.191')}
        </button>
      </div>
      <p id={`${id}-cancel-help`} className="field-help">
        {uiMessage('account.first-upload.192')}
      </p>
    </>
  );
  return showTitle ? (
    <section className="account-section account-upload" aria-labelledby={titleId}>
      {content}
    </section>
  ) : (
    <div className="account-section account-upload">{content}</div>
  );
}

/** A download link to the verified backup made before linking, while it is kept. */
export function BackupLink(): ReactNode {
  const { account } = useAccount();
  const { state } = useAccountRead(() => account.latestBackup(), [account]);
  const backup = state.status === 'ready' ? state.data : null;
  const url = useObjectUrl(backup?.blob ?? null);
  if (backup === null || url === null) return null;
  return (
    <p className="account-backup">
      {uiMessage('account.first-upload.193')}{' '}
      <a href={url} download={backup.fileName}>
        {uiMessage('account.first-upload.194')}
      </a>{' '}
      <span className="account-file">{`(${backup.fileName}, ${recordsText(backup.recordCount)})`}</span>
    </p>
  );
}
