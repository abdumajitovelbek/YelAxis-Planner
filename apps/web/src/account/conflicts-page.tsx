import { message as uiMessage } from '../messages';
/**
 * Conflicts (`/account/conflicts`, `/account/conflicts/:conflictId`). A conflict keeps
 * this device's version, the other device's version, and what both started from; nothing is chosen
 * for the person and nothing is overwritten until they choose. The choices are the ones the
 * conflict offers: Keep this device's version, Keep the other version, and Merge details (a version
 * per detail), or for a deletion Keep it deleted and Restore the edited version. Resolving shows a
 * status on the list.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';

import { useAccount } from './account-context';
import type { ConflictChoice, ConflictDetailView } from './account-service';
import {
  ResultRegion,
  attempt,
  nextMessage,
  useAccountRead,
  useFocusAfter,
  useResultMessage,
  useTimeDisplay,
  type KeyedMessage,
} from './account-parts';
import { accountPath, conflictPath, conflictsPath } from './routes';
import {
  choiceHelp,
  choiceLabels,
  conflictKindText,
  fieldSideText,
  resolvedText,
  type ConflictChoiceName,
} from './sync-text';

import './account.css';

export const conflictsIntro = uiMessage('account.conflicts-page.115');

/** The navigation state a resolution returns to the list with. */
interface ResolvedState {
  readonly resolved: string;
}

const resolvedOf = (state: unknown): string | null => {
  const resolved = (state as Partial<ResolvedState> | null)?.resolved;
  return typeof resolved === 'string' ? resolved : null;
};

