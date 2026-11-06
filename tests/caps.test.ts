import { describe, expect, it } from "vitest";
import {
  ACCOUNT_NEURONS_PER_DAY,
  APP_NEURONS_PER_DAY,
  NEURONS_PER_RUN_MAX,
  NEURONS_PER_ASK_MAX,
  NEURONS_PER_RUN_ESTIMATE as E,
  checkCaps,
  neuronsFor,
  type CapUsage,
} from "../src/caps";

const usage = (overrides: Partial<CapUsage> = {}): CapUsage => ({
  visitorRuns: 0,
  dayRuns: 0,
  appNeurons: 0,
  accountNeurons: 0,
  ...overrides,
});

describe("checkCaps", () => {
  it("allows 19 visitor runs and refuses 20", () => {
    expect(checkCaps(usage({ visitorRuns: 19 })).ok).toBe(true);
    expect(checkCaps(usage({ visitorRuns: 20 }))).toMatchObject({ ok: false, reason: "VISITOR" });
  });

  it("allows 99 daily runs and refuses 100", () => {
    expect(checkCaps(usage({ dayRuns: 99 })).ok).toBe(true);
    expect(checkCaps(usage({ dayRuns: 100 }))).toMatchObject({ ok: false, reason: "DAY" });
  });

  it("allows a run that lands exactly on the app's neuron share and refuses one past it", () => {
    expect(checkCaps(usage({ appNeurons: APP_NEURONS_PER_DAY - E })).ok).toBe(true);
    expect(checkCaps(usage({ appNeurons: APP_NEURONS_PER_DAY - E + 1 }))).toMatchObject({
      ok: false,
      reason: "APP_NEURONS",
    });
  });

  it("allows a run that lands exactly on the account cap and refuses one past it", () => {
    expect(checkCaps(usage({ accountNeurons: ACCOUNT_NEURONS_PER_DAY - E })).ok).toBe(true);
    expect(checkCaps(usage({ accountNeurons: ACCOUNT_NEURONS_PER_DAY - E + 1 }))).toMatchObject({
      ok: false,
      reason: "ACCOUNT_NEURONS",
    });
  });

  it("keeps 100 runs of the measured size inside the app's share and the free day", () => {
    expect(100 * E).toBeLessThanOrEqual(APP_NEURONS_PER_DAY);
    expect(ACCOUNT_NEURONS_PER_DAY).toBeLessThan(10_000);
    expect(neuronsFor({ prompt_tokens: 512, completion_tokens: 132 })).toBeLessThanOrEqual(E);
  });

  it("checks visitor before day when both caps are hit", () => {
    expect(checkCaps(usage({ visitorRuns: 20, dayRuns: 100 }))).toMatchObject({ ok: false, reason: "VISITOR" });
  });

  it("calculates neurons at the published input and output rates", () => {
    expect(neuronsFor({ prompt_tokens: 1_000_000, completion_tokens: 0 })).toBe(1_542);
    expect(neuronsFor({ prompt_tokens: 1_000, completion_tokens: 200 })).toBe(3.58);
    expect(neuronsFor({ prompt_tokens: 82, completion_tokens: 12 })).toBe(0.25);
    expect(neuronsFor({ prompt_tokens: 1_600, completion_tokens: 64 })).toBe(3.12);
    expect(neuronsFor({ prompt_tokens: 3_136, completion_tokens: 64 })).toBe(5.49);
    expect(neuronsFor({ prompt_tokens: 4_160, completion_tokens: 64 })).toBe(7.07);
    expect(NEURONS_PER_RUN_MAX).toBe(15.68);
    expect(neuronsFor({ prompt_tokens: 704, completion_tokens: 128 })).toBe(2.39);
    expect(NEURONS_PER_ASK_MAX).toBe(2.39);
  });
});
