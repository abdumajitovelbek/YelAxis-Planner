import { message as uiMessage } from '../messages';
import { useState, type ReactNode } from 'react';

import { axisIconEntry } from './axis-icons';

/** First letter of the title, for the fallback badge. */
export function axisInitial(title: string): string {
  const [first] = Array.from(title.trim());
  return first === undefined ? '·' : first.toLocaleUpperCase();
}

/**
 * Decorative Axis icon. It shows the chosen picture when the name is known and the image loads;
 * otherwise (no icon, a name this version does not know, or a failed load) it shows the Axis
 * initial. Either way it is hidden from assistive technology because the name is always shown.
 */
export function AxisIcon({
  icon,
  size = 'small',
  title,
}: {
  readonly icon?: string | undefined;
  readonly size?: 'small' | 'large';
  readonly title: string;
}): ReactNode {
  const entry = axisIconEntry(icon);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);
  const className = uiMessage('alignment.axis-icon.443', { value0: size });
  if (entry !== undefined && failedSrc !== entry.src) {
    return (
      <img
        className={className}
        src={entry.src}
        alt={''}
        data-axis-icon={entry.name}
        decoding="async"
        onError={() => setFailedSrc(entry.src)}
      />
    );
  }
  return (
    <span className={`${className} axis-icon-fallback`} aria-hidden="true" data-axis-icon="none">
      {axisInitial(title)}
    </span>
  );
}
