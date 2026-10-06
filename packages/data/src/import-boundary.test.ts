import { executeCommand } from '@yelaxis/application';
import { parseUUID } from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

import * as dataRoot from './index';

describe('data package import boundary', () => {
  it('resolves only its approved inner workspace dependencies', () => {
    expect(typeof executeCommand).toBe('function');
    expect(typeof parseUUID).toBe('function');
  });

  it('keeps runtime-specific browser and Node drivers out of the portable root', () => {
    expect('BrowserSqliteDriver' in dataRoot).toBe(false);
    expect('NodeSqliteDriver' in dataRoot).toBe(false);
  });
});
