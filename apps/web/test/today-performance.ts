import {
  createPlanningApplication,
  createSerialQueue,
  createTodayApplication,
  type ApplicationDependencies,
  type EndDayInput,
  type FocusCandidate,
  type FocusTargetInput,
  type OccurrenceEntry,
  type OccurrenceTargetInput,
  type PlanningApplication,
  type RoutineInput,
  type TodayApplication,
} from '@yelaxis/application';
import {
  createSqliteApplicationAdapters,
  runMigrations,
  schemaMigrations,
  SqlitePlanningQueries,
  SqliteTodayQueries,
} from '@yelaxis/data';
import { BrowserSqliteDriver } from '@yelaxis/data/browser';
import {
  addDays,
  occurrenceLogicalKey,
  routineOccurrenceId,
  type CalendarDate,
  type GeneratedOccurrencePeriod,
  type Instant,
  type OwnerId,
  type UUID,
} from '@yelaxis/domain';

/*
 * Large-plan Today performance gate: 10,000 Actions over about three years
 * of Day placements, 12,000 Time Blocks, Week placements and Week commitments, three focus rows on
 * each of 1,000 days, and 30 Routines with occurrence history. Synthetic fixtures only.
 *
 * The planning date is 2026-08-12 in New York (11:00 local). `verify-today-performance.mjs` opens
 * the production Today on the same date with a fixed browser clock.
 */
const ownerId = '91000000-0000-4000-8000-000000000001' as OwnerId;
const profileId = '92000000-0000-4000-8000-000000000001' as UUID;
const now = '2026-08-12T15:00:00.000Z' as Instant;
const zone = 'America/New_York';
const today = '2026-08-12' as CalendarDate;
const historicalDate = '2024-03-12' as CalendarDate;
const actionCount = 10_000;
/** Open Day work placed on today on top of the regular spread, so End Day can decide 50 items. */
const endDayLoad = 60;
const endDayDecisions = 50;
/** Fixed Today performance budgets; the aggregate release gate measures final behavior. */
const thresholds = Object.freeze({
  todayWorstMs: 300,
  historicalTodayWorstMs: 300,
  focusChoicesMs: 300,
  focusSessionMs: 150,
  endDayPreviewMs: 500,
  addFocusMs: 1_500,
  setDayFocusMs: 1_500,
  reorderFlexibleMs: 1_500,
  applyEndDay50Ms: 3_000,
  undoEndDayMs: 3_000,
  mainThreadGapMs: 100,
});

const outputNode = document.querySelector('#result');
if (!(outputNode instanceof HTMLElement)) throw new Error('Missing result element.');
const output: HTMLElement = outputNode;

void verify().then(
  (result) => report('passed', result),
  (error: unknown) =>
    report('failed', {
      message: error instanceof Error ? error.message : String(error),
      stack: error instanceof Error ? error.stack : undefined,
    }),
);

