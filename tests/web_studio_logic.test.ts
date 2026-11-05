import { describe, expect, it } from 'vitest';
import type { AgStudioApi } from 'ag-studio';
import { addChartTo, type ChartRequest } from '../web/src/studio/addChart';
import { latestUserText, shouldFinish } from '../web/src/studio/runner';
import { createInitialLayout } from '../web/src/studio/layout';
import { shapeCheckedDraft } from '../web/src/studio/draftWidget';
import { draftLoadState, draftRefreshResult } from '../web/src/studio/draftState';
import { deadlineDataRows, deadlineFields, evidenceDataRows, evidenceFields } from '../web/src/studio/widgetData';
import { widgetLoadResult } from '../web/src/studio/widgetState';

const chart: ChartRequest = { chart: 'bar', groupBy: 'reason', metric: 'count', period: 'all', title: 'By reason' };

function apiFor(state: any) {
  let current = state;
  return {
    api: {
      getState: () => current,
      setState: (next: unknown) => {
        current = next;
      },
    } as unknown as Pick<AgStudioApi, 'getState' | 'setState'>,
    getState: () => current,
  };
}

describe('addChartTo', () => {
  it.each([
    ['quarter', '2026-10-01'],
    ['month', '2026-11-01'],
  ] as const)('filters the added %s chart from its first UTC day', (period, start) => {
    const existingFilter = { field: { id: 'disputes.status' }, model: { operator: 'equals', value: 'Settled' } };
    const originalPage = {
      id: 'desk',
      widgets: { existing: { type: 'grid' } },
      widgetLayout: {},
      filter: { page: [existingFilter], widget: { existing: [existingFilter] } },
    };
    const { api, getState } = apiFor({ selectedPageId: 'desk', pages: [originalPage] });

    // Locally October, but November in UTC.
    expect(addChartTo(api, { ...chart, period }, new Date('2026-10-31T23:30:00-03:00'))).toBe(true);
    const page = getState().pages[0];
    const id = Object.keys(page.widgets).find((key) => key !== 'existing')!;
    expect(page.filter).toEqual({
      page: [existingFilter],
      widget: {
        existing: [existingFilter],
        [id]: [{ field: { id: 'disputes.created' }, model: { operator: 'greaterThanOrEqual', value: start } }],
      },
    });
    expect(originalPage.filter.widget).toEqual({ existing: [existingFilter] });
  });

  it('adds an all-period chart without a filter', () => {
    const { api, getState } = apiFor({
      selectedPageId: 'desk',
      pages: [{ id: 'desk', widgets: {}, widgetLayout: {} }],
    });
    expect(addChartTo(api, chart, new Date('2026-11-15T12:00:00Z'))).toBe(true);
    const page = getState().pages[0];
    expect(page.filter).toBeUndefined();
    expect(Object.values(page.widgets)[0]).not.toHaveProperty('filter');
  });

  it('maps held charts to the open money field with sum aggregation', () => {
    const { api, getState } = apiFor({ selectedPageId: 'desk', pages: [{ id: 'desk', widgets: {}, widgetLayout: {} }] });
    expect(addChartTo(api, { ...chart, metric: 'held', title: 'Money on hold' })).toBe(true);
    const widget = Object.values(getState().pages[0].widgets)[0] as any;
    expect(widget.dataMapping.valueKey).toEqual([{ id: 'disputes.held_amount', aggregation: 'sum' }]);
  });

  it('adds a widget below the lowest existing widget', () => {
    const state = {
      selectedPageId: 'desk',
      pages: [
        {
          id: 'desk',
          widgets: { existing: { type: 'grid' } },
          widgetLayout: { existing: { xTrack: 0, yTrack: 3, xSpan: 5, ySpan: 14 } },
        },
      ],
    };
    const { api, getState } = apiFor(state);

    expect(addChartTo(api, chart)).toBe(true);
    const page = getState().pages[0];
    const id = Object.keys(page.widgets).find((key) => key !== 'existing')!;
    expect(page.widgetLayout[id]).toEqual({ xTrack: 0, yTrack: 17, xSpan: 12, ySpan: 24 });
  });

  it('preserves other pages and widgets', () => {
    const otherPage = {
      id: 'other',
      widgets: { note: { type: 'text' } },
      widgetLayout: { note: { xTrack: 1, yTrack: 2, xSpan: 3, ySpan: 4 } },
    };
    const selectedPage = {
      id: 'desk',
      widgets: { existing: { type: 'grid' } },
      widgetLayout: { existing: { xTrack: 0, yTrack: 0, xSpan: 12, ySpan: 5 } },
    };
    const { api, getState } = apiFor({ selectedPageId: 'desk', pages: [otherPage, selectedPage] });

    addChartTo(api, chart);
    const state = getState();
    expect(state.pages[0]).toEqual(otherPage);
    expect(state.pages[1].widgets.existing).toEqual(selectedPage.widgets.existing);
    expect(state.pages[1].widgetLayout.existing).toEqual(selectedPage.widgetLayout.existing);
  });

  it('returns false when there are no pages', () => {
    const { api } = apiFor({ selectedPageId: 'desk', pages: [] });
    expect(addChartTo(api, chart)).toBe(false);
  });

  it('gives separate chart additions different ids', () => {
    const { api, getState } = apiFor({
      selectedPageId: 'desk',
      pages: [{ id: 'desk', widgets: {}, widgetLayout: {} }],
    });
    addChartTo(api, chart);
    addChartTo(api, chart);
    expect(Object.keys(getState().pages[0].widgets)).toHaveLength(2);
  });
});

