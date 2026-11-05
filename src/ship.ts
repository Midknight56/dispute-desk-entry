export const TRACKING_DUE_MS = 2 * 24 * 60 * 60 * 1000;

export interface Sale {
  capture_id: string;
  order_id: string;
  custom_id: string;
  amount: string;
  currency: string;
  captured_at: string;
  carrier: string;
  tracking_number: string;
  tracker_id: string | null;
}

export function shipState(row: Pick<Sale, "captured_at" | "tracker_id">, now: number) {
  if (row.tracker_id) return { state: "on_paypal" as const, due_in_ms: 0 };
  const left = Math.max(0, Date.parse(row.captured_at) + TRACKING_DUE_MS - now);
  return { state: left > 0 ? ("soon" as const) : ("late" as const), due_in_ms: left };
}
