export type HexColor = `#${string}`;

export interface SemanticColorTokens {
  readonly background: {
    readonly base: HexColor;
    readonly raised: HexColor;
  };
  readonly surface: {
    readonly subtle: HexColor;
  };
  readonly text: {
    readonly primary: HexColor;
    readonly secondary: HexColor;
  };
  readonly accent: {
    readonly cyan: HexColor;
    readonly violet: HexColor;
  };
  readonly state: {
    readonly success: HexColor;
    readonly warning: HexColor;
    readonly danger: HexColor;
  };
  readonly control: {
    readonly primaryBackground: HexColor;
    readonly primaryForeground: HexColor;
    readonly focusRing: HexColor;
  };
}

export const colorTokens = {
  dark: {
    background: {
      base: '#06111C',
      raised: '#0B1726',
    },
    surface: {
      subtle: '#10263A',
    },
    text: {
      primary: '#F5F8FB',
      secondary: '#9DB0C2',
    },
    accent: {
      cyan: '#2CCFF3',
      violet: '#806BFF',
    },
    state: {
      success: '#39C98A',
      warning: '#E9A93F',
      danger: '#D65D6B',
    },
    control: {
      primaryBackground: '#2CCFF3',
      primaryForeground: '#06111C',
      focusRing: '#2CCFF3',
    },
  },
  light: {
    background: {
      base: '#F6F9FC',
      raised: '#FFFFFF',
    },
    surface: {
      subtle: '#EEF3F8',
    },
    text: {
      primary: '#172235',
      secondary: '#63718A',
    },
    accent: {
      cyan: '#0B91AC',
      violet: '#6754DB',
    },
    state: {
      success: '#167B55',
      warning: '#966216',
      danger: '#A83848',
    },
    control: {
      // The specification allows a high-contrast neutral primary button.
      primaryBackground: '#172235',
      primaryForeground: '#FFFFFF',
      focusRing: '#0B91AC',
    },
  },
} as const satisfies Readonly<Record<'dark' | 'light', SemanticColorTokens>>;

export const spacingTokens = {
  xs: 4,
  sm: 8,
  md: 12,
  lg: 16,
  xl: 24,
  xxl: 32,
} as const;

export const layoutTokens = {
  screenGutter: spacingTokens.lg,
  minimumTouchTarget: 44,
} as const;

export const radiusTokens = {
  compact: 8,
  control: 12,
  card: 18,
  sheet: 26,
} as const;

export type FontFamilyRole = 'sans' | 'mono';
export type FontWeight = '400' | '500' | '600' | '700';

export interface TypographyToken {
  readonly family: FontFamilyRole;
  readonly fontSize: number;
  readonly lineHeight: number;
  readonly fontWeight: FontWeight;
  readonly letterSpacing: number;
  readonly scalesWithUserSettings: true;
}

export const typographyTokens = {
  display: {
    family: 'sans',
    fontSize: 32,
    lineHeight: 40,
    fontWeight: '700',
    letterSpacing: -0.4,
    scalesWithUserSettings: true,
  },
  title: {
    family: 'sans',
    fontSize: 24,
    lineHeight: 32,
    fontWeight: '700',
    letterSpacing: -0.2,
    scalesWithUserSettings: true,
  },
  heading: {
    family: 'sans',
    fontSize: 20,
    lineHeight: 28,
    fontWeight: '600',
    letterSpacing: 0,
    scalesWithUserSettings: true,
  },
  body: {
    family: 'sans',
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '400',
    letterSpacing: 0,
    scalesWithUserSettings: true,
  },
  bodyStrong: {
    family: 'sans',
    fontSize: 16,
    lineHeight: 24,
    fontWeight: '600',
    letterSpacing: 0,
    scalesWithUserSettings: true,
  },
  label: {
    family: 'sans',
    fontSize: 14,
    lineHeight: 20,
    fontWeight: '600',
    letterSpacing: 0.1,
    scalesWithUserSettings: true,
  },
  caption: {
    family: 'sans',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '500',
    letterSpacing: 0.2,
    scalesWithUserSettings: true,
  },
  technicalLabel: {
    family: 'mono',
    fontSize: 12,
    lineHeight: 18,
    fontWeight: '500',
    letterSpacing: 0.3,
    scalesWithUserSettings: true,
  },
} as const satisfies Readonly<Record<string, TypographyToken>>;

export interface ElevationToken {
  readonly level: number;
  readonly shadowOpacity: number;
  readonly shadowRadius: number;
  readonly shadowOffsetY: number;
}

export const elevationTokens = {
  none: {
    level: 0,
    shadowOpacity: 0,
    shadowRadius: 0,
    shadowOffsetY: 0,
  },
  raised: {
    level: 1,
    shadowOpacity: 0.12,
    shadowRadius: 4,
    shadowOffsetY: 1,
  },
  sheet: {
    level: 4,
    shadowOpacity: 0.18,
    shadowRadius: 12,
    shadowOffsetY: 4,
  },
  drag: {
    level: 6,
    shadowOpacity: 0.22,
    shadowRadius: 16,
    shadowOffsetY: 6,
  },
} as const satisfies Readonly<Record<string, ElevationToken>>;

export const motionTokens = {
  durationMs: {
    instant: 0,
    reduced: 80,
    tab: 150,
    horizon: 210,
    completion: 200,
    feedback: 160,
  },
  budgetMs: {
    tab: { minimum: 120, maximum: 180 },
    horizon: { minimum: 180, maximum: 240 },
    completion: { maximum: 220 },
  },
  distancePx: {
    tab: 6,
    reduced: 0,
  },
  spring: {
    capture: {
      damping: 22,
      stiffness: 240,
      mass: 1,
    },
  },
} as const;
