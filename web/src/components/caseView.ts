import type { Filed, Run } from '../api';

const recordNames: Record<string, string> = {
  capture: 'Payment',
  order: 'Order',
  tracking: 'Shipping',
  dispute: 'Dispute',
  invoice: 'Invoice',
};
export function recordType(kind?: string) {
  return (kind && recordNames[kind]) || 'Record';
}
export function citation(id: string, records: Run['records']) {
  const record = records.find((item) => item.id === id);
  const label = recordType(record?.kind);
  return { label, description: `${label} ${id}${record ? `: ${record.summary}` : ''}` };
}
export function filedOutcome(call: string) {
  if (call.endsWith('/provide-evidence')) return 'Evidence sent to PayPal';
  if (call.endsWith('/accept-claim')) return 'Refund accepted';
  if (call.endsWith('/make-offer')) return 'Offer sent';
  if (call.endsWith('/provide-supporting-info')) return 'Note sent to PayPal';
  return 'Response sent to PayPal';
}
export function filingNeedsCheck(filed: Filed | undefined, operation: { state?: string } | undefined) {
  return !filed && ['sending', 'uncertain'].includes(operation?.state ?? '');
}
export function approvalMessage(
  status: number | undefined,
  body: { run?: Run; filed?: Filed; error?: string } | undefined,
  fallback: string,
) {
  if (status === 409 && body?.run && !body.run.version) return 'Analyse again to make a new draft, then approve.';
  return body?.filed?.detail || body?.error?.trim() || fallback;
}
export function decisionView(decision: Run['decision']) {
  const review = decision.verdict === 'REVIEW';
  return {
    tone: review ? 'review' : decision.verdict === 'FIGHT' ? 'fight' : 'refund',
    approve: !review,
    money: !review,
    analyseClass: review ? 'primary' : 'analyse-again',
    facts: decision.facts ?? [],
    missing: decision.missing ?? [],
    changeIf: decision.changeIf,
    disagreements: decision.disagreements ?? [],
  };
}

// Both first loads and refreshes use this path. A failed refresh never clears saved data.
export async function loadResource<T>(
  load: () => Promise<T>,
  save: (value: T) => void,
  fail: (failed: boolean) => void,
) {
  try {
    save(await load());
    fail(false);
  } catch {
    fail(true);
  }
}
