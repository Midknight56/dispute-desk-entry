import { reasonLabel, statusLabel, type Dispute } from '../format';

export type StudioRow = {
  id: string;
  status: string;
  stage: string;
  reason: string;
  amount: number;
  held_amount: number;
  is_open: number;
  is_settled: number;
  left_out: number;
  currency: string;
  due: string | null;
  custom_id: string | null;
  updated_at: string;
  verdict: Dispute['verdict'];
  has_payment: boolean;
  has_order: boolean;
  has_tracking: boolean;
  filed: boolean;
  filed_at: string | null;
  created: string;
};

function isoDate(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

export function toStudioRows(rows: Dispute[]): StudioRow[] {
  return rows.map((row) => {
    const amount = Number.isFinite(Number(row.amount)) ? Number(row.amount) : 0;
    const settled = statusLabel(row.status) === 'Settled';
    return {
      id: row.id,
      status: statusLabel(row.status),
      stage: row.stage === 'INQUIRY' ? 'Inquiry' : row.stage === 'CHARGEBACK' ? 'Claim' : row.stage,
      reason: reasonLabel(row.reason),
      amount: row.currency === 'USD' ? amount : 0,
      held_amount: settled || row.currency !== 'USD' ? 0 : amount,
      is_open: settled ? 0 : 1,
      is_settled: settled ? 1 : 0,
      left_out: row.currency === 'USD' ? 0 : 1,
      currency: row.currency,
      due: isoDate(row.due),
      custom_id: row.custom_id,
      updated_at: row.updated_at,
      verdict: row.verdict ?? null,
      has_payment: row.kinds?.includes('capture') ?? false,
      has_order: row.kinds?.includes('order') ?? false,
      has_tracking: row.kinds?.includes('tracking') ?? false,
      filed: Boolean(row.filed_at),
      filed_at: isoDate(row.filed_at),
      created: isoDate(row.created) ?? '',
    };
  });
}

// Studio's widget data rows name each value by its full field key ("disputes.id"), or come as arrays in the
// order of the fields asked for. The widgets read plain names ("id").
export function plainRows(rows: unknown[], fieldKeys: string[]): Array<Record<string, unknown>> {
  const short = (k: string) => k.split('.').at(-1) ?? k;
  return rows.map((row) => {
    if (Array.isArray(row)) return Object.fromEntries(fieldKeys.map((k, i) => [short(k), row[i]]));
    return Object.fromEntries(Object.entries((row ?? {}) as Record<string, unknown>).map(([k, v]) => [short(k), v]));
  });
}
