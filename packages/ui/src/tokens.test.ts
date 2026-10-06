import { describe, expect, it } from 'vitest';

import { auditAccessibleControl, meetsMinimumTouchTarget, requiredHitSlop } from './accessibility';
import { contrastRatio, meetsWcagAaContrast } from './contrast';
import { resolveMotionMode, resolveMotionPlan } from './motion';
import { resolveTheme, resolveThemeName, themes } from './theme';
import {
  colorTokens,
  elevationTokens,
  layoutTokens,
  motionTokens,
  radiusTokens,
  spacingTokens,
  typographyTokens,
} from './tokens';

describe('design tokens', () => {
  it('preserves the approved dark and light semantic palette', () => {
    expect(colorTokens.dark).toMatchObject({
      background: { base: '#06111C', raised: '#0B1726' },
      surface: { subtle: '#10263A' },
      text: { primary: '#F5F8FB', secondary: '#9DB0C2' },
      accent: { cyan: '#2CCFF3', violet: '#806BFF' },
      state: { success: '#39C98A', warning: '#E9A93F', danger: '#D65D6B' },
    });
    expect(colorTokens.light).toMatchObject({
      background: { base: '#F6F9FC', raised: '#FFFFFF' },
      surface: { subtle: '#EEF3F8' },
      text: { primary: '#172235', secondary: '#63718A' },
      accent: { cyan: '#0B91AC', violet: '#6754DB' },
      state: { success: '#167B55', warning: '#966216', danger: '#A83848' },
    });
  });

  it('preserves the spacing, radius, touch, and motion budgets', () => {
    expect(Object.values(spacingTokens)).toEqual([4, 8, 12, 16, 24, 32]);
    expect(Object.values(radiusTokens)).toEqual([8, 12, 18, 26]);
    expect(layoutTokens).toEqual({ screenGutter: 16, minimumTouchTarget: 44 });
    expect(motionTokens.durationMs.tab).toBeGreaterThanOrEqual(motionTokens.budgetMs.tab.minimum);
    expect(motionTokens.durationMs.tab).toBeLessThanOrEqual(motionTokens.budgetMs.tab.maximum);
    expect(motionTokens.durationMs.horizon).toBeGreaterThanOrEqual(
      motionTokens.budgetMs.horizon.minimum,
    );
    expect(motionTokens.durationMs.horizon).toBeLessThanOrEqual(
      motionTokens.budgetMs.horizon.maximum,
    );
    expect(motionTokens.durationMs.completion).toBeLessThanOrEqual(
      motionTokens.budgetMs.completion.maximum,
    );
  });

  it('keeps typography scalable and elevation restrained', () => {
    expect(Object.values(typographyTokens).every((token) => token.scalesWithUserSettings)).toBe(
      true,
    );
    expect(typographyTokens.technicalLabel.family).toBe('mono');
    expect(typographyTokens.body.family).toBe('sans');
    expect(elevationTokens.none.level).toBe(0);
    expect(elevationTokens.raised.level).toBeLessThan(elevationTokens.sheet.level);
    expect(elevationTokens.sheet.level).toBeLessThan(elevationTokens.drag.level);
  });
});

