import { describe, expect, it } from 'vitest';
import { errorMessage, firstLoadFinished } from '../web/src/errors';

describe('errorMessage', () => {
  it('shows offline only for network failures or errors without a status', () => {
    expect(errorMessage(new TypeError('fetch failed'))).toBe('Offline, retrying');
    expect(errorMessage(new Error('failed'))).toBe('Offline, retrying');
  });

  it('uses trimmed server error text and caps it at 120 characters', () => {
    expect(errorMessage({ status: 404, body: { error: " not one of this desk's disputes " } })).toBe(
      "not one of this desk's disputes",
    );
    expect(errorMessage({ status: 409, body: { error: ' analyse this dispute first ' } })).toBe(
      'analyse this dispute first',
    );
    expect(errorMessage({ status: 404, body: { error: 'x'.repeat(125) } })).toBe('x'.repeat(120));
  });

  it('uses the PayPal message for gateway failures without server text', () => {
    for (const status of [502, 503, 504])
      expect(errorMessage({ status, body: {} })).toBe('PayPal did not answer. Try again.');
  });

  it('uses the general message for other status failures without server text', () => {
    expect(errorMessage({ status: 500, body: {} })).toBe('Something went wrong. Try again.');
    expect(errorMessage({ status: 500, body: { error: '   ' } })).toBe('Something went wrong. Try again.');
  });
});

describe('firstLoadFinished', () => {
  it('distinguishes the initial load from a completed load', () => {
    expect(firstLoadFinished(false)).toBe(false);
    expect(firstLoadFinished(true)).toBe(true);
  });
});