async function verify() {
  const databaseName = new URLSearchParams(window.location.search).get('database');
  if (databaseName === null) throw new Error('database query parameter required');
  const opened = await BrowserSqliteDriver.open({ databaseName });
  const driver = opened.driver;
  let idCounter = 1;
  const ids = {
    next() {
      const suffix = idCounter.toString(16).padStart(12, '0');
      idCounter += 1;
      return `b1000000-0000-4000-8000-${suffix}` as UUID;
    },
  };
  const dependencies: ApplicationDependencies = {
    ...createSqliteApplicationAdapters(driver),
    ids,
    clock: { now: () => now },
    projections: { notifyCommitted() {} },
  };
  // One queue for both facades, as in the composition root.
  const queue = createSerialQueue();
  const planning: PlanningApplication = createPlanningApplication(
    dependencies,
    new SqlitePlanningQueries(driver),
    { queue },
  );
  const todayApp: TodayApplication = createTodayApplication(
    dependencies,
    new SqliteTodayQueries(driver),
    { queue },
  );

  try {
    await runMigrations(driver, schemaMigrations, () => now);
    await driver.run(
      `INSERT INTO planning_identities (id, identity_kind, created_at, updated_at)
       VALUES (?, 'local', ?, ?);`,
      [ownerId, now, now],
    );
    await driver.run(
      `INSERT INTO profiles (
         id, owner_id, planning_time_zone, week_start, time_format, locale_override,
         defaults_confirmed_at, onboarding_status, onboarding_step, created_at, updated_at
       ) VALUES (?, ?, ?, 'monday', '12_hour', 'en', ?, 'completed', 'handbook', ?, ?);`,
      [profileId, ownerId, zone, now, now, now],
    );
    const seedStarted = performance.now();
    for (const statement of seedStatements()) await driver.executeScript(statement);

    const availability = await planning.addAvailability({
      strength: 'soft',
      windows: (['monday', 'tuesday', 'wednesday', 'thursday', 'friday'] as const).map(
        (weekday) => ({ weekday, start: '09:00', end: '17:00' }),
      ),
    });
    assert(availability.ok, 'Availability setup failed.');
    const routines: { readonly id: UUID; readonly kind: RoutineKind }[] = [];
    for (const [index, fixture] of routineFixtures().entries()) {
      const created = await planning.createRoutine(fixture.input);
      if (!created.ok) throw new Error(`Routine setup failed: ${fixture.input.title}`);
      const ref = created.value.canonical.find((item) => item.ref.type === 'routine')?.ref;
      assert(ref !== undefined, `Routine ${String(index)} has no canonical record.`);
      routines.push({ id: ref.id, kind: fixture.kind });
    }
    for (const statement of routineHistoryStatements(routines))
      await driver.executeScript(statement);
    const seedMs = performance.now() - seedStarted;

    /* ─── Reads ─── */
    const todayRuns = await samples(5, () => todayApp.getToday(today));
    const view = todayRuns.values[0];
    assert(view !== undefined, 'Today view missing.');
    assert(view.date === today && view.relation === 'today', 'Today must read the live date.');
    assert(
      view.flexible.open.length === 10 + endDayLoad,
      'Today must list its open flexible work.',
    );
    assert(view.timeline.entries.length >= 5, 'Today must show its scheduled work.');
    assert(view.focus.length === 1, 'Today must show its seeded focus item.');
    assert(view.routines.week.length >= 5, 'Today must show this week’s Routine counts.');
    const todaySummary = summarize(todayRuns.durations);
    assert(todaySummary.worstMs <= thresholds.todayWorstMs, 'Today exceeded threshold.');

    const historicalRuns = await samples(5, () => todayApp.getToday(historicalDate));
    assert(
      historicalRuns.values.every((past) => past.relation === 'past' && !past.focusEditable),
      'An earlier day must read as history.',
    );
    const historicalToday = summarize(historicalRuns.durations);
    assert(
      historicalToday.worstMs <= thresholds.historicalTodayWorstMs,
      'Historical Today exceeded threshold.',
    );

    const choices = await timed(() => todayApp.getFocusChoices(today));
    assert(choices.value.editable, 'Today’s focus must be editable.');
    assert(
      choices.value.candidates.filter((candidate) => candidate.selected).length === 1,
      'Only the current focus item may be marked; nothing is preselected.',
    );
    assert(choices.value.weekTotal >= 16, 'This week’s Actions must be offered.');
    assert(choices.duration <= thresholds.focusChoicesMs, 'Focus choices exceeded threshold.');

    const scheduledToday = actionId(7_100);
    const session = await timed(() => todayApp.getFocusSession(scheduledToday));
    assert(session.value?.plannedBlock !== undefined, 'Focus mode must show the planned time.');
    assert(session.duration <= thresholds.focusSessionMs, 'Focus session exceeded threshold.');

    const endDayPreview = await timed(() => todayApp.getEndDay(today));
    assert(endDayPreview.value.available, 'End Day must be available for today.');
    assert(endDayPreview.value.carryTo === addDays(today, 1), 'Today carries to tomorrow.');
    assert(endDayPreview.value.open.total >= 75, 'End Day must list the day’s open work.');
    assert(endDayPreview.duration <= thresholds.endDayPreviewMs, 'End Day preview exceeded.');

    /* ─── Commands ─── */
    const addFocus = await timed(() =>
      todayApp.addFocus({ date: today, target: { kind: 'action', actionId: actionId(5_300) } }),
    );
    assert(addFocus.value.ok && addFocus.value.value.undo.available, 'Adding focus failed.');
    assert(addFocus.duration <= thresholds.addFocusMs, 'Adding focus exceeded threshold.');

    const pick = (source: FocusCandidate['source']): FocusTargetInput => {
      const candidate = choices.value.candidates.find(
        (item) =>
          item.source === source &&
          // The Routine target must still be projected, so setting focus also materializes it.
          (item.kind === 'action' || !item.occurrence.ref.materialized),
      );
      assert(candidate !== undefined, `No ${source} focus candidate.`);
      return candidate.target;
    };
    const setDayFocus = await timed(() =>
      todayApp.setDayFocus({
        date: today,
        items: [pick('scheduled'), pick('flexible'), pick('routine')],
      }),
    );
    assert(
      setDayFocus.value.ok && setDayFocus.value.value.undo.available,
      'Setting the day’s focus failed.',
    );
    assert(setDayFocus.duration <= thresholds.setDayFocusMs, 'Setting focus exceeded threshold.');

    const beforeReorder = await todayApp.getToday(today);
    const second = beforeReorder.flexible.open[1]?.placement;
    assert(second !== undefined, 'Flexible work must carry its placement.');
    const reorder = await timed(() =>
      todayApp.reorderFlexible({
        date: today,
        placementId: second.id,
        revision: second.localRevision,
        direction: 'up',
      }),
    );
    assert(
      reorder.value.ok && reorder.value.value.undo.available,
      'Reordering flexible work failed.',
    );
    assert(reorder.duration <= thresholds.reorderFlexibleMs, 'Reordering exceeded threshold.');

    const preview = await todayApp.getEndDay(today);
    const input = endDayInput(preview.carryTo, preview.open.items);
    const applyEndDay = await withHeartbeat(() => todayApp.applyEndDay(input));
    if (!applyEndDay.value.ok) throw new Error('End Day apply failed.');
    assert(applyEndDay.duration <= thresholds.applyEndDay50Ms, 'End Day apply exceeded threshold.');
    assert(
      applyEndDay.maxGapMs <= thresholds.mainThreadGapMs,
      'End Day apply blocked the main thread.',
    );
    const receipt = applyEndDay.value.value;
    if (!receipt.undo.available) throw new Error('End Day undo missing.');
    const undoId = receipt.undo.undoId;
    const afterApply = await todayApp.getEndDay(today);
    assert(afterApply.open.total < preview.open.total, 'End Day must change the day.');

    const undo = await timed(() => planning.undo(undoId));
    assert(undo.value.ok, 'End Day undo failed.');
    assert(undo.duration <= thresholds.undoEndDayMs, 'End Day undo exceeded threshold.');
    const afterUndo = await todayApp.getEndDay(today);
    assert(afterUndo.open.total === preview.open.total, 'Undo must restore the day.');

    const memoryBefore = browserHeap();
    for (let index = 0; index < 10; index += 1) {
      await todayApp.getToday(today);
      await todayApp.getFocusChoices(today);
    }
    const memoryAfter = browserHeap();

    return {
      dataset: {
        actions: actionCount,
        historyDayPlacements: 5_000,
        dayPlacementsAroundToday: 3_000 + endDayLoad,
        weekPlacements: 1_000,
        timeBlocks: 12_000 + 1,
        weekCommitments: 312,
        focusRows: 3_000 + 1,
        routines: routines.length,
      },
      storage: opened.storage.durability,
      runtime: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      thresholds,
      results: {
        seedMs: rounded(seedMs),
        today: todaySummary,
        historicalToday,
        focusChoicesMs: rounded(choices.duration),
        focusSessionMs: rounded(session.duration),
        endDayPreviewMs: rounded(endDayPreview.duration),
        addFocusMs: rounded(addFocus.duration),
        setDayFocusMs: rounded(setDayFocus.duration),
        reorderFlexibleMs: rounded(reorder.duration),
        applyEndDay50Ms: rounded(applyEndDay.duration),
        applyEndDayDecisions: input.actions.length + input.occurrences.length,
        mainThreadGapMs: rounded(applyEndDay.maxGapMs),
        mainThreadTicksDuringApply: applyEndDay.ticks,
        undoEndDayMs: rounded(undo.duration),
        heapDeltaBytes:
          memoryBefore === null || memoryAfter === null
            ? 'unavailable'
            : memoryAfter - memoryBefore,
      },
    };
  } finally {
    await driver.close().catch(() => undefined);
  }
}

