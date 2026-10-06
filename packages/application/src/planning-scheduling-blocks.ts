/**
 * Time Block and Commitment commands: create, schedule, move, shorten, resolve/reopen, and the
 * explicit Keep-overlap choice. Rescheduling always supersedes; nothing is moved or resolved for
 * the user, and every overlap needs the user's acknowledgement in the same command. A superseded
 * block's scheduled reminder follows its replacement in the same command; resolving
 * a block never changes its reminder.
 */
import {
  addDays,
  addMinutes,
  createDayPeriod,
  createEntityRef,
  intervalsIntersect,
  localDateOf,
  localDayBounds,
  occurrenceLogicalKey,
  ok,
  parseUUID,
  routineOccurrenceId,
  transitionLifecycle,
  validateTimeBlockInterval,
  validateTimeBlockTransition,
  type CommitmentState,
  type EntityRef,
} from '@yelaxis/domain';

import type { ActionCanonicalDocument } from './actions';
import type {
  ApplicationResult,
  CanonicalMutation,
  CanonicalRecordState,
  ExpectedRevision,
} from './contracts';
import type { SchedulingMethods } from './planning';
import type {
  CommitmentDocument,
  RoutineOccurrenceDocument,
  TimeBlockDocument,
  TimedItemRef,
} from './planning-contracts';
import type { CreatedRecord } from './planning-kit';
import { createMutation, updateFrom } from './planning-kit';
import { carryBlockReminder, readCarriedBlockReminder } from './planning-reminders';
import {
  acknowledgeOverlaps,
  actionWithState,
  blockDurationMinutes,
  changed,
  expectedOf,
  findActivePlacement,
  finishedActionStates,
  invalid,
  isCurrentPlanned,
  missing,
  notAllowed,
  overlapRejection,
  placementTarget,
  plannedBlockDocument,
  rejectInvalid,
  rejected,
  resolveBlockInterval,
  scanOverlaps,
  supersede,
  timeBlockSnapshot,
  trimmedText,
  upsertPlacement,
  type AcknowledgementTarget,
  type SchedulingKit,
} from './planning-scheduling-support';
import { blockKey, collectPlannedTimedItems, occurrenceKey } from './planning-timed-items';

type BlockMethods = Pick<
  SchedulingMethods,
  | 'createCustomBlock'
  | 'scheduleAction'
  | 'moveBlock'
  | 'shortenBlock'
  | 'setBlockState'
  | 'keepOverlap'
  | 'createCommitment'
>;

const blockStates = ['planned', 'completed', 'skipped', 'canceled'] as const;