describe('Studio assistant request handling', () => {
  it.each([
    [['user'], false],
    [['user', 'tool'], true],
    [['user', 'tool', 'user'], false],
  ] as const)('finishes only after the latest message is a tool result: %j', (roles, result) => {
    expect(shouldFinish(roles.map((role) => ({ role })))).toBe(result);
  });

  it('treats a failed tool result followed by a user request as a new run', () => {
    const failedRun = [{ role: 'user' }, { role: 'tool', content: 'error' }, { role: 'user' }];
    expect(shouldFinish(failedRun)).toBe(false);
  });

  it('returns the newest user text', () => {
    expect(latestUserText({ messages: [
      { role: 'user', content: 'First chart' },
      { role: 'tool', content: 'Chart added.' },
      { role: 'user', content: 'Second chart' },
    ] } as any)).toBe('Second chart');
  });
});

describe('widget data', () => {
  const schema = [
    {
      id: 'disputes',
      fields: [
        { key: 'disputes.id' },
        { key: 'disputes.status' },
        { key: 'disputes.has_payment' },
        { key: 'disputes.has_order' },
        { key: 'disputes.has_tracking' },
        { key: 'disputes.filed' },
        { key: 'disputes.created' },
        { key: 'disputes.due' },
        { key: 'disputes.amount' },
      ],
    },
  ];

  it('selects the evidence fields and converts keyed data to short row names', () => {
    const fields = evidenceFields(schema);
    expect(fields.map((field) => field.key)).toEqual([
      'disputes.id',
      'disputes.status',
      'disputes.has_payment',
      'disputes.has_order',
      'disputes.has_tracking',
      'disputes.filed',
    ]);
    expect(
      evidenceDataRows(fields, {
        results: { rows: [{ 'disputes.id': 'D1', 'disputes.status': 'Open', 'disputes.filed': true }] },
      }),
    ).toEqual([{ id: 'D1', status: 'Open', filed: true }]);
  });

  it('selects available fields only and returns no rows for an empty result', () => {
    const partialSchema = [{ id: 'disputes', fields: [{ key: 'disputes.id' }, { key: 'disputes.due' }] }];
    const fields = deadlineFields(partialSchema);
    expect(fields.map((field) => field.key)).toEqual(['disputes.id', 'disputes.due']);
    expect(deadlineDataRows(fields, { results: { rows: [] } })).toEqual([]);
  });

  it('selects the deadline fields and converts array data in field order', () => {
    const fields = deadlineFields(schema);
    expect(fields.map((field) => field.key)).toEqual([
      'disputes.id',
      'disputes.status',
      'disputes.created',
      'disputes.due',
    ]);
    expect(deadlineDataRows(fields, { results: { rows: [['D2', 'Open', '2026-10-01', '2026-10-20']] } })).toEqual([
      { id: 'D2', status: 'Open', created: '2026-10-01', due: '2026-10-20' },
    ]);
  });
});

describe('initial Studio layout', () => {
  it('includes the dispute grid, KPIs, reason chart, and custom widgets', () => {
    const page = createInitialLayout().pages[0];
    expect(page.widgets.cases.type).toBe('grid');
    expect(page.widgets.cases.dataMapping.cols).toEqual([
      { id: 'disputes.id' },
      { id: 'disputes.currency' },
      { id: 'disputes.amount' },
      { id: 'disputes.status' },
    ]);
    expect([page.widgets.onHold.type, page.widgets.open.type, page.widgets.settled.type]).toEqual([
      'value',
      'value',
      'value',
    ]);
    expect(page.widgets.reasons).toMatchObject({
      type: 'bar-chart-grouped',
      format: { title: { text: 'Disputes by reason' } },
    });
    expect(page.widgets.evidence.type).toBe('evidence-readiness');
    expect(page.widgets.deadline.type).toBe('deadline-ring');
    expect(page.widgets.checkedDraft.type).toBe('checked-draft');
    expect(page.widgetLayout.checkedDraft).toEqual({ xTrack: 4, yTrack: 45, xSpan: 8, ySpan: 16 });
    expect(page.widgetLayout.tracking).toEqual({ xTrack: 6, yTrack: 10, xSpan: 6, ySpan: 18 });
  });

  it('keeps KPI titles to ten characters or fewer', () => {
    const page = createInitialLayout().pages[0];
    const titles = (['onHold', 'open', 'settled'] as const).map((id) => page.widgets[id].format.title.text);
    expect(titles).toEqual(['On hold', 'Open', 'Settled']);
    for (const title of titles) expect(title.length).toBeLessThanOrEqual(10);
  });

  it('keeps every widget within 12 columns without overlap', () => {
    const page = createInitialLayout().pages[0];
    const entries = Object.entries(page.widgetLayout);
    for (const [id, layout] of entries) {
      expect(layout.xTrack, id).toBeGreaterThanOrEqual(0);
      expect(layout.xTrack + layout.xSpan, id).toBeLessThanOrEqual(12);
      expect(page.widgets[id as keyof typeof page.widgets]).toBeDefined();
    }
    for (let first = 0; first < entries.length; first += 1) {
      for (let second = first + 1; second < entries.length; second += 1) {
        const [firstId, a] = entries[first];
        const [secondId, b] = entries[second];
        const overlaps =
          a.xTrack < b.xTrack + b.xSpan &&
          b.xTrack < a.xTrack + a.xSpan &&
          a.yTrack < b.yTrack + b.ySpan &&
          b.yTrack < a.yTrack + a.ySpan;
        expect(overlaps, `${firstId} overlaps ${secondId}`).toBe(false);
      }
    }
  });
});

