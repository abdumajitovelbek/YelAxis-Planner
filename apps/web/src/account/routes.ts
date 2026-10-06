/** account paths. `AccountRoutes` is mounted at `/account/*`. */

export const accountPath = (): string => '/account';

export const conflictsPath = (): string => '/account/conflicts';

export const conflictPath = (conflictId: string): string =>
  `/account/conflicts/${encodeURIComponent(conflictId)}`;
