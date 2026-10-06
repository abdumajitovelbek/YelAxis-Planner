import { message as uiMessage } from '../messages';
import { useId, type ReactNode } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { SearchApplication, SearchDetail } from '@yelaxis/application';
import { usePlanQuery } from '../plan/planning-context';
import {
  actionPath,
  axisPath,
  milestonePath,
  outcomePath,
  projectPath,
  routinePath,
  reviewPeriodPath,
} from '../plan/routes';
import { searchKindLabel } from './search-page';
import './search.css';

function objectLink(record: SearchDetail): { to: string; label: string } | null {
  const paths = {
    action: actionPath,
    axis: axisPath,
    outcome: outcomePath,
    project: projectPath,
    milestone: milestonePath,
    routine: routinePath,
  };
  if (record.kind in paths) {
    const path = paths[record.kind as keyof typeof paths];
    return {
      to: path(record.id),
      label: uiMessage('search.search-detail.2074', { value0: searchKindLabel[record.kind] }),
    };
  }
  if (record.review !== undefined)
    return {
      to: reviewPeriodPath(record.review.type, record.review.key),
      label: uiMessage('search.search-detail.2075'),
    };
  return null;
}

/** Complete canonical-derived text for every result, including otherwise routeless Notes. */
export function SearchDetailPage({
  application,
}: {
  readonly application: SearchApplication;
}): ReactNode {
  const params = useParams<{ kind: string; id: string; entityId: string }>();
  const id = params.id ?? params.entityId;
  const { state, reload } = usePlanQuery(
    () => application.detail(params.kind, id),
    [application, params.kind, id],
  );
  const titleId = useId();
  const record = state.status === 'ready' ? state.data : null;
  const link = record === null ? null : objectLink(record);
  return (
    <article
      className="search-page"
      aria-labelledby={titleId}
      aria-busy={state.status === 'loading'}
    >
      <nav aria-label={uiMessage('search.search-detail.2076')}>
        <Link to="/search">{uiMessage('search.search-detail.2077')}</Link>
      </nav>
      {state.status === 'loading' && (
        <>
          <h1 id={titleId} tabIndex={-1}>
            {uiMessage('search.search-detail.2076')}
          </h1>
          <p role="status">{uiMessage('search.search-detail.2078')}</p>
        </>
      )}
      {state.status === 'error' && (
        <>
          <h1 id={titleId} tabIndex={-1}>
            {uiMessage('search.search-detail.2076')}
          </h1>
          <div className="validation-summary" role="alert">
            <p>{uiMessage('search.search-detail.2079')}</p>
            <button type="button" onClick={() => void reload()}>
              {uiMessage('account.account-dialogs.47')}
            </button>
          </div>
        </>
      )}
      {state.status === 'ready' && record === null && (
        <>
          <h1 id={titleId} tabIndex={-1}>
            {uiMessage('search.search-detail.2080')}
          </h1>
          <p>{uiMessage('search.search-detail.2081')}</p>
        </>
      )}
      {record !== null && (
        <>
          <h1 id={titleId} tabIndex={-1}>
            {record.title}
          </h1>
          <dl className="search-detail-facts">
            <dt>{uiMessage('search.search-detail.2082')}</dt>
            <dd>{searchKindLabel[record.kind]}</dd>
            <dt>{uiMessage('alignment.alignment-page.404')}</dt>
            <dd>
              {record.state.replaceAll('_', ' ')}
              {record.archived ? uiMessage('plan.templates.2475') : ''}
            </dd>
            <dt>{uiMessage('search.search-detail.2083')}</dt>
            <dd>
              {record.createdAt}
              {uiMessage('search.search-detail.2084')}
            </dd>
            <dt>{uiMessage('search.search-detail.2085')}</dt>
            <dd>
              {record.updatedAt}
              {uiMessage('search.search-detail.2084')}
            </dd>
          </dl>
          <h2>{uiMessage('search.search-detail.2086')}</h2>
          <p className="search-detail-text">
            {record.text === '' ? uiMessage('search.search-detail.2087') : record.text}
          </p>
          <div className="search-detail-links">
            {link !== null && <Link to={link.to}>{link.label}</Link>}
            {record.axisId !== undefined && record.kind !== 'axis' && (
              <Link to={axisPath(record.axisId)}>{uiMessage('search.search-detail.2088')}</Link>
            )}
            {record.projectId !== undefined && record.kind !== 'project' && (
              <Link to={projectPath(record.projectId)}>
                {uiMessage('search.search-detail.2089')}
              </Link>
            )}
          </div>
        </>
      )}
    </article>
  );
}