/**
 * Fifty explicit End Day decisions over today's flexible Actions (carry, move, complete, cancel),
 * two planned Routine Occurrences, and a two-item focus for the carry date.
 */
function endDayInput(
  carryTo: CalendarDate,
  items: Awaited<ReturnType<TodayApplication['getEndDay']>>['open']['items'],
): EndDayInput {
  const flexible = items.flatMap((item) =>
    item.kind === 'action' && item.source === 'flexible' ? [item.action] : [],
  );
  assert(flexible.length >= endDayDecisions, 'End Day needs fifty flexible Actions.');
  const actions: EndDayInput['actions'][number][] = flexible
    .slice(0, endDayDecisions)
    .map((action, index) => {
      const choice = index % 10;
      const decision: EndDayInput['actions'][number]['decision'] =
        choice < 6
          ? { kind: 'carry' }
          : choice === 6
            ? { kind: 'move', period: { kind: 'week', date: addDays(today, 7) } }
            : choice === 7
              ? { kind: 'move', period: { kind: 'day', date: addDays(today, 3) } }
              : choice === 8
                ? { kind: 'complete' }
                : { kind: 'cancel' };
      return { actionId: action.id, revision: action.localRevision, decision };
    });
  const occurrences = items
    .flatMap((item) =>
      item.kind === 'routine_occurrence' && item.occurrence.state === 'planned'
        ? [item.occurrence]
        : [],
    )
    .slice(0, 2)
    .map((occurrence, index) => ({
      occurrence: occurrenceTarget(occurrence),
      decision: index === 0 ? ({ kind: 'complete' } as const) : ({ kind: 'skip' } as const),
    }));
  // Without them the timed apply would silently skip the occurrence and next-focus paths.
  assert(occurrences.length === 2, 'End Day needs two planned Routine Occurrences.');
  const carried = actions.filter((item) => item.decision.kind === 'carry').slice(0, 2);
  assert(carried.length === 2, 'End Day needs two carried Actions for the next focus.');
  return {
    date: today,
    carryTo,
    actions,
    occurrences,
    nextFocus: carried.map((item): FocusTargetInput => ({
      kind: 'action',
      actionId: item.actionId,
    })),
  };
}

