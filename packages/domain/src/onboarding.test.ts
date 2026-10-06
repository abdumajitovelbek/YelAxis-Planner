import { describe, expect, it } from 'vitest';

import {
  emptyOnboardingDraft,
  validateOnboardingDraft,
  validateOnboardingStep,
} from './onboarding.js';

describe('onboarding rules', () => {
  it.each([
    null,
    { ...emptyOnboardingDraft(), ownerId: 'unexpected' },
    { ...emptyOnboardingDraft(), identity: { preferredName: 42, locale: '' } },
    { ...emptyOnboardingDraft(), axes: 'unexpected' },
    { ...emptyOnboardingDraft(), week: { commitments: [], actionTitle: 42 } },
  ])('rejects malformed runtime drafts even at welcome (%#)', (input) => {
    expect(
      validateOnboardingStep('welcome', input as Parameters<typeof validateOnboardingStep>[1]),
    ).toMatchObject({ ok: false });
  });
  const validDefaults = {
    planningTimeZone: 'Asia/Tashkent',
    weekStart: 'sunday' as const,
    timeFormat: '12_hour' as const,
    locale: 'uz-Latn-UZ',
  };

  it('retains later canonical Outcome prose on rerun but rejects it when submitting the Outcome step', () => {
    const retained = {
      ...emptyOnboardingDraft(),
      defaults: validDefaults,
      outcome: { title: 'Synthetic retained outcome', successDefinition: 'x'.repeat(600) },
      week: { actionTitle: 'Synthetic action', commitments: [] },
    };
    for (const step of ['welcome', 'defaults', 'context', 'axes'] as const) {
      expect(validateOnboardingStep(step, retained)).toMatchObject({ ok: true });
    }
    expect(validateOnboardingStep('outcome', retained)).toMatchObject({ ok: false });
    expect(validateOnboardingDraft(retained)).toMatchObject({ ok: false });
  });

  it('accepts deterministic non-default planning defaults', () => {
    const result = validateOnboardingStep('defaults', {
      ...emptyOnboardingDraft(),
      defaults: validDefaults,
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.defaults).toEqual(validDefaults);
  });

  it('rejects invalid zones, wall-time windows, and unconfirmed fixed commitments', () => {
    const draft = {
      ...emptyOnboardingDraft(),
      defaults: { ...validDefaults, planningTimeZone: 'UTC+5' },
      context: { awakeWindow: { start: '23:00', end: '07:00' } },
      week: {
        actionTitle: 'Prepare the outline',
        commitments: [
          {
            title: 'Studio session',
            date: '2026-08-06',
            start: '09:00',
            end: '10:00',
            strength: 'hard' as const,
            confirmed: false,
          },
        ],
      },
    };

    expect(validateOnboardingStep('defaults', draft).ok).toBe(false);
    expect(validateOnboardingStep('context', draft).ok).toBe(false);
    expect(validateOnboardingStep('week', draft).ok).toBe(false);
  });

  it('rejects unrecognized Context, Commitment, and retained time-zone values', () => {
    const base = { ...emptyOnboardingDraft(), defaults: validDefaults };
    expect(
      validateOnboardingStep('context', {
        ...base,
        context: { boundary: { text: 'Synthetic boundary', strength: 'invalid' as 'hard' } },
      }).ok,
    ).toBe(false);
    expect(
      validateOnboardingStep('week', {
        ...base,
        week: {
          actionTitle: 'Prepare the outline',
          commitments: [
            {
              title: 'Studio session',
              date: '2026-08-06',
              start: '09:00',
              end: '10:00',
              strength: 'invalid' as 'hard',
              confirmed: true,
              timeZone: 'UTC+5',
            },
          ],
        },
      }).ok,
    ).toBe(false);
  });

  it('trims starter Axes and rejects duplicates, blanks, long names, and more than three', () => {
    const base = { ...emptyOnboardingDraft(), defaults: validDefaults };
    const accepted = validateOnboardingStep('axes', {
      ...base,
      axes: [' Study ', 'Health'],
    });
    expect(accepted.ok && accepted.value.axes).toEqual(['Study', 'Health']);

    for (const axes of [
      ['Study', ' study '],
      ['   '],
      ['a'.repeat(81)],
      ['One', 'Two', 'Three', 'Four'],
    ]) {
      expect(validateOnboardingStep('axes', { ...base, axes }).ok).toBe(false);
    }
  });

  it('requires explicit success language when an Outcome is supplied and validates its Axis link', () => {
    const base = {
      ...emptyOnboardingDraft(),
      defaults: validDefaults,
      axes: ['Career'],
    };
    expect(
      validateOnboardingStep('outcome', {
        ...base,
        outcome: { title: 'Release the beta', successDefinition: '', axisIndex: 0 },
      }).ok,
    ).toBe(false);
    expect(
      validateOnboardingStep('outcome', {
        ...base,
        outcome: {
          title: 'Release the beta',
          successDefinition: 'A tester can finish the setup without help.',
          axisIndex: 2,
        },
      }).ok,
    ).toBe(false);
  });

  it('permits every optional section to stay unknown while requiring one concrete Action', () => {
    const draft = {
      ...emptyOnboardingDraft(),
      defaults: validDefaults,
      week: { commitments: [], actionTitle: 'Draft the first page' },
    };
    expect(validateOnboardingDraft(draft).ok).toBe(true);
    expect(
      validateOnboardingDraft({ ...draft, week: { commitments: [], actionTitle: '  ' } }).ok,
    ).toBe(false);
  });
});
