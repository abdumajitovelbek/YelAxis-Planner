import { describe, expect, it, vi } from 'vitest';
import type { OwnerId, UUID } from '@yelaxis/domain';
import { createSerialQueue } from './planning-kit';
import { createSearchApplication } from './search';
import type { SearchQueryPort } from './search-contracts';

const owner = '10000000-0000-4000-8000-000000000001' as OwnerId;
const id = '16000000-0000-4000-8000-000000000001' as UUID;
const request = { text: '  synthetic  ', archive: 'exclude', dateBasis: 'updated' };
function setup(active = true) {
  const queries: SearchQueryPort = {
    search: vi.fn(() => Promise.resolve({ items: [] })),
    detail: vi.fn(() => Promise.resolve(null)),
    choices: vi.fn(() => Promise.resolve({ axes: [], projects: [], truncated: false })),
  };
  const application = createSearchApplication(
    {
      getActiveIdentity: () =>
        Promise.resolve(active ? { ownerId: owner, syncEnabled: false } : null),
    },
    queries,
  );
  return { queries, application };
}
describe('local Search application', () => {
  it('binds every read to the active owner and fixes page limits', async () => {
    const { application, queries } = setup();
    await application.search({ ...request, ownerId: 'another', limit: 99999 });
    expect(queries.search).toHaveBeenCalledWith(owner, { ...request, text: 'synthetic' }, 40);
    await application.detail('note', id);
    expect(queries.detail).toHaveBeenCalledWith(owner, 'note', id);
    await application.choices();
    expect(queries.choices).toHaveBeenCalledWith(owner, 1000);
  });
  it.each([
    { text: 'x'.repeat(201) },
    { kind: 'context' },
    { state: 'unknown' },
    { archive: 'all' },
    { dateBasis: 'other' },
    { from: '2026-02-30' },
    { from: '2026-10-02', to: '2026-10-01' },
    { axisId: 'not-an-id' },
    { projectId: 'not-an-id' },
    { cursor: 'invalid' },
    { text: 'one two three four five six seven eight nine' },
  ])('rejects invalid input without reading canonical data: %j', async (invalid) => {
    const { application, queries } = setup();
    await expect(application.search({ ...request, ...invalid })).rejects.toThrow('Search filters');
    expect(queries.search).not.toHaveBeenCalled();
  });
  it('rejects malformed deep links and needs an active identity', async () => {
    const { application, queries } = setup();
    expect(await application.detail('context', id)).toBeNull();
    expect(await application.detail('action', '../other')).toBeNull();
    expect(queries.detail).not.toHaveBeenCalled();
    await expect(setup(false).application.search(request)).rejects.toThrow('active local plan');
  });
  it('shares the composition queue so reads wait for a pending canonical write', async () => {
    const queue = createSerialQueue();
    const { queries } = setup();
    let release: (() => void) | undefined;
    const pending = queue.run(
      () =>
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const application = createSearchApplication(
      { getActiveIdentity: () => Promise.resolve({ ownerId: owner, syncEnabled: true }) },
      queries,
      { queue },
    );
    const read = application.search(request);
    await Promise.resolve();
    expect(queries.search).not.toHaveBeenCalled();
    release?.();
    await pending;
    await read;
    expect(queries.search).toHaveBeenCalledTimes(1);
  });
});