export function createBlockCommands(kit: SchedulingKit): BlockMethods {
  const { queries } = kit;

  return {
    async createCustomBlock(input, commandId) {
      const title = trimmedText(input.title, 200, 'title');
      if (!title.ok) return rejected(title.error);
      const { ownerId, profile } = await kit.session();
      const interval = resolveBlockInterval(input, profile.planningTimeZone);
      if (!interval.ok) return rejected(interval.error);
      const scan = await scanOverlaps(queries, ownerId, profile.planningTimeZone, interval.value);
      const ref = createEntityRef('time_block', kit.nextId(), ownerId);
      return kit.run(
        ownerId,
        commandId,
        'planning.block_created',
        scan.expected,
        async ({ records }) => {
          if (scan.keys.length > 0 && input.overlapAcknowledged !== true)
            return overlapRejection(scan.keys);
          const acknowledged = await acknowledgeOverlaps(records, ownerId, scan.targets);
          if (!acknowledged.ok) return acknowledged;
          return ok({
            mutations: [
              createMutation(
                ref,
                plannedBlockDocument(
                  { kind: 'custom', title: title.value },
                  interval.value,
                  scan.keys.length > 0,
                ),
              ),
              ...acknowledged.value.mutations,
            ],
            created: [{ ref, kind: 'time_block' }, ...acknowledged.value.created],
          });
        },
      );
    },

    async scheduleAction(input, commandId) {
      const actionId = parseUUID(input.actionId);
      if (!actionId.ok) return rejected(actionId.error);
      const { ownerId, profile } = await kit.session();
      const actionRef = createEntityRef('action', actionId.value, ownerId);
      const action = await queries.readRecord(ownerId, actionRef);
      if (action === null) return missing(actionRef);
      const interval = resolveBlockInterval(input, profile.planningTimeZone);
      if (!interval.ok) return rejected(interval.error);
      const oldBlock = await queries.getPlannedActionBlock(ownerId, actionId.value);
      const carried =
        oldBlock === null
          ? null
          : await readCarriedBlockReminder(queries, ownerId, oldBlock.ref.id);
      const placement = await findActivePlacement(queries, ownerId, 'action', actionId.value);
      const scan = await scanOverlaps(
        queries,
        ownerId,
        profile.planningTimeZone,
        interval.value,
        oldBlock === null ? [] : [blockKey(oldBlock.ref.id)],
      );
      const newRef = createEntityRef('time_block', kit.nextId(), ownerId);
      const expected: ExpectedRevision[] = [
        { ref: actionRef, revision: input.revision },
        ...expectedOf(oldBlock),
        ...expectedOf(carried),
        ...expectedOf(placement),
        ...scan.expected,
      ];
      return kit.run(
        ownerId,
        commandId,
        'planning.action_scheduled',
        expected,
        async ({ records, context }) => {
          const current = await records.read(actionRef);
          if (current === null) return changed('action_missing');
          const document = current.document as ActionCanonicalDocument;
          if (finishedActionStates.includes(document.state))
            return notAllowed('action_not_schedulable', 'This Action cannot be scheduled.');
          if (scan.keys.length > 0 && input.overlapAcknowledged !== true)
            return overlapRejection(scan.keys);
          const mutations: CanonicalMutation[] = [];
          const created: CreatedRecord[] = [];
          if (oldBlock !== null) {
            const superseded = await supersede(records, oldBlock.ref, newRef.id);
            if (!superseded.ok) return superseded;
            mutations.push(superseded.value.mutation);
          }
          mutations.push(
            createMutation(
              newRef,
              plannedBlockDocument(
                { kind: 'action', actionId: actionId.value },
                interval.value,
                scan.keys.length > 0,
              ),
            ),
          );
          created.push({ ref: newRef, kind: 'time_block' });
          if (oldBlock !== null) {
            const reminder = await carryBlockReminder(records, carried, oldBlock.ref.id, {
              id: newRef.id,
              startsAt: interval.value.startsAt,
            });
            if (!reminder.ok) return reminder;
            if (reminder.value !== null) mutations.push(reminder.value);
          }
          if (document.state !== 'scheduled') {
            const next = actionWithState(document, 'scheduled', context.now);
            if (!next.ok) return next;
            mutations.push(updateFrom(current, next.value));
          }
          const placed = await upsertPlacement(
            records,
            ownerId,
            placement,
            placementTarget('action', actionId.value),
            createDayPeriod(interval.value.localDate),
            kit.nextId,
          );
          if (!placed.ok) return placed;
          if (placed.value.mutation !== null) mutations.push(placed.value.mutation);
          if (placed.value.created !== undefined) created.push(placed.value.created);
          const acknowledged = await acknowledgeOverlaps(records, ownerId, scan.targets);
          if (!acknowledged.ok) return acknowledged;
          return ok({
            mutations: [...mutations, ...acknowledged.value.mutations],
            created: [...created, ...acknowledged.value.created],
          });
        },
      );
    },

    async moveBlock(input, commandId) {
      const blockId = parseUUID(input.blockId);
      if (!blockId.ok) return rejected(blockId.error);
      const { ownerId, profile } = await kit.session();
      const blockRef = createEntityRef('time_block', blockId.value, ownerId);
      const block = await queries.readRecord(ownerId, blockRef);
      if (block === null) return missing(blockRef);
      const interval = resolveBlockInterval(input, profile.planningTimeZone);
      if (!interval.ok) return rejected(interval.error);
      const target = (block.document as TimeBlockDocument).target;
      const placement =
        target.kind === 'action'
          ? await findActivePlacement(queries, ownerId, 'action', target.actionId)
          : null;
      const scan = await scanOverlaps(queries, ownerId, profile.planningTimeZone, interval.value, [
        blockKey(blockId.value),
      ]);
      const carried = await readCarriedBlockReminder(queries, ownerId, blockId.value);
      const newRef = createEntityRef('time_block', kit.nextId(), ownerId);
      const expected: ExpectedRevision[] = [
        { ref: blockRef, revision: input.revision },
        ...expectedOf(placement),
        ...expectedOf(carried),
        ...scan.expected,
      ];
      return kit.run(ownerId, commandId, 'planning.block_moved', expected, async ({ records }) => {
        const superseded = await supersede(records, blockRef, newRef.id);
        if (!superseded.ok) return superseded;
        if (scan.keys.length > 0 && input.overlapAcknowledged !== true)
          return overlapRejection(scan.keys);
        const document = superseded.value.record.document as TimeBlockDocument;
        const mutations: CanonicalMutation[] = [
          superseded.value.mutation,
          createMutation(
            newRef,
            plannedBlockDocument(document.target, interval.value, scan.keys.length > 0),
          ),
        ];
        const created: CreatedRecord[] = [{ ref: newRef, kind: 'time_block' }];
        const reminder = await carryBlockReminder(records, carried, blockRef.id, {
          id: newRef.id,
          startsAt: interval.value.startsAt,
        });
        if (!reminder.ok) return reminder;
        if (reminder.value !== null) mutations.push(reminder.value);
        if (document.target.kind === 'action') {
          // The Day placement follows the block's new local start date in the same command.
          const placed = await upsertPlacement(
            records,
            ownerId,
            placement,
            placementTarget('action', document.target.actionId),
            createDayPeriod(interval.value.localDate),
            kit.nextId,
          );
          if (!placed.ok) return placed;
          if (placed.value.mutation !== null) mutations.push(placed.value.mutation);
          if (placed.value.created !== undefined) created.push(placed.value.created);
        }
        const acknowledged = await acknowledgeOverlaps(records, ownerId, scan.targets);
        if (!acknowledged.ok) return acknowledged;
        return ok({
          mutations: [...mutations, ...acknowledged.value.mutations],
          created: [...created, ...acknowledged.value.created],
        });
      });
    },

    async shortenBlock(input, commandId) {
      const blockId = parseUUID(input.blockId);
      if (!blockId.ok) return rejected(blockId.error);
      const durationMinutes = input.durationMinutes;
      if (!Number.isInteger(durationMinutes) || durationMinutes < 5)
        return rejectInvalid('duration');
      const { ownerId, profile } = await kit.session();
      const blockRef = createEntityRef('time_block', blockId.value, ownerId);
      const block = await queries.readRecord(ownerId, blockRef);
      if (block === null) return missing(blockRef);
      const startsAt = (block.document as TimeBlockDocument).startsAt;
      const endsAt = addMinutes(startsAt, durationMinutes);
      const scan = await scanOverlaps(
        queries,
        ownerId,
        profile.planningTimeZone,
        { startsAt, endsAt },
        [blockKey(blockId.value)],
      );
      const carried = await readCarriedBlockReminder(queries, ownerId, blockId.value);
      const newRef = createEntityRef('time_block', kit.nextId(), ownerId);
      return kit.run(
        ownerId,
        commandId,
        'planning.block_shortened',
        [{ ref: blockRef, revision: input.revision }, ...expectedOf(carried)],
        async ({ records }) => {
          const superseded = await supersede(records, blockRef, newRef.id);
          if (!superseded.ok) return superseded;
          const document = superseded.value.record.document as TimeBlockDocument;
          if (durationMinutes >= blockDurationMinutes(document))
            return invalid('not_shorter', 'Choose a duration shorter than the current block.');
          const interval = validateTimeBlockInterval(
            document.startsAt,
            addMinutes(document.startsAt, durationMinutes),
            document.timeZone,
          );
          if (!interval.ok) return interval;
          // A shorter block keeps an existing acknowledgement only while it still overlaps.
          const acknowledged = document.overlapAcknowledged && scan.keys.length > 0;
          // The start is unchanged, so the reminder only moves to the replacement block.
          const reminder = await carryBlockReminder(records, carried, blockRef.id, {
            id: newRef.id,
            startsAt: interval.value.startsAt,
          });
          if (!reminder.ok) return reminder;
          return ok({
            mutations: [
              superseded.value.mutation,
              createMutation(
                newRef,
                plannedBlockDocument(document.target, interval.value, acknowledged),
              ),
              ...(reminder.value === null ? [] : [reminder.value]),
            ],
            created: [{ ref: newRef, kind: 'time_block' }],
          });
        },
      );
    },

    async setBlockState(input, commandId) {
      const blockId = parseUUID(input.blockId);
      if (!blockId.ok) return rejected(blockId.error);
      const to = input.to;
      if (!blockStates.includes(to)) return rejectInvalid('block_state');
      const { ownerId, profile } = await kit.session();
      const blockRef = createEntityRef('time_block', blockId.value, ownerId);
      const block = await queries.readRecord(ownerId, blockRef);
      if (block === null) return missing(blockRef);
      const target = (block.document as TimeBlockDocument).target;
      const alsoComplete = input.alsoCompleteAction === true;
      if (alsoComplete && (to !== 'completed' || target.kind !== 'action'))
        return rejectInvalid('also_complete_requires_completed_action_block');
      let relatedRef: EntityRef | null = null;
      let otherPlanned: EntityRef | null = null;
      let placement: CanonicalRecordState | null = null;
      if (target.kind === 'action') {
        relatedRef = createEntityRef('action', target.actionId, ownerId);
        if (to === 'planned') {
          otherPlanned =
            (await queries.getPlannedActionBlock(ownerId, target.actionId))?.ref ?? null;
          placement = await findActivePlacement(queries, ownerId, 'action', target.actionId);
        }
      } else if (target.kind === 'commitment') {
        relatedRef = createEntityRef('commitment', target.commitmentId, ownerId);
        if (to === 'planned')
          otherPlanned =
            (await queries.getPlannedCommitmentBlock(ownerId, target.commitmentId))?.ref ?? null;
      }
      const related = relatedRef === null ? null : await queries.readRecord(ownerId, relatedRef);
      return kit.run(
        ownerId,
        commandId,
        'planning.block_state_changed',
        [
          { ref: blockRef, revision: input.revision },
          ...expectedOf(related),
          ...expectedOf(placement),
        ],
        async ({ records, context }) => {
          const current = await records.read(blockRef);
          if (current === null) return changed('block_missing');
          const document = current.document as TimeBlockDocument;
          const valid = validateTimeBlockTransition(
            timeBlockSnapshot(current, context.now),
            to,
            to === 'planned' ? 'reopen_or_undo' : undefined,
          );
          if (!valid.ok) return valid;
          if (to === 'planned' && otherPlanned !== null && otherPlanned.id !== blockRef.id)
            return notAllowed(
              'another_block_planned',
              'This work already has a planned block. Move or resolve that block first.',
            );
          if (document.target.kind === 'commitment' && to === 'skipped')
            return notAllowed(
              'commitment_block_skip',
              'A Commitment block can be completed, canceled, or moved.',
            );
          const mutations: CanonicalMutation[] = [updateFrom(current, { ...document, state: to })];
          const created: CreatedRecord[] = [];
          const relatedRecord = related === null ? null : await records.read(related.ref);
          if (relatedRecord !== null && document.target.kind === 'action') {
            const action = relatedRecord.document as ActionCanonicalDocument;
            let nextState: ActionCanonicalDocument['state'] | null = null;
            if (to === 'planned') {
              if (action.state === 'planned') nextState = 'scheduled';
            } else if (alsoComplete) {
              if (action.state !== 'completed') nextState = 'completed';
            } else if (action.state === 'scheduled') {
              nextState = 'planned';
            }
            if (nextState !== null) {
              const next = actionWithState(action, nextState, context.now);
              if (!next.ok) return next;
              mutations.push(updateFrom(relatedRecord, next.value));
            }
            if (to === 'planned' && (nextState ?? action.state) === 'scheduled') {
              // A scheduled Action's Day placement follows its block's local start date, as in a
              // move; the placement may have changed or been removed while the Action was planned.
              const placed = await upsertPlacement(
                records,
                ownerId,
                placement,
                placementTarget('action', document.target.actionId),
                createDayPeriod(localDateOf(document.startsAt, profile.planningTimeZone)),
                kit.nextId,
              );
              if (!placed.ok) return placed;
              if (placed.value.mutation !== null) mutations.push(placed.value.mutation);
              if (placed.value.created !== undefined) created.push(placed.value.created);
            }
          }
          if (relatedRecord !== null && document.target.kind === 'commitment') {
            const commitment = relatedRecord.document as CommitmentDocument;
            const nextState: CommitmentState =
              to === 'canceled' ? 'canceled' : to === 'completed' ? 'completed' : 'planned';
            if (commitment.state !== nextState) {
              const transitioned = transitionLifecycle({
                entityType: 'commitment',
                current: { state: commitment.state },
                to: nextState,
                ...(nextState === 'planned' ? { intent: 'reopen_or_undo' as const } : {}),
              });
              if (!transitioned.ok) return transitioned;
              mutations.push(updateFrom(relatedRecord, { ...commitment, state: nextState }));
            }
          }
          return ok({ mutations, created });
        },
      );
    },

    async keepOverlap(input, commandId) {
      const { ownerId, profile } = await kit.session();
      const first = await resolveTimedItem(kit, ownerId, profile.planningTimeZone, input.first);
      if (!first.ok) return first;
      const second = await resolveTimedItem(kit, ownerId, profile.planningTimeZone, input.second);
      if (!second.ok) return second;
      if (first.value.key === second.value.key) return rejectInvalid('same_item');
      const overlapping = intervalsIntersect(first.value, second.value);
      return kit.run(
        ownerId,
        commandId,
        'planning.overlap_kept',
        [...first.value.expected, ...second.value.expected],
        async ({ records }) => {
          if (!overlapping)
            return invalid('no_overlap', 'These items no longer overlap. Nothing needs keeping.');
          const acknowledged = await acknowledgeOverlaps(records, ownerId, [
            first.value.target,
            second.value.target,
          ]);
          if (!acknowledged.ok) return acknowledged;
          if (acknowledged.value.mutations.length === 0)
            return invalid('already_kept', 'This overlap is already kept.');
          return ok(acknowledged.value);
        },
      );
    },

    async createCommitment(input, commandId) {
      const title = trimmedText(input.title, 200, 'title');
      if (!title.ok) return rejected(title.error);
      if (input.strength !== 'hard' && input.strength !== 'soft') return rejectInvalid('strength');
      const strength = input.strength;
      const { ownerId, profile } = await kit.session();
      const interval = resolveBlockInterval(input, profile.planningTimeZone);
      if (!interval.ok) return rejected(interval.error);
      const scan = await scanOverlaps(queries, ownerId, profile.planningTimeZone, interval.value);
      const commitmentRef = createEntityRef('commitment', kit.nextId(), ownerId);
      const blockRef = createEntityRef('time_block', kit.nextId(), ownerId);
      return kit.run(
        ownerId,
        commandId,
        'planning.commitment_created',
        scan.expected,
        async ({ records }) => {
          if (scan.keys.length > 0 && input.overlapAcknowledged !== true)
            return overlapRejection(scan.keys);
          const acknowledged = await acknowledgeOverlaps(records, ownerId, scan.targets);
          if (!acknowledged.ok) return acknowledged;
          const commitment: CommitmentDocument = { title: title.value, strength, state: 'planned' };
          return ok({
            mutations: [
              createMutation(commitmentRef, commitment),
              createMutation(
                blockRef,
                plannedBlockDocument(
                  { kind: 'commitment', commitmentId: commitmentRef.id },
                  interval.value,
                  scan.keys.length > 0,
                ),
              ),
              ...acknowledged.value.mutations,
            ],
            created: [
              { ref: commitmentRef, kind: 'commitment' },
              { ref: blockRef, kind: 'time_block' },
              ...acknowledged.value.created,
            ],
          });
        },
      );
    },
  };
}

