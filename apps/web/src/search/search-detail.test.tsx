// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import type { SearchApplication, SearchDetail } from '@yelaxis/application';
import type { UUID } from '@yelaxis/domain';
import { SearchDetailPage } from './search-detail';
const id = '16000000-0000-4000-8000-000000000001' as UUID;
const fullText = 'Synthetic long note ' + 'all original prose '.repeat(200);
const detail: SearchDetail = {
  kind: 'note',
  id,
  title: 'Synthetic Note',
  text: fullText,
  state: 'active',
  archived: false,
  createdAt: '2026-10-03T00:00:00.000Z',
  updatedAt: '2026-10-03T12:00:00.000Z',
};
afterEach(cleanup);
function setup(result: SearchDetail | null = detail, path = `/search/note/${id}`, reject = false) {
  const application: SearchApplication = {
    search: () => Promise.resolve({ items: [] }),
    choices: () => Promise.resolve({ axes: [], projects: [], truncated: false }),
    detail: vi.fn(() =>
      reject ? Promise.reject(new Error('raw SQL error')) : Promise.resolve(result),
    ),
  };
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/search/:kind/:id" element={<SearchDetailPage application={application} />} />
      </Routes>
    </MemoryRouter>,
  );
  return application;
}
describe('local Search full detail', () => {
  it('reads an owned deep link, displays every prose character, and returns to Search', async () => {
    const application = setup();
    expect(screen.getByRole('status')).toHaveTextContent('Opening');
    expect(await screen.findByRole('heading', { name: 'Synthetic Note', level: 1 })).toBeVisible();
    const prose = screen.getByRole('heading', { name: 'Full notes and prose' }).nextElementSibling;
    expect(prose?.textContent).toBe(fullText);
    expect(application.detail).toHaveBeenCalledWith('note', id);
    expect(screen.getByRole('link', { name: 'Back to Search' })).toHaveAttribute('href', '/search');
  });
  it('offers the existing canonical object detail and review routes', async () => {
    setup({ ...detail, kind: 'review_decision', review: { type: 'weekly', key: '2026-09-28' } });
    expect(await screen.findByRole('link', { name: 'Open Review' })).toHaveAttribute(
      'href',
      '/review/weekly/2026-09-28',
    );
  });
  it('shows inaccessible, malformed, and deleted details as unavailable', async () => {
    setup(null, '/search/unknown/not-an-id');
    expect(await screen.findByRole('heading', { name: 'Record unavailable' })).toBeVisible();
    expect(screen.getByText('This record is unavailable in the current plan.')).toBeVisible();
  });
  it('handles a recoverable storage failure without exposing SQL or content', async () => {
    setup(null, `/search/note/${id}`, true);
    expect(await screen.findByRole('alert')).toHaveTextContent('could not be read');
    expect(screen.queryByText('raw SQL error')).toBeNull();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});
