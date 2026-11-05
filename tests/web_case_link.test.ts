import { describe, expect, it } from 'vitest';
// @ts-expect-error The root TypeScript project excludes TSX while Vitest can import it.
import { readCaseId } from '../web/src/App';

describe('case deep links', () => {
  const knownIds = ['PP-R-AYP-10194173', 'PP-R-ERC-10194174'];

  it('reads a known case id from the query string', () => {
    expect(readCaseId('?case=PP-R-AYP-10194173', knownIds)).toBe('PP-R-AYP-10194173');
    expect(readCaseId('?other=value&case=PP-R-ERC-10194174', knownIds)).toBe('PP-R-ERC-10194174');
  });

  it('ignores missing and unknown case ids', () => {
    expect(readCaseId('', knownIds)).toBeNull();
    expect(readCaseId('?case=unknown', knownIds)).toBeNull();
  });
});