function occurrenceTarget(entry: OccurrenceEntry): OccurrenceTargetInput {
  return {
    routineId: entry.ref.routineId,
    generation: entry.ref.generation,
    period: entry.ref.period,
    ...(entry.ref.materialized && entry.ref.localRevision !== undefined
      ? { revision: entry.ref.localRevision }
      : {}),
  };
}

/* ───────────────────────── Fixtures ───────────────────────── */

type RoutineKind = 'daily' | 'weekly_days' | 'weekly_count' | 'monthly_day';

function routineFixtures(): { readonly kind: RoutineKind; readonly input: RoutineInput }[] {
  const startsOn = '2026-01-05';
  const fixtures: { kind: RoutineKind; input: RoutineInput }[] = [];
  for (let index = 0; index < 10; index += 1) {
    fixtures.push({
      kind: 'daily',
      input: {
        title: `Synthetic daily ${String(index + 1)}`,
        rule: { version: 1, kind: 'daily', intervalDays: 1, startsOn },
        schedulingMode:
          index < 5
            ? {
                kind: 'time_specific',
                wallTime: `${String(6 + index).padStart(2, '0')}:00`,
                durationMinutes: 20,
                zonePolicy: { kind: 'follow_profile' },
                gapPolicy: 'shift_forward',
                overlapPolicy: 'earlier_offset',
              }
            : { kind: 'day_flexible' },
      },
    });
  }
  for (let index = 0; index < 10; index += 1) {
    fixtures.push({
      kind: 'weekly_days',
      input: {
        title: `Synthetic weekly ${String(index + 1)}`,
        rule: {
          version: 1,
          kind: 'weekly_days',
          intervalWeeks: 1,
          weekdays: ['monday', 'thursday'],
          startsOn,
        },
        schedulingMode: { kind: 'day_flexible' },
      },
    });
  }
  for (let index = 0; index < 5; index += 1) {
    fixtures.push({
      kind: 'weekly_count',
      input: {
        title: `Synthetic count ${String(index + 1)}`,
        rule: { version: 1, kind: 'weekly_count', targetCount: 3, weekStart: 'monday', startsOn },
        schedulingMode: { kind: 'day_flexible' },
      },
    });
  }
  for (let index = 0; index < 5; index += 1) {
    fixtures.push({
      kind: 'monthly_day',
      input: {
        title: `Synthetic monthly ${String(index + 1)}`,
        rule: {
          version: 1,
          kind: 'monthly_day',
          intervalMonths: 1,
          dayOfMonth: 10 + index,
          missingDayPolicy: 'last_day',
          startsOn,
        },
        schedulingMode: { kind: 'day_flexible' },
      },
    });
  }
  return fixtures;
}

