// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { saveFile } from '../account/download';
import { DiagnosticsPanel } from './diagnostics-panel';

vi.mock('../account/download', () => ({ saveFile: vi.fn() }));
afterEach(cleanup);
beforeEach(() => {
  vi.mocked(saveFile).mockReset();
});

describe('deliberate previewed support download', () => {
  it('does not collect/download automatically and restores focus after cancel', () => {
    render(<DiagnosticsPanel />);
    expect(screen.queryByRole('button', { name: 'Download support information' })).toBeNull();
    expect(saveFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Preview support information' }));
    expect(document.activeElement?.tagName).toBe('PRE');
    expect(screen.getByText(/"schemaVersion"/)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: 'Close preview' }));
    expect(screen.getByRole('button', { name: 'Preview support information' })).toHaveFocus();
    expect(saveFile).not.toHaveBeenCalled();
  });
  it('downloads only on the second explicit gesture and makes no save-success claim', () => {
    render(<DiagnosticsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview support information' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download support information' }));
    expect(saveFile).toHaveBeenCalledTimes(1);
    const file = vi.mocked(saveFile).mock.calls[0]?.[0];
    expect(file?.fileName).toBe('yelaxis-support.json');
    expect(file?.blob).toBeInstanceOf(Blob);
    expect(screen.getByRole('status')).toHaveTextContent('Confirm that it saved');
  });
  it('never echoes a browser exception and leaves preview available to retry', () => {
    vi.mocked(saveFile).mockImplementation(() => {
      throw new Error('synthetic-private-error');
    });
    render(<DiagnosticsPanel />);
    fireEvent.click(screen.getByRole('button', { name: 'Preview support information' }));
    fireEvent.click(screen.getByRole('button', { name: 'Download support information' }));
    expect(screen.getByRole('status')).toHaveTextContent('Your plan is unchanged');
    expect(screen.queryByText('synthetic-private-error')).toBeNull();
    expect(screen.getByRole('button', { name: 'Download support information' })).toBeEnabled();
  });
});
