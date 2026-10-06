import {
  parseCalendarDate,
  parseUUID,
  type CalendarDate,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { createSerialQueue, serializeMethods, type SerialQueue } from './planning-kit';
import type { IdentityContextPort } from './ports';
import {
  searchDateBases,
  searchEntityKinds,
  searchStates,
  type SearchApplication,
  type SearchQueryPort,
  type SearchRequest,
} from './search-contracts';

const invalid = (): never => {
  throw new Error('Search filters are invalid. Check the text, dates, and selected filters.');
};
export const searchPageLimit = 40;
export const searchChoiceLimit = 1000;
export const searchCursorPattern =
  /^s1\.[0-9a-f]{8}\.\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\.(?:action|note|axis|outcome|project|milestone|routine|review|review_decision)\.[0-9a-f-]{36}$/u;

export function parseSearchRequest(raw: unknown): SearchRequest {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return invalid();
  const input = raw as Readonly<Record<string, unknown>>;
  if (typeof input['text'] !== 'string' || input['text'].length > 200) return invalid();
  const text = input['text'].trim();
  // Bounded terms protect SQL parameter count and query complexity. Normalization is adapter-owned.
  if (text.split(/[^\p{L}\p{N}\p{M}]+/u).filter(Boolean).length > 8) return invalid();
  const kind = input['kind'];
  const state = input['state'];
  const archive = input['archive'];
  const dateBasis = input['dateBasis'];
  if (kind !== undefined && !searchEntityKinds.includes(kind as never)) return invalid();
  if (state !== undefined && !searchStates.includes(state as never)) return invalid();
  if (archive !== 'exclude' && archive !== 'include' && archive !== 'only') return invalid();
  if (!searchDateBases.includes(dateBasis as never)) return invalid();
  const dates: { from?: CalendarDate; to?: CalendarDate } = {};
  for (const field of ['from', 'to'] as const) {
    const value = input[field];
    if (value === undefined) continue;
    const parsed = parseCalendarDate(typeof value === 'string' ? value : '');
    if (!parsed.ok) return invalid();
    dates[field] = parsed.value;
  }
  if (dates.from !== undefined && dates.to !== undefined && dates.from > dates.to) return invalid();
  const links: { axisId?: UUID; projectId?: UUID } = {};
  for (const field of ['axisId', 'projectId'] as const) {
    const value = input[field];
    if (value === undefined) continue;
    const parsed = parseUUID(typeof value === 'string' ? value : '');
    if (!parsed.ok) return invalid();
    links[field] = parsed.value;
  }
  const cursor = input['cursor'];
  if (cursor !== undefined && (typeof cursor !== 'string' || !searchCursorPattern.test(cursor)))
    return invalid();
  return {
    text,
    archive,
    dateBasis: dateBasis as SearchRequest['dateBasis'],
    ...(kind === undefined ? {} : { kind: kind as SearchRequest['kind'] & string }),
    ...(state === undefined ? {} : { state: state as SearchRequest['state'] & string }),
    ...dates,
    ...links,
    ...(cursor === undefined ? {} : { cursor }),
  };
}

/** Query-only use cases: identity validation and serialization are owned inward. */
export function createSearchApplication(
  identity: IdentityContextPort,
  queries: SearchQueryPort,
  options: { readonly queue?: SerialQueue } = {},
): SearchApplication {
  const owner = async (): Promise<OwnerId> => {
    const context = await identity.getActiveIdentity();
    if (context === null) throw new Error('Search needs an active local plan.');
    return context.ownerId;
  };
  return serializeMethods<SearchApplication>(
    {
      search: async (raw) =>
        queries.search(await owner(), parseSearchRequest(raw), searchPageLimit),
      detail: async (kind, id) => {
        if (!searchEntityKinds.includes(kind as never)) return null;
        const parsed = parseUUID(typeof id === 'string' ? id : '');
        if (!parsed.ok) return null;
        return queries.detail(
          await owner(),
          kind as Parameters<SearchQueryPort['detail']>[1],
          parsed.value,
        );
      },
      choices: async () => queries.choices(await owner(), searchChoiceLimit),
    },
    options.queue ?? createSerialQueue(),
  );
}
