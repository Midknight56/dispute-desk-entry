import { expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createInitialLayout } from '../web/src/studio/layout';

it('tracking widget renders three states and only the own late button', async () => {
  const widgetModule = '../web/src/studio/TrackingWidget';
  const { TrackingRows } = await import(widgetModule);
  const base = {
    capture_id: 'CAP-1',
    order_id: 'ORD-1',
    custom_id: 'dd-s001',
    amount: '8.00',
    currency: 'USD',
    captured_at: '2026-10-26T00:00:00Z',
    carrier: 'UPS',
    tracking_number: '1Z123',
    tracker_id: null,
    due_in_ms: 0,
    yours: true,
  };
  const rows = [
    { ...base, state: 'late' },
    { ...base, capture_id: 'CAP-2', state: 'late', yours: false },
    { ...base, capture_id: 'CAP-3', state: 'soon', due_in_ms: 28 * 3600000 },
    { ...base, capture_id: 'CAP-4', state: 'on_paypal', tracker_id: 'T1' },
  ];
  const html = renderToStaticMarkup(
    createElement(TrackingRows, { rows: rows as any, onTrack: () => {}, now: Date.parse('2026-10-28T00:00:00Z') }),
  );
  expect(html).toContain('On PayPal');
  expect(html).toContain('Due in 1d 4h');
  expect(html).toContain('2d 0h');
  expect(html.match(/<button/g)).toHaveLength(1);
  expect(html).toContain('aria-label="Add tracking for CAP-1"');
});
it('tracking widget is in desktop and compact layouts without overlap', () => {
  for (const compact of [false, true]) {
    const page = createInitialLayout(compact).pages[0];
    expect(Object.values(page.widgets).some((w) => w.type === 'tracking-paypal')).toBe(true);
    const boxes = Object.values(page.widgetLayout);
    for (let i = 0; i < boxes.length; i++)
      for (const b of boxes.slice(i + 1)) {
        const a = boxes[i];
        expect(
          a.xTrack < b.xTrack + b.xSpan &&
            b.xTrack < a.xTrack + a.xSpan &&
            a.yTrack < b.yTrack + b.ySpan &&
            b.yTrack < a.yTrack + a.ySpan,
        ).toBe(false);
      }
  }
});
it('pool ship dry run prints two dd-s physical sales', async () => {
  const processModule = 'node:child_process';
  const { execFileSync } = await import(processModule);
  const out = execFileSync('python', ['tools/pool.py', '--ship', '2', '--dry'], { encoding: 'utf8' });
  expect(out.match(/custom_id dd-s\d+/g)).toHaveLength(2);
  expect(out).toContain('Ceramic spoon rest');
  expect(out).toContain('Small bud vase');
});
