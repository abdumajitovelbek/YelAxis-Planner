import {
  alignmentNodeKinds,
  type AlignmentNodeKind,
  type CalendarDate,
  type ReviewType,
} from '@yelaxis/domain';

export const planHorizons = ['year', 'month', 'week', 'day'] as const;
export type PlanHorizon = (typeof planHorizons)[number];

export const lastHorizonKey = 'yelaxis:plan:horizon';

/** Canonical Plan URL: `/plan/<horizon>/<YYYY-MM-DD>`; month/year use any date inside the period. */
export function planPath(horizon: PlanHorizon, date: CalendarDate | string): string {
  return `/plan/${horizon}/${date}`;
}

export const routinesPath = '/plan/routines';
export const routinePath = (routineId: string): string => `/plan/routines/${routineId}`;
export const templatesPath = '/plan/templates';
export const templatePath = (templateId: string): string => `/plan/templates/${templateId}`;
export const capacityPath = '/plan/availability';
export const milestonePath = (milestoneId: string): string => `/milestones/${milestoneId}`;
export const actionPath = (actionId: string): string => `/actions/${actionId}`;

/* ───────────────────────── Today ───────────────────────── */

/**
 * Today: `/` is the live planning today; `/?date=YYYY-MM-DD` is a selected date that only in-app
 * navigation creates and that never rolls over. A date equal to the live today, or
 * no date, is `/`.
 */
export function todayPath(date?: CalendarDate | string, liveToday?: CalendarDate | string): string {
  return date === undefined || date === liveToday ? '/' : `/?date=${date}`;
}

/** Focus mode for one Action. */
export const focusPath = (actionId: string): string => `/focus/${actionId}`;

/** End Day for one planning date (today or earlier). */
export const endDayPath = (date: CalendarDate | string): string => `/end-day/${date}`;

/** True for Today, Focus mode, and End Day: the Today navigation item is current on all three. */
export function isTodayAreaPath(pathname: string): boolean {
  return pathname === '/' || pathname.startsWith('/focus/') || pathname.startsWith('/end-day/');
}

/* ───────────────────────── Review ───────────────────────── */

/** The Review overview: current checkpoints, reviews in progress, and history. */
export const reviewPath = (): string => '/review';

/**
 * One review period: `/review/<type>/<period key>` for weekly (the week's first date), monthly
 * (`YYYY-MM`), and yearly (`YYYY`) reviews. The daily review is End Day for that date.
 */
export function reviewPeriodPath(type: ReviewType, key: string): string {
  return type === 'daily' ? endDayPath(key) : `/review/${type}/${key}`;
}

/** True for the Review overview and every review page: the Review navigation item is current. */
export function isReviewAreaPath(pathname: string): boolean {
  return pathname === '/review' || pathname.startsWith('/review/');
}

/* ───────────────────────── Axis area ───────────────────────── */

/** The Axis overview; `?archived=1` also lists archived Axes. */
export const axisOverviewPath = '/axis';
export const axisPath = (axisId: string): string => `/axis/${axisId}`;
export const outcomePath = (outcomeId: string): string => `/outcomes/${outcomeId}`;
export const projectPath = (projectId: string): string => `/projects/${projectId}`;

/** The object a map or list is centered on, written in the URL as `<kind>:<uuid>`. */
export interface AlignmentFocusParam {
  readonly kind: AlignmentNodeKind;
  readonly id: string;
}
export type AlignmentView = 'list' | 'map';

/**
 * The alignment page: `/axis/alignment?focus=<kind>:<uuid>&view=list|map`. The list is the
 * default view, so `view` is written only when given.
 */
export function alignmentPath(focus?: AlignmentFocusParam | null, view?: AlignmentView): string {
  // Written by hand so the focus stays readable (`outcome:<uuid>`); ':' is valid in a query.
  const parts = [
    ...(focus === undefined || focus === null
      ? []
      : [`focus=${focus.kind}:${encodeURIComponent(focus.id)}`]),
    ...(view === undefined ? [] : [`view=${view}`]),
  ];
  return parts.length === 0 ? '/axis/alignment' : `/axis/alignment?${parts.join('&')}`;
}

/** Read a `focus` search parameter; null when it is absent or not `<kind>:<id>`. */
export function parseAlignmentFocus(value: string | null | undefined): AlignmentFocusParam | null {
  if (value === null || value === undefined) return null;
  const separator = value.indexOf(':');
  if (separator <= 0) return null;
  const kind = value.slice(0, separator);
  const id = value.slice(separator + 1);
  const known = alignmentNodeKinds.find((candidate) => candidate === kind);
  return known === undefined || id === '' ? null : { kind: known, id };
}

const axisAreaPrefixes = ['/axis', '/outcomes', '/projects', '/milestones'] as const;

/** True for the Axis overview, the alignment page, and every Axis, Outcome, Project, and Milestone page. */
export function isAxisAreaPath(pathname: string): boolean {
  return axisAreaPrefixes.some(
    (prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`),
  );
}
