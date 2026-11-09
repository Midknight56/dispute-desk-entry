import { describe, expect, it } from 'vitest';
import { daysLeft, formatMoney, reasonLabel, tileValues, type Dispute } from '../web/src/format';
import { statusLabel, statusTone } from '../web/src/format';

const dispute = (overrides: Partial<Dispute> = {}): Dispute => ({
  id: 'case-1',
  status: 'WAITING_FOR_SELLER_RESPONSE',
  stage: 'INQUIRY',
  reason: 'MERCHANDISE_OR_SERVICE_NOT_RECEIVED',
  amount: '48.00',
  currency: 'USD',
  due: '2026-10-23T00:00:00.000Z',
  custom_id: null,
  updated_at: '',
  ...overrides,
});

describe('web formatting helpers', () => {
  it('formats money using the currency', () => {
    expect(formatMoney('48.00')).toBe('$48.00');
  });
  it('computes days left and handles missing due dates', () => {
    expect(daysLeft('2026-10-23T00:00:00Z', Date.parse('2026-10-22T00:00:00Z'))).toBe(1);
    expect(daysLeft(null)).toBeNull();
  });
  it('maps known reasons and formats unknown codes', () => {
    expect(reasonLabel('MERCHANDISE_OR_SERVICE_NOT_RECEIVED')).toBe('Not received');
    expect(reasonLabel('OTHER_REASON')).toBe('other reason');
  });
  it('aggregates open amounts, counts and nearest deadline', () => {
    expect(
      tileValues(
        [dispute(), dispute({ id: 'case-2', status: 'RESOLVED', amount: '12.00' })],
        Date.parse('2026-10-22T00:00:00Z'),
      ),
    ).toEqual({ openAmount: 48, open: 1, nextDeadline: 'in 1d', settled: 1, leftOut: 0 });
  });

  it('sums only open USD cases and keeps all open cases in the count', () => {
    const values = tileValues([dispute({ amount: '6' }), dispute({ id: 'case-2', currency: 'EUR', amount: '100' })]);
    expect(values.openAmount).toBe(6);
    expect(values.leftOut).toBe(1);
    expect(values.open).toBe(2);
  });
});

describe('status labels', () => {
  it('names each PayPal status and never calls an unknown one settled', () => {
    expect(statusLabel('WAITING_FOR_SELLER_RESPONSE')).toBe('Your move');
    expect(statusLabel('WAITING_FOR_BUYER_RESPONSE')).toBe("Buyer's move");
    expect(statusLabel('UNDER_REVIEW')).toBe('With PayPal');
    expect(statusLabel('RESOLVED')).toBe('Settled');
    expect(statusLabel('OPEN_SOMETHING_NEW')).toBe('open something new');
    expect(statusTone('OPEN_SOMETHING_NEW')).not.toBe('settled');
  });
});
