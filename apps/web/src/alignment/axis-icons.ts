/**
 * The Axis icons offered by the Axis form. An Axis stores only the icon name, and
 * the Axis is always shown by name, so icons are decorative.
 *
 * - To change the artwork, replace the file under `apps/web/public/icons/axis/` (any square PNG;
 * 192 px is enough). The service worker precaches every PNG in that folder.
 * - To offer another icon, add its file there and an entry here. Names must match the domain's
 * `axisIconPattern` (a lowercase letter, then lowercase letters, digits, or hyphens).
 */
export interface AxisIconEntry {
  readonly name: string;
  readonly label: string;
  readonly src: string;
}

export const axisIcons: readonly AxisIconEntry[] = [
  { name: 'standard', label: 'Standard', src: '/icons/axis/standard.png' },
];

export function axisIconEntry(name: string | undefined): AxisIconEntry | undefined {
  return name === undefined ? undefined : axisIcons.find((entry) => entry.name === name);
}

/** The icon in words, for places that also show the picture. */
export function axisIconLabel(name: string | undefined): string {
  if (name === undefined) return 'No icon';
  return axisIconEntry(name)?.label ?? 'An icon this version cannot show';
}
