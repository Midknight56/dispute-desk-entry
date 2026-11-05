import { describe, expect, it, vi } from 'vitest';
import { beginRequest } from '../web/src/components/requestGuard';

describe('request guard', () => {
  it('rejects a second synchronous click while a request is active', () => {
    let busy = false;
    const setBusy = vi.fn((value: boolean) => {
      busy = value;
    });
    expect(beginRequest(busy, setBusy)).toBe(true);
    expect(busy).toBe(true);
    expect(beginRequest(busy, setBusy)).toBe(false);
    expect(setBusy).toHaveBeenCalledTimes(1);
  });
});
