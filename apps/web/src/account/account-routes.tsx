import { message as uiMessage } from '../messages';
/**
 * The account routes, mounted by the app at `/account/*`. Without account configuration (or
 * without the account provider) every account path says so calmly and nothing else is offered.
 */
import { useId, type ReactNode } from 'react';
import { Link, Route, Routes } from 'react-router-dom';

import { accountsOffered, useAccountOptional } from './account-context';
import { AccountNotConfigured, AccountPage } from './account-page';
import { ConflictDetailPage, ConflictListPage } from './conflicts-page';
import { accountPath } from './routes';

import './account.css';

export function AccountRoutes(): ReactNode {
  const context = useAccountOptional();
  if (!accountsOffered(context)) return <AccountNotConfigured />;
  return (
    <Routes>
      <Route index element={<AccountPage />} />
      <Route path="conflicts" element={<ConflictListPage />} />
      <Route path="conflicts/:conflictId" element={<ConflictDetailPage />} />
      <Route path="*" element={<AccountPathUnavailable />} />
    </Routes>
  );
}

function AccountPathUnavailable(): ReactNode {
  const titleId = useId();
  return (
    <article className="account-page" aria-labelledby={titleId}>
      <header className="account-header">
        <h1 id={titleId} tabIndex={-1}>
          {uiMessage('account.account-routes.109')}
        </h1>
        <p className="account-intro">{uiMessage('account.account-routes.110')}</p>
      </header>
      <p>
        <Link className="back-link" to={accountPath()}>
          {uiMessage('account.account-routes.111')}
        </Link>
      </p>
    </article>
  );
}
