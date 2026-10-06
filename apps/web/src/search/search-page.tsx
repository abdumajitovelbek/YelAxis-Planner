import { message as uiMessage } from '../messages';
import { useId, useMemo, useRef, useState, useEffect, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  parseSearchRequest,
  searchEntityKinds,
  searchStates,
  type SearchApplication,
  type SearchEntityKind,
  type SearchRequest,
  type SearchPage as SearchResults,
} from '@yelaxis/application';
import { usePlanQuery } from '../plan/planning-context';
import './search.css';

export const searchKindLabel: Readonly<Record<SearchEntityKind, string>> = {
  action: uiMessage('actions-ui.282'),
  note: uiMessage('plan.routines.1606'),
  axis: uiMessage('actions-ui.251'),
  outcome: uiMessage('alignment.milestone-detail.607'),
  project: uiMessage('actions-ui.254'),
  milestone: uiMessage('actions-ui.276'),
  routine: uiMessage('plan.routine-form.1531'),
  review: uiMessage('app.783'),
  review_decision: uiMessage('search.search-page.2090'),
};
const words = (value: string): string => value.replaceAll('_', ' ');
const initial = {
  text: '',
  kind: '',
  state: '',
  archive: 'exclude',
  axisId: '',
  projectId: '',
  dateBasis: 'updated',
  from: '',
  to: '',
};

