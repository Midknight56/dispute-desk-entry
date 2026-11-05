import { describe, expect, it } from 'vitest';
// @ts-expect-error The root TypeScript project excludes TSX while Vitest can import it.
import { leaveGridOnTab, opensCaseOnRowKey } from '../web/src/components/DisputeGrid';

describe('dispute grid keyboard behavior', () => {
  it('hands Tab navigation back to the browser', () => {
    expect(leaveGridOnTab()).toBe(false);
  });

  it('opens a case when its row is activated with Enter or Space', () => {
    expect(opensCaseOnRowKey('Enter')).toBe(true);
    expect(opensCaseOnRowKey(' ')).toBe(true);
    expect(opensCaseOnRowKey('ArrowDown')).toBe(false);
    expect(opensCaseOnRowKey('Tab')).toBe(false);
  });
});
