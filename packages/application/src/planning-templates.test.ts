import {
  createEntityRef,
  entityRefKey,
  previewTemplateApplication,
  type EntityType,
  type IanaTimeZone,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';
import { beforeEach, describe, expect, it } from 'vitest';

import type { ActionCanonicalDocument } from './actions';
import type { ApplicationResult, CanonicalRecordState, CommandReceipt } from './contracts';
import { executeCommand } from './execute-command';
import type {
  PlanProfile,
  PlanningPlacementDocument,
  ProjectDocument,
  TemplateDocument,
  TimeBlockDocument,
} from './planning-contracts';
import { planPlanningUndo } from './planning-kit';
import { createTestPlanningQueries } from './planning-routines-test-queries';
import { createTemplateCommands } from './planning-templates';
import { planTemplateApplication, scanTemplateOverlaps } from './planning-templates-apply';
import { builtInTemplates } from './template-catalog';
import { createInMemoryHarness, type InMemoryHarness } from './testing/in-memory-unit-of-work';

const ownerId = '10000000-0000-4000-8000-000000000001' as OwnerId;
const now = '2026-09-28T13:00:00.000Z' as Instant;
const zone = 'America/New_York' as IanaTimeZone;
const profile: PlanProfile = {
  profileId: '10000000-0000-4000-8000-0000000000aa' as UUID,
  planningTimeZone: zone,
  weekStart: 'monday',
  timeFormat: '24_hour',
};
// Friday before the 2026-03-08 US daylight-saving change.
const anchor = '2026-03-06';

let harness: InMemoryHarness;
let commands: ReturnType<typeof createTemplateCommands>;

function recordsOf(type: EntityType): CanonicalRecordState[] {
  return [...harness.unitOfWork.state.records.values()].filter((item) => item.ref.type === type);
}

function record(type: EntityType, id: string): CanonicalRecordState | undefined {
  return harness.unitOfWork.get(entityRefKey(createEntityRef(type, id as UUID, ownerId)));
}

function seed(type: EntityType, id: string, document: Readonly<Record<string, unknown>>): void {
  harness.unitOfWork.seed({
    ref: createEntityRef(type, id as UUID, ownerId),
    localRevision: 1,
    serverRevision: 0,
    baseSnapshotHash: null,
    document,
  });
}

function accepted(result: ApplicationResult<CommandReceipt>): CommandReceipt {
  if (!result.ok) throw new Error(`Expected success, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function rejectionReason(result: ApplicationResult<CommandReceipt>): unknown {
  if (result.ok) throw new Error('Expected a rejection.');
  if (result.error.code !== 'domain_rejected') return result.error.code;
  return result.error.domainError.details?.['reason'] ?? result.error.domainError.code;
}

function builtIn(title: string) {
  const template = builtInTemplates.find((item) => item.title === title);
  if (template === undefined) throw new Error(`Missing built-in ${title}`);
  return template;
}

const allKeys = (title: string): string[] =>
  builtIn(title).blueprint.items.map((item) => item.templateKey);

function counts(): Record<string, number> {
  const output: Record<string, number> = {};
  for (const item of harness.unitOfWork.state.records.values())
    output[item.ref.type] = (output[item.ref.type] ?? 0) + 1;
  return output;
}

const placements = () =>
  recordsOf('planning_placement').map((item) => item.document as PlanningPlacementDocument);
const blocks = () => recordsOf('time_block').map((item) => item.document as TimeBlockDocument);
const actions = () => recordsOf('action').map((item) => item.document as ActionCanonicalDocument);

function expectMinimizedEvents(): void {
  for (const { event } of harness.unitOfWork.state.events)
    expect(Object.keys(event.payload)).toEqual(['operation']);
}

async function apply(title: string, selectedKeys = allKeys(title)) {
  return commands.applyTemplate({
    templateId: builtIn(title).id,
    anchorDate: anchor,
    timeZone: zone,
    selectedKeys,
    overlapAcknowledged: false,
  });
}

beforeEach(() => {
  harness = createInMemoryHarness(ownerId, now);
  commands = createTemplateCommands(
    harness.dependencies,
    createTestPlanningQueries(harness.unitOfWork, profile),
  );
});

describe('applyTemplate with built-in templates', () => {
  it('Weekly Reset creates four scheduled Actions with Day placements and blocks', async () => {
    accepted(await apply('Weekly Reset'));
    expect(counts()).toEqual({ action: 4, planning_placement: 4, time_block: 4 });
    expect(actions().every((action) => action.state === 'scheduled')).toBe(true);
    expect(actions().every((action) => action.captureOrigin === 'plan')).toBe(true);
    expect(
      placements().every((item) => item.period.kind === 'day' && item.period.date === anchor),
    ).toBe(true);
    // 09:00 EST on 2026-03-06 is 14:00 UTC.
    expect(
      blocks()
        .map((item) => item.startsAt)
        .sort()[0],
    ).toBe('2026-03-06T14:00:00.000Z');
    expect(blocks().every((item) => !item.overlapAcknowledged && item.timeZone === zone)).toBe(
      true,
    );
    expectMinimizedEvents();
  });

  it('Study Week crosses the DST change with correct instants and a Week-placed Project', async () => {
    accepted(await apply('Study Week'));
    expect(counts()).toEqual({ project: 1, action: 6, planning_placement: 7, time_block: 5 });
    const project = recordsOf('project')[0];
    const projectDocument = project?.document as ProjectDocument;
    expect(projectDocument.state).toBe('active');
    expect(projectDocument.desiredResult).toContain('practice');
    expect(actions().every((action) => action.projectId === project?.ref.id)).toBe(true);
    expect(actions().filter((action) => action.state === 'planned')).toHaveLength(1);
    const weekPlacement = placements().find((item) => item.target.kind === 'project');
    expect(weekPlacement?.period).toEqual({
      kind: 'week',
      start: '2026-03-02',
      end: '2026-03-08',
      weekStart: 'monday',
    });
    const starts = blocks()
      .map((item) => item.startsAt)
      .sort();
    // 18:00 EST (UTC-5) before the change, 18:00 EDT (UTC-4) after; 17:00 EDT on 2026-03-10.
    expect(starts).toEqual([
      '2026-03-06T23:00:00.000Z',
      '2026-03-07T23:00:00.000Z',
      '2026-03-08T22:00:00.000Z',
      '2026-03-09T22:00:00.000Z',
      '2026-03-10T21:00:00.000Z',
    ]);
    const light = placements().filter(
      (item) => item.period.kind === 'day' && item.period.date === '2026-03-11',
    );
    expect(light).toHaveLength(1);
  });

  it('Product Sprint creates the Project, Actions, and a Note', async () => {
    accepted(await apply('Product Sprint'));
    expect(counts()).toEqual({
      project: 1,
      action: 5,
      note: 1,
      planning_placement: 6,
      time_block: 2,
    });
    const projectId = recordsOf('project')[0]?.ref.id;
    expect(recordsOf('note')[0]?.document).toMatchObject({
      title: 'Sprint retrospective',
      projectId,
      state: 'active',
    });
  });

  it('Research Block creates three timed Actions and a Note', async () => {
    accepted(await apply('Research Block'));
    expect(counts()).toEqual({ action: 3, note: 1, planning_placement: 3, time_block: 3 });
  });

  it('Balanced Day creates five timed Actions', async () => {
    accepted(await apply('Balanced Day'));
    expect(counts()).toEqual({ action: 5, planning_placement: 5, time_block: 5 });
    expect(
      blocks()
        .map((item) => [item.startsAt, item.endsAt])
        .sort()[0],
    ).toEqual(['2026-03-06T14:00:00.000Z', '2026-03-06T15:30:00.000Z']);
  });

  it('blocks application with no writes when a parent is deselected', async () => {
    const result = await apply(
      'Study Week',
      allKeys('Study Week').filter((key) => key !== 'project'),
    );
    expect(rejectionReason(result)).toBe('template_preview_issues');
    if (!result.ok && result.error.code === 'domain_rejected')
      expect(result.error.domainError.details?.['issues']).toContainEqual({
        code: 'parent_deselected',
        templateKey: 'notes',
        parentTemplateKey: 'project',
      });
    expect(harness.unitOfWork.state.records.size).toBe(0);
    expect(harness.unitOfWork.state.events).toHaveLength(0);
    expect(rejectionReason(await apply('Weekly Reset', []))).toBe('template_preview_issues');
  });

  it('undo archives or cancels everything the application created', async () => {
    const receipt = accepted(await apply('Research Block'));
    if (!receipt.undo.available) throw new Error('Undo unavailable.');
    accepted(
      await executeCommand(
        harness.dependencies,
        {
          commandId: harness.dependencies.ids.next(),
          ownerId,
          actor: 'user',
          expectedRevisions: [],
          input: undefined,
          consumesUndoId: receipt.undo.undoId,
        },
        ({ records, context, undoDescriptor }) =>
          planPlanningUndo(undoDescriptor?.descriptor.payload, records, context),
      ),
    );
    expect(actions().every((action) => action.state === 'archived')).toBe(true);
    expect(recordsOf('note').every((note) => note.document['state'] === 'archived')).toBe(true);
    expect(placements().every((item) => item.archivedAt === now)).toBe(true);
    expect(blocks().every((item) => item.state === 'canceled')).toBe(true);
    expect(counts()).toEqual({ action: 3, note: 1, planning_placement: 3, time_block: 3 });
  });
});

describe('applyTemplate with user templates', () => {
  async function saveUser(blueprint: unknown, title = 'Mine'): Promise<UUID> {
    const receipt = accepted(await commands.saveTemplate({ title, blueprint }));
    const ref = receipt.canonical[0]?.ref;
    if (ref === undefined) throw new Error('No template created.');
    return ref.id;
  }

  it('keeps version 1 items unscheduled as Backlog Actions', async () => {
    const templateId = await saveUser({
      version: 1,
      items: [
        { templateKey: 'a', kind: 'action', title: 'Pack bag', estimateMinutes: 10 },
        { templateKey: 'b', kind: 'action', title: 'Water plants', priority: 'low' },
      ],
    });
    accepted(
      await commands.applyTemplate({
        templateId,
        anchorDate: anchor,
        timeZone: zone,
        selectedKeys: ['a', 'b'],
        overlapAcknowledged: false,
      }),
    );
    expect(actions().map((action) => action.state)).toEqual(['planned', 'planned']);
    expect(recordsOf('planning_placement')).toHaveLength(0);
    expect(recordsOf('time_block')).toHaveLength(0);
  });

  it('maps typed parents and horizons and resolves a DST-gap commitment time', async () => {
    const templateId = await saveUser({
      version: 2,
      items: [
        { templateKey: 'axis', kind: 'axis', title: 'Learning' },
        {
          templateKey: 'outcome',
          kind: 'outcome',
          title: 'Pass the exam',
          note: 'Score 80 or more',
          parentTemplateKey: 'axis',
          relativeDayOffset: 0,
        },
        {
          templateKey: 'milestone',
          kind: 'milestone',
          title: 'Mock exam',
          note: 'Complete one mock exam',
          parentTemplateKey: 'outcome',
          relativeDayOffset: 3,
        },
        {
          templateKey: 'project',
          kind: 'project',
          title: 'Revision',
          parentTemplateKey: 'outcome',
        },
        {
          templateKey: 'commitment',
          kind: 'commitment',
          title: 'Early lab',
          relativeDayOffset: 2,
          localStartTime: '02:30',
          durationMinutes: 60,
        },
      ],
    });
    accepted(
      await commands.applyTemplate({
        templateId,
        anchorDate: anchor,
        timeZone: zone,
        selectedKeys: ['axis', 'outcome', 'milestone', 'project', 'commitment'],
        overlapAcknowledged: false,
      }),
    );
    const axis = recordsOf('axis')[0];
    const outcome = recordsOf('outcome')[0];
    expect(outcome?.document).toMatchObject({
      successDefinition: 'Score 80 or more',
      axisId: axis?.ref.id,
      progress: { mode: 'none' },
      state: 'active',
    });
    expect(recordsOf('milestone')[0]?.document).toMatchObject({
      measurableCheckpoint: 'Complete one mock exam',
      outcomeId: outcome?.ref.id,
    });
    expect(recordsOf('project')[0]?.document).toMatchObject({
      state: 'idea',
      primaryOutcomeId: outcome?.ref.id,
    });
    expect(
      placements()
        .map((item) => item.period.kind)
        .sort(),
    ).toEqual(['month', 'week']);
    expect(recordsOf('commitment')[0]?.document).toEqual({
      title: 'Early lab',
      strength: 'soft',
      state: 'planned',
    });
    // 02:30 does not exist on 2026-03-08 in New York; it shifts to 03:30 EDT (07:30 UTC).
    expect(blocks()[0]).toMatchObject({
      startsAt: '2026-03-08T07:30:00.000Z',
      endsAt: '2026-03-08T08:30:00.000Z',
      target: { kind: 'commitment', commitmentId: recordsOf('commitment')[0]?.ref.id },
    });
    const keys = [...recordsOf('axis'), ...recordsOf('outcome'), ...recordsOf('milestone')].map(
      (item) => item.document['orderKey'],
    );
    expect(keys.every((key) => typeof key === 'string' && /^\d{15}$/u.test(key))).toBe(true);
  });

  it('blocks routine items until they are deselected', async () => {
    const templateId = await saveUser({
      version: 2,
      items: [
        { templateKey: 'routine', kind: 'routine', title: 'Daily reading' },
        { templateKey: 'action', kind: 'action', title: 'Buy a notebook' },
      ],
    });
    const blocked = await commands.applyTemplate({
      templateId,
      anchorDate: anchor,
      timeZone: zone,
      selectedKeys: ['routine', 'action'],
      overlapAcknowledged: false,
    });
    expect(rejectionReason(blocked)).toBe('template_preview_issues');
    expect(recordsOf('action')).toHaveLength(0);
    accepted(
      await commands.applyTemplate({
        templateId,
        anchorDate: anchor,
        timeZone: zone,
        selectedKeys: ['action'],
        overlapAcknowledged: false,
      }),
    );
    expect(recordsOf('action')).toHaveLength(1);
  });
});

describe('applyTemplate overlaps and block rules', () => {
  const existingBlock = '50000000-0000-4000-8000-0000000000e1';
  const timedAction = (
    templateKey: string,
    title: string,
    localStartTime: string,
    durationMinutes = 60,
  ) => ({
    templateKey,
    kind: 'action',
    title,
    relativeDayOffset: 0,
    localStartTime,
    durationMinutes,
  });

  async function saveUser(items: unknown[]): Promise<UUID> {
    const receipt = accepted(
      await commands.saveTemplate({ title: 'Mine', blueprint: { version: 2, items } }),
    );
    const ref = receipt.canonical[0]?.ref;
    if (ref === undefined) throw new Error('No template created.');
    return ref.id;
  }

  function seedExistingBlock(): void {
    // 09:00-10:00 EST on the anchor date.
    seed('time_block', existingBlock, {
      target: { kind: 'custom', title: 'Dentist' },
      startsAt: '2026-03-06T14:00:00.000Z',
      endsAt: '2026-03-06T15:00:00.000Z',
      timeZone: zone,
      state: 'planned',
      overlapAcknowledged: false,
    });
  }

  const request = (templateId: string, selectedKeys: string[], overlapAcknowledged: boolean) => ({
    templateId,
    anchorDate: anchor,
    timeZone: zone,
    selectedKeys,
    overlapAcknowledged,
  });

  it('rejects a timed item that overlaps planned work until the user keeps the overlap', async () => {
    seedExistingBlock();
    const templateId = await saveUser([timedAction('a', 'Write', '09:30')]);
    const before = new Map(harness.unitOfWork.state.records);
    const refused = await commands.applyTemplate(request(templateId, ['a'], false));
    expect(refused).toMatchObject({
      ok: false,
      error: {
        code: 'domain_rejected',
        domainError: {
          code: 'invalid_value',
          details: {
            reason: 'overlap_requires_acknowledgement',
            overlaps: [`block:${existingBlock}`],
          },
        },
      },
    });
    expect(harness.unitOfWork.state.records).toEqual(before);

    const receipt = accepted(await commands.applyTemplate(request(templateId, ['a'], true)));
    const created = recordsOf('time_block').find((item) => item.ref.id !== existingBlock);
    expect(created?.document).toMatchObject({
      startsAt: '2026-03-06T14:30:00.000Z',
      overlapAcknowledged: true,
    });
    const existing = record('time_block', existingBlock);
    expect(existing?.document['overlapAcknowledged']).toBe(true);
    expect(existing?.localRevision).toBe(2);
    expect(receipt.canonical.map(({ ref }) => ref.id)).toContain(existingBlock);
    expectMinimizedEvents();
  });

  it('treats overlaps among the template items as overlaps too', async () => {
    const templateId = await saveUser([
      timedAction('a', 'Write', '09:00'),
      timedAction('b', 'Review', '09:30'),
      timedAction('c', 'Lunch', '12:00'),
    ]);
    const refused = await commands.applyTemplate(request(templateId, ['a', 'b', 'c'], false));
    expect(refused).toMatchObject({
      ok: false,
      error: {
        domainError: {
          details: {
            reason: 'overlap_requires_acknowledgement',
            overlaps: ['template:b', 'template:a'],
          },
        },
      },
    });
    expect(recordsOf('time_block')).toHaveLength(0);
    // Deselecting one side removes the overlap.
    accepted(await commands.applyTemplate(request(templateId, ['a', 'c'], false)));
    expect(blocks().every((item) => !item.overlapAcknowledged)).toBe(true);
  });

  it('marks only overlapping new blocks when the overlaps are kept', async () => {
    const templateId = await saveUser([
      timedAction('a', 'Write', '09:00'),
      timedAction('b', 'Review', '09:30'),
      timedAction('c', 'Lunch', '12:00'),
    ]);
    accepted(await commands.applyTemplate(request(templateId, ['a', 'b', 'c'], true)));
    expect(
      blocks()
        .map((item) => [item.startsAt, item.overlapAcknowledged])
        .sort(),
    ).toEqual([
      ['2026-03-06T14:00:00.000Z', true],
      ['2026-03-06T14:30:00.000Z', true],
      ['2026-03-06T17:00:00.000Z', false],
    ]);
  });

  it('lists, per timed item, the titles of what it would overlap', async () => {
    seedExistingBlock();
    const templateId = await saveUser([
      timedAction('a', 'Write', '09:30'),
      timedAction('b', 'Review', '10:15'),
      { templateKey: 'n', kind: 'note', title: 'Notes' },
    ]);
    const template = record('template', templateId)?.document as TemplateDocument;
    const preview = previewTemplateApplication(template.blueprint, {
      anchorDate: anchor,
      timeZone: zone,
    });
    if (!preview.ok) throw new Error('preview');
    const scan = await scanTemplateOverlaps(
      createTestPlanningQueries(harness.unitOfWork, profile),
      ownerId,
      zone,
      preview.value,
    );
    expect(scan.items).toEqual([
      {
        templateKey: 'a',
        overlaps: [
          { key: `block:${existingBlock}`, title: 'Dentist' },
          { key: 'template:b', title: 'Review' },
        ],
      },
      { templateKey: 'b', overlaps: [{ key: 'template:a', title: 'Write' }] },
    ]);
    expect(scan.targets).toHaveLength(1);
  });

  it('never creates a block shorter than the Time Block minimum', async () => {
    expect(
      rejectionReason(
        await commands.saveTemplate({
          title: 'Short',
          blueprint: { version: 2, items: [timedAction('a', 'Blink', '09:00', 3)] },
        }),
      ),
    ).toBe('duration_minutes');
    const preview = previewTemplateApplication(
      { version: 2, items: [timedAction('a', 'Blink', '09:00', 5)] } as never,
      { anchorDate: anchor, timeZone: zone },
    );
    if (!preview.ok) throw new Error('preview');
    const [item] = preview.value.items;
    if (item?.schedule.kind !== 'timed') throw new Error('timed');
    // A preview built outside the parser (for example from an older document) is re-checked.
    const short = {
      ...preview.value,
      items: [
        {
          ...item,
          schedule: { ...item.schedule, endsAt: '2026-03-06T14:03:00.000Z' as Instant },
        },
      ],
    };
    const planned = planTemplateApplication({
      preview: short,
      ownerId,
      weekStart: 'monday',
      nextId: () => '70000000-0000-4000-8000-000000000001' as UUID,
      now,
    });
    expect(planned.ok ? 'ok' : planned.error.code).toBe('invalid_interval');
  });
});

describe('user template management', () => {
  const blueprint = {
    version: 2,
    items: [{ templateKey: 'a', kind: 'action', title: 'Plan', relativeDayOffset: 0 }],
  };

  it('creates, updates, archives, and restores a user template', async () => {
    const created = accepted(await commands.saveTemplate({ title: ' Mine ', blueprint }));
    const templateId = created.canonical[0]?.ref.id ?? '';
    expect(record('template', templateId)?.document).toEqual({
      title: 'Mine',
      blueprint,
      state: 'active',
    });
    accepted(
      await commands.saveTemplate({
        templateId,
        revision: 1,
        title: 'Renamed',
        blueprint: { version: 1, items: [{ templateKey: 'x', kind: 'note', title: 'Idea' }] },
      }),
    );
    const updated = record('template', templateId)?.document as TemplateDocument;
    expect(updated.title).toBe('Renamed');
    expect(updated.blueprint.version).toBe(1);
    expect(
      rejectionReason(await commands.saveTemplate({ templateId, title: 'No revision', blueprint })),
    ).toBe('revision_required');
    expect(
      rejectionReason(
        await commands.saveTemplate({ title: 'Bad', blueprint: { version: 3, items: [] } }),
      ),
    ).toBe('unsupported_version');

    accepted(await commands.archiveTemplate({ templateId, revision: 2 }));
    expect(record('template', templateId)?.document).toMatchObject({
      state: 'archived',
      stateBeforeArchive: 'active',
      archivedAt: now,
    });
    expect(
      rejectionReason(
        await commands.applyTemplate({
          templateId,
          anchorDate: anchor,
          timeZone: zone,
          selectedKeys: ['x'],
          overlapAcknowledged: false,
        }),
      ),
    ).toBe('template_archived');
    accepted(await commands.restoreTemplate({ templateId, revision: 3 }));
    const restored = record('template', templateId)?.document as TemplateDocument;
    expect(restored.state).toBe('active');
    expect(restored.archivedAt).toBeUndefined();
    expectMinimizedEvents();
  });

  it('keeps built-in templates read-only and duplicates them into user templates', async () => {
    const source = builtIn('Weekly Reset');
    expect(
      rejectionReason(
        await commands.saveTemplate({ templateId: source.id, revision: 1, title: 'X', blueprint }),
      ),
    ).toBe('built_in_read_only');
    expect(
      rejectionReason(await commands.archiveTemplate({ templateId: source.id, revision: 1 })),
    ).toBe('built_in_read_only');
    const receipt = accepted(
      await commands.duplicateTemplate({ templateId: source.id, title: 'My reset' }),
    );
    const copyId = receipt.canonical[0]?.ref.id ?? '';
    expect(copyId).not.toBe(source.id);
    const copy = record('template', copyId)?.document as TemplateDocument;
    expect(copy.title).toBe('My reset');
    expect(copy.blueprint).toEqual(source.blueprint);
    const second = accepted(
      await commands.duplicateTemplate({ templateId: copyId, title: 'Again' }),
    );
    expect(second.canonical[0]?.ref.id).not.toBe(copyId);
    expect(
      rejectionReason(await commands.duplicateTemplate({ templateId: source.id, title: '  ' })),
    ).toBe('title');
  });
});

describe('saveWeekAsTemplate', () => {
  const taskA = '40000000-0000-4000-8000-00000000000a';
  const taskB = '40000000-0000-4000-8000-00000000000b';
  const taskC = '40000000-0000-4000-8000-00000000000c';

  it('copies Day-placed and scheduled Action structure without state or history', async () => {
    seed('action', taskA, {
      title: 'Write report',
      captureOrigin: 'inbox',
      note: 'Section two',
      estimateMinutes: 60,
      energy: 'focused',
      priority: 'high',
      due: { kind: 'date', date: '2026-10-02' },
      orderKey: '500000000000000',
      state: 'scheduled',
    });
    seed('action', taskB, {
      title: 'Call bank',
      captureOrigin: 'inbox',
      orderKey: '500000000000001',
      state: 'completed',
      completedAt: now,
    });
    seed('action', taskC, {
      title: 'Next week',
      captureOrigin: 'inbox',
      orderKey: '500000000000002',
      state: 'planned',
    });
    seed('planning_placement', '60000000-0000-4000-8000-00000000000a', {
      target: { kind: 'action', actionId: taskA },
      period: { kind: 'day', date: '2026-09-29' },
      orderKey: '500000000000000',
    });
    seed('planning_placement', '60000000-0000-4000-8000-00000000000b', {
      target: { kind: 'action', actionId: taskB },
      period: { kind: 'day', date: '2026-10-01' },
      orderKey: '500000000000001',
    });
    seed('planning_placement', '60000000-0000-4000-8000-00000000000c', {
      target: { kind: 'action', actionId: taskC },
      period: { kind: 'day', date: '2026-10-06' },
      orderKey: '500000000000002',
    });
    // 14:00-15:00 EDT on Tuesday 2026-09-29.
    seed('time_block', '50000000-0000-4000-8000-00000000000a', {
      target: { kind: 'action', actionId: taskA },
      startsAt: '2026-09-29T18:00:00.000Z',
      endsAt: '2026-09-29T19:00:00.000Z',
      timeZone: zone,
      state: 'planned',
      overlapAcknowledged: false,
    });

    const receipt = accepted(
      await commands.saveWeekAsTemplate({ weekDate: '2026-10-01', title: 'Typical week' }),
    );
    const template = record('template', receipt.canonical[0]?.ref.id ?? '')
      ?.document as TemplateDocument;
    expect(template.title).toBe('Typical week');
    expect(template.blueprint).toEqual({
      version: 2,
      items: [
        {
          templateKey: 'action-1',
          kind: 'action',
          title: 'Write report',
          note: 'Section two',
          estimateMinutes: 60,
          energy: 'focused',
          priority: 'high',
          relativeDayOffset: 1,
          localStartTime: '14:00',
          durationMinutes: 60,
        },
        {
          templateKey: 'action-2',
          kind: 'action',
          title: 'Call bank',
          relativeDayOffset: 3,
        },
      ],
    });
    expect(JSON.stringify(template)).not.toMatch(/completed|due|scheduled/u);
    expectMinimizedEvents();
  });

  it('rejects an empty week', async () => {
    expect(
      rejectionReason(
        await commands.saveWeekAsTemplate({ weekDate: '2026-10-01', title: 'Empty' }),
      ),
    ).toBe('nothing_to_save');
  });
});
