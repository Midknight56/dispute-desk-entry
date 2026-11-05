export function createInitialLayout(compact = false) {
  return {
    panels: {
      ai: { collapsed: compact },
      edit: { collapsed: true },
    },
    pages: [
      {
        id: 'desk',
        widgets: {
          onHold: {
            type: 'value',
            dataMapping: { value: [{ id: 'disputes.held_amount', aggregation: 'sum' }] },
            format: { title: { enabled: true, text: 'On hold' } },
          },
          open: {
            type: 'value',
            dataMapping: { value: [{ id: 'disputes.is_open', aggregation: 'sum' }] },
            format: { title: { enabled: true, text: 'Open' } },
          },
          settled: {
            type: 'value',
            dataMapping: { value: [{ id: 'disputes.is_settled', aggregation: 'sum' }] },
            format: { title: { enabled: true, text: 'Settled' } },
          },
          cases: {
            type: 'grid',
            dataMapping: {
              cols: [{ id: 'disputes.id' }, { id: 'disputes.currency' }, { id: 'disputes.amount' }, { id: 'disputes.status' }],
            },
            format: { style: { columnAutoSize: true } },
          },
          reasons: {
            type: 'bar-chart-grouped',
            dataMapping: {
              categoryKey: [{ id: 'disputes.reason' }],
              valueKey: [{ id: 'disputes.id', aggregation: 'count' }],
            },
            format: { title: { enabled: true, text: 'Disputes by reason' } },
          },
          evidence: { type: 'evidence-readiness', dataMapping: {} },
          deadline: { type: 'deadline-ring', dataMapping: {} },
          checkedDraft: { type: 'checked-draft', dataMapping: {} },
          tracking: {
            type: 'tracking-paypal',
            dataMapping: {},
            format: { title: { enabled: true, text: 'Tracking on PayPal' } },
          },
        },
        widgetLayout: {
          onHold: { xTrack: 0, yTrack: 0, xSpan: 4, ySpan: 10 },
          open: { xTrack: 4, yTrack: 0, xSpan: 4, ySpan: 10 },
          settled: { xTrack: 8, yTrack: 0, xSpan: 4, ySpan: 10 },
          cases: { xTrack: 0, yTrack: 10, xSpan: 6, ySpan: 18 },
          tracking: { xTrack: 6, yTrack: 10, xSpan: 6, ySpan: 18 },
          evidence: { xTrack: 0, yTrack: 28, xSpan: 8, ySpan: 17 },
          deadline: { xTrack: 8, yTrack: 28, xSpan: 4, ySpan: 17 },
          reasons: { xTrack: 0, yTrack: 45, xSpan: 4, ySpan: 16 },
          checkedDraft: { xTrack: 4, yTrack: 45, xSpan: 8, ySpan: 16 },
        },
      },
    ],
    selectedPageId: 'desk',
  };
}
