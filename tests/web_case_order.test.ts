import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FeedRow, Run } from '../web/src/api';
import { uniqueRecords } from '../web/src/components/caseView';
// @ts-expect-error Vitest handles TSX; the server project does not enable JSX.
import { DecisionCard, RunActions } from '../web/src/components/CaseStates';
// @ts-expect-error Vitest handles TSX; the server project does not enable JSX.
import CasePanel from '../web/src/components/CasePanel';
// @ts-expect-error Vitest handles TSX; the server project does not enable JSX.
import Feed, { feedRowsFor } from '../web/src/components/Feed';

const read = async (path: string): Promise<string> => {
  const fsModule = 'fs';
  const fs = (await import(fsModule)) as { readFileSync: (file: string, encoding: string) => string };
  return fs.readFileSync(path, 'utf8');
};

const run = (verdict: 'FIGHT' | 'ACCEPT' | 'REVIEW'): Run => ({
  disputeId: 'D1',
  decision: {
    verdict,
    rule: 'test',
    why: 'Delivered before the claim',
    facts: [{ label: 'Delivered', value: 'Nov 2', recordId: 'TRK-1' }],
    missing: ['A signature'],
    changeIf: 'A later delivery',
    disagreements: ['Amounts differ'],
  },
  records: [
    { id: 'CAP-1', kind: 'capture', summary: 'Paid $48.00' },
    { id: 'TRK-1', kind: 'tracking', summary: 'Delivered Nov 2' },
    { id: 'TRK-1', kind: 'tracking', summary: 'Delivered Nov 2' },
    { id: 'TRK-2', kind: 'tracking', summary: 'Delivered Nov 2' },
  ],
  sentences: [{ text: 'The buyer paid.', record_id: 'CAP-1' }],
  dropped: [],
  steps: [
    { tool: 'get_capture', ref: 'CAP-1', ok: true, summary: 'read', ms: 300 },
    { tool: 'get_tracking', ref: 'TRK-1', ok: true, summary: 'read', ms: 200 },
  ],
  writer: 'template',
  chosenTools: [],
  usage: {},
});

const actions = (r: Run) =>
  createElement(RunActions, {
    run: r,
    amount: '48',
    currency: 'USD',
    canAnalyse: false,
    canApprove: true,
    busy: false,
    error: '',
    analyse: () => {},
    approve: () => {},
  });

const panel = (r: Run) =>
  renderToStaticMarkup(
    createElement(CasePanel, {
      id: 'D1',
      refreshKey: 0,
      mine: new Set(['D1']),
      ownerKey: null,
      replay: {
        label: 'Replay',
        run: r,
        dispute: { id: 'D1', amount: '48', currency: 'USD', status: 'WAITING_FOR_SELLER_RESPONSE', reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED', stage: 'CHARGEBACK', due: null, custom_id: null },
      },
    }),
  );

describe('case screen reading order', () => {
  it('puts the recommendation and the action together, with decisive evidence, missing items and disagreements in the same card', () => {
    const html = renderToStaticMarkup(createElement(DecisionCard, { run: run('FIGHT'), currency: 'USD' }, actions(run('FIGHT'))));
    expect(html).toContain('aria-label="Recommendation"');
    const at = (text: string) => html.indexOf(text);
    for (const text of ['FIGHT', 'Decisive evidence', 'Nov 2', 'Not found', 'A signature', 'Records that disagree', 'class="primary approve"'])
      expect(at(text), text).toBeGreaterThanOrEqual(0);
    expect(at('FIGHT')).toBeLessThan(at('class="primary approve"'));
    expect(at('class="primary approve"')).toBeLessThan(at('Decisive evidence'));
  });

  it('gives a Review case no filing action', () => {
    const html = renderToStaticMarkup(createElement(DecisionCard, { run: run('REVIEW'), currency: 'USD' }, actions(run('REVIEW'))));
    expect(html).toContain('REVIEW');
    expect(html).not.toContain('approve');
  });

  it('shows the card before the draft and keeps records and routine checks folded', () => {
    const html = panel(run('FIGHT'));
    const card = html.indexOf('aria-label="Recommendation"');
    const draft = html.indexOf('<h3>Draft</h3>');
    expect(card).toBeGreaterThanOrEqual(0);
    expect(card).toBeLessThan(draft);
    expect(html).toMatch(/<details class="records-detail"><summary>Evidence behind this draft, 2 records<\/summary>/);
    expect(html).toMatch(/<details class="steps-detail"><summary>/);
    expect(html.indexOf('Desk policy') === -1 || html.indexOf('Desk policy') > draft).toBe(true);
    expect(html).toContain('This would change it');
    expect(html.indexOf('This would change it')).toBeGreaterThan(draft);
  });

  it('keeps the action inside the card in the live panel source', async () => {
    const source = (await read('web/src/components/CasePanel.tsx')).replace(/\s/g, '');
    const card = source.indexOf('<DecisionCard');
    const actionsAt = source.indexOf('<RunActionsrun={run}');
    const cardEnd = source.indexOf('</DecisionCard>');
    expect(card).toBeGreaterThanOrEqual(0);
    expect(actionsAt).toBeGreaterThan(card);
    expect(actionsAt).toBeLessThan(cardEnd);
    expect(cardEnd).toBeLessThan(source.indexOf('className="draft"'));
  });

  it('drops repeated records by id and by identical summary', () => {
    expect(uniqueRecords(run('FIGHT').records).map((item) => item.id)).toEqual(['CAP-1', 'TRK-1']);
  });
});

describe('activity feed is secondary', () => {
  const rows: FeedRow[] = [
    { seq: 4, at: '2026-11-09T05:00:03Z', kind: 'agent', title: 'verdict FIGHT', ref: 'D1', detail: 'x' },
    { seq: 3, at: '2026-11-09T05:00:02Z', kind: 'agent', title: 'get_capture', ref: 'CAP-1', detail: 'x' },
    { seq: 2, at: '2026-11-09T05:00:01Z', kind: 'webhook', title: 'CUSTOMER.DISPUTE.CREATED', ref: 'D2', detail: 'x' },
    { seq: 1, at: '2026-11-09T05:00:00Z', kind: 'call', title: 'GET /v1/customer/disputes/{id}', ref: 'D3', detail: 'x' },
  ];
  it('shows only the selected case and its records until full activity is asked for', () => {
    expect(feedRowsFor(rows, ['D1', 'CAP-1'], false).map((row: FeedRow) => row.seq)).toEqual([4, 3]);
    expect(feedRowsFor(rows, ['D1', 'CAP-1'], true).map((row: FeedRow) => row.seq)).toEqual([4, 3, 2, 1]);
    expect(feedRowsFor(rows, [], false).map((row: FeedRow) => row.seq)).toEqual([4, 3, 2, 1]);
  });
  it('names it Activity and offers This case and All activity', () => {
    const html = renderToStaticMarkup(createElement(Feed, { rows, caseRefs: ['D1'] }));
    expect(html).toContain('<h2>Activity</h2>');
    expect(html).toContain('aria-pressed="true">This case</button>');
    expect(html).toContain('aria-pressed="false">All activity</button>');
    expect(html).not.toContain('PayPal opened a dispute');
  });
  it('sits below the workspace, not beside the case list', async () => {
    const app = (await read('web/src/App.tsx')).replace(/\s/g, '');
    expect(app.indexOf('<Feedrows={feed}')).toBeGreaterThan(app.indexOf('<CasePanel'));
    expect(app).toContain('caseRefs={caseRefs}');
  });
});