function hex(prefix: string, index: number): string {
  return `${prefix}-0000-4000-8000-${(index + 1).toString(16).padStart(12, '0')}`;
}

function actionId(index: number): UUID {
  return hex('93000000', index) as UUID;
}

function sortKey(index: number): string {
  return String(500_000_000_000_000 + index).padStart(15, '0');
}

function at(date: string, hour: number, minute = 0): string {
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00.000Z`;
}

function chunks<T>(values: readonly T[], size = 1_000): T[][] {
  const output: T[][] = [];
  for (let index = 0; index < values.length; index += size)
    output.push(values.slice(index, index + size));
  return output;
}

function seedStatements(): string[] {
  const stamp = `'${now}','${now}','${now}'`;
  const actions: string[] = [];
  const placements: string[] = [];
  const blocks: string[] = [];
  const action = (index: number, state: string) =>
    `('${actionId(index)}','${ownerId}','Synthetic Action ${String(index + 1).padStart(5, '0')}','${state}','plan','${sortKey(index)}',${state === 'completed' ? `'${now}'` : 'NULL'},${stamp})`;
  const placement = (index: number, date: string, horizon: 'day' | 'week' = 'day') =>
    `('${hex('94000000', index)}','${ownerId}','${actionId(index)}','${horizon}','${date}','${date}','${horizon === 'week' ? addDays(date as CalendarDate, 6) : date}',${horizon === 'week' ? `'monday'` : 'NULL'},'${sortKey(index)}',${stamp})`;
  const block = (
    id: string,
    target: { readonly action?: string; readonly commitment?: string; readonly title?: string },
    startsAt: string,
    endsAt: string,
    state: string,
  ) => {
    const value = (text: string | undefined) => (text === undefined ? 'NULL' : `'${text}'`);
    return `('${id}','${ownerId}',${value(target.action)},${value(target.commitment)},${value(target.title)},'${startsAt}','${endsAt}','${zone}','${state}',${stamp})`;
  };
  for (let index = 0; index < actionCount; index += 1) {
    if (index < 5_000) {
      // Completed history: five a day for 1,000 days, each with its completed block.
      const date = addDays('2023-08-19' as CalendarDate, Math.floor(index / 5));
      actions.push(action(index, 'completed'));
      placements.push(placement(index, date));
      blocks.push(
        block(
          hex('95000000', index),
          { action: actionId(index) },
          at(date, 14),
          at(date, 15),
          'completed',
        ),
      );
    } else if (index < 7_000) {
      // Flexible Day work around today: ten a day for 200 days.
      actions.push(action(index, 'planned'));
      placements.push(
        placement(index, addDays('2026-05-04' as CalendarDate, (index - 5_000) % 200)),
      );
    } else if (index < 8_000) {
      // Scheduled Day work: five a day for 200 days at distinct hours, each with its planned block.
      const offset = index - 7_000;
      const date = addDays('2026-05-04' as CalendarDate, offset % 200);
      const hour = 13 + (Math.floor(offset / 200) % 8);
      actions.push(action(index, 'scheduled'));
      placements.push(placement(index, date));
      blocks.push(
        block(
          hex('95000000', index),
          { action: actionId(index) },
          at(date, hour),
          at(date, hour, 45),
          'planned',
        ),
      );
    } else if (index < 9_000) {
      // Week-placed work across 60 Monday weeks.
      actions.push(action(index, 'planned'));
      placements.push(
        placement(index, addDays('2025-08-18' as CalendarDate, 7 * ((index - 8_000) % 60)), 'week'),
      );
    } else if (index < 9_000 + endDayLoad) {
      actions.push(action(index, 'planned'));
      placements.push(placement(index, today));
    } else {
      actions.push(action(index, 'inbox'));
    }
  }
  for (let index = 0; index < 6_000; index += 1) {
    const date = addDays('2023-08-19' as CalendarDate, Math.floor(index / 6));
    blocks.push(
      block(
        hex('96000000', index),
        { title: `Synthetic history ${String(index)}` },
        at(date, 20),
        at(date, 20, 45),
        'completed',
      ),
    );
  }
  // One hard Commitment overlapping a scheduled Action today.
  const commitment = hex('99000000', 0);
  blocks.push(
    block(hex('99100000', 0), { commitment }, at(today, 17, 30), at(today, 18, 30), 'planned'),
  );

  const selections: string[] = [];
  for (let week = 0; week < 104; week += 1) {
    const start = addDays('2024-08-19' as CalendarDate, 7 * week);
    for (let slot = 0; slot < 3; slot += 1) {
      const index = week * 3 + slot;
      const target = actionId(9_000 + endDayLoad + (index % (1_000 - endDayLoad)));
      selections.push(
        `('${hex('97000000', index)}','${ownerId}','${profileId}','${target}','${start}','${addDays(start, 6)}','monday','${sortKey(index)}',${stamp})`,
      );
    }
  }
  const focus: string[] = [];
  for (let dayIndex = 0; dayIndex < 1_000; dayIndex += 1) {
    const date = addDays(today, dayIndex - 1_000);
    for (let slot = 0; slot < 3; slot += 1) {
      const index = dayIndex * 3 + slot;
      focus.push(
        `('${hex('98000000', index)}','${ownerId}','${profileId}','${actionId(index % 5_000)}','${date}','${sortKey(slot)}',${stamp})`,
      );
    }
  }
  // Today's single focus item: flexible Action 5,100 (placed on today).
  focus.push(
    `('${hex('98000000', 3_000)}','${ownerId}','${profileId}','${actionId(5_100)}','${today}','${sortKey(0)}',${stamp})`,
  );

  return [
    ...chunks(actions).map(
      (rows) => `INSERT INTO actions (id, owner_id, title, state, capture_origin, sort_key,
        completed_at, created_at, updated_at, client_updated_at) VALUES ${rows.join(',')};`,
    ),
    ...chunks(placements).map(
      (rows) => `INSERT INTO planning_placements (id, owner_id, action_id, horizon, period_key,
        period_start_date, period_end_date, week_start, sort_key, created_at, updated_at,
        client_updated_at) VALUES ${rows.join(',')};`,
    ),
    `INSERT INTO commitments (id, owner_id, title, strength, state, created_at, updated_at,
      client_updated_at) VALUES ('${commitment}','${ownerId}','Synthetic class','hard','planned',${stamp});`,
    ...chunks(blocks).map(
      (rows) => `INSERT INTO time_blocks (id, owner_id, action_id, commitment_id, custom_title,
        starts_at_utc, ends_at_utc, time_zone, state, created_at, updated_at, client_updated_at)
        VALUES ${rows.join(',')};`,
    ),
    ...chunks(selections).map(
      (rows) => `INSERT INTO week_selections (id, owner_id, profile_id, action_id,
        period_start_date, period_end_date, week_start, sort_key, created_at, updated_at,
        client_updated_at) VALUES ${rows.join(',')};`,
    ),
    ...chunks(focus).map(
      (rows) => `INSERT INTO focus_selections (id, owner_id, profile_id, action_id, local_date,
        sort_key, created_at, updated_at, client_updated_at) VALUES ${rows.join(',')};`,
    ),
  ];
}

/**
 * Materialized history before today for the created Routines: 120 days of daily occurrences, 31
 * weeks of Monday and Thursday occurrences, and 31 weekly counts; monthly Routines stay projected.
 */
function routineHistoryStatements(
  routines: readonly { readonly id: UUID; readonly kind: RoutineKind }[],
): string[] {
  const stamp = `'${now}','${now}','${now}'`;
  const rows: string[] = [];
  const dated = (routineId: UUID, date: CalendarDate, index: number) => {
    const period: GeneratedOccurrencePeriod = { kind: 'date', date };
    const id = routineOccurrenceId(occurrenceLogicalKey(routineId, 1, period));
    const completed = index % 4 !== 3;
    rows.push(
      `('${id}','${ownerId}','${routineId}',1,'${date}','dated','${completed ? 'completed' : 'skipped'}',NULL,NULL,${completed ? `'${date}T12:00:00.000Z'` : 'NULL'},0,${stamp})`,
    );
  };
  for (const routine of routines) {
    if (routine.kind === 'daily') {
      for (let offset = 120; offset >= 1; offset -= 1)
        dated(routine.id, addDays(today, -offset), offset);
    } else if (routine.kind === 'weekly_days') {
      for (let week = 0; week < 31; week += 1) {
        const monday = addDays('2026-01-05' as CalendarDate, 7 * week);
        dated(routine.id, monday, week);
        dated(routine.id, addDays(monday, 3), week + 1);
      }
    } else if (routine.kind === 'weekly_count') {
      for (let week = 0; week < 31; week += 1) {
        const start = addDays('2026-01-05' as CalendarDate, 7 * week);
        const period: GeneratedOccurrencePeriod = {
          kind: 'week',
          start,
          end: addDays(start, 6),
          weekStart: 'monday',
          targetCount: 3,
        };
        const id = routineOccurrenceId(occurrenceLogicalKey(routine.id, 1, period));
        const completed = week % 3 !== 2;
        rows.push(
          `('${id}','${ownerId}','${routine.id}',1,'${start}/${period.end}/monday','weekly_count','${completed ? 'completed' : 'planned'}',3,${completed ? '3' : '1'},${completed ? `'${period.end}T12:00:00.000Z'` : 'NULL'},0,${stamp})`,
        );
      }
    }
  }
  return chunks(rows).map(
    (values) => `INSERT INTO routine_occurrences (id, owner_id, routine_id, generation,
      logical_period_key, occurrence_kind, state, target_count, completed_count, completed_at,
      ordinal, created_at, updated_at, client_updated_at) VALUES ${values.join(',')};`,
  );
}

/* ───────────────────────── Measurement ───────────────────────── */

async function timed<Value>(operation: () => Promise<Value>) {
  const started = performance.now();
  const value = await operation();
  return { value, duration: performance.now() - started };
}

/**
 * Time one operation while a 10 ms main-thread heartbeat records the longest gap between ticks
 * SQL runs in the worker, so application work must not starve the page.
 */
async function withHeartbeat<Value>(operation: () => Promise<Value>) {
  let last = performance.now();
  let maxGapMs = 0;
  let ticks = 0;
  const heartbeat = window.setInterval(() => {
    const current = performance.now();
    maxGapMs = Math.max(maxGapMs, current - last);
    last = current;
    ticks += 1;
  }, 10);
  try {
    const result = await timed(operation);
    maxGapMs = Math.max(maxGapMs, performance.now() - last);
    return { ...result, maxGapMs, ticks };
  } finally {
    window.clearInterval(heartbeat);
  }
}

async function samples<Value>(count: number, operation: () => Promise<Value>) {
  const durations: number[] = [];
  const values: Value[] = [];
  for (let index = 0; index < count; index += 1) {
    const result = await timed(operation);
    durations.push(result.duration);
    values.push(result.value);
  }
  return { durations, values };
}

function summarize(values: readonly number[]) {
  const sorted = [...values].sort((left, right) => left - right);
  return {
    runs: values.length,
    medianMs: rounded(sorted[Math.floor(sorted.length / 2)] ?? 0),
    worstMs: rounded(Math.max(...values)),
  };
}

function rounded(value: number): number {
  return Math.round(value * 10) / 10;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function browserHeap(): number | null {
  const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory;
  return memory?.usedJSHeapSize ?? null;
}

function report(status: 'failed' | 'passed', value: unknown): void {
  output.dataset['status'] = status;
  output.textContent = JSON.stringify(value, null, 2);
}
