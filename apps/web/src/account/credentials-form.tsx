import { message as uiMessage } from '../messages';
/**
 * Email and password forms. Passwords stay in their inputs: they are read once on
 * submit, passed to the account service, and cleared; they never enter React state, a URL, or a
 * log. Each form checks its fields in words, ties every error to its field, and moves focus to
 * the first problem. Every error a submission brings is also announced as it appears: a person who
 * pressed Enter in the field it belongs to stays there, and focus alone would say nothing.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';

import { useAccount } from './account-context';
import type { SignInOutcome } from './account-service';
import { attempt } from './account-parts';

export type CredentialMode = 'sign_in' | 'create';

export interface CredentialErrors {
  readonly email?: string;
  readonly password?: string;
  /** A refusal that belongs to the whole form. */
  readonly form?: string;
}

const emailShape = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/** Field checks in words; an empty object when both fields can be sent. */
export function checkCredentials(
  email: string,
  password: string,
  mode: CredentialMode,
): CredentialErrors {
  const address = email.trim();
  return {
    ...(address === ''
      ? { email: uiMessage('account.credentials-form.147') }
      : emailShape.test(address)
        ? {}
        : { email: uiMessage('account.credentials-form.148') }),
    ...(password.length === 0
      ? {
          password:
            mode === 'create'
              ? uiMessage('account.credentials-form.149')
              : uiMessage('account.account-dialogs.48'),
        }
      : {}),
  };
}

/** The field a service refusal belongs to (by its code); null means the whole form. */
export function credentialField(code: string): 'email' | 'password' | null {
  if (/email/iu.test(code)) return 'email';
  if (/password/iu.test(code)) return 'password';
  return null;
}

/** Whether a refusal of a password-only form (sign in again, delete account) is about the password. */
export function isPasswordRefusal(code: string): boolean {
  return /password|credential/iu.test(code);
}

type FocusTarget = 'email' | 'password' | 'form';

function useFocusTarget(targets: Readonly<Record<FocusTarget, { current: HTMLElement | null }>>) {
  const [request, setRequest] = useState<{ readonly target: FocusTarget; readonly key: number }>();
  useEffect(() => {
    if (request !== undefined) targets[request.target].current?.focus();
  }, [request]);
  return (target: FocusTarget): void =>
    setRequest((current) => ({ target, key: (current?.key ?? 0) + 1 }));
}

/** `aria-describedby` for a field's error, only while it has one. */
const described = (error: string | undefined, errorId: string) =>
  error === undefined ? {} : { 'aria-describedby': errorId };

/** Errors with the submission that brought them: each submission announces its errors anew. */
interface SubmittedErrors {
  readonly errors: CredentialErrors;
  readonly key: number;
}

function useSubmittedErrors() {
  const [state, setState] = useState<SubmittedErrors>({ errors: {}, key: 0 });
  const show = (errors: CredentialErrors): void =>
    setState((current) => ({ errors, key: current.key + 1 }));
  return { errors: state.errors, key: state.key, show };
}

/** A field's error: tied to the field by id, and announced when a submission brings it. */
export function FieldError({
  id,
  submission,
  text,
}: {
  readonly id: string;
  readonly text: string | undefined;
  readonly submission: number;
}): ReactNode {
  if (text === undefined) return null;
  return (
    <p key={submission} id={id} className="account-field-error" role="alert">
      {text}
    </p>
  );
}

