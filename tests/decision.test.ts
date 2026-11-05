import { describe, expect, it } from "vitest";
import { decide, formatMoney, type CaseFacts } from "../src/rules";

const facts = (overrides: Partial<CaseFacts> = {}): CaseFacts => ({
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  amount: 48,
  currency: "USD",
  claimAt: "2026-01-04T12:00:00Z",
  hasOrder: true,
  hasCapture: true,
  ...overrides,
});

describe("decide", () => {
  it("fights when delivery was three days before the claim", () => {
    const d = decide(facts({ tracking: { status: "DELIVERED", deliveredAt: "2026-01-01T12:00:00Z", carrier: "UPS" } }));
    expect(d).toMatchObject({ verdict: "FIGHT", rule: "INR_DELIVERED_BEFORE_CLAIM" });
    expect(d.why).toContain("3 days");
  });

  it("fights when delivery was earlier on the same day", () => {
    const d = decide(facts({ tracking: { status: "DELIVERED", deliveredAt: "2026-01-04T09:00:00Z" } }));
    expect(d.verdict).toBe("FIGHT");
    expect(d.why).toMatch(/\d+ (hours?|minutes?) before the claim/);
  });

  it("offers on delivery after the claim", () => {
    expect(decide(facts({ tracking: { status: "DELIVERED", deliveredAt: "2026-01-05T12:00:00Z" } }))).toMatchObject({
      verdict: "OFFER",
      rule: "WEAK_EVIDENCE",
    });
  });

  it("offers on delivered tracking without a date", () => {
    expect(decide(facts({ tracking: { status: "DELIVERED" } }))).toMatchObject({
      verdict: "OFFER",
      rule: "WEAK_EVIDENCE",
    });
  });

  it("offers with shipped tracking", () => {
    expect(decide(facts({ tracking: { status: "SHIPPED" } }))).toMatchObject({
      verdict: "OFFER",
      rule: "WEAK_EVIDENCE",
    });
  });

  it("offers exactly at the fight line without evidence", () => {
    expect(decide(facts({ amount: 10 }))).toMatchObject({ verdict: "OFFER", rule: "NO_EVIDENCE_OVER_LINE" });
  });

  it("accepts below the fight line without evidence", () => {
    expect(decide(facts({ amount: 9.99 }))).toMatchObject({ verdict: "ACCEPT", rule: "NO_EVIDENCE_UNDER_LINE" });
  });

  it("accepts a low value digital case", () => {
    const d = decide(facts({ amount: 6, digital: true }));
    expect(d).toMatchObject({ verdict: "ACCEPT", rule: "NO_EVIDENCE_UNDER_LINE" });
    expect(d.why).toContain("$6.00");
    expect(d.why).toContain("$10.00");
  });

  it("rounds offer amounts to cents", () => {
    expect(decide(facts()).offerAmount).toBe("24.00");
    expect(decide(facts({ amount: 7.35, tracking: { status: "SHIPPED" } })).offerAmount).toBe("3.68");
  });

  it("formats other currencies with their code", () => {
    expect(formatMoney(6, "EUR")).toBe("EUR 6.00");
    expect(decide(facts({ amount: 6, currency: "EUR" })).verdict).toBe("REVIEW");
  });
});
