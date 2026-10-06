import { afterEach, describe, expect, it } from 'vitest';

import type { OnboardingState } from '@yelaxis/application';
import type { Instant } from '@yelaxis/domain';

import type { NodeSqliteDriver } from '../sqlite/testing/node-driver.node';
import {
  complete,
  expectReceiptMatchesEvents,
  firstCompletionArtifacts,
  latestReceipt,
  ledgerDeletion,
  onboardingEventCount,
  openOnboardingFixture,
  removeOnboardingFixtures,
  rerun,
  rows,
  setupDay,
  starterActionTitle,
} from './testing/onboarding-fixture';

// The Saturday that ends the setup week.
const laterDay = '2026-08-08T07:00:00.000Z' as Instant;

afterEach(removeOnboardingFixtures);

/** A focus item the person chose on Today, for an Action of their own. */
async function addFocusItem(
  driver: NodeSqliteDriver,
  state: Pick<OnboardingState, 'ownerId' | 'profileId'>,
  item: Readonly<{ number: number; date: string; sortKey: string }>,
): Promise<string> {
  const suffix = item.number.toString(16).padStart(12, '0');
  const action = `30000000-0000-4000-8000-${suffix}`;
  const focus = `31000000-0000-4000-8000-${suffix}`;
  const now = setupDay;
  await driver.run(
    `INSERT INTO actions (
       id, owner_id, title, state, capture_origin, sort_key, created_at, updated_at,
       client_updated_at
     ) VALUES (?, ?, ?, 'planned', 'today', ?, ?, ?, ?);`,
    [action, state.ownerId, `Chosen Action ${item.number}`, item.sortKey, now, now, now],
  );
  await driver.run(
    `INSERT INTO focus_selections (
       id, owner_id, profile_id, action_id, local_date, sort_key, created_at, updated_at,
       client_updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?);`,
    [focus, state.ownerId, state.profileId, action, item.date, item.sortKey, now, now, now],
  );
  return focus;
}

const focusRows = (driver: NodeSqliteDriver) => rows(driver, 'focus_selections');
const focusEventCount = (driver: NodeSqliteDriver, focusId?: string) =>
  onboardingEventCount(driver, 'focus', focusId);

