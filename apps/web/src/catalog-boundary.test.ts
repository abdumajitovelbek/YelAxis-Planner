import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import {
  getMessagePlaceholders,
  interpolateMessage,
  pseudoLocalize,
  webMessages,
} from '@yelaxis/i18n';

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(directory, entry.name);
      return entry.isDirectory() ? sourceFiles(path) : [path];
    })
    .filter(
      (path) => /\.tsx?$/u.test(path) && !path.includes('.test.') && !path.includes('__fixtures__'),
    );
}

describe('manual presentation catalog boundary', () => {
  it('keeps visible JSX prose and accessibility labels in the typed catalog', () => {
    const failures: string[] = [];
    for (const path of sourceFiles(new URL('.', import.meta.url).pathname)) {
      const source = ts.createSourceFile(
        path,
        readFileSync(path, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
        path.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const visit = (node: ts.Node): void => {
        const visibleText = ts.isJsxText(node) && /[A-Za-z]{2}/u.test(node.text);
        const visibleAttribute =
          ts.isJsxAttribute(node) &&
          ['aria-label', 'title', 'placeholder', 'alt'].includes(node.name.getText(source)) &&
          node.initializer !== undefined &&
          ts.isStringLiteral(node.initializer) &&
          /[A-Za-z]{2}/u.test(node.initializer.text);
        if (visibleText || visibleAttribute)
          failures.push(
            `${path}:${source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1}`,
          );
        if (ts.isCallExpression(node) && node.expression.getText(source) === 'uiMessage') {
          const id = node.arguments[0];
          if (id !== undefined && ts.isStringLiteral(id) && !(id.text in webMessages))
            failures.push(`${path}: unknown catalog id ${id.text}`);
        }
        ts.forEachChild(node, visit);
      };
      visit(source);
    }
    expect(failures).toEqual([]);
  });

  it('preserves every interpolation through expanded pseudo copy without transforming user prose', () => {
    for (const source of Object.values(webMessages)) {
      const placeholders = getMessagePlaceholders(source);
      expect(getMessagePlaceholders(pseudoLocalize(source))).toEqual(placeholders);
      const values = Object.fromEntries(placeholders.map((key) => [key, 'Synthetic نور 日本語']));
      const result = interpolateMessage(pseudoLocalize(source), values);
      if (placeholders.length > 0) expect(result).toContain('Synthetic نور 日本語');
    }
  });
});
