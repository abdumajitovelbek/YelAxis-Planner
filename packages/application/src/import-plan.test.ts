import type { CanonicalSnapshotRecord } from './account-contracts';
import type { ImportBundle, ImportDestination } from './import-contracts';
import { buildImportPlan } from './import-plan';
import { emptyOnboardingDraft, type EntityType, type Instant, type UUID } from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

const id = (number: number) =>
  `bb000000-0000-4000-8000-${number.toString(16).padStart(12, '0')}` as UUID;
const profile: CanonicalSnapshotRecord = {
  type: 'profile',
  id: id(1),
  localRevision: 1,
  document: { planningTimeZone: 'UTC', weekStart: 'monday', timeFormat: '24_hour' },
};
const record = (
  type: EntityType,
  number: number,
  document: Record<string, unknown>,
): CanonicalSnapshotRecord => ({ type, id: id(number), localRevision: 1, document });
const action = record('action', 2, {
  title: 'Current',
  orderKey: 'a',
  state: 'planned',
  captureOrigin: 'plan',
});
const destination: ImportDestination = {
  snapshot: { ownerId: id(10), records: [profile, action] },
  supplement: { profileSettings: null, openConflicts: [] },
  accountLinked: false,
  syncWasPending: false,
  unconfirmedSync: false,
};
const bundle = (
  records: readonly CanonicalSnapshotRecord[],
  supplement: ImportBundle['supplement'] = { profileSettings: null, openConflicts: [] },
): ImportBundle => ({
  bundleId: id(30),
  exportedAt: '2026-10-03T00:00:00.000Z' as Instant,
  bytes: 3000,
  containsSensitiveContext: false,
  records,
  supplement,
});
const make = (
  incoming: ImportBundle,
  choices: Parameters<typeof buildImportPlan>[2] = [],
  mode: 'merge' | 'replace' = 'merge',
) => buildImportPlan(incoming, destination, choices, mode, {}, () => id(100));

