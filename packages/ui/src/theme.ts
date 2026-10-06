import {
  colorTokens,
  elevationTokens,
  layoutTokens,
  motionTokens,
  radiusTokens,
  spacingTokens,
  typographyTokens,
  type SemanticColorTokens,
} from './tokens';

export type ThemeName = 'dark' | 'light';
export type ThemePreference = ThemeName | 'system';

export interface Theme {
  readonly name: ThemeName;
  readonly colors: SemanticColorTokens;
  readonly spacing: typeof spacingTokens;
  readonly layout: typeof layoutTokens;
  readonly radius: typeof radiusTokens;
  readonly typography: typeof typographyTokens;
  readonly elevation: typeof elevationTokens;
  readonly motion: typeof motionTokens;
}

export const themes = {
  dark: {
    name: 'dark',
    colors: colorTokens.dark,
    spacing: spacingTokens,
    layout: layoutTokens,
    radius: radiusTokens,
    typography: typographyTokens,
    elevation: elevationTokens,
    motion: motionTokens,
  },
  light: {
    name: 'light',
    colors: colorTokens.light,
    spacing: spacingTokens,
    layout: layoutTokens,
    radius: radiusTokens,
    typography: typographyTokens,
    elevation: elevationTokens,
    motion: motionTokens,
  },
} as const satisfies Readonly<Record<ThemeName, Theme>>;

export function resolveThemeName(
  preference: ThemePreference,
  systemTheme: ThemeName | null | undefined,
): ThemeName {
  if (preference !== 'system') {
    return preference;
  }

  return systemTheme ?? 'dark';
}

export function resolveTheme(
  preference: ThemePreference,
  systemTheme: ThemeName | null | undefined,
): Theme {
  return themes[resolveThemeName(preference, systemTheme)];
}