const succeed = <T>(value: T): ApplicationResult<T> => ({ ok: true, value });

interface ResolvedTimedItem {
  readonly key: string;
  readonly startsAt: TimeBlockDocument['startsAt'];
  readonly endsAt: TimeBlockDocument['endsAt'];
  readonly target: AcknowledgementTarget;
  readonly expected: readonly ExpectedRevision[];
}

/** Resolve one side of a Keep-overlap choice to its current interval and acknowledgement target. */
async function resolveTimedItem(
  kit: SchedulingKit,
  ownerId: EntityRef['ownerId'],
  timeZone: Parameters<typeof localDayBounds>[1],
  item: TimedItemRef,
): Promise<ApplicationResult<ResolvedTimedItem>> {
  if (item.kind === 'block') {
    const blockId = parseUUID(item.blockId);
    if (!blockId.ok) return rejected(blockId.error);
    const ref = createEntityRef('time_block', blockId.value, ownerId);
    const record = await kit.queries.readRecord(ownerId, ref);
    if (record === null) return missing(ref);
    const document = record.document as TimeBlockDocument;
    if (!isCurrentPlanned(document)) return rejectInvalid('block_not_planned');
    return succeed({
      key: blockKey(ref.id),
      startsAt: document.startsAt,
      endsAt: document.endsAt,
      target: { kind: 'block', ref },
      expected: [{ ref, revision: item.revision }],
    });
  }
  const routineId = parseUUID(item.occurrence.routineId);
  if (!routineId.ok) return rejected(routineId.error);
  const period = item.occurrence.period;
  const ref = createEntityRef(
    'routine_occurrence',
    routineOccurrenceId(occurrenceLogicalKey(routineId.value, item.occurrence.generation, period)),
    ownerId,
  );
  const record = await kit.queries.readRecord(ownerId, ref);
  const overrideDate = (record?.document as RoutineOccurrenceDocument | undefined)?.override?.date;
  const date = overrideDate ?? (period.kind === 'date' ? period.date : undefined);
  if (date === undefined) return rejectInvalid('occurrence_not_timed');
  // A fixed-zone occurrence's instant can land on another planning-zone date (zones differ by up
  // to 26 hours), so search two days each way and match the occurrence by id.
  const candidates = await collectPlannedTimedItems(
    kit.queries,
    ownerId,
    timeZone,
    localDayBounds(addDays(date, -2), timeZone).startsAt,
    localDayBounds(addDays(date, 2), timeZone).endsAt,
  );
  const candidate = candidates.find((entry) => entry.key === occurrenceKey(ref.id));
  if (candidate === undefined) return rejectInvalid('occurrence_not_timed');
  return succeed({
    key: candidate.key,
    startsAt: candidate.startsAt,
    endsAt: candidate.endsAt,
    target: { kind: 'occurrence', target: item.occurrence },
    expected: expectedOf(record),
  });
}
