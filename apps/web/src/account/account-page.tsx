import { message as uiMessage } from '../messages';
/**
 * Account (`/account`): optional sign-in, the first-upload choice, the sync state
 * in words, and the account actions (export, sign out, remove from this device, delete). Nothing
 * here gates the local plan: every state explains the next safe action and no control waits for
 * the network to keep planning. Results are announced politely and receive focus.
 */
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import {
  accountEmail,
  useAccount,
  useAccountOptional,
  type AccountContextValue,
} from './account-context';
import { DeleteAccountDialog, RemoveDeviceDialog, SignOutDialog } from './account-dialogs';
import type { SignInOutcome, SyncStatus } from './account-service';
import {
  ResultRegion,
  attempt,
  nextMessage,
  useFocusAfter,
  useFocusAfterDialogs,
  useOnline,
  useResultMessage,
  useTimeDisplay,
  type KeyedMessage,
  type ResultMessage,
} from './account-parts';
import { CredentialsForm, ReauthForm, isPasswordRefusal } from './credentials-form';
import { ExportButton } from './export-button';
import { FirstUploadChoice, FirstUploadProgress } from './first-upload';
import { conflictsPath } from './routes';
import {
  accountOpenedText,
  accountOutcomes,
  notConfiguredText,
  syncStateSentence,
} from './sync-text';

import './account.css';

export type AccountView = 'not_configured' | 'choose_first_upload' | 'signed_out' | 'signed_in';

/** Which Account view a context shows. */
export function accountViewOf(context: AccountContextValue | null): AccountView {
  if (context === null || !context.account.configured) return 'not_configured';
  if (context.firstUpload?.phase === 'choose') return 'choose_first_upload';
  if (context.firstUpload?.phase === 'started') return 'signed_in';
  const { account, state } = context.status;
  // An open account stays in view while it signs in again: only a local plan shows the forms.
  if (account !== undefined) return 'signed_in';
  return state === 'local_only' || state === 'signing_in' ? 'signed_out' : 'signed_in';
}

/** The status the signed-in view shows: a started first upload reads as uploading at once. */
function shownStatus(context: AccountContextValue): SyncStatus {
  const { firstUpload, status } = context;
  return firstUpload?.phase === 'started' &&
    (status.state === 'local_only' || status.state === 'signing_in')
    ? { ...status, state: 'first_upload' }
    : status;
}

export const signedOutIntro = uiMessage('account.account-page.72');

export function AccountPage(): ReactNode {
  const context = useAccountOptional();
  const titleId = useId();
  const result = useResultMessage();
  const view = accountViewOf(context);
  // An operation that switched the open plan ends here: its outcome is this page's result, once.
  const notice = context?.notice ?? null;
  useEffect(() => {
    if (notice === null || context === null) return;
    result.show(notice.text);
    context.consumeNotice(notice.key);
  }, [notice?.key]);
  if (context === null || view === 'not_configured') return <AccountNotConfigured />;
  const email = accountEmail(context);
  const intro =
    view === 'signed_out'
      ? signedOutIntro
      : view === 'choose_first_upload'
        ? uiMessage('account.account-page.73')
        : email === null
          ? uiMessage('account.account-page.74')
          : uiMessage('account.account-page.75', { value0: email });
  return (
    <article className="account-page" aria-labelledby={titleId}>
      <header className="account-header">
        <h1 id={titleId} tabIndex={-1}>
          {uiMessage('account.account-page.76')}
        </h1>
        <p className="account-intro">{intro}</p>
      </header>
      <ResultRegion result={result} />
      {view === 'signed_out' && <SignedOutView result={result} />}
      {view === 'choose_first_upload' && context.firstUpload?.phase === 'choose' && (
        <FirstUploadChoice
          preview={context.firstUpload.preview}
          level={2}
          showTitle
          onStarted={() => result.show(accountOutcomes.uploadStarted)}
          onKept={() => result.show(accountOutcomes.planKept)}
          onCanceled={() => result.show(accountOutcomes.signInCanceled)}
        />
      )}
      {view === 'signed_in' && (
        <SignedInView status={shownStatus(context)} email={email} result={result} />
      )}
    </article>
  );
}

export function AccountNotConfigured(): ReactNode {
  const titleId = useId();
  return (
    <article className="account-page" aria-labelledby={titleId}>
      <header className="account-header">
        <h1 id={titleId} tabIndex={-1}>
          {uiMessage('account.account-page.76')}
        </h1>
        <p className="account-intro">{notConfiguredText}</p>
      </header>
      <p>
        <Link className="back-link" to="/settings">
          {uiMessage('account.account-page.77')}
        </Link>
      </p>
    </article>
  );
}