export function ConflictListPage(): ReactNode {
  const { conflicts, status } = useAccount();
  const location = useLocation();
  const navigate = useNavigate();
  const time = useTimeDisplay();
  const titleId = useId();
  const titleRef = useRef<HTMLHeadingElement>(null);
  const result = useResultMessage();
  const { retry, state } = useAccountRead(
    () => conflicts.list(),
    [conflicts, status.openConflicts],
  );
  // A resolution comes back with its status: shown once, then cleared from history.
  const resolved = resolvedOf(location.state);
  useEffect(() => {
    if (resolved === null) return;
    result.show(resolved);
    void navigate(location.pathname, { replace: true, state: null });
  }, [resolved]);

  return (
    <article
      className="account-page"
      aria-labelledby={titleId}
      aria-busy={state.status === 'loading'}
    >
      <header className="account-header">
        <Link className="back-link" to={accountPath()}>
          {uiMessage('account.conflicts-page.116')}
        </Link>
        <h1 id={titleId} ref={titleRef} tabIndex={-1}>
          {uiMessage('account.conflicts-page.117')}
        </h1>
        <p className="account-intro">{conflictsIntro}</p>
      </header>
      <ResultRegion result={result} />
      {state.status === 'loading' && (
        <p className="account-loading">{uiMessage('account.conflicts-page.118')}</p>
      )}
      {state.status === 'error' && (
        <div className="validation-summary" role="alert">
          <p>{uiMessage('account.conflicts-page.119')}</p>
          <button
            type="button"
            onClick={() => {
              // The alert goes while the list loads again: focus stays on the page's heading.
              retry();
              titleRef.current?.focus();
            }}
          >
            {uiMessage('account.account-dialogs.47')}
          </button>
        </div>
      )}
      {state.status === 'ready' &&
        (state.data.length === 0 ? (
          <p className="quiet-empty">{uiMessage('account.conflicts-page.120')}</p>
        ) : (
          <ul className="account-list" aria-label={uiMessage('account.conflicts-page.121')}>
            {state.data.map((item) => {
              const found = time(item.createdAt);
              return (
                <li key={item.conflictId} className="account-row">
                  <Link to={conflictPath(item.conflictId)}>{item.title}</Link>
                  <p className="account-row-facts">
                    {`${item.kindLabel} · ${conflictKindText(item.kind)}`}
                  </p>
                  {found !== null && (
                    <p className="account-row-facts">
                      {uiMessage('account.conflicts-page.122', { value0: found })}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
        ))}
    </article>
  );
}

export function ConflictDetailPage(): ReactNode {
  const { conflictId = '' } = useParams();
  // Another conflict is another page: nothing of this one carries over.
  return <ConflictDetail key={conflictId} conflictId={conflictId} />;
}

function ConflictDetail({ conflictId }: { readonly conflictId: string }): ReactNode {
  const { conflicts } = useAccount();
  const navigate = useNavigate();
  const time = useTimeDisplay();
  const id = useId();
  const titleId = `${id}-title`;
  const { retry, state } = useAccountRead(() => conflicts.get(conflictId), [conflicts, conflictId]);
  const [merging, setMerging] = useState(false);
  const [busy, setBusy] = useState<ConflictChoiceName | null>(null);
  const [error, setError] = useState<KeyedMessage | null>(null);
  const [mergeClosed, setMergeClosed] = useState(0);
  const errorRef = useRef<HTMLParagraphElement>(null);
  const mergeButtonRef = useRef<HTMLButtonElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);
  useFocusAfter(errorRef, error?.key ?? 0);
  useFocusAfter(mergeButtonRef, mergeClosed);

  /**
   * The page in every state, with one heading element in one place: "Try again" moves focus to it,
   * and focus stays there while the conflict loads and when it arrives.
   */
  const page = (
    content: {
      readonly title: string;
      readonly eyebrow?: string;
      readonly intro?: ReactNode;
      readonly busy?: boolean;
    },
    children: ReactNode,
  ): ReactNode => (
    <article className="account-page" aria-labelledby={titleId} aria-busy={content.busy === true}>
      <header className="account-header">
        <Link className="back-link" to={conflictsPath()}>
          {uiMessage('account.conflicts-page.123')}
        </Link>
        {content.eyebrow !== undefined && <p className="eyebrow">{content.eyebrow}</p>}
        <h1 id={titleId} ref={titleRef} tabIndex={-1}>
          {content.title}
        </h1>
        {content.intro}
      </header>
      {children}
    </article>
  );
  if (state.status === 'loading')
    return page(
      { title: uiMessage('account.conflicts-page.124'), busy: true },
      <p className="account-loading">{uiMessage('account.conflicts-page.125')}</p>,
    );
  if (state.status === 'error')
    return page(
      { title: uiMessage('account.conflicts-page.124') },
      <div className="validation-summary" role="alert">
        <p>{uiMessage('account.conflicts-page.126')}</p>
        <button
          type="button"
          onClick={() => {
            // The alert goes while the conflict loads again: focus stays on the page's heading.
            retry();
            titleRef.current?.focus();
          }}
        >
          {uiMessage('account.account-dialogs.47')}
        </button>
      </div>,
    );
  const detail = state.data;
  if (detail === null)
    return page(
      {
        title: uiMessage('account.conflicts-page.127'),
        intro: <p className="account-intro">{uiMessage('account.conflicts-page.128')}</p>,
      },
      null,
    );

  const resolve = async (choice: ConflictChoice): Promise<void> => {
    if (busy !== null) return;
    setBusy(choice.choice);
    setError(null);
    const result = await attempt(
      () => conflicts.resolve(conflictId, choice),
      uiMessage('account.conflicts-page.129'),
    );
    setBusy(null);
    if (!result.ok) {
      setError((current) => nextMessage(current, result.message));
      return;
    }
    const back: ResolvedState = { resolved: resolvedText(choice.choice, detail.title) };
    void navigate(conflictsPath(), { state: back });
  };

  const found = time(detail.createdAt);
  const alert = error !== null && (
    <p key={error.key} ref={errorRef} className="validation-summary" role="alert" tabIndex={-1}>
      {error.text}
    </p>
  );
  return page(
    {
      title: detail.title,
      eyebrow: uiMessage('account.conflicts-page.130', { value0: detail.kindLabel }),
      intro: (
        <>
          <p className="account-intro">
            {uiMessage('account.conflicts-page.131', { value0: conflictKindText(detail.kind) })}
          </p>
          {found !== null && (
            <p className="field-help">
              {uiMessage('account.conflicts-page.122', { value0: found })}
            </p>
          )}
        </>
      ),
    },
    <>
      <FieldTable detail={detail} />
      {merging ? (
        <MergeForm
          detail={detail}
          busy={busy === 'merge'}
          alert={alert}
          onCancel={() => {
            setMerging(false);
            setError(null);
            setMergeClosed((value) => value + 1);
          }}
          onSubmit={(fields) => void resolve({ choice: 'merge', fields })}
        />
      ) : (
        <section className="account-section" aria-labelledby={`${id}-choose`}>
          <h2 id={`${id}-choose`}>{uiMessage('account.conflicts-page.132')}</h2>
          <ul className="account-choices">
            {detail.choices.map((choice) => (
              <li key={choice}>
                <button
                  ref={choice === 'merge' ? mergeButtonRef : undefined}
                  type="button"
                  aria-describedby={`${id}-${choice}-help`}
                  aria-disabled={busy !== null ? true : undefined}
                  onClick={() => {
                    if (busy !== null) return;
                    if (choice === 'merge') {
                      setError(null);
                      setMerging(true);
                    } else void resolve({ choice });
                  }}
                >
                  {busy === choice ? uiMessage('account.conflicts-page.133') : choiceLabels[choice]}
                </button>
                <p id={`${id}-${choice}-help`} className="field-help">
                  {choiceHelp[choice]}
                </p>
              </li>
            ))}
          </ul>
          {alert}
        </section>
      )}
    </>,
  );
}

function FieldTable({ detail }: { readonly detail: ConflictDetailView }): ReactNode {
  const id = useId();
  return (
    <section className="account-section" aria-labelledby={`${id}-heading`}>
      <h2 id={`${id}-heading`}>{uiMessage('account.conflicts-page.134')}</h2>
      {detail.fields.length === 0 ? (
        <p>{uiMessage('account.conflicts-page.135')}</p>
      ) : (
        // A wide table scrolls inside its own focusable region instead of the page.
        <div
          className="account-table-wrap"
          role="region"
          aria-labelledby={`${id}-caption`}
          tabIndex={0}
        >
          <table className="account-table">
            <caption id={`${id}-caption`}>
              {uiMessage('account.conflicts-page.136', { value0: detail.title })}
            </caption>
            <thead>
              <tr>
                <th scope="col">{uiMessage('account.conflicts-page.137')}</th>
                <th scope="col">{uiMessage('account.account-page.84')}</th>
                <th scope="col">{uiMessage('account.conflicts-page.138')}</th>
                <th scope="col">{uiMessage('account.conflicts-page.139')}</th>
              </tr>
            </thead>
            <tbody>
              {detail.fields.map((field) => (
                <tr key={field.field}>
                  <th scope="row">{field.label}</th>
                  <td>{fieldSideText(field, 'local', detail.kind)}</td>
                  <td>{fieldSideText(field, 'remote', detail.kind)}</td>
                  <td>{fieldSideText(field, 'base', detail.kind)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/** Merge details: one version per conflicting detail, each chosen explicitly. */
function MergeForm({
  alert,
  busy,
  detail,
  onCancel,
  onSubmit,
}: {
  readonly detail: ConflictDetailView;
  readonly busy: boolean;
  readonly alert: ReactNode;
  readonly onCancel: () => void;
  readonly onSubmit: (fields: Readonly<Record<string, 'local' | 'remote'>>) => void;
}): ReactNode {
  const id = useId();
  const [picks, setPicks] = useState<Readonly<Record<string, 'local' | 'remote'>>>({});
  const [missing, setMissing] = useState<readonly string[]>([]);
  const [focusMissing, setFocusMissing] = useState(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const firstRadios = useRef(new Map<string, HTMLInputElement>());
  useEffect(() => headingRef.current?.focus(), []);
  useEffect(() => {
    if (focusMissing === 0) return;
    const first = missing[0];
    if (first !== undefined) firstRadios.current.get(first)?.focus();
  }, [focusMissing]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    event.stopPropagation();
    if (busy) return;
    const unpicked = detail.fields
      .filter((field) => picks[field.field] === undefined)
      .map((field) => field.field);
    setMissing(unpicked);
    if (unpicked.length > 0) {
      setFocusMissing((value) => value + 1);
      return;
    }
    onSubmit(
      Object.fromEntries(
        detail.fields.map((field) => [field.field, picks[field.field] ?? 'local']),
      ),
    );
  };

  return (
    <form
      className="account-section account-merge"
      noValidate
      aria-labelledby={`${id}-heading`}
      onSubmit={submit}
    >
      <h2 id={`${id}-heading`} ref={headingRef} tabIndex={-1}>
        {uiMessage('account.conflicts-page.140')}
      </h2>
      <p>{uiMessage('account.conflicts-page.141')}</p>
      {detail.fields.map((field, index) => {
        const name = `${id}-field-${String(index)}`;
        const invalid = missing.includes(field.field);
        const pick = (side: 'local' | 'remote'): void => {
          setPicks((current) => ({ ...current, [field.field]: side }));
          setMissing((current) => current.filter((item) => item !== field.field));
        };
        return (
          <fieldset
            key={field.field}
            className="account-fieldset"
            {...(invalid ? { 'aria-describedby': `${name}-error` } : {})}
          >
            <legend>{field.label}</legend>
            <div className="account-choice-list">
              <label className="account-choice">
                <input
                  ref={(element) => {
                    if (element === null) firstRadios.current.delete(field.field);
                    else firstRadios.current.set(field.field, element);
                  }}
                  type="radio"
                  name={name}
                  value="local"
                  checked={picks[field.field] === 'local'}
                  aria-invalid={invalid ? true : undefined}
                  onChange={() => pick('local')}
                />
                <span>
                  {uiMessage('account.conflicts-page.142', {
                    value0: fieldSideText(field, 'local', detail.kind),
                  })}
                </span>
              </label>
              <label className="account-choice">
                <input
                  type="radio"
                  name={name}
                  value="remote"
                  checked={picks[field.field] === 'remote'}
                  aria-invalid={invalid ? true : undefined}
                  onChange={() => pick('remote')}
                />
                <span>
                  {uiMessage('account.conflicts-page.143', {
                    value0: fieldSideText(field, 'remote', detail.kind),
                  })}
                </span>
              </label>
            </div>
            {invalid && (
              <p id={`${name}-error`} className="account-field-error">
                {uiMessage('account.conflicts-page.144', { value0: field.label })}
              </p>
            )}
          </fieldset>
        );
      })}
      {alert}
      <div className="account-actions">
        <button type="submit" className="primary-button" aria-disabled={busy ? true : undefined}>
          {busy ? uiMessage('account.conflicts-page.133') : uiMessage('account.conflicts-page.145')}
        </button>
        <button type="button" onClick={onCancel}>
          {uiMessage('account.conflicts-page.146')}
        </button>
      </div>
    </form>
  );
}
