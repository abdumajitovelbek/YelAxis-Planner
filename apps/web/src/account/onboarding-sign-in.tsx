import { message as uiMessage } from '../messages';
/**
 * "Sign in" beside "Start locally" on the welcome step. It is optional and
 * never a gate: it opens a dialog with Sign in or Create account, a plan already on this device
 * leads to the first-upload choice, and closing, canceling, or a failed sign-in leaves the local
 * plan unchanged: closing the dialog while the choice waits cancels the sign-in. Nothing is shown
 * when the build has no account configuration.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

import { Modal } from '../plan/modal';
import { accountsOffered, useAccount, useAccountOptional } from './account-context';
import type { SignInOutcome } from './account-service';
import { CredentialsForm, type CredentialMode } from './credentials-form';
import { FirstUploadChoice, FirstUploadProgress, firstUploadTitle } from './first-upload';
import { accountOpenedText, accountOutcomes } from './sync-text';

import './account.css';

/** The welcome step's honest line about accounts, for builds with and without them. */
export function welcomeAccountText(offered: boolean): string {
  return offered
    ? uiMessage('account.onboarding-sign-in.195')
    : uiMessage('account.onboarding-sign-in.196');
}

export function OnboardingSignIn(): ReactNode {
  const context = useAccountOptional();
  const [open, setOpen] = useState(false);
  if (!accountsOffered(context)) return null;
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        {uiMessage('account.account-page.80')}
      </button>
      {createPortal(
        // The welcome step is itself a form: the dialog's forms live outside it in the page, and
        // their submit events stop here instead of reaching the welcome step (Start locally).
        <div onSubmit={(event) => event.stopPropagation()}>
          <SignInDialog open={open} onClose={() => setOpen(false)} />
        </div>,
        document.body,
      )}
    </>
  );
}

type Step =
  | { readonly kind: 'form'; readonly mode: CredentialMode; readonly switched: boolean }
  | { readonly kind: 'opened'; readonly email: string }
  | { readonly kind: 'started' }
  | { readonly kind: 'kept' }
  | { readonly kind: 'canceled' }
  | { readonly kind: 'sign_in_canceled' };

const firstStep: Step = { kind: 'form', mode: 'sign_in', switched: false };

function stepTitle(step: Step): string {
  switch (step.kind) {
    case 'form':
      return step.mode === 'sign_in'
        ? uiMessage('account.account-page.80')
        : uiMessage('account.account-page.81');
    case 'opened':
      return uiMessage('account.onboarding-sign-in.197');
    case 'started':
      return uiMessage('account.first-upload.186');
    case 'kept':
      return uiMessage('account.onboarding-sign-in.198');
    case 'canceled':
      return uiMessage('account.onboarding-sign-in.199');
    case 'sign_in_canceled':
      return uiMessage('account.onboarding-sign-in.200');
  }
}

function SignInDialog({
  onClose,
  open,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
}): ReactNode {
  const { account, firstUpload, setFirstUpload } = useAccount();
  const [step, setStep] = useState<Step>(firstStep);
  const choiceBusy = useRef(false);
  // Each opening starts again at the sign-in form (a waiting first-upload choice still shows).
  const [shownOpen, setShownOpen] = useState(open);
  if (shownOpen !== open) {
    setShownOpen(open);
    if (open) setStep(firstStep);
  }
  const choosing =
    step.kind === 'form' && firstUpload?.phase === 'choose' ? firstUpload.preview : null;
  // Closing while the choice waits backs out of the sign-in: the session goes and the local plan
  // stays exactly as it was. A choice already under way finishes instead.
  const close = (): void => {
    if (choosing !== null && !choiceBusy.current) {
      setFirstUpload(null);
      void account.cancelFirstUpload().catch(() => undefined);
    }
    onClose();
  };
  return (
    <Modal
      open={open}
      onClose={close}
      title={choosing === null ? stepTitle(step) : firstUploadTitle}
      className="account-dialog"
    >
      {choosing !== null ? (
        <FirstUploadChoice
          preview={choosing}
          level={2}
          showTitle={false}
          onBusyChange={(busy) => {
            choiceBusy.current = busy;
          }}
          onStarted={() => setStep({ kind: 'started' })}
          onKept={() => setStep({ kind: 'kept' })}
          onCanceled={() => setStep({ kind: 'sign_in_canceled' })}
        />
      ) : step.kind === 'form' ? (
        <SignInForms step={step} onStep={setStep} />
      ) : (
        <Outcome key={step.kind} step={step} onStep={setStep} onClose={close} />
      )}
    </Modal>
  );
}

function SignInForms({
  onStep,
  step,
}: {
  readonly step: Extract<Step, { readonly kind: 'form' }>;
  readonly onStep: (step: Step) => void;
}): ReactNode {
  const { setFirstUpload } = useAccount();
  const signIn = step.mode === 'sign_in';
  const signedIn = (outcome: SignInOutcome, email: string): void => {
    if (outcome.kind === 'choose_first_upload')
      setFirstUpload({ phase: 'choose', preview: outcome.preview });
    else onStep({ kind: 'opened', email });
  };
  return (
    <div className="account-dialog-body">
      <p className="field-help">{uiMessage('account.onboarding-sign-in.201')}</p>
      <CredentialsForm
        key={step.mode}
        mode={step.mode}
        label={signIn ? uiMessage('account.account-page.80') : uiMessage('account.account-page.81')}
        autoFocus={step.switched}
        onSignedIn={signedIn}
      />
      <p className="account-switch">
        {signIn
          ? uiMessage('account.onboarding-sign-in.202')
          : uiMessage('account.onboarding-sign-in.203')}{' '}
        <button
          type="button"
          className="text-button"
          onClick={() =>
            onStep({ kind: 'form', mode: signIn ? 'create' : 'sign_in', switched: true })
          }
        >
          {signIn
            ? uiMessage('account.onboarding-sign-in.204')
            : uiMessage('account.onboarding-sign-in.205')}
        </button>
      </p>
    </div>
  );
}

function outcomeText(step: Exclude<Step, { readonly kind: 'form' }>): string {
  switch (step.kind) {
    case 'opened':
      return accountOpenedText(step.email);
    case 'started':
      return accountOutcomes.uploadStarted;
    case 'kept':
      return accountOutcomes.planKept;
    case 'canceled':
      return accountOutcomes.uploadCanceled;
    case 'sign_in_canceled':
      return accountOutcomes.signInCanceled;
  }
}

function Outcome({
  onClose,
  onStep,
  step,
}: {
  readonly step: Exclude<Step, { readonly kind: 'form' }>;
  readonly onStep: (step: Step) => void;
  readonly onClose: () => void;
}): ReactNode {
  const ref = useRef<HTMLParagraphElement>(null);
  useEffect(() => ref.current?.focus(), []);
  return (
    <div className="account-dialog-body">
      <div role="status">
        <p ref={ref} className="account-result" tabIndex={-1}>
          {outcomeText(step)}
        </p>
      </div>
      {step.kind === 'started' && (
        <FirstUploadProgress
          level={3}
          showTitle={false}
          onCanceled={() => onStep({ kind: 'canceled' })}
        />
      )}
      <div className="dialog-actions">
        <button type="button" className="primary-button" onClick={onClose}>
          {uiMessage('account.onboarding-sign-in.206')}
        </button>
      </div>
    </div>
  );
}
