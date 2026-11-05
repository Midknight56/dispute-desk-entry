import type { FeedRow } from '../api';

const calls: Record<string, string> = {
  'GET /v1/customer/disputes/{id}': 'The desk read the dispute',
  'POST /v2/checkout/orders/{id}/track': 'The desk sent tracking to PayPal',
  'PUT /v1/shipping/trackers/{id}': 'The desk updated delivery on PayPal',
  'POST /v1/customer/disputes/{id}/provide-evidence': 'The desk sent evidence',
  'POST /v1/customer/disputes/{id}/provide-supporting-info': 'The desk sent a note to PayPal',
  'POST /v1/customer/disputes/{id}/accept-claim': 'The desk accepted the claim',
  'POST /v1/customer/disputes/{id}/make-offer': 'The desk sent an offer',
  'refresh failed': 'Refresh failed, the filing is saved',
};
const agent: Record<string, string> = {
  get_dispute: 'The desk read the dispute',
  get_capture: 'The desk read the payment',
  get_order: 'The desk read the order',
  get_tracking: 'The desk checked shipping',
  get_delivery_date: 'The desk checked the delivery date',
  get_invoice: 'The desk checked for an invoice',
  'verdict FIGHT': 'The desk recommends sending evidence',
  'verdict ACCEPT': 'The desk recommends a refund',
  'verdict OFFER': 'The desk recommends an offer',
  'verdict REVIEW': 'The case needs review',
  'evidence pack': 'The evidence pack could not be built',
};
export function feedSentence(row: Pick<FeedRow, 'kind' | 'title' | 'detail'>): string {
  if (row.kind === 'webhook') {
    if (row.title === 'CUSTOMER.DISPUTE.CREATED') return 'PayPal opened a dispute';
    if (row.title === 'CUSTOMER.DISPUTE.RESOLVED') return 'PayPal resolved a dispute';
    if (row.title === 'PAYMENT.CAPTURE.COMPLETED') return 'PayPal confirmed a payment';
    if (row.title === 'CUSTOMER.DISPUTE.UPDATED') return 'PayPal sent an update';
    return row.detail;
  }
  if (row.kind === 'call') {
    if (row.title === 'file refused') return `Filing refused: ${row.detail}`;
    return calls[row.title] ?? row.detail;
  }
  return (row.kind === 'agent' ? agent[row.title] : undefined) ?? row.detail;
}
