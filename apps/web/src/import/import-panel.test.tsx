// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { ImportApplication, ImportJournal, ImportPreview } from '@yelaxis/application';
import type { Instant, UUID } from '@yelaxis/domain';

import { ImportPanel } from './import-panel';

afterEach(cleanup);
const id = 'ee000000-0000-4000-8000-000000000001' as UUID;
const at = '2026-10-03T05:00:00.000Z' as Instant;
const preview: ImportPreview = {
  previewId: id,
  bundleId: id,
  mode: 'merge',
  creates: 1,
  updates: 0,
  deletes: 0,
  identicalSkips: 0,
  keeps: 0,
  conflicts: [],
  problems: [],
  decisions: [],
  sensitiveContextCount: 0,
  recoveryConflicts: 0,
  expectedStorageBytes: 2048,
  accountLinked: false,
  backupRequired: true,
  canApply: true,
};
const journal: ImportJournal = {
  id,
  ownerId: id,
  text: '{}',
  mode: 'merge',
  decisions: [],
  duplicatedIds: {},
  destinationDigest: 'a'.repeat(64),
  createdAt: at,
};
type MockApplication = { [Method in keyof ImportApplication]: Mock<ImportApplication[Method]> };
function fake(overrides: Partial<MockApplication> = {}): MockApplication {
  return {
    preview: vi.fn<ImportApplication['preview']>((_text, options) =>
      Promise.resolve({ ok: true, value: { ...preview, mode: options?.mode ?? 'merge' } }),
    ),
    apply: vi.fn<ImportApplication['apply']>(() =>
      Promise.resolve({
        ok: true,
        value: {
          commandId: id,
          ownerId: id,
          actor: 'import',
          acceptedAt: at,
          canonical: [],
          eventIds: [],
          undo: { available: false },
          sync: { queued: false },
        },
      }),
    ),
    pending: vi.fn<ImportApplication['pending']>(() => Promise.resolve(null)),
    resume: vi.fn<ImportApplication['resume']>(() => Promise.resolve({ ok: true, value: preview })),
    discard: vi.fn<ImportApplication['discard']>(() =>
      Promise.resolve({ ok: true, value: undefined }),
    ),
    recoveryBackup: vi.fn<ImportApplication['recoveryBackup']>(() => Promise.resolve(null)),
    recoveryConflicts: vi.fn<ImportApplication['recoveryConflicts']>(() => Promise.resolve([])),
    resolveRecovery: vi.fn<ImportApplication['resolveRecovery']>(() =>
      Promise.resolve({ ok: false, code: 'preview_missing' }),
    ),
    ...overrides,
  };
}
function file(): File {
  const result = new File(['{}'], 'synthetic-backup.json', { type: 'application/json' });
  Object.defineProperty(result, 'text', { value: () => Promise.resolve('{}') });
  return result;
}
function renderPanel(application: ImportApplication) {
  const changed = vi.fn();
  const downloaded = vi.fn();
  render(<ImportPanel application={application} onChanged={changed} onDownload={downloaded} />);
  return { changed, downloaded, user: userEvent.setup() };
}

describe('canonical import preview UI', () => {
  it('previews first, uses explicit replacement confirmation, and reports local completion', async () => {
    const application = fake();
    const { changed, user } = renderPanel(application);
    await user.click(screen.getByRole('radio', { name: 'Restore/Replace' }));
    await user.upload(screen.getByLabelText('YelAxis Planner JSON backup file'), file());
    const apply = await screen.findByRole('button', { name: 'Replace plan after verified backup' });
    expect(application.apply).not.toHaveBeenCalled();
    expect(apply).toBeDisabled();
    await user.type(screen.getByLabelText('Type REPLACE MY PLAN to confirm'), 'yes');
    expect(apply).toBeDisabled();
    await user.clear(screen.getByLabelText('Type REPLACE MY PLAN to confirm'));
    await user.type(screen.getByLabelText('Type REPLACE MY PLAN to confirm'), 'REPLACE MY PLAN');
    await user.click(apply);
    expect(application.apply).toHaveBeenCalledWith(id, 'REPLACE MY PLAN');
    await waitFor(() => expect(changed).toHaveBeenCalledOnce());
    expect(screen.getByRole('status')).toHaveTextContent('Import completed');
  });

  it('compares nested dates, zone, periods, numeric and boolean fields before any conflict decision', async () => {
    const application = fake({
      preview: vi.fn<ImportApplication['preview']>(() =>
        Promise.resolve({
          ok: true,
          value: {
            ...preview,
            canApply: false,
            conflicts: [
              {
                type: 'action',
                id,
                title: 'Synthetic Action',
                reason: 'id_collision',
                choices: ['keep_current', 'use_imported', 'duplicate_imported'],
                current: {
                  deleted: false,
                  document: {
                    title: 'Current Action',
                    due: { kind: 'date', date: '2026-10-05' },
                    estimateMinutes: 15,
                  },
                },
                imported: {
                  deleted: false,
                  document: {
                    title: 'Imported Action',
                    due: {
                      kind: 'instant',
                      instant: '2026-10-06T05:30:00.000Z',
                      authoredTimeZone: 'Asia/Tashkent',
                    },
                    period: {
                      kind: 'week',
                      start: '2026-10-05',
                      end: '2026-10-11',
                      weekStart: 'monday',
                    },
                    estimateMinutes: 45,
                    overlapAcknowledged: true,
                  },
                },
                linkTitles: {},
              },
            ],
          },
        }),
      ),
    });
    const { user } = renderPanel(application);
    await user.upload(screen.getByLabelText('YelAxis Planner JSON backup file'), file());
    expect(await screen.findByText('Current Action')).toBeVisible();
    expect(screen.getByText('Imported Action')).toBeVisible();
    expect(screen.getByText(/2026-10-06T05:30:00.000Z/u)).toHaveTextContent('Asia/Tashkent');
    expect(screen.getByText(/start: 2026-10-05/u)).toHaveTextContent('end: 2026-10-11');
    expect(screen.getByText('45')).toBeVisible();
    expect(screen.getByText('true')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Apply merge' })).toBeDisabled();
    expect(application.apply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Keep current' }));
    expect(application.preview).toHaveBeenLastCalledWith('{}', {
      mode: 'merge',
      decisions: [{ type: 'action', id, decision: 'keep_current' }],
    });
  });

  it('shows interrupted preview recovery and allows discard without applying', async () => {
    const application = fake({
      pending: vi.fn<ImportApplication['pending']>(() => Promise.resolve(journal)),
    });
    const { user } = renderPanel(application);
    await user.click(await screen.findByRole('button', { name: 'Discard unfinished preview' }));
    expect(application.discard).toHaveBeenCalledOnce();
    expect(application.apply).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Resume import preview' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('status')).toHaveTextContent('Your plan was not changed');
  });

  it('rejects malformed input with a focused recoverable error and never offers an apply button', async () => {
    const application = fake({
      preview: vi.fn<ImportApplication['preview']>(() =>
        Promise.resolve({ ok: false, code: 'digest_mismatch' }),
      ),
    });
    const { user } = renderPanel(application);
    await user.upload(screen.getByLabelText('YelAxis Planner JSON backup file'), file());
    const error = await screen.findByRole('alert');
    expect(error).toHaveTextContent('verification digest');
    expect(error).toHaveFocus();
    expect(screen.queryByRole('button', { name: 'Apply merge' })).not.toBeInTheDocument();
    expect(application.apply).not.toHaveBeenCalled();
  });
});