/** "Sign in" or "Create account" with email and password. */
export function CredentialsForm({
  autoFocus = false,
  label,
  labelledBy,
  mode,
  onSignedIn,
}: {
  readonly mode: CredentialMode;
  /** The id of the heading that names the form. */
  readonly labelledBy?: string;
  /** The form's name when no heading names it. */
  readonly label?: string;
  /** Focus the email field when the form appears (after switching forms in a dialog). */
  readonly autoFocus?: boolean;
  readonly onSignedIn: (outcome: SignInOutcome, email: string) => void;
}): ReactNode {
  const { account } = useAccount();
  const id = useId();
  const [email, setEmail] = useState('');
  const { errors, key: submission, show: setErrors } = useSubmittedErrors();
  const [busy, setBusy] = useState(false);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);
  const focusOn = useFocusTarget({ email: emailRef, password: passwordRef, form: formErrorRef });
  const signIn = mode === 'sign_in';
  useEffect(() => {
    if (autoFocus) emailRef.current?.focus();
  }, []);

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    const password = passwordRef.current?.value ?? '';
    const checked = checkCredentials(email, password, mode);
    if (checked.email !== undefined || checked.password !== undefined) {
      setErrors(checked);
      focusOn(checked.email !== undefined ? 'email' : 'password');
      return;
    }
    setErrors({});
    setBusy(true);
    const address = email.trim();
    const result = await attempt(
      () => (signIn ? account.signIn(address, password) : account.signUp(address, password)),
      signIn
        ? uiMessage('account.credentials-form.150')
        : uiMessage('account.credentials-form.151'),
    );
    setBusy(false);
    if (result.ok) {
      if (passwordRef.current !== null) passwordRef.current.value = '';
      onSignedIn(result.value, address);
      return;
    }
    const field = credentialField(result.code);
    if (field !== 'email' && passwordRef.current !== null) passwordRef.current.value = '';
    setErrors(field === null ? { form: result.message } : { [field]: result.message });
    focusOn(field ?? 'form');
  };

  const emailId = `${id}-email`;
  const passwordId = `${id}-password`;
  return (
    <form
      className="account-form"
      method="post"
      noValidate
      {...(labelledBy === undefined ? {} : { 'aria-labelledby': labelledBy })}
      {...(label === undefined ? {} : { 'aria-label': label })}
      onSubmit={(event) => void submit(event)}
    >
      {errors.form !== undefined && (
        <p ref={formErrorRef} className="validation-summary" role="alert" tabIndex={-1}>
          {errors.form}
        </p>
      )}
      <div className="account-field">
        <label htmlFor={emailId}>{uiMessage('account.credentials-form.152')}</label>
        <input
          ref={emailRef}
          id={emailId}
          name="email"
          type="email"
          autoComplete={signIn ? 'username' : 'email'}
          inputMode="email"
          spellCheck={false}
          required
          value={email}
          aria-invalid={errors.email === undefined ? undefined : true}
          {...described(errors.email, `${emailId}-error`)}
          onChange={(event) => setEmail(event.target.value)}
        />
        <FieldError id={`${emailId}-error`} text={errors.email} submission={submission} />
      </div>
      <div className="account-field">
        <label htmlFor={passwordId}>{uiMessage('account.account-dialogs.65')}</label>
        <input
          ref={passwordRef}
          id={passwordId}
          name="password"
          type="password"
          autoComplete={signIn ? 'current-password' : 'new-password'}
          required
          aria-invalid={errors.password === undefined ? undefined : true}
          {...described(errors.password, `${passwordId}-error`)}
        />
        <FieldError id={`${passwordId}-error`} text={errors.password} submission={submission} />
      </div>
      <div className="account-actions">
        <button type="submit" className="primary-button" aria-disabled={busy ? true : undefined}>
          {busy
            ? signIn
              ? uiMessage('account.credentials-form.153')
              : uiMessage('account.credentials-form.154')
            : signIn
              ? uiMessage('account.account-page.80')
              : uiMessage('account.account-page.81')}
        </button>
      </div>
    </form>
  );
}

/** "Sign in again" after the session ended: the password only. */
export function ReauthForm({
  labelledBy,
  onSignedIn,
}: {
  readonly labelledBy: string;
  readonly onSignedIn: () => void;
}): ReactNode {
  const { account } = useAccount();
  const id = useId();
  const { errors, key: submission, show: setErrors } = useSubmittedErrors();
  const [busy, setBusy] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const formErrorRef = useRef<HTMLParagraphElement>(null);
  const focusOn = useFocusTarget({ email: passwordRef, password: passwordRef, form: formErrorRef });

  const submit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    const password = passwordRef.current?.value ?? '';
    if (password.length === 0) {
      setErrors({ password: uiMessage('account.account-dialogs.48') });
      focusOn('password');
      return;
    }
    setErrors({});
    setBusy(true);
    const result = await attempt(
      () => account.reauthenticate(password),
      uiMessage('account.credentials-form.155'),
    );
    setBusy(false);
    if (passwordRef.current !== null) passwordRef.current.value = '';
    if (result.ok) {
      onSignedIn();
      return;
    }
    const onPassword = isPasswordRefusal(result.code);
    setErrors(onPassword ? { password: result.message } : { form: result.message });
    focusOn(onPassword ? 'password' : 'form');
  };

  const passwordId = `${id}-password`;
  return (
    <form
      className="account-form"
      method="post"
      noValidate
      aria-labelledby={labelledBy}
      onSubmit={(event) => void submit(event)}
    >
      {errors.form !== undefined && (
        <p ref={formErrorRef} className="validation-summary" role="alert" tabIndex={-1}>
          {errors.form}
        </p>
      )}
      <div className="account-field">
        <label htmlFor={passwordId}>{uiMessage('account.account-dialogs.65')}</label>
        <input
          ref={passwordRef}
          id={passwordId}
          name="password"
          type="password"
          autoComplete="current-password"
          required
          aria-invalid={errors.password === undefined ? undefined : true}
          {...described(errors.password, `${passwordId}-error`)}
        />
        <FieldError id={`${passwordId}-error`} text={errors.password} submission={submission} />
      </div>
      <div className="account-actions">
        <button type="submit" className="primary-button" aria-disabled={busy ? true : undefined}>
          {busy ? uiMessage('account.credentials-form.153') : uiMessage('account.account-page.98')}
        </button>
      </div>
    </form>
  );
}
