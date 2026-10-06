import type { CaptureOrigin } from '@yelaxis/domain';

export const actionCaptureOrigins = [
  'global_capture',
  'today',
  'plan',
  'axis',
  'review',
  'inbox',
  'project',
  'onboarding',
  'import',
  'other',
] as const satisfies readonly CaptureOrigin[];

export type ActionCaptureOrigin = (typeof actionCaptureOrigins)[number];

type MissingCaptureOrigin = Exclude<CaptureOrigin, ActionCaptureOrigin>;

/** Compile-time exhaustiveness guard for the generated SQL vocabulary. */
export const actionCaptureOriginParity: [MissingCaptureOrigin] extends [never] ? true : never =
  true;
