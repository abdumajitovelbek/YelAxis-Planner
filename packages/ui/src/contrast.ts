import type { HexColor } from './tokens';

export type ContrastUse = 'normalText' | 'largeText' | 'nonText';

const contrastThresholds = {
  normalText: 4.5,
  largeText: 3,
  nonText: 3,
} as const satisfies Readonly<Record<ContrastUse, number>>;

function colorChannels(color: HexColor): readonly [number, number, number] {
  const match = /^#([0-9A-F]{2})([0-9A-F]{2})([0-9A-F]{2})$/i.exec(color);
  if (match === null) {
    throw new RangeError(`Expected a six-digit hexadecimal color, received ${color}.`);
  }

  return [
    Number.parseInt(match[1]!, 16),
    Number.parseInt(match[2]!, 16),
    Number.parseInt(match[3]!, 16),
  ];
}

function linearize(channel: number): number {
  const normalized = channel / 255;
  return normalized <= 0.04045 ? normalized / 12.92 : ((normalized + 0.055) / 1.055) ** 2.4;
}

export function relativeLuminance(color: HexColor): number {
  const [red, green, blue] = colorChannels(color);
  return 0.2126 * linearize(red) + 0.7152 * linearize(green) + 0.0722 * linearize(blue);
}

export function contrastRatio(foreground: HexColor, background: HexColor): number {
  const foregroundLuminance = relativeLuminance(foreground);
  const backgroundLuminance = relativeLuminance(background);
  const lighter = Math.max(foregroundLuminance, backgroundLuminance);
  const darker = Math.min(foregroundLuminance, backgroundLuminance);
  return (lighter + 0.05) / (darker + 0.05);
}

export function meetsWcagAaContrast(
  foreground: HexColor,
  background: HexColor,
  use: ContrastUse,
): boolean {
  return contrastRatio(foreground, background) >= contrastThresholds[use];
}
