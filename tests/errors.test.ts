import { describe, it, expect } from "vitest";
import { runAgent, type AgentDeps } from "../src/agent";
import { fileResponse } from "../src/file";

const explanation = {
  facts: [{ label: "Amount", value: "$8.50" }],
  missing: [],
  disagreements: [],
  changeIf: "A delivery record would change the verdict.",
};

const dispute = {
  dispute_id: "PP-R-9",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_life_cycle_stage: "INQUIRY",
  create_time: "2026-10-23T02:00:00Z",
  dispute_amount: { currency_code: "USD", value: "8.50" },
  disputed_transactions: [{ seller_transaction_id: "CAP9", custom: "dd-0009" }],
  links: [{ rel: "provide_evidence" }, { rel: "accept_claim" }, { rel: "make_offer" }],
};

function deps(over: Partial<AgentDeps> = {}): AgentDeps {
  return {
    getDispute: async () => dispute,
    getCapture: async () => {
      throw new Error("PayPal GET /v2/payments/captures/CAP9 404 RESOURCE_NOT_FOUND");
    },
    getOrder: async () => {
      throw new Error("unreachable");
    },
    getTracker: async () => {
      throw new Error("unreachable");
    },
    deliveredAt: async () => undefined,
    ...over,
  };
}

describe("error states", () => {
  it("a payment PayPal cannot return is a failed step, and the case still gets a decision", async () => {
    const r = await runAgent("PP-R-9", deps());
    const cap = r.steps.find((s) => s.tool === "get_capture");
    expect(cap?.ok).toBe(false);
    expect(cap?.summary).toContain("404");
    expect(r.decision.verdict).toBe("REVIEW");
    for (const s of r.sentences) expect(r.records.some((x) => x.id === s.record_id)).toBe(true);
  });

  it("a capture with no order id needs review without citing an order", async () => {
    const r = await runAgent(
      "PP-R-9",
      deps({
        getCapture: async () => ({
          id: "CAP9",
          amount: { value: "8.50", currency_code: "USD" },
          create_time: "2026-10-20T00:00:00Z",
          supplementary_data: { related_ids: {} },
        }),
      }),
    );
    expect(r.decision).toMatchObject({ verdict: "REVIEW", rule: "READ_FAILED" });
    expect(r.steps.find((s) => s.tool === "get_order")).toMatchObject({
      ok: false,
      summary: "No order id on the payment",
    });
    expect(r.records.some((record) => record.kind === "order")).toBe(false);
    for (const sentence of r.sentences)
      expect(r.records.find((record) => record.id === sentence.record_id)?.kind).not.toBe("order");
  });

  it("no tracking anywhere: the agent says so and does not fight", async () => {
    const r = await runAgent(
      "PP-R-9",
      deps({
        getCapture: async () => ({
          id: "CAP9",
          amount: { value: "8.50", currency_code: "USD" },
          create_time: "2026-10-20T00:00:00Z",
          supplementary_data: { related_ids: { order_id: "ORD9" } },
        }),
        getOrder: async () => ({ id: "ORD9", purchase_units: [{ description: "Planter", shipping: {} }] }),
        shipment: async () => undefined,
      }),
    );
    expect(r.decision.verdict).not.toBe("FIGHT");
    expect(r.steps.find((s) => s.tool === "get_tracking")?.summary).toBe("no shipping record");
  });

  it("filing refuses a response the dispute's links do not offer, without calling PayPal", async () => {
    const calls: string[] = [];
    const spy = new Proxy(
      {},
      {
        get: (_t, k) => async () => {
          calls.push(String(k));
        },
      },
    ) as any;
    const f = await fileResponse(
      spy,
      { ...dispute, links: [{ rel: "self" }], status: "UNDER_REVIEW", dispute_life_cycle_stage: "CHARGEBACK" },
      { ...explanation, verdict: "FIGHT", rule: "x", why: "y" },
      [{ text: "t", record_id: "r" }],
    );
    expect(f.ok).toBe(false);
    expect(f.detail).toContain("UNDER_REVIEW");
    expect(calls).toEqual([]);
  });

  it("sends files only with FIGHT evidence", async () => {
    const files = [{ name: "PP-R-9-evidence.pdf", type: "application/pdf", data: new Uint8Array([37, 80, 68, 70]) }];
    const calls: Array<{ method: string; args: any[] }> = [];
    const spy = new Proxy(
      {},
      {
        get:
          (_target, method) =>
          async (...args: any[]) =>
            calls.push({ method: String(method), args }),
      },
    ) as any;
    const sentences = [{ text: "The order arrived.", record_id: "r" }];

    const fight = await fileResponse(
      spy,
      { ...dispute, dispute_life_cycle_stage: "CHARGEBACK" },
      { ...explanation, verdict: "FIGHT", rule: "x", why: "y" },
      sentences,
      undefined,
      files,
    );
    expect(fight.detail).toBe("evidence filed with the evidence pack");
    expect(calls[0]).toMatchObject({
      method: "provideEvidence",
      args: ["PP-R-9", { evidences: expect.any(Array), files }],
    });

    calls.length = 0;
    const inquiryFight = await fileResponse(
      spy,
      dispute,
      { ...explanation, verdict: "FIGHT", rule: "x", why: "y" },
      sentences,
      undefined,
      files,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].method).toBe("provideEvidence");
    expect(calls[0].args[1]).not.toHaveProperty("files");
    expect(inquiryFight.detail).toBe("evidence filed; the evidence pack goes with a claim, not an inquiry");

    calls.length = 0;
    await fileResponse(
      spy,
      dispute,
      { ...explanation, verdict: "ACCEPT", rule: "x", why: "y" },
      sentences,
      undefined,
      files,
    );
    expect(calls[0].method).toBe("acceptClaim");
    expect(calls[0].args[1]).not.toHaveProperty("files");

    calls.length = 0;
    await fileResponse(
      spy,
      dispute,
      { ...explanation, verdict: "OFFER", rule: "x", why: "y", offerAmount: "4.00" },
      sentences,
      undefined,
      files,
    );
    expect(calls[0].method).toBe("makeOffer");
    expect(calls[0].args[1]).not.toHaveProperty("files");
  });
});
