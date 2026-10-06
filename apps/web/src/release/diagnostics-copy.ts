import { isPseudoLocale, pseudoLocalize } from '@yelaxis/i18n';

import { uiLocale } from '../messages';

const copy = {
  heading: 'Support information',
  explanation:
    'Preview a small support file before downloading. It contains the candidate revision, browser family, online state, available browser features and notification permission. It contains no plan content, account information, identifiers, URLs, storage contents or credentials. Nothing is sent automatically.',
  preview: 'Preview support information',
  download: 'Download support information',
  cancel: 'Close preview',
  handedOff: 'The file was handed to your browser. Confirm that it saved before sharing it.',
  failed: 'The file could not be handed to your browser. Your plan is unchanged. Try again.',
} as const;

export function diagnosticText(key: keyof typeof copy): string {
  return isPseudoLocale(uiLocale) ? pseudoLocalize(copy[key]) : copy[key];
}
