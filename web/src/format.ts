export type Dispute = {
  id: string;
  status: string;
  stage: string;
  reason: string;
  amount: string;
  currency: string;
  due: string | null;
  custom_id: string | null;
  updated_at: string;
  verdict?: 'FIGHT' | 'ACCEPT' | 'OFFER' | null;
  kinds?: ('dispute' | 'capture' | 'order' | 'tracking')[];
  filed_at?: string | null;
  created?: string;
};
export type TileValues = {
  openAmount: number;
  open: number;
  nextDeadline: string;
  settled: number;
  leftOut: number;
};

export function formatMoney(amount: string | number, currency = 'USD'): string {
  const value = typeof amount === 'number' ? amount : Number(amount);
  return new Intl.NumberFormat('en-US', {
    style: 'currency',
    currency: /^[A-Z]{3}$/.test(currency) ? currency : 'USD',
  }).format(Number.isFinite(value) ? value : 0);
}

export function daysLeft(due: string | null, now = Date.now()): number | null {
  if (!due) return null;
  const timestamp = Date.parse(due);
  if (!Number.isFinite(timestamp)) return null;
  return Math.ceil((timestamp - now) / 86400000);
}

export function filedTime(filed: { at?: string } | null | undefined): string | null {
  return filed?.at && Number.isFinite(Date.parse(filed.at)) ? filed.at : null;
}

export function formatDeadline(due: string | null, now = Date.now()): string {
  if (!due) return '-';
  const timestamp = Date.parse(due);
  if (!Number.isFinite(timestamp)) return '-';
  const remainingHours = Math.ceil((timestamp - now) / 3600000);
  if (remainingHours <= 0) return 'Late';
  const days = Math.floor(remainingHours / 24);
  const hours = remainingHours % 24;
  if (days && hours) return `${days}d ${hours}h`;
  if (days) return `${days}d`;
  return `${remainingHours}h`;
}

export function reasonLabel(reason: string): string {
  if (reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED') return 'Not received';
  if (reason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED') return 'Not as described';
  return reason.toLowerCase().replaceAll('_', ' ');
}

export function evidenceText(summary: string, reason: string): string {
  return summary
    .replace(/^(?:Dispute|Payment|Order|Shipping record|Tracking) /, '')
    .replaceAll(reason, reasonLabel(reason));
}

export function plainReasons(reasons?: string[]): string {
  if (!reasons || !reasons.length) return '';
  return reasons
    .map((reason) => {
      if (reason === 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED') return 'not received';
      if (reason === 'MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED') return 'not as described';
      return reason.toLowerCase().replace(/_/g, ' ');
    })
    .join(', ');
}

export function tileValues(disputes: Dispute[], now = Date.now()): TileValues {
  const openItems = disputes.filter((item) => item.status !== 'RESOLVED');
  const dueTimes = openItems.map((item) => (item.due ? Date.parse(item.due) : Number.NaN)).filter(Number.isFinite);
  const nearest = dueTimes.length ? Math.min(...dueTimes) : null;
  const remaining = nearest === null ? null : formatDeadline(new Date(nearest).toISOString(), now);
  const openAmount = openItems.reduce((total, item) => total + (item.currency === 'USD' ? Number(item.amount) || 0 : 0), 0);
  const values: TileValues = {
    openAmount,
    open: openItems.length,
    nextDeadline: remaining === null ? 'none' : remaining === 'Late' ? 'Late' : `in ${remaining}`,
    settled: disputes.length - openItems.length,
    leftOut: openItems.filter((item) => item.currency !== 'USD').length,
  };
  return values;
}

// PayPal's dispute statuses in the seller's words. Unknown ones show as written, never as settled.
const STATUS: Record<string, [string, 'move' | 'review' | 'settled' | 'wait']> = {
  WAITING_FOR_SELLER_RESPONSE: ['Your move', 'move'],
  WAITING_FOR_BUYER_RESPONSE: ["Buyer's move", 'wait'],
  UNDER_REVIEW: ['With PayPal', 'review'],
  RESOLVED: ['Settled', 'settled'],
};
export function statusLabel(status: string): string {
  return STATUS[status]?.[0] ?? status.toLowerCase().replace(/_/g, ' ');
}
export function statusTone(status: string): string {
  return STATUS[status]?.[1] ?? 'review';
}

export function caseStatus(status: string, filedOk: boolean): string {
  return filedOk && status === 'WAITING_FOR_SELLER_RESPONSE' ? 'UNDER_REVIEW' : status;
}

export function caseProgress(
  status: string,
): { steps: { label: string; state: 'done' | 'current' | 'todo' }[] } | null {
  if (!Object.hasOwn(STATUS, status)) return null;
  const current = status === 'WAITING_FOR_SELLER_RESPONSE' ? 1 : status === 'RESOLVED' ? 4 : 2;
  return {
    steps: [
      'Opened',
      'Your reply',
      status === 'WAITING_FOR_BUYER_RESPONSE' ? 'With buyer' : 'With PayPal',
      'Settled',
    ].map((label, index) => ({
      label,
      state: index < current ? 'done' : index === current ? 'current' : 'todo',
    })),
  };
}

export function replyBy(due: string | null, status: string, now = Date.now()): string | null {
  if (status !== 'WAITING_FOR_SELLER_RESPONSE' || !due || !Number.isFinite(Date.parse(due))) return null;
  const date = new Date(due).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return `${Date.parse(due) < now ? 'Reply was due' : 'Reply by'} ${date}`;
}

export function actionLabel(
  verdict: string,
  amount: string | number,
  offerAmount: string | number | null | undefined,
  currency: string,
): string {
  if (verdict === 'ACCEPT') return `Accept and refund ${formatMoney(amount, currency)}`;
  if (verdict === 'OFFER' && offerAmount != null) return `Approve and offer ${formatMoney(offerAmount, currency)}`;
  return 'Approve and file';
}

export function moneyLine(
  verdict: string,
  amount: string | number,
  offerAmount: string | number | null | undefined,
  currency: string,
): { label: string; value: string } | null {
  if (verdict === 'ACCEPT') return { label: 'Refund to buyer', value: formatMoney(amount, currency) };
  if (verdict === 'OFFER' && offerAmount != null)
    return { label: 'Offer to buyer', value: formatMoney(offerAmount, currency) };
  return null;
}