describe('theme contrast and resolution', () => {
  it.each(['dark', 'light'] as const)(
    '%s theme body and state text meet normal-text AA',
    (name) => {
      const { colors } = themes[name];
      expect(meetsWcagAaContrast(colors.text.primary, colors.background.base, 'normalText')).toBe(
        true,
      );
      expect(meetsWcagAaContrast(colors.text.secondary, colors.background.base, 'normalText')).toBe(
        true,
      );
      expect(meetsWcagAaContrast(colors.state.success, colors.background.base, 'normalText')).toBe(
        true,
      );
      expect(meetsWcagAaContrast(colors.state.warning, colors.background.base, 'normalText')).toBe(
        true,
      );
      expect(meetsWcagAaContrast(colors.state.danger, colors.background.base, 'normalText')).toBe(
        true,
      );
      expect(
        meetsWcagAaContrast(
          colors.control.primaryForeground,
          colors.control.primaryBackground,
          'normalText',
        ),
      ).toBe(true);
      expect(meetsWcagAaContrast(colors.control.focusRing, colors.background.base, 'nonText')).toBe(
        true,
      );
    },
  );

  it('reserves light cyan for non-text/large emphasis at its specified contrast', () => {
    expect(
      meetsWcagAaContrast(
        colorTokens.light.accent.cyan,
        colorTokens.light.background.base,
        'nonText',
      ),
    ).toBe(true);
    expect(
      contrastRatio(colorTokens.light.accent.cyan, colorTokens.light.background.base),
    ).toBeCloseTo(3.51, 2);
  });

  it('resolves explicit and system themes with a dark fallback', () => {
    expect(resolveThemeName('light', 'dark')).toBe('light');
    expect(resolveThemeName('system', 'light')).toBe('light');
    expect(resolveThemeName('system', null)).toBe('dark');
    expect(resolveTheme('system', 'light')).toBe(themes.light);
  });
});

describe('accessibility helpers', () => {
  it('enforces 44-point targets and computes symmetric hit slop', () => {
    expect(meetsMinimumTouchTarget(44, 44)).toBe(true);
    expect(meetsMinimumTouchTarget(43, 44)).toBe(false);
    expect(requiredHitSlop(24, 32)).toEqual({ top: 6, right: 10, bottom: 6, left: 10 });
  });

  it('reports missing semantics, alternatives, and non-color cues', () => {
    expect(
      auditAccessibleControl({
        label: ' ',
        width: 32,
        height: 32,
        usesGesture: true,
        conveysStateWithColor: true,
      }),
    ).toEqual([
      'missing_label',
      'missing_role',
      'touch_target_too_small',
      'gesture_without_alternative',
      'color_only_state',
    ]);

    expect(
      auditAccessibleControl({
        label: 'Open Today',
        role: 'tab',
        width: 44,
        height: 44,
        usesGesture: true,
        hasVisibleGestureAlternative: true,
        conveysStateWithColor: true,
        hasTextOrIconStateCue: true,
      }),
    ).toEqual([]);
  });
});

describe('motion resolution', () => {
  it('honors system and explicit motion preferences', () => {
    expect(resolveMotionMode('system', true)).toBe('reduced');
    expect(resolveMotionMode('system', false)).toBe('full');
    expect(resolveMotionMode('full', true)).toBe('full');
    expect(resolveMotionMode('reduced', false)).toBe('reduced');
  });

  it('removes translation and bounds opacity feedback under reduced motion', () => {
    expect(
      resolveMotionPlan({
        preference: 'system',
        systemReduceMotion: true,
        kind: 'transition',
        durationMs: motionTokens.durationMs.horizon,
        translatePx: motionTokens.distancePx.tab,
      }),
    ).toEqual({
      mode: 'reduced',
      enabled: true,
      durationMs: 80,
      translatePx: 0,
      usesOpacity: true,
    });
  });

  it('preserves signed directional movement only in full motion mode', () => {
    expect(
      resolveMotionPlan({
        preference: 'full',
        systemReduceMotion: true,
        kind: 'transition',
        durationMs: motionTokens.durationMs.tab,
        translatePx: -motionTokens.distancePx.tab,
      }),
    ).toMatchObject({
      mode: 'full',
      enabled: true,
      translatePx: -6,
    });
  });

  it('stops ambient motion when reduced, backgrounded, or unfocused', () => {
    for (const plan of [
      resolveMotionPlan({
        preference: 'reduced',
        systemReduceMotion: false,
        kind: 'ambient',
        durationMs: 1_000,
      }),
      resolveMotionPlan({
        preference: 'full',
        systemReduceMotion: false,
        kind: 'ambient',
        durationMs: 1_000,
        appActivity: 'background',
      }),
      resolveMotionPlan({
        preference: 'full',
        systemReduceMotion: false,
        kind: 'ambient',
        durationMs: 1_000,
        screenFocused: false,
      }),
    ]) {
      expect(plan.enabled).toBe(false);
      expect(plan.durationMs).toBe(0);
    }
  });
});