describe('checked draft shaping', () => {
  const run = (text: string, dropped: { text: string; record_id: string }[] = []) => ({
    disputeId: text,
    decision: { verdict: 'FIGHT' as const, rule: 'evidence', why: 'Evidence supports a response.' },
    sentences: [{ text, record_id: 'order-1' }],
    dropped,
    records: [{ id: 'order-1', kind: 'order', summary: 'Order summary' }],
    steps: [],
    writer: 'template' as const,
    chosenTools: [],
    usage: {},
  });

  it('chooses the newest analysed case', () => {
    const disputes = [
      { id: 'CASE-2', updated_at: '2026-10-22T00:00:00Z' },
      { id: 'CASE-1', updated_at: '2026-10-21T00:00:00Z' },
    ] as any;
    const details = [
      { id: 'CASE-1', data: { run: run('Older draft') } },
      { id: 'CASE-2', data: { run: run('Newer draft') } },
    ] as any;

    expect(shapeCheckedDraft(disputes, details)?.caseId).toBe('CASE-2');
    expect(shapeCheckedDraft(disputes, details)?.sentences[0].text).toBe('Newer draft');
  });

  it('maps sentence record ids to chips and marks dropped sentences with a reason', () => {
    const disputes = [{ id: 'CASE-1', updated_at: '2026-10-21T00:00:00Z' }] as any;
    const details = [
      {
        id: 'CASE-1',
        data: { run: run('Kept sentence', [{ text: 'Dropped sentence', record_id: 'missing' }]) },
      },
    ] as any;

    expect(shapeCheckedDraft(disputes, details)?.sentences).toEqual([
      { text: 'Kept sentence', recordId: 'order-1', dropped: false },
      { text: 'Dropped sentence', recordId: 'missing', dropped: true, reason: 'Record not in case' },
    ]);
  });

  it('returns the empty state for empty input', () => {
    expect(shapeCheckedDraft([], [])).toBeNull();
  });
});

describe('checked draft refresh state', () => {
  const oldDraft = { caseId: 'OLD', verdict: 'FIGHT', sentences: [] };
  const newDraft = { caseId: 'NEW', verdict: 'ACCEPT', sentences: [] };

  it('replaces a shown draft when a refresh finds a new run', () => {
    expect(draftRefreshResult(oldDraft, newDraft, false)).toEqual({ draft: newDraft, state: 'ready' });
  });

  it('keeps the last good draft when refresh fails', () => {
    expect(draftRefreshResult(oldDraft, null, true)).toEqual({ draft: oldDraft, state: 'stale' });
    expect(draftLoadState(oldDraft as any, true, true, true)).toBe('stale');
  });

  it('shows an error after the first failed load', () => {
    expect(draftRefreshResult(null, null, true)).toEqual({ draft: null, state: 'error' });
    expect(draftLoadState(null, true, true)).toBe('error');
  });

  it('shows the empty state when the list loaded without a run', () => {
    expect(draftRefreshResult(null, null, false)).toEqual({ draft: null, state: 'empty' });
    expect(draftLoadState(null, true, false)).toBe('empty');
  });
});

describe('Studio widget load states', () => {
  it('shows an error when the first load fails', () => {
    expect(widgetLoadResult(null, null, true)).toEqual({ data: null, state: 'error' });
  });
  it('keeps last good data and shows stale after a failed refresh', () => {
    const oldRows = [{ id: 'D1' }];
    expect(widgetLoadResult(oldRows, null, true)).toEqual({ data: oldRows, state: 'stale' });
  });
  it('recovers to ready after stale and reports empty successful data', () => {
    expect(widgetLoadResult([{ id: 'D1' }], [{ id: 'D2' }], false)).toEqual({ data: [{ id: 'D2' }], state: 'ready' });
    expect(widgetLoadResult(null, null, false)).toEqual({ data: null, state: 'empty' });
  });
});
