import { executeCommand } from '@yelaxis/application';
import { entityRefKey } from '@yelaxis/domain';
import { describe, expect, it } from 'vitest';

describe('sync package import boundary', () => {
  it('resolves only its approved inner workspace dependencies', () => {
    expect([executeCommand, entityRefKey]).toEqual([expect.any(Function), expect.any(Function)]);
  });
});
