import { describe, expect, it, vi } from 'vitest';
import type { Instant, UUID } from '@yelaxis/domain';
import { emptyOnboardingDraft } from '@yelaxis/domain';

import { createExportApplication, reducedExport } from './export-application';
import { createSerialQueue } from './planning-kit';
import type { EncodedBundle, EncodeBundleInput } from './account-contracts';
import type { ImportBundle } from './import-contracts';

const id = (n: number) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}` as UUID;
const at = '2026-10-03T00:00:00.000Z' as Instant;
const bundle: ImportBundle = {
  bundleId: id(1),
  exportedAt: at,
  bytes: 100,
  containsSensitiveContext: true,
  records: [
    { type: 'context', id: id(2), localRevision: 1, document: { sensitivity: 'sensitive' } },
    { type: 'constraint', id: id(3), localRevision: 1, document: { contextId: id(2) } },
    {
      type: 'action',
      id: id(4),
      localRevision: 1,
      document: { title: 'Keep 日本語', state: 'inbox' },
    },
  ],
  supplement: { profileSettings: null, openConflicts: [] },
};
const encoded: EncodedBundle = {
  bundleId: id(1),
  exportedAt: at,
  text: 'verified fixture',
  recordCount: 3,
  manifest: {
    sections: [],
    recordCounts: { actions: 1, contexts: 1, constraints: 1 },
    dataSha256: 'a'.repeat(64),
    sourceMode: 'account',
    syncWasPending: true,
    containsSensitiveContext: true,
  },
};
function fixture(valid = true) {
  const encode = vi.fn((input: EncodeBundleInput) =>
    Promise.resolve({
      ...encoded,
      recordCount: input.snapshot.records.length,
    }),
  );
  const application = createExportApplication(
    {
      accounts: { exportBundle: () => Promise.resolve({ ok: true, value: encoded }) },
      decoder: { decode: () => Promise.resolve({ ok: true, value: bundle }) },
      bundles: {
        encode,
        verify: () =>
          Promise.resolve(
            valid
              ? {
                  ok: true,
                  bundleId: id(1),
                  recordCount: encode.mock.calls.length === 0 ? 3 : 1,
                  manifest: encoded.manifest,
                }
              : { ok: false, reason: 'digest_mismatch' },
          ),
      },
      ownerId: id(9),
      ids: { next: () => id(10) },
      clock: { now: () => at },
      appVersion: 'test',
    },
    { queue: createSerialQueue() },
  );
  return { application, encode };
}
describe('previewed verified exports', () => {
  it('removes sensitive setup draft copies and artifact links to omitted Context', () => {
    const draft = {
      ...emptyOnboardingDraft(),
      context: { boundary: { text: 'Synthetic private duplicate', strength: 'hard' as const } },
    };
    const reduced = reducedExport({
      ...bundle,
      supplement: {
        ...bundle.supplement,
        profileSettings: {
          profileId: id(8),
          localRevision: 1,
          preferredName: null,
          localeOverride: null,
          onboardingDraft: draft,
          onboardingArtifacts: {
            axisIds: [],
            commitments: [],
            boundaryContextId: id(2),
            availabilityConstraintId: id(3),
            actionId: id(4),
          },
        },
      },
    });
    expect(JSON.stringify(reduced)).not.toContain('Synthetic private duplicate');
    expect(reduced.supplement.profileSettings?.onboardingDraft).toBeNull();
    expect(reduced.supplement.profileSettings?.onboardingArtifacts).toEqual({
      axisIds: [],
      commitments: [],
      actionId: id(4),
    });
  });
  it('requires a snapshot preview and reports sensitivity and queued sync before download', async () => {
    const { application } = fixture();
    expect(await application.backup(true)).toEqual({ ok: false, code: 'preview_missing' });
    expect(await application.preview()).toMatchObject({
      ok: true,
      value: { recordCount: 3, sensitiveContextCount: 1, syncWasPending: true },
    });
    expect(await application.backup(true)).toEqual({ ok: true, value: encoded });
    const csv = await application.convenience('actions');
    expect(csv.ok).toBe(true);
    if (csv.ok) expect(csv.value).toContain('Keep 日本語');
  });
  it('re-encodes a reduced export without sensitive Context or dangling Constraints', async () => {
    expect(reducedExport(bundle).records.map((row) => row.type)).toEqual(['action']);
    const { application, encode } = fixture();
    await application.preview();
    expect(await application.backup(false)).toMatchObject({ ok: true, value: { recordCount: 1 } });
    expect(encode.mock.calls[0]?.[0]).toMatchObject({
      sourceMode: 'account',
      syncWasPending: true,
      snapshot: { records: [bundle.records[2]] },
    });
  });
  it('does not offer a file whose digest verification fails', async () => {
    const { application } = fixture(false);
    await application.preview();
    expect(await application.backup(true)).toEqual({ ok: false, code: 'verification_failed' });
  });
});