/* ───────────────────────── Signed out ───────────────────────── */

function SignedOutView({ result }: { readonly result: ResultMessage }): ReactNode {
  const { setFirstUpload } = useAccount();
  const online = useOnline();
  const signInId = useId();
  const createId = useId();
  const signedIn = (outcome: SignInOutcome, email: string): void => {
    if (outcome.kind === 'choose_first_upload') {
      setFirstUpload({ phase: 'choose', preview: outcome.preview });
      // The choice's question takes focus; the status only reports the sign-in.
      result.show(uiMessage('account.account-page.75', { value0: email }), { focus: false });
      return;
    }
    result.show(accountOpenedText(email));
  };
  return (
    <>
      {!online && <p className="account-note">{uiMessage('account.account-page.78')}</p>}
      <p className="field-help account-wide-help">{uiMessage('account.account-page.79')}</p>
      <div className="account-columns">
        <section className="account-section" aria-labelledby={signInId}>
          <h2 id={signInId}>{uiMessage('account.account-page.80')}</h2>
          <CredentialsForm mode="sign_in" labelledBy={signInId} onSignedIn={signedIn} />
        </section>
        <section className="account-section" aria-labelledby={createId}>
          <h2 id={createId}>{uiMessage('account.account-page.81')}</h2>
          <CredentialsForm mode="create" labelledBy={createId} onSignedIn={signedIn} />
        </section>
      </div>
    </>
  );
}

/* ───────────────────────── Signed in ───────────────────────── */

type AccountDialog = 'sign_out' | 'remove' | 'delete';

function SignedInView({
  email,
  result,
  status,
}: {
  readonly status: SyncStatus;
  readonly email: string | null;
  readonly result: ResultMessage;
}): ReactNode {
  const [dialog, setDialog] = useState<AccountDialog | null>(null);
  const [deletionError, setDeletionError] = useState<KeyedMessage | null>(null);
  const exportId = useId();
  const signOutId = useId();
  const deviceId = useId();
  const deleteId = useId();
  const state = status.state;
  const close = (): void => setDialog(null);
  // The upload keeps its progress, Cancel upload, and the backup for the whole link, also while a
  // conflict, a rejection, or an ended session needs attention beside it.
  const uploading = state === 'first_upload' || status.firstUpload !== undefined;
  return (
    <>
      {state === 'auth_expired' && <ReauthSection email={email} result={result} />}
      {uploading && (
        <FirstUploadProgress
          level={2}
          onCanceled={() => result.show(accountOutcomes.uploadCanceled)}
        />
      )}
      {state === 'deletion_pending' && (
        <DeletionPendingSection
          error={deletionError}
          onError={(text) =>
            setDeletionError((current) => (text === null ? null : nextMessage(current, text)))
          }
          result={result}
        />
      )}
      <SyncSection status={status} result={result} />
      <section className="account-section" aria-labelledby={exportId}>
        <h2 id={exportId}>{uiMessage('account.account-page.82')}</h2>
        <p>{uiMessage('account.account-page.83')}</p>
        <ExportButton />
      </section>
      <section className="account-section" aria-labelledby={signOutId}>
        <h2 id={signOutId}>{uiMessage('account.account-dialogs.22')}</h2>
        <p>{uiMessage('account.account-dialogs.15')}</p>
        <div className="account-actions">
          <button type="button" onClick={() => setDialog('sign_out')}>
            {uiMessage('account.account-dialogs.22')}
          </button>
        </div>
      </section>
      <section className="account-section" aria-labelledby={deviceId}>
        <h2 id={deviceId}>{uiMessage('account.account-page.84')}</h2>
        <p>{uiMessage('account.account-page.85')}</p>
        <div className="account-actions">
          <button type="button" onClick={() => setDialog('remove')}>
            {uiMessage('account.account-page.86')}
          </button>
        </div>
      </section>
      {state !== 'deletion_pending' && (
        <section className="account-section danger-zone" aria-labelledby={deleteId}>
          <h2 id={deleteId}>{uiMessage('account.account-dialogs.52')}</h2>
          <p>{uiMessage('account.account-page.87')}</p>
          <div className="account-actions">
            <button
              type="button"
              className="destructive-button"
              onClick={() => setDialog('delete')}
            >
              {uiMessage('account.account-dialogs.52')}
            </button>
          </div>
        </section>
      )}
      <SignOutDialog
        open={dialog === 'sign_out'}
        onClose={close}
        onSignedOut={() => {
          close();
          result.show(accountOutcomes.signedOut);
        }}
      />
      <RemoveDeviceDialog
        open={dialog === 'remove'}
        onClose={close}
        onRemoved={(deletedCopy) => {
          close();
          result.show(
            deletedCopy ? accountOutcomes.removedDeletedCopy : accountOutcomes.removedKeptCopy,
          );
        }}
      />
      <DeleteAccountDialog
        open={dialog === 'delete'}
        onClose={close}
        onDeleted={(keptCopy) => {
          close();
          result.show(keptCopy ? accountOutcomes.deletedKeptCopy : accountOutcomes.deletedWithCopy);
        }}
        onPending={(message) => {
          close();
          setDeletionError((current) => nextMessage(current, message));
        }}
      />
    </>
  );
}

