import { message as uiMessage } from '../messages';
/**
 * The outcome of an account operation that switched the open plan (signing out, removing the
 * account from this device, deleting it, the first upload's start or cancel, keeping this plan).
 * The view that started the operation is gone once the plan switched, so its outcome is shown here,
 * once: in the app frame, or above the setup journey when a fresh local plan starts at setup. On
 * the Account page the page itself shows it, in its own result region. It takes focus a frame after
 * it appears, after whatever the new view focused on its own, and stays until the person moves on.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';

import { useAccountOptional } from './account-context';
import type { AccountNotice } from './account-service';
import { useFocusAfterDialogs } from './account-parts';
import { accountPath } from './routes';

import './account.css';

export function AccountNoticeBanner({
  accountPageMounted = true,
}: {
  /**
   * Whether the Account page can be on screen beside this banner. Above the setup journey it never
   * is, whatever the path, so the banner shows every outcome there.
   */
  readonly accountPageMounted?: boolean;
} = {}): ReactNode {
  const context = useAccountOptional();
  const location = useLocation();
  const [shown, setShown] = useState<{
    readonly notice: AccountNotice;
    /** The page it was shown on: moving to another page leaves it behind. */
    readonly locationKey: string;
  } | null>(null);
  const textRef = useRef<HTMLParagraphElement>(null);
  const notice = context?.notice ?? null;
  // The Account page shows its own outcomes, when it is on screen.
  const onAccountPage =
    accountPageMounted && location.pathname.replace(/\/+$/u, '') === accountPath();
  useEffect(() => {
    if (notice === null || onAccountPage || context === null) return;
    setShown({ notice, locationKey: location.key });
    context.consumeNotice(notice.key);
  }, [notice?.key, onAccountPage]);
  useFocusAfterDialogs(textRef, shown?.notice.key ?? 0);

  if (shown === null || shown.locationKey !== location.key) return null;
  return (
    <section className="account-notice" aria-label={uiMessage('account.account-notice.70')}>
      <div role={shown.notice.tone === 'alert' ? 'alert' : 'status'}>
        <p key={shown.notice.key} ref={textRef} className="account-notice-text" tabIndex={-1}>
          {shown.notice.text}
        </p>
      </div>
      <button type="button" className="text-button" onClick={() => setShown(null)}>
        {uiMessage('account.account-notice.71')}
      </button>
    </section>
  );
}
