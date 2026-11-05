import type { Dispute } from './format';

export type Run = {
  disputeId: string;
  version?: string;
  decision: {
    verdict: 'FIGHT' | 'ACCEPT' | 'OFFER' | 'REVIEW';
    rule: string;
    why: string;
    offerAmount?: string | number;
    facts?: { label: string; value: string; recordId?: string }[];
    missing?: string[];
    changeIf?: string;
    disagreements?: string[];
  };
  sentences: { text: string; record_id: string }[];
  dropped: { text: string; record_id: string }[];
  records: { id: string; kind: string; summary: string }[];
  steps: { tool: string; ref: string; ok: boolean; summary: string; ms: number }[];
  writer: 'model' | 'template';
  chosenTools: string[];
  usage: unknown;
};
export type Operation = { state: 'sending' | 'uncertain' | string; [key: string]: unknown };
export type FilingConflict = { changed: string[]; paypalUrl: string };
export type CaseData = Dispute & { data?: { dispute?: unknown; run?: Run; neurons?: unknown; filed?: Filed; operation?: Operation; filingConflict?: FilingConflict } };
export type Filed = { call: string; ok: boolean; detail: string; at?: string };
export type FeedRow = {
  seq: number;
  at: string;
  kind: 'webhook' | 'call' | 'agent' | 'note';
  title: string;
  ref: string;
  detail: string;
};
export type Analysis = { run: Run; neurons: unknown; cap: string | null };
export type Approval =
  | { kind: 'filed'; filed: Filed; status: string; stage: string }
  | { kind: 'refused'; detail: string; operationCleared?: boolean }
  | { kind: 'uncertain'; message: string; operation: Operation; conflict?: FilingConflict };
export type ReplayDispute = Omit<Dispute, 'updated_at'>;
export type NextCase =
  | { disputeId: string; replay: false; fresh: boolean }
  | { disputeId: null; replay: { label: string; dispute: ReplayDispute; run: Run; neurons: number }; fresh: false };
export type Me = { cases: { dispute_id: string; kind: 'fight' | 'accept' | 'ship' }[] };

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const text = await response.text();
  let body: (T & { error?: string }) | Record<string, never> = {};
  try {
    body = text ? (JSON.parse(text) as T & { error?: string }) : {};
  } catch {
    body = {};
  }
  if (!response.ok) throw Object.assign(new Error('Request failed'), { status: response.status, body });
  return body as T;
}

export const getDisputes = () => request<Dispute[]>('/api/disputes');
export const getDispute = (id: string) => request<CaseData>(`/api/disputes/${encodeURIComponent(id)}`);
export const analyseDispute = (id: string, key?: string) =>
  request<Analysis>(`/api/disputes/${encodeURIComponent(id)}/analyse`, {
    method: 'POST',
    headers: key ? { 'x-desk-key': key } : undefined,
  });
export async function approveDispute(id: string, version: string | undefined, key?: string): Promise<Approval> {
  const response = await fetch(`/api/disputes/${encodeURIComponent(id)}/approve`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(key ? { 'x-desk-key': key } : {}) },
    body: JSON.stringify({ version }),
  });
  let body: Record<string, any> = {};
  try { body = await response.json() as Record<string, any>; } catch { /* handled as an empty response */ }
  if (response.status === 202)
    return { kind: 'uncertain', message: 'PayPal did not confirm the filing yet.', operation: body.operation, ...(body.conflict ? { conflict: body.conflict } : {}) };
  if (response.status === 422 || (response.status === 409 && !body.run))
    return { kind: 'refused', detail: body.filed?.detail ?? body.error ?? 'Filing was refused.', ...(body.operationCleared ? { operationCleared: true } : {}) };
  if (!response.ok) throw Object.assign(new Error('Request failed'), { status: response.status, body });
  return { kind: 'filed', filed: body.filed, status: body.status, stage: body.stage };
}
export const getFeed = () => request<FeedRow[]>('/api/feed');
export const getNext = (kind: 'fight' | 'accept') => request<NextCase>(`/api/judge/next?kind=${kind}`);
export const getMe = () => request<Me>('/api/me');

export type Sale = {
  capture_id: string;
  order_id: string;
  custom_id: string;
  amount: string;
  currency: string;
  captured_at: string;
  carrier: string;
  tracking_number: string;
  tracker_id: string | null;
  state: 'soon' | 'late' | 'on_paypal';
  due_in_ms: number;
  yours: boolean;
};
export const getSales = () => request<Sale[]>('/api/sales');
export const trackSale = (id: string) =>
  request<Sale | { already: true }>(`/api/sales/${encodeURIComponent(id)}/track`, { method: 'POST' });
export const getShipNext = () =>
  request<{ disputeId: string | null; replay: boolean; fresh: boolean }>('/api/judge/next?kind=ship');
