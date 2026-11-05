import type { AgFilterState, AgStudioApi } from 'ag-studio';

export type ChartRequest = {
  chart: 'bar' | 'pie';
  groupBy: 'reason' | 'status' | 'stage';
  metric: 'count' | 'amount' | 'held';
  period: 'all' | 'quarter' | 'month';
  title: string;
};

export function addChartTo(
  api: Pick<AgStudioApi, 'getState' | 'setState'>,
  input: ChartRequest,
  now = new Date(),
): boolean {
  const state = api.getState();
  const page = state.pages.find((entry) => entry.id === state.selectedPageId) ?? state.pages[0];
  if (!page) return false;
  const timestamp = Date.now();
  let widgetId = `ask-${timestamp}`;
  let suffix = 1;
  while (page.widgets?.[widgetId]) widgetId = `ask-${timestamp}-${suffix++}`;
  const pageWithWidgets = { ...page, widgets: { ...page.widgets }, widgetLayout: { ...page.widgetLayout } };
  pageWithWidgets.widgets![widgetId] = {
    type: input.chart === 'bar' ? 'bar-chart-grouped' : 'pie-chart',
    dataMapping: {
      categoryKey: [{ id: `disputes.${input.groupBy}` }],
      valueKey: [
        {
          id: `disputes.${input.metric === 'count' ? 'id' : input.metric === 'held' ? 'held_amount' : 'amount'}`,
          aggregation: input.metric === 'count' ? 'count' : 'sum',
        },
      ],
    },
    format: { title: { enabled: true, text: input.title } },
  } as never;
  if (input.period !== 'all') {
    const month = now.getUTCMonth();
    const start = new Date(
      Date.UTC(now.getUTCFullYear(), input.period === 'month' ? month : month - (month % 3), 1),
    );
    const filter: AgFilterState = {
      field: { id: 'disputes.created' },
      // dateFormat serializes dates as YYYY-MM-DD; the boundary is UTC midnight.
      model: { operator: 'greaterThanOrEqual', value: start.toISOString().slice(0, 10) },
    };
    pageWithWidgets.filter = {
      ...page.filter,
      widget: { ...page.filter?.widget, [widgetId]: [filter] },
    };
  }
  const bottom = Math.max(
    0,
    ...Object.values(page.widgetLayout ?? {}).flatMap((layout) => (layout ? [layout.yTrack + layout.ySpan] : [])),
  );
  pageWithWidgets.widgetLayout![widgetId] = { xTrack: 0, yTrack: bottom, xSpan: 12, ySpan: 24 };
  api.setState({ ...state, pages: state.pages.map((entry) => (entry.id === page.id ? pageWithWidgets : entry)) });
  return Object.keys(api.getState().pages.find((entry) => entry.id === page.id)?.widgets ?? {}).includes(widgetId);
}
