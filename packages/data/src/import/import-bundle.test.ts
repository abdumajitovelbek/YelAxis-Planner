import type { CanonicalSnapshotRecord, EncodeBundleInput } from '@yelaxis/application';
import type { Instant, UUID } from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import { CanonicalBundleCodec, canonicalJson, sha256Hex } from '../account/canonical-bundle';

const id = (suffix: number) =>
  `aa000000-0000-4000-8000-${suffix.toString(16).padStart(12, '0')}` as UUID;
const at = '2026-10-03T05:00:00.000Z' as Instant;
const action: CanonicalSnapshotRecord = {
  type: 'action',
  id: id(1),
  localRevision: 1,
  document: { title: 'نور 🌱', state: 'planned', captureOrigin: 'plan', orderKey: 'a' },
};
const input: EncodeBundleInput = {
  snapshot: { ownerId: id(9), records: [action] },
  supplement: { profileSettings: null, openConflicts: [] },
  bundleId: id(8),
  exportedAt: at,
  appVersion: 'test',
  sourceMode: 'local',
  syncWasPending: false,
};

async function changed(edit: (data: Record<string, unknown>) => void): Promise<string> {
  const bundle = await new CanonicalBundleCodec().encode(input);
  const parsed = JSON.parse(bundle.text) as {
    data: Record<string, unknown>;
    manifest: { dataSha256: string; sections: string[]; recordCounts: Record<string, number> };
  };
  edit(parsed.data);
  parsed.manifest.dataSha256 = await sha256Hex(canonicalJson(parsed.data));
  parsed.manifest.sections = Object.keys(parsed.data).sort();
  parsed.manifest.recordCounts = Object.fromEntries(
    Object.entries(parsed.data).map(([section, records]) => [
      section,
      (records as unknown[]).length,
    ]),
  );
  return JSON.stringify(parsed);
}

describe('bounded canonical import parser', () => {
  it('decodes the verified human-readable bundle without copying authorization', async () => {
    const codec = new CanonicalBundleCodec();
    const result = await codec.decode((await codec.encode(input)).text);
    expect(result).toMatchObject({
      ok: true,
      value: { records: [action], supplement: { tombstones: [], history: [] } },
    });
    expect(JSON.stringify(result)).not.toContain(input.snapshot.ownerId);
  });

  it('accepts tested earlier v1 bundles without history and ledger supplements', async () => {
    const text = await changed((data) => {
      delete data['history'];
      delete data['tombstones'];
    });
    expect(await new CanonicalBundleCodec().decode(text)).toMatchObject({ ok: true });
  });

  it('rejects truncation, forged ownership, duplicate stable IDs, and unsupported versions', async () => {
    const codec = new CanonicalBundleCodec();
    const original = (await codec.encode(input)).text;
    expect(await codec.decode(original.slice(0, 100))).toEqual({
      ok: false,
      code: 'invalid_bundle',
    });
    expect(
      await codec.decode(original.replace('"formatVersion": 1', '"formatVersion": 2')),
    ).toEqual({ ok: false, code: 'unsupported_format' });
    const forged = await changed((data) => {
      const records = data['actions'] as { document: Record<string, unknown> }[];
      const row = records[0];
      if (row) row.document['ownerId'] = id(9);
    });
    expect(await codec.decode(forged)).toEqual({ ok: false, code: 'invalid_record' });
    const duplicate = await changed((data) => {
      const records = data['actions'] as unknown[];
      records.push(records[0]);
    });
    expect(await codec.decode(duplicate)).toMatchObject({ ok: false });
  });

  it('rejects prototype keys, excessive nesting, and huge strings before record parsing', async () => {
    const codec = new CanonicalBundleCodec();
    expect(await codec.decode('{"__proto__":{"polluted":true}}')).toEqual({
      ok: false,
      code: 'input_limit',
    });
    expect(await codec.decode(`${'['.repeat(50)}null${']'.repeat(50)}`)).toEqual({
      ok: false,
      code: 'input_limit',
    });
    expect(await codec.decode(JSON.stringify({ title: 'x'.repeat(100_001) }))).toEqual({
      ok: false,
      code: 'input_limit',
    });
    expect(await codec.decode(JSON.stringify(new Array<null>(200_000).fill(null)))).toEqual({
      ok: false,
      code: 'input_limit',
    });
    expect(Object.prototype).not.toHaveProperty('polluted');
  });

  it('validates conflict candidate schemas and real IANA zones, even with a valid digest', async () => {
    const badCandidate = await changed((data) => {
      data['conflict_candidates'] = [
        {
          id: id(22),
          revision: 1,
          document: {
            entityType: 'action',
            entityId: action.id,
            kind: 'stale_base',
            fields: ['title'],
            base: null,
            local: { deleted: false, document: { ...action.document, title: '' } },
            remote: { deleted: true, document: null },
            createdAt: at,
          },
        },
      ];
    });
    expect(await new CanonicalBundleCodec().decode(badCandidate)).toEqual({
      ok: false,
      code: 'invalid_record',
    });
    const badZone = await changed((data) => {
      data['time_blocks'] = [
        {
          id: id(23),
          revision: 1,
          document: {
            target: { kind: 'custom', title: 'Event' },
            startsAt: at,
            endsAt: '2026-10-03T06:00:00.000Z',
            timeZone: 'Not/AZone',
            state: 'scheduled',
          },
        },
      ];
    });
    expect(await new CanonicalBundleCodec().decode(badZone)).toEqual({
      ok: false,
      code: 'invalid_record',
    });
  });

  it('refuses unsupported record sections and altered content digest', async () => {
    const codec = new CanonicalBundleCodec();
    const text = (await codec.encode(input)).text;
    expect(await codec.decode(text.replace('نور 🌱', 'changed'))).toEqual({
      ok: false,
      code: 'digest_mismatch',
    });
    expect(
      await codec.decode(
        await changed((data) => {
          data['auth_tokens'] = [];
        }),
      ),
    ).toMatchObject({ ok: false });
  });
});
