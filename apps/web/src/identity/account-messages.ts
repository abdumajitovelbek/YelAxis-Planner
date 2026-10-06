/**
 * Calm, safe copy for account results. A message never contains planning content, a
 * credential, or an email address, and always says what happened to this device's plan.
 */
export const accountMessages = Object.freeze({
  not_configured: 'Accounts are not available in this version. Your plan stays on this device.',
  invalid_input: 'Enter an email address and a password.',
  invalid_credentials:
    'That email and password did not match an account. Your plan on this device is unchanged.',
  user_exists: 'An account with this email already exists. Sign in instead.',
  weak_password: 'Choose a longer password, then try again.',
  confirmation_required:
    'Check your email to confirm the account, then sign in. Your plan on this device is unchanged.',
  email_not_confirmed: 'Confirm your email address first, then sign in.',
  rate_limited: 'There were too many attempts. Wait a moment, then try again.',
  offline:
    'You appear to be offline. Your plan on this device is unchanged; try again when you are connected.',
  unavailable:
    'The account service is not responding right now. Your plan on this device is unchanged; try again later.',
  account_being_deleted: 'This account is being deleted, so it cannot be opened on this device.',
  account_active: 'Sign out of the current account before signing in to another one.',
  no_pending_choice: 'No first upload is waiting. Sign in again to choose.',
  backup_failed:
    'The backup could not be made and checked, so nothing was uploaded. Your plan on this device is unchanged.',
  link_failed:
    'The first upload could not start. Your plan on this device is unchanged; try again.',
  nothing_to_cancel: 'There is no first upload to cancel.',
  cancel_failed:
    'The first upload could not be canceled right now. Every record is still on this device; try again.',
  storage: 'This device’s plan could not be read or saved. Nothing was changed; try again.',
  database_busy: 'Your plan is open in another tab. Close it there, then try again.',
  not_signed_in: 'No account is open on this device.',
  session_expired:
    'Your sign-in has expired. Sign in again to continue; your plan on this device is unchanged.',
  email_unknown: 'Sign in with your email and password to continue.',
  different_account:
    'That sign-in belongs to a different account. Your plan on this device is unchanged.',
  unsynced_changes:
    'Some changes have not reached your account yet. Export them first, or confirm that they are deleted with this copy.',
  remove_failed:
    'You are signed out. This device’s copy could not be removed yet; YelAxis Planner removes it the next time it opens.',
  deleted_copy_remove_failed:
    'Your account was deleted. This device’s copy could not be removed yet; YelAxis Planner removes it the next time it opens.',
  wrong_password: 'That password is not right. Nothing was deleted.',
  password_required: 'Enter your password to delete the account. Nothing was deleted.',
  deletion_in_progress: 'A deletion is already waiting. Retry or cancel it first.',
  deletion_failed:
    'The deletion did not finish. This device’s copy is kept; you can retry or cancel.',
  no_deletion: 'There is no account deletion to retry or cancel.',
  deletion_finish_failed:
    'Your account was deleted, but this device’s copy could not be finished. Try again; nothing was lost.',
  deletion_check_unavailable:
    'The account service cannot be reached, so the deletion could not be checked. This device’s copy is unchanged; you can still export it or remove it from this device.',
  deletion_check_signed_out:
    'Your sign-in has ended, so the deletion could not be checked. This device’s copy is unchanged; you can still export it or remove it from this device.',
  deletion_password_unverified:
    'That password did not sign you in. An account that was already deleted can no longer sign in. This device’s copy is unchanged; you can still export it or remove it from this device.',
  deletion_done_copy_kept:
    'Your account had already been deleted, so the deletion could not be canceled. This device’s copy is now a local plan.',
  deletion_done_copy_removed:
    'Your account had already been deleted, so the deletion could not be canceled. This device’s copy was deleted, as you chose.',
  export_failed: 'The export could not be made and checked, so no file was offered. Try again.',
} as const);

export type AccountMessageCode = keyof typeof accountMessages;
