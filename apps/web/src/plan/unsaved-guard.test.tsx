// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, useState, type ReactNode } from 'react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

import { installDialogPolyfill, LocationProbe } from './__fixtures__/c1-planning-fake';
import { NavigationGuardProvider, useGuardedNavigate, useUnsavedGuard } from './unsaved-guard';

beforeAll(() => installDialogPolyfill());
afterEach(() => cleanup());

/** A minimal editor: saving blank text fails validation next to the field, like ThemeEditor. */
function Editor(): ReactNode {
  const [value, setValue] = useState('Calm weeks');
  const [error, setError] = useState<string | null>(null);
  const field = useRef<HTMLInputElement>(null);
  const save = (): Promise<boolean> => {
    if (value.trim() === '') {
      setError('Write a theme, or use Cancel to keep things as they are.');
      field.current?.focus();
      return Promise.resolve(false);
    }
    setError(null);
    return Promise.resolve(true);
  };
  const { dialog } = useUnsavedGuard(value !== 'Calm weeks', save);
  return (
    <>
      <Link to="/elsewhere">Leave</Link>
      {error !== null && <p role="alert">{error}</p>}
      <label>
        Theme
        <input
          ref={field}
          value={value}
          aria-invalid={error !== null}
          onChange={(event) => setValue(event.target.value)}
        />
      </label>
      {dialog}
    </>
  );
}

function GoButton(): ReactNode {
  const navigate = useGuardedNavigate();
  return (
    <button type="button" onClick={() => navigate('/elsewhere')}>
      Go elsewhere
    </button>
  );
}

function renderEditor(): void {
  render(
    <MemoryRouter initialEntries={['/editor']}>
      <NavigationGuardProvider>
        <GoButton />
        <Routes>
          <Route path="/editor" element={<Editor />} />
          <Route path="*" element={<p>Elsewhere</p>} />
        </Routes>
      </NavigationGuardProvider>
      <LocationProbe />
    </MemoryRouter>,
  );
}

describe('Unsaved-change guard', () => {
  it('closes the dialog and focuses the field when Save fails validation', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.clear(screen.getByLabelText('Theme'));
    await user.click(screen.getByRole('link', { name: 'Leave' }));
    await user.click(await screen.findByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(
        screen.queryByRole('dialog', { name: 'Save your changes before leaving?' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('Write a theme');
    await waitFor(() => expect(screen.getByLabelText('Theme')).toHaveFocus());
    expect(screen.getByTestId('location')).toHaveTextContent('/editor');
  });

  it('routes programmatic navigation through the dirty editor', async () => {
    const user = userEvent.setup();
    renderEditor();
    await user.type(screen.getByLabelText('Theme'), ' ahead');
    await user.click(screen.getByRole('button', { name: 'Go elsewhere' }));
    expect(
      await screen.findByRole('dialog', { name: 'Save your changes before leaving?' }),
    ).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent('/editor');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Elsewhere')).toBeVisible();
    expect(screen.getByTestId('location')).toHaveTextContent('/elsewhere');
  });
});
