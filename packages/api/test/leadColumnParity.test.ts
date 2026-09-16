import { readFileSync } from 'fs';
import { join } from 'path';
import { LEAD_EXPORT_COLUMNS } from '../src/utils/leadColumns';

/**
 * The browser cannot import the API module (it carries node's crypto and the SQL text),
 * so it keeps a mirror in packages/web/src/lib/leadColumns.ts. Two hand-written lists is
 * exactly what let the export drift from the query in the first place, so the drift is
 * asserted instead of trusted.
 */
describe('web/API column registry parity', () => {
  const webSrc = readFileSync(join(__dirname, '../../web/src/lib/leadColumns.ts'), 'utf8');
  const webHeaders = [...webSrc.matchAll(/\{\s*header:\s*'([^']+)'/g)].map((m) => m[1]);
  const webFields = [...webSrc.matchAll(/field:\s*'([^']+)'/g)].map((m) => m[1]);

  test('web mirror is not empty (regex broke?)', () => {
    expect(webHeaders.length).toBeGreaterThan(30);
  });

  test('same headers in the same order', () => {
    expect(webHeaders).toEqual(LEAD_EXPORT_COLUMNS.map((c) => c.header));
  });

  test('same canonical fields', () => {
    expect(webFields).toEqual(LEAD_EXPORT_COLUMNS.map((c) => c.field));
  });
});
