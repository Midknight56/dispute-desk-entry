import { describe, expect, it } from "vitest";
import { dropUnbacked, finalDecision, type CaseFacts, type Decision } from "../src/rules";

const facts = (amount: number): CaseFacts => ({
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  amount,
  currency: "USD",
  claimAt: "2026-01-01T00:00:00Z",
  hasOrder: true,
  hasCapture: true,
});
const fight: Decision = {
  verdict: "FIGHT",
  rule: "INR_DELIVERED_BEFORE_CLAIM",
  why: "Delivered before claim.",
  facts: [{ label: "Amount", value: "$48.00" }],
  missing: [],
  disagreements: [],
  changeIf: "A later delivery would make the desk offer half back.",
};

describe("dropUnbacked", () => {
  it("keeps backed sentences and trims their text", () => {
    expect(dropUnbacked([{ text: "  Delivered. ", record_id: "r1" }], new Set(["r1"])).kept).toEqual([
      { text: "Delivered.", record_id: "r1" },
    ]);
  });

  it("drops a well formed sentence with an unknown record id", () => {
    expect(dropUnbacked([{ text: "Delivered.", record_id: "other" }], new Set()).dropped).toEqual([
      { text: "Delivered.", record_id: "other" },
    ]);
  });

  it("drops empty text", () => {
    expect(dropUnbacked([{ text: "  ", record_id: "r1" }], new Set(["r1"]))).toEqual({ kept: [], dropped: [] });
  });

  it("survives non array input, nulls and numbers", () => {
    expect(dropUnbacked(null, new Set())).toEqual({ kept: [], dropped: [] });
    expect(dropUnbacked([null, 3, "bad"], new Set())).toEqual({ kept: [], dropped: [] });
  });

  it("turns a fight with no kept evidence into accept under the line", () => {
    expect(finalDecision(fight, [], facts(9.99))).toMatchObject({ verdict: "ACCEPT", rule: "NOT_ENOUGH_EVIDENCE" });
  });

  it("turns a fight with no kept evidence into an offer over the line", () => {
    expect(finalDecision(fight, [], facts(10))).toMatchObject({
      verdict: "OFFER",
      rule: "NOT_ENOUGH_EVIDENCE",
      offerAmount: "5.00",
    });
  });

  it("leaves a fight with kept evidence unchanged", () => {
    const kept = [{ text: "Delivered.", record_id: "r1" }];
    expect(finalDecision(fight, kept, facts(48))).toBe(fight);
  });
});
