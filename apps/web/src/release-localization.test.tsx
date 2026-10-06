// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('./messages', async () => {
  const { interpolateMessage, pseudoLocalize, webMessages } = await import('@yelaxis/i18n');
  return {
    uiLocale: 'ar-XB',
    uiDirection: 'rtl',
    message: (id: keyof typeof webMessages, values?: Record<string, string>) =>
      interpolateMessage(pseudoLocalize(webMessages[id]), values),
  };
});

import {
  fakeAlignment,
  photos,
  renderAlignmentTree,
} from './alignment/__fixtures__/w3-alignment-fixtures';
import { AlignmentPage } from './alignment/alignment-page';
import { message } from './messages';
import { actionsChangedEvent, notifyPlanChanged, planChangedEvent } from './plan/planning-context';
import { alignmentPath } from './plan/routes';
import { emptyRoutineForm } from './plan/routine-form';

afterEach(() => cleanup());

describe('pseudo locale keeps planning protocols unchanged', () => {
  it('transforms only catalog prose, preserving user-authored Unicode interpolation', () => {
    const title = 'Synthetic نور 日本語';
    expect(message('today.end-day.2156', { value0: title })).toContain(title);
    expect(message('app.784')).not.toBe('Search');
  });

  it('keeps native plan and Action event names stable', () => {
    const plan = vi.fn(),
      actions = vi.fn();
    window.addEventListener('yelaxis:plan-changed', plan);
    window.addEventListener('yelaxis:actions-changed', actions);
    try {
      expect(planChangedEvent).toBe('yelaxis:plan-changed');
      expect(actionsChangedEvent).toBe('yelaxis:actions-changed');
      notifyPlanChanged();
      expect(plan).toHaveBeenCalledTimes(1);
      expect(actions).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener('yelaxis:plan-changed', plan);
      window.removeEventListener('yelaxis:actions-changed', actions);
    }
  });

  it('keeps empty canonical drafts and recurrence enums independent of the locale', () => {
    const draft = emptyRoutineForm('2026-10-05');
    expect(draft.title).toBe('');
    expect(draft.description).toBe('');
    expect(draft.note).toBe('');
    expect(draft.pattern).toBe('daily');
    expect(draft.startsOn).toBe('2026-10-05');
    expect(draft.weekdays).toEqual(['monday']);
    expect(draft.zoneKind).toBe('follow_profile');
    expect(draft.reminder).toBe('off');
  });

  it('keeps canonical unassigned Project routes under translated labels', async () => {
    const alignment = fakeAlignment({
      listAxes: vi.fn().mockResolvedValue({ items: [], total: 0 }),
      listUnassigned: vi.fn().mockResolvedValue({
        outcomes: { items: [], total: 0 },
        projects: {
          items: [
            { ...photos, orderKey: '000000001000000000', nextAction: { status: 'not_applicable' } },
          ],
          total: 1,
        },
      }),
    });
    render(
      renderAlignmentTree(<AlignmentPage />, {
        alignment,
        path: '/axis/alignment',
        route: '/axis/alignment',
      }),
    );
    expect(await screen.findByRole('link', { name: photos.title })).toHaveAttribute(
      'href',
      alignmentPath({ kind: 'project', id: photos.id }),
    );
  });
});