/** What the person can do about changes the account did not accept. */
export const rejectedChangesHelp = uiMessage('account.account-page.88');

function SyncSection({
  result,
  status,
}: {
  readonly status: SyncStatus;
  readonly result: ResultMessage;
}): ReactNode {
  const { sync } = useAccount();
  const time = useTimeDisplay();
  const id = useId();
  const [busy, setBusy] = useState<'sync' | 'retry' | null>(null);
  const state = status.state;
  const canSync = state !== 'auth_expired' && state !== 'deletion_pending';
  const lastSynced = time(status.lastSyncedAt);
  const nextAttempt =
    state === 'server_unavailable' || state === 'queued_offline' || state === 'needs_attention'
      ? time(status.nextAttemptAt)
      : null;

  // Both resolve when their cycle ends and never reject; the result is the state it ends in.
  const run = async (kind: 'sync' | 'retry'): Promise<void> => {
    if (busy !== null) return;
    setBusy(kind);
    try {
      await (kind === 'sync' ? sync.syncNow() : sync.retryRejected());
    } catch {
      // The status below says what happened either way.
    }
    setBusy(null);
    result.show(syncStateSentence(sync.getStatus()));
  };

  const rejectedHelpId = `${id}-rejected`;
  return (
    <section className="account-section" aria-labelledby={id}>
      <h2 id={id}>{uiMessage('account.account-page.89')}</h2>
      <p className="account-state" data-state={state}>
        {syncStateSentence(status)}
      </p>
      <dl className="account-facts">
        <div>
          <dt>{uiMessage('account.account-page.90')}</dt>
          <dd>{status.pendingChanges}</dd>
        </div>
        <div>
          <dt>{uiMessage('account.account-dialogs.10')}</dt>
          <dd>
            {status.openConflicts}
            {status.openConflicts > 0 && (
              <>
                {' '}
                <Link to={conflictsPath()}>{uiMessage('account.account-page.91')}</Link>
              </>
            )}
          </dd>
        </div>
        {status.rejectedChanges > 0 && (
          <div>
            <dt>{uiMessage('account.account-page.92')}</dt>
            <dd>{status.rejectedChanges}</dd>
          </div>
        )}
        <div>
          <dt>{uiMessage('account.account-dialogs.11')}</dt>
          <dd>{lastSynced ?? uiMessage('account.account-dialogs.12')}</dd>
        </div>
        {nextAttempt !== null && (
          <div>
            <dt>{uiMessage('account.account-page.93')}</dt>
            <dd>{nextAttempt}</dd>
          </div>
        )}
      </dl>
      {status.rejectedChanges > 0 && (
        <p id={rejectedHelpId} className="field-help">
          {rejectedChangesHelp}
        </p>
      )}
      {canSync && (
        <div className="account-actions">
          <button
            type="button"
            aria-disabled={busy !== null ? true : undefined}
            onClick={() => void run('sync')}
          >
            {busy === 'sync'
              ? uiMessage('account.account-page.94')
              : uiMessage('account.account-page.95')}
          </button>
          {status.rejectedChanges > 0 && (
            <button
              type="button"
              aria-disabled={busy !== null ? true : undefined}
              aria-describedby={rejectedHelpId}
              onClick={() => void run('retry')}
            >
              {busy === 'retry'
                ? uiMessage('account.account-page.96')
                : uiMessage('account.account-page.97')}
            </button>
          )}
        </div>
      )}
    </section>
  );
}

