import { describe, expect, it } from 'vitest';
import type { Dispute } from '../web/src/format';
import { readiness } from '../web/src/widgets/readiness';
import { windowLeft } from '../web/src/widgets/deadline';
import { chartOptions, type AskReply } from '../web/src/widgets/chart';

const row = (overrides: Partial<Dispute> = {}): Dispute => ({
  id: 'case-1',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  stage: 'INQUIRY',
  reason: 'OTHER',
  amount: '20.00',
  currency: 'USD',
  due: null,
  custom_id: null,
  updated_at: '',
  ...overrides,
});

const palette = { chart: '#6b6b66', ok: '#2f7d4f', text: '#1d1d1b', line: '#e3e3df' };

describe('widget helpers', () => {
  it('lists evidence held and missing, including filing', () => {
    expect(readiness(row({ kinds: ['capture', 'order'], filed_at: null }))).toEqual({
      held: ['payment', 'order'],
      missing: ['tracking', 'response'],
      filled: [true, true, false, false],
    });
  });

  it('computes clamped days and share remaining in the response window', () => {
    expect(windowLeft('2026-10-01T00:00:00Z', '2026-10-21T00:00:00Z', Date.parse('2026-10-11T00:00:00Z'))).toEqual({
      share: 0.5,
      days: 10,
    });
    expect(windowLeft('2026-10-01T00:00:00Z', '2026-10-21T00:00:00Z', Date.parse('2026-10-22T00:00:00Z'))).toEqual({
      share: 0,
      days: 0,
    });
    expect(windowLeft('2026-10-01T00:00:00Z', null, Date.now())).toBeNull();
  });

  it('maps bar, pie, and money replies to chart options', () => {
    const reply: AskReply = {
      spec: { chart: 'bar', groupBy: 'reason', metric: 'amount', period: 'all' },
      title: 'By reason',
      rows: [
        { key: 'A', value: 10 },
        { key: 'B', value: 20 },
      ],
      by: 'words',
      neurons: 0,
    };
    const bar = chartOptions(reply, palette);
    const barOptions = bar as unknown as {
      series: {
        type: string;
        xKey: string;
        yKey: string;
        fill: string;
        itemStyler: (params: { datum: { value: number } }) => { fill: string };
      }[];
      axes: { label: { formatter?: (params: { value: number }) => string } }[];
    };
    expect(barOptions.series[0]).toMatchObject({ type: 'bar', xKey: 'key', yKey: 'value', fill: palette.chart });
    expect(barOptions.axes[1].label.formatter?.({ value: 20 })).toBe('$20');
    expect(barOptions.series[0].itemStyler({ datum: { value: 20 } })).toEqual({ fill: palette.ok });
    const pie = chartOptions({ ...reply, spec: { ...reply.spec, chart: 'pie', metric: 'count' } }, palette);
    const pieOptions = pie as unknown as {
      series: { type: string; angleKey: string; calloutLabelKey: string }[];
      legend: unknown;
    };
    expect(pieOptions.series[0]).toMatchObject({ type: 'pie', angleKey: 'value', calloutLabelKey: 'key' });
    expect(pieOptions.legend).toEqual({ enabled: true, item: { label: { color: palette.text } } });
  });
});
