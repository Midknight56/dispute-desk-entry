import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { actionLabel, caseProgress, caseStatus, evidenceText, filedTime, formatDeadline, moneyLine, replyBy, tileValues, type Dispute } from '../web/src/format';
import { defaultTab, firstSelection, pageOfRow, rowsForTab, selectedFirst, sortRows, tabCounts, tabOf, type JudgeRow } from '../web/src/judge';
// @ts-expect-error The root TypeScript project excludes TSX while Vitest can import it.
import DeadlineRing from '../web/src/widgets/DeadlineRing';
import { windowLeft } from '../web/src/widgets/deadline';

const row = (id: string, status: string, extra: Partial<JudgeRow> = {}): JudgeRow => ({
  id,
  status,
  stage: 'TEST',
  reason: 'OTHER',
  amount: '6.00',
  currency: 'USD',
  due: null,
  custom_id: null,
  updated_at: '',
  ...extra,
});
const move = 'WAITING_FOR_SELLER_RESPONSE';
describe('case view', () => {
  it('uses the filed time supplied by the server', async () => {
    expect(filedTime({ at: '2026-11-01T18:48:28.651Z' })).toBe('2026-11-01T18:48:28.651Z');
    expect(filedTime({})).toBeNull();
    expect(filedTime(null)).toBeNull();
    expect(filedTime(undefined)).toBeNull();
    expect(filedTime({ at: 'nonsense' })).toBeNull();
    const fsModule = 'fs';
    const { readFileSync } = (await import(fsModule)) as unknown as {
      readFileSync: (path: string, encoding: string) => string;
    };
    const source = readFileSync('web/src/components/CasePanel.tsx', 'utf8');
    expect(source).toContain('setFiledAt(filedTime(');
    expect(source).not.toContain('data.updated_at');
  });
  it('uses the same deadline text in the ring, list and tile', () => {
    const now = Date.parse('2026-11-01T00:00:00Z');
    const due = '2026-11-07T11:00:00Z';
    const html = renderToStaticMarkup(createElement(DeadlineRing, { created: '2026-10-01T00:00:00Z', due, now }));
    expect(html).toContain('6d');
    expect(html).toContain('11h');
    expect(html).not.toContain('7d');
    expect(formatDeadline(due, now)).toBe('6d 11h');
    expect(windowLeft('2026-10-01T00:00:00Z', due, now)?.days).toBe(6);
    const dispute: Dispute = { id: 'case-1', status: 'WAITING_FOR_SELLER_RESPONSE', stage: 'INQUIRY', reason: 'OTHER', amount: '1', currency: 'USD', due, custom_id: null, updated_at: '' };
    expect(tileValues([dispute], now).nextDeadline).toBe('in 6d 11h');
    const pastDue = '2026-10-31T23:00:00Z';
    expect(renderToStaticMarkup(createElement(DeadlineRing, { created: '2026-10-01T00:00:00Z', due: pastDue, now }))).toContain('Late');
    expect(tileValues([{ ...dispute, due: pastDue }], now).nextDeadline).toBe('Late');
  });
  it('uses review only for a successful seller reply', () => {
    expect(caseStatus(move, true)).toBe('UNDER_REVIEW');
    expect(caseStatus(move, false)).toBe(move);
    expect(caseStatus('RESOLVED', true)).toBe('RESOLVED');
    expect(caseStatus('NEW', true)).toBe('NEW');
  });
  it('shows only known progress and the right current step', () => {
    for (const [status, states] of [
      [move, ['done', 'current', 'todo', 'todo']],
      ['UNDER_REVIEW', ['done', 'done', 'current', 'todo']],
      ['WAITING_FOR_BUYER_RESPONSE', ['done', 'done', 'current', 'todo']],
      ['RESOLVED', ['done', 'done', 'done', 'done']],
    ] as const) {
      expect(caseProgress(status)?.steps.map((step) => step.state)).toEqual(states);
      expect(caseProgress(status)?.steps.map((step) => step.label)).toEqual([
        'Opened',
        'Your reply',
        status === 'WAITING_FOR_BUYER_RESPONSE' ? 'With buyer' : 'With PayPal',
        'Settled',
      ]);
    }
    expect(caseProgress('NEW')).toBeNull();
    expect(caseProgress('toString')).toBeNull();
  });
  it('shows valid reply dates only while the seller must reply', () => {
    const due = '2026-11-05T12:00:00Z';
    const date = new Date(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    expect(replyBy(due, move, Date.parse(due) - 1)).toBe(`Reply by ${date}`);
    expect(replyBy(due, move, Date.parse(due) + 1)).toBe(`Reply was due ${date}`);
    expect(replyBy(due, move, Date.parse(due))).toBe(`Reply by ${date}`);
    expect(replyBy(null, move)).toBeNull();
    expect(replyBy('bad', move)).toBeNull();
    expect(replyBy(due, 'UNDER_REVIEW')).toBeNull();
  });
  it('names the action and the money involved', () => {
    expect(actionLabel('FIGHT', '6', undefined, 'USD')).toBe('Approve and file');
    expect(actionLabel('ACCEPT', '6', undefined, 'USD')).toBe('Accept and refund $6.00');
    expect(actionLabel('OFFER', '6', '3', 'USD')).toBe('Approve and offer $3.00');
    expect(actionLabel('OFFER', '6', 0, 'USD')).toBe('Approve and offer $0.00');
    expect(actionLabel('OFFER', '6', undefined, 'USD')).toBe('Approve and file');
    expect(actionLabel('NEW', '6', undefined, 'USD')).toBe('Approve and file');
    expect(moneyLine('ACCEPT', '6', undefined, 'USD')).toEqual({ label: 'Refund to buyer', value: '$6.00' });
    expect(moneyLine('OFFER', '6', '3', 'USD')).toEqual({ label: 'Offer to buyer', value: '$3.00' });
    expect(moneyLine('OFFER', '6', undefined, 'USD')).toBeNull();
    expect(moneyLine('FIGHT', '6', undefined, 'USD')).toBeNull();
  });
});
describe('case tabs', () => {
  const rows = [row('move', move), row('wait', 'UNDER_REVIEW'), row('done', 'RESOLVED'), row('new', 'NEW')];
  it('counts unknown cases as waiting and defaults after rows arrive', () => {
    expect(rows.map((item) => tabOf(item.status))).toEqual(['move', 'waiting', 'settled', 'waiting']);
    expect(tabCounts(rows)).toEqual({ move: 1, waiting: 2, settled: 1, all: 4 });
    expect(defaultTab([])).toBe('all');
    expect(defaultTab(rows)).toBe('move');
    expect(defaultTab(rows.slice(1))).toBe('all');
  });
  it('retains owned and selected cases in source order without duplicates', () => {
    expect(rowsForTab(rows, 'waiting', new Set(['move', 'wait']), 'done').map((item) => item.id)).toEqual([
      'move',
      'wait',
      'done',
      'new',
    ]);
    expect(rowsForTab(rows, 'settled', new Set(), null)).toEqual([rows[2]]);
    expect(rowsForTab(rows, 'all', new Set(['move']), 'move')).toEqual(rows);
  });
  it('finds the selected page', () => {
    expect([0, 11, 12, 35, 36].map((index) => pageOfRow(index, 12))).toEqual([0, 0, 1, 2, 3]);
  });
  it('selects owned kinds before replay and replay before other open cases', () => {
    const choices = [
      row('open', move),
      row('replay', 'RESOLVED', { replay: true }),
      row('accept', move, { kind: 'accept' }),
      row('fight', move, { kind: 'fight' }),
    ];
    expect(firstSelection(choices, new Set(['accept', 'fight']))).toBe('fight');
    expect(firstSelection(choices, new Set(['accept']))).toBe('accept');
    expect(firstSelection(choices, new Set())).toBe('replay');
    expect(firstSelection([choices[0]], new Set())).toBe('open');
    expect(firstSelection([], new Set())).toBeNull();
  });
});
describe('evidence row text', () => {
  it('removes the repeated kind and labels reason codes', () => {
    expect(evidenceText('Dispute PP-R-X: reason MERCHANDISE_OR_SERVICE_NOT_RECEIVED, $7.25', 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED'))
      .toBe('PP-R-X: reason Not received, $7.25');
    expect(evidenceText('Shipping record ship-1: UPS', 'OTHER')).toBe('ship-1: UPS');
  });
});
describe('row sorting', () => {
  it('puts replay rows ahead of open rows and settled rows', () => {
    const rows = [row('settled', 'RESOLVED'), row('open', move), row('replay', 'RESOLVED', { replay: true })];
    expect(sortRows(rows, new Set()).map((item) => item.id)).toEqual(['replay', 'open', 'settled']);
  });
  it('puts a selected case from another tab first', () => {
    const rows = [row('open', move), row('settled', 'RESOLVED')];
    expect(selectedFirst(rows, 'move', 'settled').map((item) => item.id)).toEqual(['settled', 'open']);
  });
  it('keeps a selected case in its tab in place', () => {
    const rows = [row('open', move), row('settled', 'RESOLVED')];
    expect(selectedFirst(rows, 'move', 'open')).toEqual(rows);
  });
  it('does not change all tab ordering', () => {
    const rows = [row('open', move), row('settled', 'RESOLVED')];
    expect(selectedFirst(rows, 'all', 'settled')).toEqual(rows);
  });
  it('does not change ordering without a selected case', () => {
    const rows = [row('open', move), row('settled', 'RESOLVED')];
    expect(selectedFirst(rows, 'move', null)).toEqual(rows);
  });
});
