import { createImportApplication, type ImportStorePort } from '@yelaxis/application';
import type { OwnerId } from '@yelaxis/domain';
import { afterEach, expect, it, vi } from 'vitest';

import { CanonicalBundleCodec } from '../account/canonical-bundle';
import {
  openAccountFixture,
  removeAccountFixtures,
  type AccountFixture,
} from '../account/testing/account-fixture';
import { SqliteImportStore } from './sqlite-import-store';

const fixtures: AccountFixture[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fixture of fixtures.splice(0)) await fixture.driver.close();
  await removeAccountFixtures();
});

async function fixture() {
  const fixture = await openAccountFixture();
  fixtures.push(fixture);
  return fixture;
}

function application(
  fixture: AccountFixture,
  store: ImportStorePort = new SqliteImportStore(fixture.driver),
) {
  const codec = new CanonicalBundleCodec();
  return createImportApplication({
    store,
    decoder: codec,
    bundles: codec,
    clock: fixture.clock,
    ids: fixture.ids,
    appVersion: 'test',
  });
}

async function preview(fixture: AccountFixture) {
  const bundle = await fixture.account().exportBundle();
  if (!bundle.ok) throw new Error('Synthetic export failed.');
  const result = await application(fixture).preview(bundle.value.text);
  if (!result.ok) throw new Error('Synthetic preview failed.');
  return result.value;
}

it('reads an empty pending/resume journal without opening any write transaction or write capability', async () => {
  const source = await fixture();
  const transaction = vi
    .spyOn(source.driver, 'transaction')
    .mockRejectedValue(new Error('Unexpected write transaction.'));
  const run = vi.spyOn(source.driver, 'run').mockRejectedValue(new Error('Unexpected write.'));
  const script = vi
    .spyOn(source.driver, 'executeScript')
    .mockRejectedValue(new Error('Unexpected script.'));
  const imports = application(source);
  expect(await imports.pending()).toBeNull();
  expect(await imports.resume()).toEqual({ ok: false, code: 'preview_missing' });
  expect(transaction).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(script).not.toHaveBeenCalled();
});

it('reads a durable pending journal without writes and retains exactly the required preview transaction on resume', async () => {
  const source = await fixture();
  const saved = await preview(source);
  await source.reopen();
  const before = await source.driver.all('SELECT * FROM import_journal;');
  const owner = await source.ownerId();
  const transaction = vi.spyOn(source.driver, 'transaction');
  const run = vi.spyOn(source.driver, 'run');
  const imports = application(source);
  expect(await imports.pending()).toMatchObject({
    id: saved.previewId,
    ownerId: owner,
  });
  expect(transaction).not.toHaveBeenCalled();
  expect(run).not.toHaveBeenCalled();
  expect(await source.driver.all('SELECT * FROM import_journal;')).toEqual(before);
  expect(await imports.resume()).toMatchObject({ ok: true, value: { previewId: saved.previewId } });
  expect(transaction).toHaveBeenCalledTimes(1);
  expect(await source.driver.get('PRAGMA integrity_check;')).toEqual({ integrity_check: 'ok' });
  expect(await source.driver.all('PRAGMA foreign_key_check;')).toEqual([]);
});

it('keeps read-only journal access on the shared application queue before a discard transaction', async () => {
  const source = await fixture();
  const store = new SqliteImportStore(source.driver);
  const read = store.readJournal.bind(store);
  let finish: (() => void) | undefined;
  let entered: (() => void) | undefined;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  vi.spyOn(store, 'readJournal').mockImplementationOnce(async () => {
    entered?.();
    await gate;
    return await read();
  });
  const transaction = vi.spyOn(source.driver, 'transaction');
  const imports = application(source, store);
  const pending = imports.pending();
  const discard = imports.discard();
  await started;
  expect(transaction).not.toHaveBeenCalled();
  finish?.();
  expect(await pending).toBeNull();
  expect(await discard).toEqual({ ok: true, value: undefined });
  expect(transaction).toHaveBeenCalledTimes(1);
});

it('validates active ownership, refuses ambiguous identities, and never falls back to another owner journal', async () => {
  const source = await fixture();
  const saved = await preview(source);
  const owner = await source.ownerId();
  const other = 'd9000000-0000-4000-8000-000000000001' as OwnerId;
  const at = source.clock.now();
  await source.driver.run(
    "INSERT INTO planning_identities(id,identity_kind,created_at,updated_at) VALUES(?,'local',?,?);",
    [other, at, at],
  );
  const ownerStore = new SqliteImportStore(source.driver, { ownerId: owner });
  const otherStore = new SqliteImportStore(source.driver, { ownerId: other });
  expect((await ownerStore.readJournal())?.id).toBe(saved.previewId);
  expect(await otherStore.readJournal()).toBeNull();
  await expect(new SqliteImportStore(source.driver).readJournal()).rejects.toMatchObject({
    code: 'identity_ambiguous',
  });
  await source.driver.run('UPDATE planning_identities SET deleted_at=? WHERE id=?;', [at, owner]);
  await expect(ownerStore.readJournal()).rejects.toMatchObject({ code: 'identity_ambiguous' });
  expect(await otherStore.readJournal()).toBeNull();
  expect(
    (
      await source.driver.get<{ id: string }>('SELECT id FROM import_journal WHERE owner_id=?;', [
        owner,
      ])
    )?.id,
  ).toBe(saved.previewId);
});

it.each([
  ['destination_digest', 'g'.repeat(64)],
  ['decisions_json', '{"synthetic":"wrong shape"}'],
  ['remap_json', '{"action:synthetic":"invalid-uuid"}'],
  ['created_at', 'synthetic-invalid-instant'],
] as const)(
  'rejects malformed persisted %s without resetting or returning its contents',
  async (column, invalid) => {
    const source = await fixture();
    await preview(source);
    await source.driver.run(`UPDATE import_journal SET ${column}=?;`, [invalid]);
    const before = await source.driver.all('SELECT * FROM import_journal;');
    const transaction = vi.spyOn(source.driver, 'transaction');
    const imports = application(source);
    await expect(imports.pending()).rejects.toMatchObject({
      code: 'invalid_persisted_record',
      message: 'YelAxis Planner data operation failed.',
    });
    expect(await imports.resume()).toEqual({ ok: false, code: 'storage_failed' });
    expect(transaction).not.toHaveBeenCalled();
    expect(await source.driver.all('SELECT * FROM import_journal;')).toEqual(before);
  },
);