describe('Today and Focus onboarding day focus', () => {
  it('creates exactly one focus row for the starter Action on the normal first completion', async () => {
    const { driver, onboarding } = await openOnboardingFixture();

    const completed = await complete(onboarding);

    const { actionId, focusId } = completed.artifacts;
    expect(await focusRows(driver)).toEqual([
      expect.objectContaining({
        id: focusId,
        action_id: actionId,
        local_date: '2026-08-06',
        sort_key: 'onboarding-01',
        archived_at: null,
        local_revision: 1,
      }),
    ]);
    expect(await focusEventCount(driver, focusId)).toBe(1);
    const receipt = await latestReceipt(driver);
    expect(receipt.canonical.map(({ ref }) => ref)).toContainEqual(
      expect.objectContaining({ type: 'focus_selection', id: focusId }),
    );
    await expectReceiptMatchesEvents(driver, receipt);
    await driver.close();
  });

  it('leaves focus the person reordered untouched when setup is rerun on a full day', async () => {
    const { driver, onboarding, setNow } = await openOnboardingFixture();
    const completed = await complete(onboarding);
    // What Today leaves behind: two more focus items, the starter Action moved to the end, and
    // three focus items already chosen for the day of the rerun.
    await addFocusItem(driver, completed, {
      number: 1,
      date: '2026-08-06',
      sortKey: '000001000000000',
    });
    await addFocusItem(driver, completed, {
      number: 2,
      date: '2026-08-06',
      sortKey: '000002000000000',
    });
    await driver.run(
      `UPDATE focus_selections SET sort_key = '000003000000000', local_revision = local_revision + 1
       WHERE id = ?;`,
      [completed.artifacts.focusId ?? ''],
    );
    for (const number of [3, 4, 5]) {
      await addFocusItem(driver, completed, {
        number,
        date: '2026-08-08',
        sortKey: `00000${number}000000000`,
      });
    }
    const before = await focusRows(driver);

    setNow(laterDay);
    const replay = await rerun(onboarding);

    expect(replay.status).toBe('completed');
    expect(replay.artifacts.focusId).toBe(completed.artifacts.focusId);
    expect(await focusRows(driver)).toEqual(before);
    expect(await focusEventCount(driver)).toBe(1);
    await expectReceiptMatchesEvents(driver, await latestReceipt(driver));
    await driver.close();
  });

  it('keeps a removed focus item removed when setup is rerun', async () => {
    const { driver, onboarding, setNow } = await openOnboardingFixture();
    const completed = await complete(onboarding);
    await driver.run(
      `UPDATE focus_selections SET archived_at = ?, local_revision = local_revision + 1
       WHERE id = ?;`,
      [setupDay, completed.artifacts.focusId ?? ''],
    );
    const before = await focusRows(driver);

    setNow(laterDay);
    await rerun(onboarding);

    expect(await focusRows(driver)).toEqual(before);
    expect(before).toEqual([
      expect.objectContaining({ local_date: '2026-08-06', archived_at: setupDay }),
    ]);
    expect(await focusEventCount(driver)).toBe(1);
    await driver.close();
  });

  it('completes setup without adding focus when the day already has three focus items', async () => {
    const { driver, onboarding, initial } = await openOnboardingFixture();
    // The person left setup, used Today, and chose three focus items first.
    const chosen = [];
    for (const number of [1, 2, 3]) {
      chosen.push(
        await addFocusItem(driver, initial, {
          number,
          date: '2026-08-06',
          sortKey: `00000${number}000000000`,
        }),
      );
    }
    const before = await focusRows(driver);

    const completed = await complete(onboarding);

    expect(completed.status).toBe('completed');
    expect(await focusRows(driver)).toEqual(before);
    expect(await focusEventCount(driver)).toBe(0);
    const receipt = await latestReceipt(driver);
    expect(receipt.canonical.map(({ ref }) => ref.id)).not.toContain(completed.artifacts.focusId);
    await expectReceiptMatchesEvents(driver, receipt);
    // The starter Action is still created and placed on the day.
    await expect(
      driver.get('SELECT action_id, period_start_date FROM planning_placements;'),
    ).resolves.toEqual({
      action_id: completed.artifacts.actionId,
      period_start_date: '2026-08-06',
    });

    // Once the day has room again, a rerun still leaves the focus to the person.
    await driver.run(
      `UPDATE focus_selections SET archived_at = ?, local_revision = local_revision + 1
       WHERE id = ?;`,
      [setupDay, chosen[0] ?? ''],
    );
    const withRoom = await focusRows(driver);
    await rerun(onboarding);
    expect(await focusRows(driver)).toEqual(withRoom);
    expect(await focusEventCount(driver)).toBe(0);
    await driver.close();
  });

  it('never resurrects the focus row of a starter Action that was permanently deleted', async () => {
    const { driver, onboarding, setNow, actions } = await openOnboardingFixture();
    const completed = await complete(onboarding);
    const { actionId, focusId } = completed.artifacts;
    if (actionId === undefined || focusId === undefined) throw new Error('Missing artifacts');
    const application = actions();
    const detail = await application.getAction(actionId);
    if (detail === null) throw new Error('Missing starter Action');
    expect(
      await application.deletePermanently(
        actionId,
        detail.action.localRevision,
        starterActionTitle,
      ),
    ).toMatchObject({ ok: true });
    const ledger = await driver.all(
      `SELECT entity_type, entity_id FROM deletion_ledger WHERE entity_id = ?;`,
      [focusId],
    );
    expect(ledger).toEqual([{ entity_type: 'focus_selection', entity_id: focusId }]);
    expect(await focusRows(driver)).toEqual([]);

    setNow(laterDay);
    const replay = await rerun(onboarding, (draft) => ({
      ...draft,
      week: { ...draft.week, actionTitle: 'Draft the proposal outline again' },
    }));

    const focus = await focusRows(driver);
    expect(focus.map((row) => row['id'])).not.toContain(focusId);
    await expect(
      driver.all(`SELECT entity_type, entity_id FROM deletion_ledger WHERE entity_id = ?;`, [
        focusId,
      ]),
    ).resolves.toEqual(ledger);
    expect(await focusEventCount(driver, focusId)).toBe(1);
    // The replacement starter Action is new: its focus, if the day has room, has a new id too.
    expect(replay.artifacts.focusId).not.toBe(focusId);
    expect(focus).toEqual([
      expect.objectContaining({
        id: replay.artifacts.focusId,
        action_id: replay.artifacts.actionId,
        local_date: '2026-08-08',
      }),
    ]);
    await driver.close();
  });

  it('completes a rerun after a focus row alone was permanently deleted, without re-adding it', async () => {
    const { driver, onboarding, setNow } = await openOnboardingFixture();
    const completed = await complete(onboarding);
    const focusId = completed.artifacts.focusId ?? '';
    await driver.run('DELETE FROM focus_selections WHERE id = ?;', [focusId]);
    await ledgerDeletion(driver, completed.ownerId, 'focus_selection', focusId);

    setNow(laterDay);
    const replay = await rerun(onboarding);

    expect(replay.status).toBe('completed');
    expect(await focusRows(driver)).toEqual([]);
    expect(await focusEventCount(driver)).toBe(1);
    await driver.close();
  });

  it('skips a first-completion focus id that is permanently deleted or already taken', async () => {
    const focusId = (await firstCompletionArtifacts()).focusId;
    if (focusId === undefined) throw new Error('Missing focus artifact');

    const deleted = await openOnboardingFixture();
    await ledgerDeletion(deleted.driver, deleted.initial.ownerId, 'focus_selection', focusId);
    const afterDeleted = await complete(deleted.onboarding);
    expect(afterDeleted.artifacts.focusId).toBe(focusId);
    expect(afterDeleted.status).toBe('completed');
    expect(await focusRows(deleted.driver)).toEqual([]);
    await expectReceiptMatchesEvents(deleted.driver, await latestReceipt(deleted.driver));
    await deleted.driver.close();

    const taken = await openOnboardingFixture();
    const existing = await addFocusItem(taken.driver, taken.initial, {
      number: 1,
      date: '2026-08-05',
      sortKey: '000001000000000',
    });
    await taken.driver.run('UPDATE focus_selections SET id = ? WHERE id = ?;', [focusId, existing]);
    const before = await focusRows(taken.driver);
    const afterTaken = await complete(taken.onboarding);
    expect(afterTaken.status).toBe('completed');
    expect(await focusRows(taken.driver)).toEqual(before);
    expect(await focusEventCount(taken.driver)).toBe(0);
    await taken.driver.close();
  });
});
