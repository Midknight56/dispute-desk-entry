import { describe, expect, it } from 'vitest';
// @ts-expect-error The root TypeScript project excludes TSX while Vitest can import it.
import { disputeGridColumns, formatDeadline } from '../web/src/components/DisputeGrid';

describe('dispute grid layout', () => {
  it('sizes columns for their longest visible values', () => {
    const columns = disputeGridColumns(new Set(), []);
    const widths: Array<{ headerName?: string; width?: number; minWidth?: number; flex?: number }> = columns;
    expect(widths.map((column) => column.minWidth)).toEqual([72, 160, 140, 76, 72, 124, 78]);
    expect(widths.every((column) => column.flex || column.width === column.minWidth)).toBe(true);
    expect(widths.filter((column) => column.flex).map((column) => column.headerName)).toEqual(['Reason']);
    expect(widths.find((column) => column.headerName === 'Proof')).toBeDefined();
    expect(widths.reduce((total, column) => total + (column.minWidth ?? 0), 0)).toBe(722);
  });

  it('formats compact deadlines for the grid', () => {
    const now = Date.parse('2026-10-23T12:00:00Z');
    expect(formatDeadline('2026-10-25T16:00:00Z', now)).toBe('2d 4h');
    expect(formatDeadline('2026-10-23T15:00:00Z', now)).toBe('3h');
    expect(formatDeadline('2026-10-23T11:59:00Z', now)).toBe('Late');
    expect(formatDeadline(null, now)).toBe('-');
  });
});
