import { message as uiMessage } from '../messages';
/**
 * Sign out, Remove this account from this device, and Delete account (the
 * identity contract). Each dialog shows its consequences before anything changes, offers the
 * export first, and asks for a separate acknowledgement wherever changes would stay behind or be
 * deleted. What waits on this device is read when a dialog opens; when it cannot be read, the
 * dialog acts as if changes wait. Nothing is deleted by default except, on account deletion, this
 * device's copy, which the person can keep.
 */
import { useId, useRef, useState, type FormEvent, type ReactNode, type RefObject } from 'react';

import { Modal } from '../plan/modal';
import { useAccount } from './account-context';
import type { DeletionPreview, SignOutFacts } from './account-service';
import {
  CountsList,
  attempt,
  nextMessage,
  useAccountRead,
  useFocusAfter,
  useTimeDisplay,
  type KeyedMessage,
} from './account-parts';
import { FieldError, isPasswordRefusal } from './credentials-form';
import { ExportButton } from './export-button';
import { changesText, conflictsText, recordsText } from './sync-text';

/** "3 changes have not synced, and 1 conflict waits for your choice." */
export function waitingText(facts: SignOutFacts): string {
  const parts = [
    ...(facts.pendingChanges > 0
      ? [
          uiMessage('account.account-dialogs.2', {
            value0: changesText(facts.pendingChanges),
            value1: facts.pendingChanges === 1 ? 'has' : 'have',
          }),
        ]
      : []),
    ...(facts.openConflicts > 0
      ? [
          uiMessage('account.account-dialogs.3', {
            value0: conflictsText(facts.openConflicts),
            value1: facts.openConflicts === 1 ? 'waits' : 'wait',
          }),
        ]
      : []),
  ];
  return `${parts.join(', and ')}.`;
}

/** What waiting changes do when this device's copy stays (signing out, or keeping the copy). */
function staysText(facts: SignOutFacts | null): string {
  return facts === null
    ? uiMessage('account.account-dialogs.4')
    : uiMessage('account.account-dialogs.5', { value0: waitingText(facts) });
}

function AlertMessage({
  message,
  messageRef,
}: {
  readonly message: KeyedMessage | null;
  readonly messageRef: RefObject<HTMLParagraphElement | null>;
}): ReactNode {
  if (message === null) return null;
  return (
    <p key={message.key} ref={messageRef} className="validation-summary" role="alert" tabIndex={-1}>
      {message.text}
    </p>
  );
}

/* ───────────────────────── What waits on this device ───────────────────────── */

/**
 * What waits on this device, read when the dialog opens. `facts` is null while loading and when it
 * cannot be read; `unknown` says the read failed, and the dialogs then act as if changes wait.
 */
function useWaitingFacts() {
  const { account } = useAccount();
  const { retry, state } = useAccountRead(() => account.signOutFacts(), [account]);
  const facts = state.status === 'ready' ? state.data : null;
  return {
    facts,
    loading: state.status === 'loading',
    unknown: state.status === 'error' || (state.status === 'ready' && state.data === null),
    retry,
  };
}

/** The facts as a list, "Checking…" while they load, or a calm failure with Check again. */
function WaitingFacts({
  facts,
  loading,
  onCheckAgain,
  unknown,
}: {
  readonly facts: SignOutFacts | null;
  readonly loading: boolean;
  readonly unknown: boolean;
  readonly onCheckAgain: () => void;
}): ReactNode {
  const time = useTimeDisplay();
  if (loading) return <p className="field-help">{uiMessage('account.account-dialogs.6')}</p>;
  if (unknown || facts === null) {
    return (
      <div className="validation-summary">
        <p>{uiMessage('account.account-dialogs.7')}</p>
        <button type="button" onClick={onCheckAgain}>
          {uiMessage('account.account-dialogs.8')}
        </button>
      </div>
    );
  }
  return (
    <dl className="account-facts">
      <div>
        <dt>{uiMessage('account.account-dialogs.9')}</dt>
        <dd>{facts.pendingChanges}</dd>
      </div>
      <div>
        <dt>{uiMessage('account.account-dialogs.10')}</dt>
        <dd>{facts.openConflicts}</dd>
      </div>
      <div>
        <dt>{uiMessage('account.account-dialogs.11')}</dt>
        <dd>{time(facts.lastSyncedAt) ?? uiMessage('account.account-dialogs.12')}</dd>
      </div>
    </dl>
  );
}

