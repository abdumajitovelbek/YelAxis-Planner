import { isInputRecord } from './input-record.js';

type Check = (value: unknown) => boolean;
const text: Check = (value) => typeof value === 'string';
const boolean: Check = (value) => typeof value === 'boolean';
const integer: Check = (value) => typeof value === 'number' && Number.isSafeInteger(value);
const optional =
  (check: Check): Check =>
  (value) =>
    value === undefined || check(value);
const nullable =
  (check: Check): Check =>
  (value) =>
    value === null || check(value);
const list =
  (check: Check): Check =>
  (value) =>
    Array.isArray(value) && value.every(check);
const object =
  (fields: Readonly<Record<string, Check>>): Check =>
  (value) =>
    isInputRecord(value, Object.keys(fields)) &&
    Object.entries(fields).every(([key, check]) =>
      check(Object.hasOwn(value, key) ? value[key] : undefined),
    );

// Closed runtime shape for every step. Existing semantic limits belong to the reached step;
// later canonical edits may exceed narrower starter limits and must stay visible for correction.
export const isOnboardingDraftInput = object({
  identity: object({ preferredName: text, locale: text }),
  defaults: nullable(
    object({ planningTimeZone: text, weekStart: text, timeFormat: text, locale: text }),
  ),
  context: object({
    awakeWindow: optional(object({ start: text, end: text })),
    availability: optional(
      object({
        label: text,
        weekdays: list(text),
        start: text,
        end: text,
        strength: text,
      }),
    ),
    boundary: optional(object({ text: text, strength: text })),
  }),
  axes: list(text),
  outcome: nullable(
    object({
      title: text,
      successDefinition: text,
      axisIndex: optional(integer),
      targetDate: optional(text),
    }),
  ),
  week: object({
    actionTitle: text,
    commitments: list(
      object({
        title: text,
        date: text,
        start: text,
        end: text,
        strength: text,
        confirmed: boolean,
        timeZone: optional(text),
      }),
    ),
  }),
});
