import { describe, expect, it } from 'vitest';
import { firstSelection, showsApprove, sortRows, type JudgeRow } from '../web/src/judge';

const row = (id: string, status: string, kind?: 'fight' | 'accept', replay = false): JudgeRow => ({
  id,
  status,
  stage: 'TEST',
  reason: 'TEST',
  amount: '10.00',
  currency: 'USD',
  due: null,
  custom_id: null,
  updated_at: '',
  kind,
  replay,
});

describe('judge UI logic', () => {
  it('sorts yours first, then open, then settled', () => {
    const rows = [row('settled', 'RESOLVED'), row('open', 'WAITING'), row('mine', 'RESOLVED')];
    expect(sortRows(rows, new Set(['mine'])).map((item) => item.id)).toEqual(['mine', 'open', 'settled']);
  });

  it('selects fight, then accept, then the first open case', () => {
    const rows = [row('accept', 'WAITING', 'accept'), row('fight', 'WAITING', 'fight'), row('other', 'WAITING')];
    expect(firstSelection(rows, new Set(['fight', 'accept']))).toBe('fight');
    expect(firstSelection([rows[0]], new Set(['accept']))).toBe('accept');
    expect(firstSelection([rows[2]], new Set())).toBe('other');
  });

  it('shows approve only for mine or an owner, never for replay', () => {
    const own = row('own', 'WAITING');
    const other = row('other', 'WAITING');
    expect(showsApprove(own, new Set(['own']), null)).toBe(true);
    expect(showsApprove(other, new Set(), 'secret')).toBe(true);
    expect(showsApprove(other, new Set(), null)).toBe(false);
    expect(showsApprove(row('replay', 'WAITING', undefined, true), new Set(['replay']), 'secret')).toBe(false);
  });
});
