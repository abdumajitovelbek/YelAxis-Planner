// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { act, cleanup, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { Link, MemoryRouter, Route, Routes, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { todayPath } from '../plan/routes';
import { TodayLocationProbe } from './__fixtures__/today-fake';
import {
  createTodayEntryTracker,
  isFreshTodayEntry,
  parseTodaySearch,
  readDocumentEntry,
  useTodayMode,
  type DocumentNavigationType,
  type TodayEntryTracker,
} from './today-route';

afterEach(() => cleanup());

describe('isFreshTodayEntry', () => {
  const base = {
    initialUrl: '/?date=2026-09-29',
    currentUrl: '/?date=2026-09-29',
    consumed: false,
  };

  it('is fresh for the first render of a navigated, reloaded, or prerendered document', () => {
    for (const initialType of ['navigate', 'reload', 'prerender'] as const)
      expect(isFreshTodayEntry({ ...base, initialType }), initialType).toBe(true);
  });

  it('keeps Back/Forward, later renders, and other entries', () => {
    expect(isFreshTodayEntry({ ...base, initialType: 'back_forward' })).toBe(false);
    expect(isFreshTodayEntry({ ...base, initialType: 'reload', consumed: true })).toBe(false);
    expect(
      isFreshTodayEntry({ ...base, initialType: 'navigate', currentUrl: '/?date=2026-09-30' }),
    ).toBe(false);
  });
});

describe('parseTodaySearch', () => {
  it('reads live, selected, and invalid dates', () => {
    expect(parseTodaySearch('')).toEqual({ kind: 'live' });
    expect(parseTodaySearch('?other=1')).toEqual({ kind: 'live' });
    expect(parseTodaySearch('?date=2026-09-29')).toEqual({
      kind: 'selected',
      date: '2026-09-29',
    });
    for (const search of ['?date=', '?date=2026-02-30', '?date=today', '?date=2026-9-1'])
      expect(parseTodaySearch(search), search).toEqual({ kind: 'invalid' });
  });

  it('pairs with todayPath: the live today is always `/`', () => {
    expect(todayPath('2026-09-28', '2026-09-28')).toBe('/');
    expect(parseTodaySearch(todayPath('2026-09-29', '2026-09-28').slice(1))).toEqual({
      kind: 'selected',
      date: '2026-09-29',
    });
  });
});

describe('createTodayEntryTracker', () => {
  it('answers fresh once per document, stable for that history entry only', () => {
    const tracker = createTodayEntryTracker({
      initialUrl: '/?date=2026-09-29',
      initialType: 'reload',
    });
    expect(tracker.isFresh('/?date=2026-09-29', 'default')).toBe(true);
    expect(tracker.isFresh('/?date=2026-09-29', 'default')).toBe(true);
    expect(tracker.isFresh('/?date=2026-09-29', 'later')).toBe(false);
    expect(tracker.isFresh('/', 'default')).toBe(false);
  });

  it('is never fresh when Today first renders at another URL', () => {
    const tracker = createTodayEntryTracker({
      initialUrl: '/plan/week/2026-09-28',
      initialType: 'navigate',
    });
    expect(tracker.isFresh('/?date=2026-09-29', 'default')).toBe(false);
  });

  it('reads the document URL', () => {
    expect(readDocumentEntry().initialUrl).toBe(
      `${window.location.pathname}${window.location.search}`,
    );
  });
});

function ModeProbe({ tracker }: { readonly tracker: TodayEntryTracker }): ReactNode {
  const mode = useTodayMode(tracker);
  const navigate = useNavigate();
  return (
    <>
      <p data-testid="mode">{mode.kind === 'selected' ? `selected ${mode.date}` : mode.kind}</p>
      <Link to="/?date=2026-09-29">Next day</Link>
      <Link to="/plan/week/2026-09-28">Plan</Link>
      <button type="button" onClick={() => void navigate(-1)}>
        Back
      </button>
      <button type="button" onClick={() => void navigate(1)}>
        Forward
      </button>
    </>
  );
}

function renderMode(path: string, initialUrl: string, initialType: DocumentNavigationType) {
  const tracker = createTodayEntryTracker({ initialUrl, initialType });
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/" element={<ModeProbe tracker={tracker} />} />
        <Route path="*" element={<ModeProbe tracker={tracker} />} />
      </Routes>
      <TodayLocationProbe />
    </MemoryRouter>,
  );
}

const location = () => screen.getByTestId('location').textContent;
const mode = () => screen.getByTestId('mode').textContent;

describe('useTodayMode', () => {
  it('drops ?date on a fresh navigation or reload and opens the live today', async () => {
    for (const initialType of ['navigate', 'reload'] as const) {
      renderMode('/?date=2026-09-29', '/?date=2026-09-29', initialType);
      expect(mode()).toBe('live');
      await act(async () => Promise.resolve());
      expect(location()).toBe('/');
      cleanup();
    }
  });

  it('drops an unreadable ?date on a fresh entry too', async () => {
    renderMode('/?date=2026-02-30', '/?date=2026-02-30', 'reload');
    await act(async () => Promise.resolve());
    expect(location()).toBe('/');
    expect(mode()).toBe('live');
  });

  it('keeps ?date on a Back/Forward document load', async () => {
    renderMode('/?date=2026-09-29', '/?date=2026-09-29', 'back_forward');
    await act(async () => Promise.resolve());
    expect(location()).toBe('/?date=2026-09-29');
    expect(mode()).toBe('selected 2026-09-29');
  });

  it('keeps a date chosen in the app, including after Back and Forward', async () => {
    const user = userEvent.setup();
    renderMode('/', '/', 'navigate');
    expect(mode()).toBe('live');
    await user.click(screen.getByRole('link', { name: 'Next day' }));
    expect(mode()).toBe('selected 2026-09-29');
    await user.click(screen.getByRole('link', { name: 'Plan' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(location()).toBe('/?date=2026-09-29');
    expect(mode()).toBe('selected 2026-09-29');
    await user.click(screen.getByRole('button', { name: 'Back' }));
    expect(mode()).toBe('live');
    await user.click(screen.getByRole('button', { name: 'Forward' }));
    expect(location()).toBe('/?date=2026-09-29');
    expect(mode()).toBe('selected 2026-09-29');
  });

  it('reports an unreadable date chosen in the app as invalid, without changing the URL', () => {
    renderMode('/?date=nope', '/', 'navigate');
    expect(mode()).toBe('invalid');
    expect(location()).toBe('/?date=nope');
  });
});