describe('canonical import preview and graph rules', () => {
  it('classifies creates, identical skips, and unresolved collisions without choosing by time', () => {
    const incoming = bundle([
      profile,
      { ...action, document: { ...action.document, title: 'Imported' } },
      record('note', 3, { body: 'Text', orderKey: 'b', state: 'active' }),
    ]);
    const plan = make(incoming);
    expect(plan.preview).toMatchObject({
      creates: 1,
      identicalSkips: 1,
      updates: 0,
      canApply: false,
    });
    expect(plan.preview.conflicts).toMatchObject([
      { type: 'action', id: action.id, reason: 'id_collision' },
    ]);
    expect(
      make(incoming, [{ type: 'action', id: action.id, decision: 'keep_current' }]).preview,
    ).toMatchObject({ keeps: 1, canApply: true });
    expect(
      make(incoming, [{ type: 'action', id: action.id, decision: 'use_imported' }]).preview,
    ).toMatchObject({ updates: 1, canApply: true });
  });

  it('blocks missing required endpoints and preserved dependent records on replace', () => {
    const bad = record('action', 3, { ...action.document, projectId: id(99) });
    expect(make(bundle([profile, bad])).preview.problems).toContainEqual({
      code: 'missing_reference',
      type: 'action',
      id: bad.id,
    });
  });

  it('remaps the entire incoming dependency component when duplication is selected', () => {
    const incoming = bundle([
      profile,
      { ...action, document: { ...action.document, title: 'Imported' } },
      record('planning_placement', 4, {
        target: { kind: 'action', actionId: action.id },
        period: { kind: 'day', date: '2026-10-03' },
        orderKey: 'a',
      }),
    ]);
    let number = 100;
    const plan = buildImportPlan(
      incoming,
      destination,
      [{ type: 'action', id: action.id, decision: 'duplicate_imported' }],
      'merge',
      {},
      () => id(number++),
    );
    const importedAction = plan.records.find(
      (row) => row.type === 'action' && row.id !== action.id,
    );
    const placement = plan.records.find((row) => row.type === 'planning_placement');
    expect(plan.preview).toMatchObject({ creates: 2, canApply: true });
    expect(placement?.document['target']).toEqual({ kind: 'action', actionId: importedAction?.id });
    expect(plan.records.find((row) => row.type === 'profile')?.id).toBe(profile.id);
  });

  it('never applies imported deletion against live data or resurrects a tombstone implicitly', () => {
    const incoming = bundle([profile], {
      profileSettings: null,
      openConflicts: [],
      tombstones: [
        {
          entityType: 'action',
          entityId: action.id,
          localRevision: 2,
          deletedAt: '2026-10-02T00:00:00.000Z' as Instant,
        },
      ],
    });
    expect(make(incoming).preview).toMatchObject({ deletes: 0, canApply: false });
    expect(
      make(incoming, [{ type: 'action', id: action.id, decision: 'use_imported' }]).preview,
    ).toMatchObject({ deletes: 1, canApply: true });
    const deletedDestination = {
      ...destination,
      snapshot: { ...destination.snapshot, records: [profile] },
      supplement: { ...destination.supplement, tombstones: incoming.supplement.tombstones ?? [] },
    };
    expect(
      buildImportPlan(bundle([profile, action]), deletedDestination, [], 'merge', {}, () => id(100))
        .preview.conflicts,
    ).toMatchObject([{ reason: 'deleted_here' }]);
  });

  it('checks the resulting day focus cap and exact week boundaries before writing', () => {
    const actions = [2, 3, 4, 5].map((number) =>
      record('action', number, { ...action.document, title: `Action ${number}` }),
    );
    const focuses = actions.map((row, index) =>
      record('focus_selection', 20 + index, {
        kind: 'day_focus',
        profileId: profile.id,
        target: { kind: 'action', actionId: row.id },
        periodStart: '2026-10-03',
        periodEnd: '2026-10-03',
        orderKey: String(index),
      }),
    );
    const plan = make(bundle([profile, ...actions, ...focuses]), [
      { type: 'action', id: action.id, decision: 'use_imported' },
    ]);
    expect(plan.preview.problems.some((problem) => problem.code === 'focus_limit')).toBe(true);
    const badWeek = record('planning_placement', 40, {
      target: { kind: 'action', actionId: action.id },
      period: { kind: 'week', start: '2026-10-01', end: '2026-10-07', weekStart: 'monday' },
      orderKey: 'a',
    });
    expect(make(bundle([profile, action, badWeek])).preview.problems).toContainEqual({
      code: 'invalid_period',
      type: 'planning_placement',
      id: badWeek.id,
    });
  });

  it('previews disallowed horizons and unique planning slots instead of failing only at commit', () => {
    const yearPlacement = record('planning_placement', 40, {
      target: { kind: 'action', actionId: action.id },
      period: { kind: 'year', year: '2026' },
      orderKey: 'a',
    });
    expect(make(bundle([profile, action, yearPlacement])).preview.problems).toContainEqual({
      code: 'invalid_period',
      type: 'planning_placement',
      id: yearPlacement.id,
    });
    const blocks = [41, 42].map((number) =>
      record('time_block', number, {
        target: { kind: 'action', actionId: action.id },
        startsAt: '2026-10-03T05:00:00.000Z',
        endsAt: '2026-10-03T06:00:00.000Z',
        timeZone: 'UTC',
        state: 'planned',
        overlapAcknowledged: false,
      }),
    );
    expect(make(bundle([profile, action, ...blocks])).preview.problems).toContainEqual({
      code: 'duplicate_target',
      type: 'time_block',
      id: id(42),
    });
  });

  it('validates Routine generation continuity and the generation of Action defaults', () => {
    const routine = record('routine', 45, {
      title: 'Walk',
      state: 'active',
      orderKey: 'a',
      generations: [
        {
          generation: 2,
          rule: { kind: 'daily', startsOn: '2026-10-03', intervalDays: 1 },
          schedulingMode: { kind: 'day_flexible' },
        },
      ],
    });
    const defaults = record('routine_action_defaults', 46, {
      routineId: routine.id,
      generation: 1,
    });
    const plan = make(bundle([profile, routine, defaults]));
    expect(plan.preview.problems).toContainEqual({
      code: 'routine_mismatch',
      type: 'routine',
      id: routine.id,
    });
    expect(plan.preview.problems).toContainEqual({
      code: 'routine_mismatch',
      type: 'routine_action_defaults',
      id: defaults.id,
    });
  });

  it('shows full local Profile settings when a planning-identical Profile requires a decision', () => {
    const currentSettings = {
      profileId: profile.id,
      localRevision: 1,
      preferredName: 'Current person',
      localeOverride: null,
      onboardingDraft: null,
    };
    const importedSettings = {
      ...currentSettings,
      preferredName: 'Imported person',
      onboardingDraft: {
        ...emptyOnboardingDraft(),
        identity: { preferredName: 'Draft person', locale: 'en' },
      },
    };
    const plan = buildImportPlan(
      bundle([profile], { profileSettings: importedSettings, openConflicts: [] }),
      { ...destination, supplement: { profileSettings: currentSettings, openConflicts: [] } },
      [],
      'merge',
      {},
      () => id(100),
    );
    expect(plan.preview.conflicts).toMatchObject([
      {
        type: 'profile',
        current: { document: { preferredName: 'Current person', onboardingDraft: null } },
        imported: {
          document: {
            preferredName: 'Imported person',
            onboardingDraft: importedSettings.onboardingDraft,
          },
        },
      },
    ]);
  });

  it('retains valid historical conversions after their converted record was permanently deleted', () => {
    const converted = record('action', 50, {
      ...action.document,
      state: 'archived',
      stateBeforeArchive: 'planned',
      archivedAt: '2026-10-03T00:00:00.000Z',
      convertedTo: { type: 'note', id: id(51) },
    });
    expect(make(bundle([profile, converted])).preview).toMatchObject({
      problems: [],
      canApply: true,
    });
  });
});
