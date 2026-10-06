import { message as uiMessage } from '../messages';
/**
 * Sync state outside the Account page. The app frame shows a short state in words
 * with a link to Account for an account identity, and nothing for a local-only one. The Today
 * header shows one quiet line only when something waits or needs an action. Neither
 * is a dialog or a live region: they never interrupt, announce themselves, or block a control.
 */
import type { ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { useAccountOptional } from './account-context';
import { accountPath } from './routes';
import { syncShortText, todaySyncNotice } from './sync-text';

import './account.css';

export function SyncStatusLine(): ReactNode {
  const context = useAccountOptional();
  const text = context === null ? null : syncShortText(context.status);
  if (context === null || text === null) return null;
  return (
    <p className="sync-status-line" data-state={context.status.state}>
      <span className="sync-status-text">{text}</span>
      <span aria-hidden="true"> · </span>
      <Link to={accountPath()}>{uiMessage('account.account-page.76')}</Link>
    </p>
  );
}

export function TodaySyncLine(): ReactNode {
  const context = useAccountOptional();
  const notice = context === null ? null : todaySyncNotice(context.status);
  if (context === null || notice === null) return null;
  return (
    <p className="today-sync-notice" data-state={context.status.state}>
      <span>{notice.text}</span> <Link to={notice.link.to}>{notice.link.label}</Link>
    </p>
  );
}
