/**
 * The planning Month theme and Year direction rules, shared by `setMonthTheme`, `setYearDirection`, and
 * the monthly and yearly reviews' Finish, so a theme or direction has one mutation
 * path. Each is one optional plain-text record per period with no progress or completion: setting
 * it updates the active record's text or creates one. Text is trimmed and holds 1 to 2,000
 * characters.
 */
import {
  createEntityRef,
  ok,
  type DomainResult,
  type EntityRef,
  type MonthKey,
  type OwnerId,
  type UUID,
  type YearKey,
} from '@yelaxis/domain';

import type { CanonicalMutation, CanonicalRecordState } from './contracts';
import type {
  MonthThemeDocument,
  PlanningQueryPort,
  YearDirectionDocument,
} from './planning-contracts';
import { createMutation, updateFrom, type CreatedRecord } from './planning-kit';
import { changed, trimmedText } from './planning-scheduling-support';
import type { PlanningRecordReader } from './ports';

export const themeTextLimit = 2000;

/** Event types of setting a theme or direction. Payloads carry only `{ operation }`. */
export const themeEventTypes = Object.freeze({
  monthThemeSet: 'planning.month_theme_set',
  yearDirectionSet: 'planning.year_direction_set',
});

/** A Month theme's text: trimmed, 1 to 2,000 characters. */
export const monthThemeText = (value: unknown): DomainResult<string> =>
  trimmedText(value, themeTextLimit, 'theme_text');

/** A Year direction's text: trimmed, 1 to 2,000 characters. */
export const yearDirectionText = (value: unknown): DomainResult<string> =>
  trimmedText(value, themeTextLimit, 'direction_text');

/** The active theme record of a month, read before a command opens. */
export async function findActiveTheme(
  queries: Pick<PlanningQueryPort, 'listMonthThemes' | 'readRecord'>,
  ownerId: OwnerId,
  month: MonthKey,
): Promise<CanonicalRecordState | null> {
  const rows = await queries.listMonthThemes(ownerId, month.slice(0, 4) as YearKey);
  const row = rows.find((candidate) => candidate.month === month);
  return row === undefined
    ? null
    : queries.readRecord(ownerId, createEntityRef('theme', row.id, ownerId));
}

/** The active direction record of a year, read before a command opens. */
export async function findActiveDirection(
  queries: Pick<PlanningQueryPort, 'getYearDirection' | 'readRecord'>,
  ownerId: OwnerId,
  year: YearKey,
): Promise<CanonicalRecordState | null> {
  const row = await queries.getYearDirection(ownerId, year);
  return row === null
    ? null
    : queries.readRecord(ownerId, createEntityRef('direction', row.id, ownerId));
}

/** One set theme or direction: an update of the active record, or a created one. */
export interface PeriodTextPlan {
  readonly mutation: CanonicalMutation;
  readonly created?: CreatedRecord;
}

/** Set a month's theme inside the command transaction (`existing` was read before it). */
export async function planMonthTheme(
  records: PlanningRecordReader,
  request: {
    readonly existing: CanonicalRecordState | null;
    readonly profileId: UUID;
    readonly month: MonthKey;
    /** Already checked with `monthThemeText`. */
    readonly text: string;
    readonly newRef: EntityRef<'theme'>;
  },
): Promise<DomainResult<PeriodTextPlan>> {
  const current = request.existing === null ? null : await records.read(request.existing.ref);
  if (current !== null) {
    const document = current.document as MonthThemeDocument;
    if (document.archivedAt !== undefined) return changed('theme_changed');
    return ok({ mutation: updateFrom(current, { ...document, text: request.text }) });
  }
  const document: MonthThemeDocument = {
    profileId: request.profileId,
    month: request.month,
    text: request.text,
  };
  return ok({
    mutation: createMutation(request.newRef, document),
    created: { ref: request.newRef, kind: 'theme' },
  });
}

/** Set a year's direction inside the command transaction (`existing` was read before it). */
export async function planYearDirection(
  records: PlanningRecordReader,
  request: {
    readonly existing: CanonicalRecordState | null;
    readonly profileId: UUID;
    readonly year: YearKey;
    /** Already checked with `yearDirectionText`. */
    readonly text: string;
    readonly newRef: EntityRef<'direction'>;
  },
): Promise<DomainResult<PeriodTextPlan>> {
  const current = request.existing === null ? null : await records.read(request.existing.ref);
  if (current !== null) {
    const document = current.document as YearDirectionDocument;
    if (document.archivedAt !== undefined) return changed('direction_changed');
    return ok({ mutation: updateFrom(current, { ...document, text: request.text }) });
  }
  const document: YearDirectionDocument = {
    profileId: request.profileId,
    year: request.year,
    text: request.text,
  };
  return ok({
    mutation: createMutation(request.newRef, document),
    created: { ref: request.newRef, kind: 'direction' },
  });
}