/** Immediate local query UI. Form state and result copies are temporary; SQLite owns the plan. */
export function SearchPage({
  application,
}: {
  readonly application: SearchApplication;
}): ReactNode {
  const [form, setForm] = useState(initial);
  const [cursor, setCursor] = useState<string>();
  const titleId = useId();
  const hintId = useId();
  const filtersId = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  const resultsRef = useRef<HTMLHeadingElement>(null);
  const focusResults = useRef(false);
  const parsed = useMemo((): { request: SearchRequest | null; error: string | null } => {
    try {
      return {
        request: parseSearchRequest({
          text: form.text,
          archive: form.archive,
          dateBasis: form.dateBasis,
          ...Object.fromEntries(
            Object.entries(form).filter(
              ([key, value]) => !['text', 'archive', 'dateBasis'].includes(key) && value !== '',
            ),
          ),
          ...(cursor === undefined ? {} : { cursor }),
        }),
        error: null,
      };
    } catch {
      return {
        request: null,
        error: uiMessage('search.search-page.2091'),
      };
    }
  }, [form, cursor]);
  const results = usePlanQuery<SearchResults>(
    () =>
      parsed.request === null ? Promise.resolve({ items: [] }) : application.search(parsed.request),
    [application, parsed.request],
  );
  const choices = usePlanQuery(() => application.choices(), [application]);
  useEffect(() => {
    if (focusResults.current && results.state.status === 'ready' && !results.state.refreshing) {
      focusResults.current = false;
      resultsRef.current?.focus();
    }
  }, [results.state]);
  const field = (name: keyof typeof initial, value: string): void => {
    setForm((current) => ({ ...current, [name]: value }));
    setCursor(undefined);
  };
  const loading =
    results.state.status === 'loading' ||
    (results.state.status === 'ready' && results.state.refreshing);
  return (
    <article className="search-page" aria-labelledby={titleId} aria-busy={loading}>
      <header>
        <h1 id={titleId} tabIndex={-1}>
          {uiMessage('app.784')}
        </h1>
        <p>{uiMessage('search.search-page.2092')}</p>
      </header>
      <form role="search" onSubmit={(event) => event.preventDefault()} className="search-form">
        <label>
          {uiMessage('search.search-page.2093')}
          <input
            ref={searchRef}
            type="search"
            value={form.text}
            maxLength={200}
            aria-describedby={hintId}
            onChange={(event) => field('text', event.currentTarget.value)}
          />
        </label>
        <p id={hintId} className="search-hint">
          {uiMessage('search.search-page.2094')}
        </p>
        <fieldset aria-labelledby={filtersId}>
          <legend id={filtersId}>{uiMessage('search.search-page.2095')}</legend>
          <div className="search-filters">
            <label>
              {uiMessage('search.search-detail.2082')}
              <select
                value={form.kind}
                onChange={(event) => field('kind', event.currentTarget.value)}
              >
                <option value="">{uiMessage('search.search-page.2096')}</option>
                {searchEntityKinds.map((kind) => (
                  <option key={kind} value={kind}>
                    {searchKindLabel[kind]}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {uiMessage('alignment.alignment-page.404')}
              <select
                value={form.state}
                onChange={(event) => field('state', event.currentTarget.value)}
              >
                <option value="">{uiMessage('search.search-page.2097')}</option>
                {searchStates.map((state) => (
                  <option key={state} value={state}>
                    {words(state)}
                  </option>
                ))}
              </select>
            </label>
            <label>
              {uiMessage('actions-ui.251')}
              <select
                value={form.axisId}
                onChange={(event) => field('axisId', event.currentTarget.value)}
                disabled={choices.state.status !== 'ready'}
              >
                <option value="">{uiMessage('search.search-page.2098')}</option>
                {choices.state.status === 'ready' &&
                  choices.state.data.axes.map((axis) => (
                    <option key={axis.id} value={axis.id}>
                      {axis.title}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              {uiMessage('actions-ui.254')}
              <select
                value={form.projectId}
                onChange={(event) => field('projectId', event.currentTarget.value)}
                disabled={choices.state.status !== 'ready'}
              >
                <option value="">{uiMessage('search.search-page.2099')}</option>
                {choices.state.status === 'ready' &&
                  choices.state.data.projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.title}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              {uiMessage('actions-ui.258')}
              <select
                value={form.archive}
                onChange={(event) => field('archive', event.currentTarget.value)}
              >
                <option value="exclude">{uiMessage('search.search-page.2100')}</option>
                <option value="include">{uiMessage('search.search-page.2101')}</option>
                <option value="only">{uiMessage('search.search-page.2102')}</option>
              </select>
            </label>
            <label>
              {uiMessage('search.search-page.2103')}
              <select
                value={form.dateBasis}
                onChange={(event) => field('dateBasis', event.currentTarget.value)}
              >
                <option value="updated">{uiMessage('search.search-page.2104')}</option>
                <option value="created">{uiMessage('search.search-page.2105')}</option>
                <option value="due">{uiMessage('search.search-page.2106')}</option>
                <option value="planned">{uiMessage('search.search-page.2107')}</option>
              </select>
            </label>
            <label>
              {uiMessage('search.search-page.2108')}
              <input
                type="date"
                value={form.from}
                onChange={(event) => field('from', event.currentTarget.value)}
              />
            </label>
            <label>
              {uiMessage('search.search-page.2109')}
              <input
                type="date"
                value={form.to}
                onChange={(event) => field('to', event.currentTarget.value)}
              />
            </label>
          </div>
        </fieldset>
        <button
          type="button"
          onClick={() => {
            setForm(initial);
            setCursor(undefined);
            searchRef.current?.focus();
          }}
        >
          {uiMessage('search.search-page.2110')}
        </button>
      </form>
      {choices.state.status === 'error' && (
        <div className="validation-summary" role="alert">
          <p>{uiMessage('search.search-page.2111')}</p>
          <button type="button" onClick={() => void choices.reload()}>
            {uiMessage('search.search-page.2112')}
          </button>
        </div>
      )}
      {choices.state.status === 'ready' && choices.state.data.truncated && (
        <p className="search-hint">{uiMessage('search.search-page.2113')}</p>
      )}
      {parsed.error !== null && (
        <p className="validation-summary" role="alert">
          {parsed.error}
        </p>
      )}
      <section className="search-results" aria-labelledby={`${titleId}-results`}>
        <h2 id={`${titleId}-results`} ref={resultsRef} tabIndex={-1}>
          {uiMessage('search.search-page.2114')}
        </h2>
        {loading && parsed.error === null && (
          <p role="status">{uiMessage('search.search-page.2115')}</p>
        )}
        {results.state.status === 'error' && (
          <div className="validation-summary" role="alert">
            <p>{uiMessage('search.search-page.2116')}</p>
            <button type="button" onClick={() => void results.reload()}>
              {uiMessage('account.account-dialogs.47')}
            </button>
          </div>
        )}
        {parsed.error === null && results.state.status === 'ready' && !loading && (
          <>
            <p role="status">
              {results.state.data.items.length}{' '}
              {results.state.data.items.length === 1
                ? uiMessage('search.search-page.2481')
                : uiMessage('search.search-page.2482')}
              {uiMessage('search.search-page.2117')}
              {results.state.data.nextCursor === undefined
                ? ''
                : uiMessage('search.search-page.2118')}
            </p>
            {results.state.data.items.length === 0 ? (
              <p className="quiet-empty">{uiMessage('search.search-page.2119')}</p>
            ) : (
              <ul className="search-result-list">
                {results.state.data.items.map((item) => (
                  <li key={`${item.kind}:${item.id}`}>
                    <h3>
                      <Link to={`/search/${item.kind}/${item.id}`}>{item.title}</Link>
                    </h3>
                    <p className="search-result-meta">
                      {searchKindLabel[item.kind]} · {words(item.state)}
                      {item.archived ? uiMessage('plan.templates.2475') : ''}
                    </p>
                    {item.excerpt !== '' && (
                      <p className="search-result-excerpt">
                        {item.excerpt}
                        {item.excerpt.length === 200 ? '…' : ''}
                      </p>
                    )}
                  </li>
                ))}
              </ul>
            )}
            <div className="search-pagination">
              {cursor !== undefined && (
                <button
                  type="button"
                  onClick={() => {
                    focusResults.current = true;
                    setCursor(undefined);
                  }}
                >
                  {uiMessage('search.search-page.2120')}
                </button>
              )}
              {results.state.data.nextCursor !== undefined && (
                <button
                  type="button"
                  onClick={() => {
                    if (results.state.status === 'ready') {
                      focusResults.current = true;
                      setCursor(results.state.data.nextCursor);
                    }
                  }}
                >
                  {uiMessage('search.search-page.2121')}
                </button>
              )}
            </div>
          </>
        )}
      </section>
    </article>
  );
}
