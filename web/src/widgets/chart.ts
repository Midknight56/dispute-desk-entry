export type AskReply = {
  spec: { chart: 'bar' | 'pie'; groupBy: string; metric: 'count' | 'amount' | 'held'; period: string };
  title: string;
  rows: { key: string; value: number }[];
  by: 'model' | 'words';
  neurons: number;
};

import type { AgChartOptions } from 'ag-charts-community';

export function chartOptions(
  reply: AskReply,
  palette: { chart: string; ok: string; text: string; line: string },
): AgChartOptions {
  if (reply.spec.chart === 'pie') {
    return {
      data: reply.rows,
      background: { fill: 'transparent' },
      series: [
        {
          type: 'pie' as const,
          angleKey: 'value',
          calloutLabelKey: 'key',
          sectorLabelKey: 'value',
          fills: [palette.chart, palette.ok],
        },
      ],
      legend: { enabled: true, item: { label: { color: palette.text } } },
    } as unknown as AgChartOptions;
  }
  const largest = Math.max(...reply.rows.map((row) => row.value), Number.NEGATIVE_INFINITY);
  return {
    data: reply.rows,
    background: { fill: 'transparent' },
    axes: [
      { type: 'category' as const, position: 'bottom' as const, label: { color: palette.text } },
      {
        type: 'number' as const,
        position: 'left' as const,
        label: {
          color: palette.text,
          ...(reply.spec.metric === 'amount' || reply.spec.metric === 'held'
            ? {
                formatter: (params: { value: number }) =>
                  new Intl.NumberFormat('en-US', {
                    style: 'currency',
                    currency: 'USD',
                    maximumFractionDigits: 0,
                  }).format(params.value),
              }
            : {}),
        },
      },
    ],
    series: [
      {
        type: 'bar' as const,
        xKey: 'key',
        yKey: 'value',
        fill: palette.chart,
        stroke: palette.line,
        itemStyler: (params: { datum: { value: number } }) => ({
          fill: params.datum.value === largest ? palette.ok : palette.chart,
        }),
      },
    ],
    legend: { enabled: false },
  } as unknown as AgChartOptions;
}
