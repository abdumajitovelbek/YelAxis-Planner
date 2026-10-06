// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import type { SearchApplication, SearchPage as SearchResults } from '@yelaxis/application';
import type { UUID } from '@yelaxis/domain';
import { SearchPage } from './search-page';
const id = '16000000-0000-4000-8000-000000000001' as UUID;
afterEach(cleanup);
const sample: SearchResults = {
  items: [
    {
      kind: 'action',
      id,
      title: 'Synthetic Action',
      excerpt: '<script>plain user text</script>',
      state: 'inbox',
      archived: false,
      updatedAt: '2026-10-03T12:00:00.000Z',
    },
  ],
};
function setup(overrides: Partial<SearchApplication> = {}) {
  const application: SearchApplication = {
    search: vi.fn(() => Promise.resolve(sample)),
    detail: vi.fn(() => Promise.resolve(null)),
    choices: vi.fn(() =>
      Promise.resolve({
        axes: [{ id, title: 'Synthetic Axis' }],
        projects: [{ id, title: 'Synthetic Project' }],
        truncated: false,
      }),
    ),
    ...overrides,
  };
  render(
    <MemoryRouter>
      <SearchPage application={application} />
    </MemoryRouter>,
  );
  return { application, user: userEvent.setup() };
}
describe('local Search page', () => {
  it('shows loading then owned results, explicit local semantics and plain text', async () => {
    setup();
    expect(screen.getByRole('status')).toHaveTextContent('Searching');
    expect(await screen.findByRole('link', { name: 'Synthetic Action' })).toHaveAttribute(
      'href',
      `/search/action/${id}`,
    );
    expect(screen.getByRole('searchbox', { name: 'Search text' })).toHaveAccessibleDescription(
      /word prefixes/u,
    );
    expect(screen.getByText('<script>plain user text</script>')).toBeVisible();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.getByRole('heading', { name: 'Search', level: 1 })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent('1 result');
  });
  it('queries immediately, exposes every filter, validates dates without querying, and resets accessibly', async () => {
    const { application, user } = setup();
    await screen.findByRole('link', { name: 'Synthetic Action' });
    await user.type(screen.getByRole('searchbox'), 'recover');
    await user.selectOptions(screen.getByLabelText('Type'), 'note');
    await user.selectOptions(screen.getByLabelText('State'), 'active');
    await user.selectOptions(screen.getByLabelText('Axis'), id);
    await user.selectOptions(screen.getByLabelText('Project'), id);
    await user.selectOptions(screen.getByLabelText('Archive'), 'include');
    await user.selectOptions(screen.getByLabelText('Date basis'), 'due');
    await user.type(screen.getByLabelText('From date'), '2026-10-08');
    await user.type(screen.getByLabelText('Through date'), '2026-10-09');
    await waitFor(() =>
      expect(application.search).toHaveBeenLastCalledWith(
        expect.objectContaining({
          text: 'recover',
          kind: 'note',
          state: 'active',
          axisId: id,
          projectId: id,
          archive: 'include',
          dateBasis: 'due',
          from: '2026-10-08',
          to: '2026-10-09',
        }),
      ),
    );
    const before = vi.mocked(application.search).mock.calls.length;
    await user.clear(screen.getByLabelText('Through date'));
    await user.type(screen.getByLabelText('Through date'), '2026-10-07');
    expect(await screen.findByRole('alert')).toHaveTextContent('Search filters');
    await waitFor(() =>
      expect(vi.mocked(application.search).mock.calls.length).toBeGreaterThanOrEqual(before),
    );
    const invalidCalls = vi
      .mocked(application.search)
      .mock.calls.filter(
        ([value]) =>
          typeof value === 'object' && value !== null && 'to' in value && value.to === '2026-10-07',
      );
    expect(invalidCalls).toEqual([]);
    await user.click(screen.getByRole('button', { name: 'Reset search' }));
    expect(screen.getByRole('searchbox')).toHaveFocus();
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(screen.getByLabelText('Archive')).toHaveValue('exclude');
  });
  it('shows empty results and a recoverable error with retry', async () => {
    const search = vi
      .fn<SearchApplication['search']>()
      .mockRejectedValueOnce(new Error('synthetic storage interruption'))
      .mockResolvedValue({ items: [] });
    const { user } = setup({ search });
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
    expect(screen.queryByText('synthetic storage interruption')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('No matching records.')).toBeVisible();
  });
  it('paginates with exact query cursor and focuses results after keyboard navigation', async () => {
    const cursor = `s1.00000000.2026-10-03T12:00:00.000Z.action.${id}`;
    const search = vi
      .fn<SearchApplication['search']>()
      .mockResolvedValueOnce({ ...sample, nextCursor: cursor })
      .mockResolvedValue(sample);
    const { user } = setup({ search });
    const next = await screen.findByRole('button', { name: 'Next results' });
    next.focus();
    await user.keyboard('{Enter}');
    await waitFor(() =>
      expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ cursor })),
    );
    await waitFor(() =>
      expect(screen.getByRole('heading', { name: 'Results', level: 2 })).toHaveFocus(),
    );
    expect(screen.getByRole('button', { name: 'First results' })).toBeVisible();
  });
});
