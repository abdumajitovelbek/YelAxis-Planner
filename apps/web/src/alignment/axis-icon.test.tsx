// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';

import { cleanup, fireEvent, render } from '@testing-library/react';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { axisIconPattern } from '@yelaxis/domain';

import { AxisIcon, axisInitial } from './axis-icon';
import { axisIconEntry, axisIconLabel, axisIcons } from './axis-icons';

afterEach(cleanup);

// jsdom replaces the global URL, so resolve the public folder from this file's path instead.
const publicFolder = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'public');

describe('Axis icon catalog', () => {
  it('names every icon the way the domain stores it, with artwork in the public icon folder', () => {
    expect(axisIcons.length).toBeGreaterThan(0);
    for (const entry of axisIcons) {
      expect(entry.name).toMatch(axisIconPattern);
      expect(entry.src).toMatch(/^\/icons\/axis\/[a-z0-9-]+\.png$/u);
      expect(existsSync(join(publicFolder, entry.src))).toBe(true);
    }
    expect(new Set(axisIcons.map((entry) => entry.name)).size).toBe(axisIcons.length);
  });

  it('describes the icon in words', () => {
    expect(axisIconLabel(undefined)).toBe('No icon');
    expect(axisIconLabel('standard')).toBe('Standard');
    expect(axisIconLabel('leaf')).toBe('An icon this version cannot show');
    expect(axisIconEntry('leaf')).toBeUndefined();
  });
});

describe('AxisIcon', () => {
  it('shows a known icon as a decorative picture', () => {
    const { container } = render(<AxisIcon icon="standard" title="Health" />);
    const image = container.querySelector('img');
    expect(image).toHaveAttribute('src', '/icons/axis/standard.png');
    expect(image).toHaveAttribute('alt', '');
    expect(image).toHaveAttribute('data-axis-icon', 'standard');
  });

  it('falls back to the Axis initial without an icon or with an unknown one', () => {
    for (const icon of [undefined, 'leaf']) {
      const { container, unmount } = render(<AxisIcon icon={icon} title="  health" />);
      const fallback = container.querySelector('[data-axis-icon="none"]');
      expect(fallback).toHaveTextContent('H');
      expect(fallback).toHaveAttribute('aria-hidden', 'true');
      expect(container.querySelector('img')).toBeNull();
      unmount();
    }
  });

  it('falls back to the initial when the picture cannot load', () => {
    const { container } = render(<AxisIcon icon="standard" title="Craft" size="large" />);
    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    fireEvent.error(image as HTMLImageElement);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('[data-axis-icon="none"]')).toHaveTextContent('C');
    expect(container.querySelector('.axis-icon-large')).not.toBeNull();
  });

  it('uses the first character of the title, whatever the script', () => {
    expect(axisInitial('élan')).toBe('É');
    expect(axisInitial('   ')).toBe('·');
    expect(axisInitial('🌱 garden')).toBe('🌱');
  });
});
