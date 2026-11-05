import { describe, expect, it } from 'vitest';
import type { Dispute } from '../web/src/format';
import { toStudioRows } from '../web/src/studio/data';
import { askToEvents, type AskReply } from '../web/src/studio/runner';

const dispute: Dispute = {
  id: 'case-1',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  stage: 'INQUIRY',
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  amount: '12.50',
  currency: 'USD',
  due: '2026-11-01T12:00:00Z',
  custom_id: null,
  updated_at: '2026-10-20T12:00:00Z',
  kinds: ['capture', 'tracking'],
  filed_at: null,
  created: '2026-10-01T12:00:00Z',
};

describe('toStudioRows', () => {
  it('maps seller labels, numeric amounts, evidence flags, and ISO dates', () => {
    const { kinds, ...source } = dispute;
    expect(kinds).toEqual(['capture', 'tracking']);
    expect(toStudioRows([dispute])[0]).toEqual({
      ...source,
      status: 'Your move',
      stage: 'Inquiry',
      reason: 'Not received',
      amount: 12.5,
      held_amount: 12.5,
      left_out: 0,
      is_open: 1,
      is_settled: 0,
      has_payment: true,
      has_order: false,
      has_tracking: true,
      filed: false,
      filed_at: null,
      due: '2026-11-01T12:00:00.000Z',
      created: '2026-10-01T12:00:00.000Z',
      verdict: null,
    });
  });

  it('uses empty date for missing created and zero for invalid amount', () => {
    const row = toStudioRows([{ ...dispute, amount: 'bad', created: undefined }])[0];
    expect(row.amount).toBe(0);
    expect(row.created).toBe('');
  });

  it('zeros other currencies in money totals and retains their currency and dispute count', () => {
    const rows = toStudioRows([dispute, { ...dispute, id: 'case-2', currency: 'EUR', amount: '100' }]);
    expect(rows[1]).toMatchObject({ amount: 0, held_amount: 0, currency: 'EUR', is_open: 1, left_out: 1 });
    expect(rows.reduce((sum, row) => sum + row.held_amount, 0)).toBe(12.5);
    expect(rows.reduce((sum, row) => sum + row.is_open, 0)).toBe(2);
  });
});

describe('askToEvents', () => {
  const reply: AskReply = {
    spec: { chart: 'bar', groupBy: 'reason', metric: 'count', period: 'quarter' },
    title: 'Disputes by reason this quarter',
    rows: [],
    by: {},
    neurons: 1,
  };

  it('maps an ask reply to a chart tool call', () => {
    const events = askToEvents(reply, { messageId: 'm1', toolCallId: 't1' });
    expect(events.map((event) => event.type)).toEqual(['TOOL_CALL_START', 'TOOL_CALL_ARGS', 'TOOL_CALL_END']);
    expect(events[1]).toMatchObject({
      toolCallId: 't1',
      delta: JSON.stringify({
        chart: 'bar',
        groupBy: 'reason',
        metric: 'count',
        period: 'quarter',
        title: reply.title,
      }),
    });
  });

  it('maps the finish and error branches', () => {
    expect(askToEvents({ finish: true }, { messageId: 'm2', toolCallId: 't2' })).toEqual([
      { type: 'TEXT_MESSAGE_START', messageId: 'm2', role: 'assistant' },
      { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm2', delta: 'Added.' },
      { type: 'TEXT_MESSAGE_END', messageId: 'm2' },
    ]);
    expect(askToEvents({ error: 'Request failed' }, { messageId: 'm3', toolCallId: 't3' })).toEqual([
      { type: 'RUN_ERROR', message: 'Request failed' },
    ]);
  });
});

import { plainRows } from '../web/src/studio/data';
describe('plainRows', () => {
  it('reads keyed rows and array rows by their short names', () => {
    expect(plainRows([{ 'disputes.id': 'D1', 'disputes.filed': true }], [])).toEqual([{ id: 'D1', filed: true }]);
    expect(plainRows([['D2', false]], ['disputes.id', 'disputes.filed'])).toEqual([{ id: 'D2', filed: false }]);
  });
});