/** An acknowledgement checkbox, its problem tied to it and announced through focus. */
function Acknowledgement({
  checked,
  checkboxRef,
  id,
  label,
  onChange,
  problem,
}: {
  readonly id: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  /** Shown after an attempt without the acknowledgement. */
  readonly problem: string | null;
  readonly checkboxRef: RefObject<HTMLInputElement | null>;
}): ReactNode {
  return (
    <>
      <label className="toggle-row">
        <input
          ref={checkboxRef}
          type="checkbox"
          checked={checked}
          aria-invalid={problem === null ? undefined : true}
          {...(problem === null ? {} : { 'aria-describedby': `${id}-error` })}
          onChange={(event) => onChange(event.target.checked)}
        />
        {label}
      </label>
      {problem !== null && (
        <p id={`${id}-error`} className="account-field-error">
          {problem}
        </p>
      )}
    </>
  );
}

/* ───────────────────────── Sign out ───────────────────────── */

export function SignOutDialog({
  onClose,
  onSignedOut,
  open,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onSignedOut: () => void;
}): ReactNode {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={uiMessage('account.account-dialogs.13')}
      className="account-dialog"
    >
      <SignOutBody onClose={onClose} onSignedOut={onSignedOut} />
    </Modal>
  );
}

function SignOutBody({
  onClose,
  onSignedOut,
}: {
  readonly onClose: () => void;
  readonly onSignedOut: () => void;
}): ReactNode {
  const { account } = useAccount();
  const id = useId();
  const { facts, loading, retry, unknown } = useWaitingFacts();
  const [acknowledged, setAcknowledged] = useState(false);
  const [ackProblem, setAckProblem] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<KeyedMessage | null>(null);
  const leadRef = useRef<HTMLParagraphElement>(null);
  const ackRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useFocusAfter(ackRef, ackProblem);
  useFocusAfter(errorRef, error?.key ?? 0);

  // When the facts cannot be read, changes may be waiting: the acknowledgement is still asked.
  const waiting =
    unknown || (facts !== null && (facts.pendingChanges > 0 || facts.openConflicts > 0));

  const signOut = async (): Promise<void> => {
    if (busy || loading) return;
    if (waiting && !acknowledged) {
      setAckProblem((value) => value + 1);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await attempt(() => account.signOut(), uiMessage('account.account-dialogs.14'));
    setBusy(false);
    if (!result.ok) {
      setError((current) => nextMessage(current, result.message));
      return;
    }
    onSignedOut();
  };

  return (
    <div className="account-dialog-body">
      <p ref={leadRef} className="account-lead" tabIndex={-1} data-autofocus>
        {uiMessage('account.account-dialogs.15')}
      </p>
      <WaitingFacts
        facts={facts}
        loading={loading}
        unknown={unknown}
        onCheckAgain={() => {
          // The button goes while the facts load again: focus stays on the dialog's lead.
          retry();
          leadRef.current?.focus();
        }}
      />
      {!loading && (
        <p>
          {waiting ? staysText(unknown ? null : facts) : uiMessage('account.account-dialogs.16')}
        </p>
      )}
      <p className="field-help">{uiMessage('account.account-dialogs.17')}</p>
      <ExportButton />
      {waiting && (
        <div className="account-ack">
          <Acknowledgement
            id={`${id}-ack`}
            checkboxRef={ackRef}
            checked={acknowledged}
            onChange={setAcknowledged}
            label={uiMessage('account.account-dialogs.18')}
            problem={
              ackProblem > 0 && !acknowledged ? uiMessage('account.account-dialogs.19') : null
            }
          />
        </div>
      )}
      <AlertMessage message={error} messageRef={errorRef} />
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          {uiMessage('account.account-dialogs.20')}
        </button>
        <button
          type="button"
          className="primary-button"
          aria-disabled={busy || loading ? true : undefined}
          onClick={() => void signOut()}
        >
          {busy ? uiMessage('account.account-dialogs.21') : uiMessage('account.account-dialogs.22')}
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── Remove from this device ───────────────────────── */

export function RemoveDeviceDialog({
  onClose,
  onRemoved,
  open,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** `deletedCopy` is true when this device's copy was deleted. */
  readonly onRemoved: (deletedCopy: boolean) => void;
}): ReactNode {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={uiMessage('account.account-dialogs.23')}
      className="account-dialog"
    >
      <RemoveBody onClose={onClose} onRemoved={onRemoved} />
    </Modal>
  );
}

function RemoveBody({
  onClose,
  onRemoved,
}: {
  readonly onClose: () => void;
  readonly onRemoved: (deletedCopy: boolean) => void;
}): ReactNode {
  const { account } = useAccount();
  const id = useId();
  const { facts, loading, retry, unknown } = useWaitingFacts();
  const [deleteCopy, setDeleteCopy] = useState(false);
  /** Keeping the copy: waiting changes stay on this device (as when signing out). */
  const [acknowledged, setAcknowledged] = useState(false);
  /** Deleting the copy: changes that have not synced are deleted with it. */
  const [accepted, setAccepted] = useState(false);
  /** The service found changes that have not synced after the facts were read. */
  const [refusedUnsynced, setRefusedUnsynced] = useState(false);
  const [ackProblem, setAckProblem] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<KeyedMessage | null>(null);
  const leadRef = useRef<HTMLParagraphElement>(null);
  const ackRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useFocusAfter(ackRef, ackProblem);
  useFocusAfter(errorRef, error?.key ?? 0);

  const known = unknown ? null : facts;
  const waiting = known === null || known.pendingChanges > 0 || known.openConflicts > 0;
  // Null: how many have not synced is not known (the read failed, or the service found more).
  const pending =
    known === null || (refusedUnsynced && known.pendingChanges === 0) ? null : known.pendingChanges;
  const unsynced = pending === null || pending > 0;
  // Known once the facts are read; a refusal for unsynced changes keeps it while they are read again.
  const needsAck =
    (deleteCopy && refusedUnsynced) || (!loading && (deleteCopy ? unsynced : waiting));
  const confirmed = deleteCopy ? accepted : acknowledged;

  const remove = async (): Promise<void> => {
    if (busy || loading) return;
    if (needsAck && !confirmed) {
      setAckProblem((value) => value + 1);
      return;
    }
    setBusy(true);
    setError(null);
    const result = await attempt(
      () =>
        account.removeFromDevice({
          deleteLocalCopy: deleteCopy,
          acceptUnsyncedLoss: deleteCopy && accepted,
        }),
      uiMessage('account.account-dialogs.24'),
    );
    setBusy(false);
    if (!result.ok) {
      if (result.code === 'unsynced_changes') {
        // Changes arrived after the facts were read: read them again and ask for the
        // acknowledgement, which was not needed a moment ago.
        setRefusedUnsynced(true);
        retry();
      }
      setError((current) => nextMessage(current, result.message));
      return;
    }
    onRemoved(deleteCopy);
  };

  const keepWarning = waiting ? staysText(known) : uiMessage('account.account-dialogs.16');
  const deleteWarning =
    pending === null
      ? uiMessage('account.account-dialogs.25')
      : pending > 0
        ? uiMessage('account.account-dialogs.26', {
            value0: changesText(pending),
            value1: pending === 1 ? 'has' : 'have',
            value2: pending === 1 ? 'it' : 'them',
          })
        : uiMessage('account.account-dialogs.27');
  const lossLabel =
    pending === null
      ? uiMessage('account.account-dialogs.28')
      : uiMessage('account.account-dialogs.29', {
          value0: changesText(pending),
          value1: pending === 1 ? 'has' : 'have',
        });
  const showAckProblem = ackProblem > 0 && !confirmed;
  return (
    <div className="account-dialog-body">
      <p ref={leadRef} className="account-lead" tabIndex={-1} data-autofocus>
        {uiMessage('account.account-dialogs.30')}
      </p>
      <WaitingFacts
        facts={facts}
        loading={loading}
        unknown={unknown}
        onCheckAgain={() => {
          retry();
          leadRef.current?.focus();
        }}
      />
      <fieldset className="account-fieldset">
        <legend>{uiMessage('account.account-dialogs.31')}</legend>
        <div className="account-choice-list">
          <label className="account-choice">
            <input
              type="radio"
              name={`${id}-copy`}
              value="keep"
              checked={!deleteCopy}
              aria-describedby={`${id}-keep-help`}
              onChange={() => setDeleteCopy(false)}
            />
            <span>{uiMessage('account.account-dialogs.32')}</span>
          </label>
          <p id={`${id}-keep-help`} className="field-help">
            {uiMessage('account.account-dialogs.33')}
          </p>
          <label className="account-choice">
            <input
              type="radio"
              name={`${id}-copy`}
              value="delete"
              checked={deleteCopy}
              aria-describedby={`${id}-delete-help`}
              onChange={() => setDeleteCopy(true)}
            />
            <span>{uiMessage('account.account-dialogs.34')}</span>
          </label>
          <p id={`${id}-delete-help`} className="field-help">
            {uiMessage('account.account-dialogs.35')}
          </p>
        </div>
      </fieldset>
      {!loading && (
        <div className={needsAck ? 'account-warning' : undefined}>
          <p>{deleteCopy ? deleteWarning : keepWarning}</p>
        </div>
      )}
      <p className="field-help">{uiMessage('account.account-dialogs.17')}</p>
      <ExportButton />
      {needsAck && (
        <div className="account-ack">
          {deleteCopy ? (
            <Acknowledgement
              key="delete"
              id={`${id}-loss`}
              checkboxRef={ackRef}
              checked={accepted}
              onChange={setAccepted}
              label={lossLabel}
              problem={showAckProblem ? uiMessage('account.account-dialogs.36') : null}
            />
          ) : (
            <Acknowledgement
              key="keep"
              id={`${id}-stay`}
              checkboxRef={ackRef}
              checked={acknowledged}
              onChange={setAcknowledged}
              label={uiMessage('account.account-dialogs.37')}
              problem={showAckProblem ? uiMessage('account.account-dialogs.38') : null}
            />
          )}
        </div>
      )}
      <AlertMessage message={error} messageRef={errorRef} />
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          {uiMessage('account.account-dialogs.20')}
        </button>
        <button
          type="button"
          className={deleteCopy ? 'destructive-button' : 'primary-button'}
          aria-disabled={busy || loading ? true : undefined}
          onClick={() => void remove()}
        >
          {busy ? uiMessage('account.account-dialogs.39') : uiMessage('account.account-dialogs.40')}
        </button>
      </div>
    </div>
  );
}

/* ───────────────────────── Delete account ───────────────────────── */

export function DeleteAccountDialog({
  onClose,
  onDeleted,
  onPending,
  open,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  /** `keptCopy` is true when this device's copy stays as a local plan. */
  readonly onDeleted: (keptCopy: boolean) => void;
  /** Deletion is pending after a recoverable failure: the page offers Retry and Cancel. */
  readonly onPending: (message: string) => void;
}): ReactNode {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={uiMessage('account.account-dialogs.41')}
      className="account-dialog"
    >
      <DeleteBody onClose={onClose} onDeleted={onDeleted} onPending={onPending} />
    </Modal>
  );
}

interface DeleteErrors {
  readonly password?: string;
  readonly confirmation?: string;
}

/** Whether the typed confirmation names the account (spaces around it and case do not matter). */
export function confirmsEmail(typed: string, email: string): boolean {
  return typed.trim().toLowerCase() === email.trim().toLowerCase();
}

/** Backups kept by the account service: only the local test service's are known (none). */
export const providerBackupsText = (localTestService: boolean): string =>
  localTestService
    ? uiMessage('account.account-dialogs.42')
    : uiMessage('account.account-dialogs.43');

function DeleteBody({
  onClose,
  onDeleted,
  onPending,
}: {
  readonly onClose: () => void;
  readonly onDeleted: (keptCopy: boolean) => void;
  readonly onPending: (message: string) => void;
}): ReactNode {
  const { account } = useAccount();
  const { retry, state } = useAccountRead(() => account.deletionPreview(), [account]);
  const leadRef = useRef<HTMLParagraphElement>(null);
  const loaded = state.status === 'ready' ? state.data : null;
  const preview = loaded !== null && loaded.ok ? loaded.value : null;
  const cancel = (
    <div className="dialog-actions">
      <button type="button" onClick={onClose}>
        {uiMessage('account.account-dialogs.20')}
      </button>
    </div>
  );
  // One lead paragraph in every state: the dialog focuses it, and focus stays on it when the
  // preview arrives instead of falling out of the dialog.
  return (
    <div className="account-dialog-body">
      <p ref={leadRef} className="account-lead" tabIndex={-1} data-autofocus>
        {state.status === 'loading'
          ? uiMessage('account.account-dialogs.44')
          : uiMessage('account.account-dialogs.45')}
      </p>
      {preview !== null ? (
        <DeleteForm
          preview={preview}
          onClose={onClose}
          onDeleted={onDeleted}
          onPending={onPending}
        />
      ) : state.status === 'loading' ? (
        cancel
      ) : (
        <>
          <div className="validation-summary" role="alert">
            <p>
              {loaded === null || loaded.ok
                ? uiMessage('account.account-dialogs.46')
                : loaded.message}
            </p>
            <button
              type="button"
              onClick={() => {
                // The alert goes while the preview loads again: focus stays on the lead.
                retry();
                leadRef.current?.focus();
              }}
            >
              {uiMessage('account.account-dialogs.47')}
            </button>
          </div>
          {cancel}
        </>
      )}
    </div>
  );
}

function DeleteForm({
  onClose,
  onDeleted,
  onPending,
  preview,
}: {
  readonly preview: DeletionPreview;
  readonly onClose: () => void;
  readonly onDeleted: (keptCopy: boolean) => void;
  readonly onPending: (message: string) => void;
}): ReactNode {
  const { account, sync } = useAccount();
  const id = useId();
  const [keepCopy, setKeepCopy] = useState(false);
  const [confirmation, setConfirmation] = useState('');
  const [errors, setErrors] = useState<{ readonly fields: DeleteErrors; readonly key: number }>({
    fields: {},
    key: 0,
  });
  const [fieldFocus, setFieldFocus] = useState<{
    readonly field: keyof DeleteErrors;
    readonly key: number;
  }>({ field: 'password', key: 0 });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<KeyedMessage | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const confirmRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLParagraphElement>(null);
  useFocusAfter(fieldFocus.field === 'password' ? passwordRef : confirmRef, fieldFocus.key);
  useFocusAfter(errorRef, error?.key ?? 0);

  const showErrors = (fields: DeleteErrors): void =>
    setErrors((current) => ({ fields, key: current.key + 1 }));
  const focusField = (field: keyof DeleteErrors): void =>
    setFieldFocus((current) => ({ field, key: current.key + 1 }));
  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    const password = passwordRef.current?.value ?? '';
    const next: DeleteErrors = {
      ...(password.length === 0 ? { password: uiMessage('account.account-dialogs.48') } : {}),
      ...(confirmsEmail(confirmation, preview.accountEmail)
        ? {}
        : {
            confirmation:
              confirmation.trim() === ''
                ? uiMessage('account.account-dialogs.49')
                : uiMessage('account.account-dialogs.50'),
          }),
    };
    if (next.password !== undefined || next.confirmation !== undefined) {
      showErrors(next);
      focusField(next.password !== undefined ? 'password' : 'confirmation');
      return;
    }
    showErrors({});
    setBusy(true);
    setError(null);
    const result = await attempt(
      () => account.deleteAccount({ password, keepLocalCopy: keepCopy }),
      uiMessage('account.account-dialogs.51'),
    );
    setBusy(false);
    if (passwordRef.current !== null) passwordRef.current.value = '';
    if (result.ok) {
      onDeleted(keepCopy);
      return;
    }
    if (sync.getStatus().state === 'deletion_pending') {
      onPending(result.message);
      return;
    }
    if (isPasswordRefusal(result.code)) {
      showErrors({ password: result.message });
      focusField('password');
      return;
    }
    setError((current) => nextMessage(current, result.message));
  };

  const passwordId = `${id}-password`;
  const confirmId = `${id}-confirm`;
  const fields = errors.fields;
  const describe = (help: string, problem: string | undefined, problemId: string) => ({
    'aria-describedby': problem === undefined ? help : `${help} ${problemId}`,
    'aria-invalid': problem === undefined ? undefined : true,
  });
  return (
    <form
      className="account-form"
      method="post"
      noValidate
      aria-label={uiMessage('account.account-dialogs.52')}
      onSubmit={(event) => void submit(event)}
    >
      <p>{uiMessage('account.account-dialogs.53')}</p>
      <section className="account-scope" aria-labelledby={`${id}-cloud`}>
        <h3 id={`${id}-cloud`}>{uiMessage('account.account-dialogs.54')}</h3>
        <p>
          {uiMessage('account.account-dialogs.55', {
            value0: recordsText(preview.cloud.total),
            value1: preview.accountEmail,
          })}
        </p>
        <CountsList counts={preview.cloud} label={uiMessage('account.account-dialogs.56')} />
      </section>
      <section className="account-scope" aria-labelledby={`${id}-local`}>
        <h3 id={`${id}-local`}>{uiMessage('account.account-dialogs.57')}</h3>
        <p>
          {uiMessage('account.account-dialogs.58', { value0: recordsText(preview.local.total) })}
        </p>
        {preview.pendingChanges > 0 && (
          <p>
            {uiMessage('account.account-dialogs.59', {
              value0: changesText(preview.pendingChanges),
              value1:
                preview.pendingChanges === 1
                  ? uiMessage('account.account-dialogs.2430')
                  : uiMessage('account.account-dialogs.2431'),
              value2:
                preview.pendingChanges === 1
                  ? uiMessage('account.account-dialogs.2432')
                  : uiMessage('account.account-dialogs.2433'),
              value3:
                preview.pendingChanges === 1
                  ? uiMessage('account.account-dialogs.2434')
                  : uiMessage('account.account-dialogs.2435'),
            })}
          </p>
        )}
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={keepCopy}
            aria-describedby={`${id}-keep-help`}
            onChange={(event) => setKeepCopy(event.target.checked)}
          />
          {uiMessage('account.account-dialogs.60')}
        </label>
        <p id={`${id}-keep-help`} className="field-help">
          {uiMessage('account.account-dialogs.61')}
        </p>
        <ExportButton />
      </section>
      <section className="account-scope" aria-labelledby={`${id}-exports`}>
        <h3 id={`${id}-exports`}>{uiMessage('account.account-dialogs.62')}</h3>
        <p>{uiMessage('account.account-dialogs.63')}</p>
      </section>
      <section className="account-scope" aria-labelledby={`${id}-backups`}>
        <h3 id={`${id}-backups`}>{uiMessage('account.account-dialogs.64')}</h3>
        <p>{providerBackupsText(account.localTestService)}</p>
      </section>
      <div className="account-field">
        <label htmlFor={passwordId}>{uiMessage('account.account-dialogs.65')}</label>
        <p id={`${passwordId}-help`} className="field-help">
          {uiMessage('account.account-dialogs.66')}
        </p>
        <input
          ref={passwordRef}
          id={passwordId}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          {...describe(`${passwordId}-help`, fields.password, `${passwordId}-error`)}
        />
        <FieldError id={`${passwordId}-error`} text={fields.password} submission={errors.key} />
      </div>
      <div className="account-field">
        <label htmlFor={confirmId}>{uiMessage('account.account-dialogs.67')}</label>
        <p id={`${confirmId}-hint`} className="field-help">
          {uiMessage('account.account-dialogs.68')}
          <strong>{preview.accountEmail}</strong>
        </p>
        <input
          ref={confirmRef}
          id={confirmId}
          name="confirmation"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={confirmation}
          {...describe(`${confirmId}-hint`, fields.confirmation, `${confirmId}-error`)}
          onChange={(event) => setConfirmation(event.target.value)}
        />
        <FieldError id={`${confirmId}-error`} text={fields.confirmation} submission={errors.key} />
      </div>
      <AlertMessage message={error} messageRef={errorRef} />
      <div className="dialog-actions">
        <button type="button" onClick={onClose}>
          {uiMessage('account.account-dialogs.20')}
        </button>
        <button
          type="submit"
          className="destructive-button"
          aria-disabled={busy ? true : undefined}
        >
          {busy ? uiMessage('account.account-dialogs.69') : uiMessage('account.account-dialogs.52')}
        </button>
      </div>
    </form>
  );
}
