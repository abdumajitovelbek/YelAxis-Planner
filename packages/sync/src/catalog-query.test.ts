import { describe, expect, it } from 'vitest';
import { catalogQueryArguments, parseCatalogRows } from './testing/catalog-query';

describe('local catalog query protocol', () => {
  it('selects explicit query JSON and disables ambient CLI agent detection', () => {
    expect(catalogQueryArguments('/synthetic-stack', 'SELECT 1')).toEqual([
      'db',
      'query',
      '--local',
      '--workdir',
      '/synthetic-stack',
      '--output-format',
      'json',
      '--agent',
      'no',
      'SELECT 1',
    ]);
  });

  it('preserves typed catalog rows and a genuine empty result', () => {
    const rows = [{ rls: true, count: 3, name: 'synthetic', value: null }];
    expect(parseCatalogRows(JSON.stringify({ rows }))).toEqual(rows);
    expect(parseCatalogRows('{"rows":[]}')).toEqual([]);
  });

  it('rejects malformed or status-shaped output without echoing its contents', () => {
    for (const output of [
      'synthetic private material',
      '{"data":[]}',
      '{"rows":[null]}',
      '{"rows":[1]}',
      '{"rows":[[]]}',
    ])
      expect(() => parseCatalogRows(output)).toThrow(
        'The local catalog query returned an unsupported result format.',
      );
  });
});
