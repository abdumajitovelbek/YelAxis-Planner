import { message as uiMessage } from '../messages';
/**
 * The Settings entry to Account (`/account`): one section with the account state in words and an
 * "Open Account" link. It shows the honest not-available line in a build without accounts.
 */
import { useId, type ReactNode } from 'react';
import { Link } from 'react-router-dom';

import { accountEmail, accountsOffered, useAccountOptional } from './account-context';
import { accountPath } from './routes';
import { notConfiguredText, syncShortText } from './sync-text';

import './account.css';

export function AccountSettingsSection(): ReactNode {
  const context = useAccountOptional();
  const headingId = useId();
  let text = notConfiguredText;
  if (context !== null && accountsOffered(context)) {
    const short = syncShortText(context.status);
    const email = accountEmail(context);
    text =
      short === null
        ? uiMessage('account.account-settings.112')
        : `${email === null ? uiMessage('account.account-settings.113') : uiMessage('account.account-page.75', { value0: email })} ${short}${short.endsWith('…') ? '' : '.'}`;
  }
  return (
    <section className="settings-section account-settings" aria-labelledby={headingId}>
      <div>
        <h2 id={headingId}>{uiMessage('account.account-settings.114')}</h2>
        <p>{text}</p>
      </div>
      <Link className="inline-button account-settings-link" to={accountPath()}>
        {uiMessage('account.account-routes.111')}
      </Link>
    </section>
  );
}