function ReauthSection({
  email,
  result,
}: {
  readonly email: string | null;
  readonly result: ResultMessage;
}): ReactNode {
  const id = useId();
  return (
    <section className="account-section account-attention" aria-labelledby={id}>
      <h2 id={id}>{uiMessage('account.account-page.98')}</h2>
      <p>
        {uiMessage('account.account-page.99', { value0: email === null ? '' : ` for ${email}` })}
      </p>
      <ReauthForm labelledBy={id} onSignedIn={() => result.show(accountOutcomes.signedInAgain)} />
    </section>
  );
}

function DeletionPendingSection({
  error,
  onError,
  result,
}: {
  readonly error: KeyedMessage | null;
  readonly onError: (text: string | null) => void;
  readonly result: ResultMessage;
}): ReactNode {
  const { account } = useAccount();
  const id = useId();
  const [busy, setBusy] = useState<'retry' | 'cancel' | null>(null);
  const [passwordError, setPasswordError] = useState<KeyedMessage | null>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // The first error comes from the Delete account dialog as it closes: its opener is gone and the
  // page is inert until it has closed, so the alert takes focus a frame later.
  useFocusAfterDialogs(errorRef, error?.key ?? 0);
  useFocusAfter(passwordRef, passwordError?.key ?? 0);

  const run = async (kind: 'retry' | 'cancel'): Promise<void> => {
    if (busy !== null) return;
    // Read once and cleared: the password never enters React state.
    const password = kind === 'retry' ? (passwordRef.current?.value ?? '') : '';
    setBusy(kind);
    setPasswordError(null);
    const outcome = await attempt(
      () => (kind === 'retry' ? account.retryDeletion(password) : account.cancelDeletion()),
      kind === 'retry'
        ? uiMessage('account.account-dialogs.51')
        : uiMessage('account.account-page.100'),
    );
    setBusy(null);
    if (passwordRef.current !== null) passwordRef.current.value = '';
    if (!outcome.ok) {
      if (kind === 'retry' && isPasswordRefusal(outcome.code)) {
        onError(null);
        setPasswordError((current) => nextMessage(current, outcome.message));
        return;
      }
      onError(outcome.message);
      return;
    }
    onError(null);
    result.show(
      kind === 'retry' ? accountOutcomes.deletionRetried : accountOutcomes.deletionCanceled,
    );
  };

  const passwordId = `${id}-password`;
  return (
    <section className="account-section account-attention" aria-labelledby={id}>
      <h2 id={id}>{uiMessage('account.account-page.101')}</h2>
      <p>{uiMessage('account.account-page.102')}</p>
      {error !== null && (
        <p key={error.key} ref={errorRef} className="validation-summary" role="alert" tabIndex={-1}>
          {error.text}
        </p>
      )}
      <form
        className="account-form"
        method="post"
        noValidate
        aria-labelledby={id}
        onSubmit={(event) => {
          event.preventDefault();
          event.stopPropagation();
          void run('retry');
        }}
      >
        <div className="account-field">
          <label htmlFor={passwordId}>{uiMessage('account.account-dialogs.65')}</label>
          <p id={`${passwordId}-help`} className="field-help">
            {uiMessage('account.account-page.103')}
          </p>
          <input
            ref={passwordRef}
            id={passwordId}
            name="password"
            type="password"
            autoComplete="current-password"
            aria-describedby={
              passwordError === null
                ? `${passwordId}-help`
                : `${passwordId}-help ${passwordId}-error`
            }
            aria-invalid={passwordError === null ? undefined : true}
          />
          {passwordError !== null && (
            // Announced when it appears: focus may already be in the field (Enter to submit).
            <p
              key={passwordError.key}
              id={`${passwordId}-error`}
              className="account-field-error"
              role="alert"
            >
              {passwordError.text}
            </p>
          )}
        </div>
        <div className="account-actions">
          <button
            type="submit"
            className="primary-button"
            aria-disabled={busy !== null ? true : undefined}
          >
            {busy === 'retry'
              ? uiMessage('account.account-page.105')
              : uiMessage('account.account-page.106')}
          </button>
          <button
            type="button"
            aria-disabled={busy !== null ? true : undefined}
            onClick={() => void run('cancel')}
          >
            {busy === 'cancel'
              ? uiMessage('account.account-page.107')
              : uiMessage('account.account-page.108')}
          </button>
        </div>
      </form>
    </section>
  );
}
