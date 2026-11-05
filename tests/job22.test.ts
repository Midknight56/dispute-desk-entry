import { describe, expect, it, vi } from "vitest";
import { dropUnsupportedNumbers, runAgent, type AgentDeps, type EvidenceRecord } from "../src/agent";
import { fileResponse, noteFrom, type FileDeps } from "../src/file";
import { decide, type CaseFacts } from "../src/rules";
import { runProof } from "../src/proof";

const claimAt = "2026-11-05T00:52:00Z";
const deliveredAt = "2026-11-05T00:51:00Z";
const dispute = {
  dispute_id: "D22",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "WAITING_FOR_SELLER_RESPONSE",
  create_time: claimAt,
  dispute_amount: { value: "6.00", currency_code: "USD" },
  disputed_transactions: [{ seller_transaction_id: "C22", custom: "sale22" }],
  links: [{ rel: "provide_evidence" }],
};
const capture = {
  id: "C22",
  status: "COMPLETED",
  amount: { value: "6.00", currency_code: "USD" },
  create_time: "2026-11-04T00:00:00Z",
  supplementary_data: { related_ids: { order_id: "O22" } },
};
const trackingOrder = {
  id: "O22",
  status: "COMPLETED",
  purchase_units: [{ description: "Mug", shipping: { trackers: [{ id: "T22" }] } }],
};
const deps = (over: Partial<AgentDeps> = {}): AgentDeps => ({
  getDispute: async () => dispute,
  getCapture: async () => capture,
  getOrder: async () => trackingOrder,
  getTracker: async () => ({ status: "SHIPPED", carrier: "UPS", tracking_number: "ZX22" }),
  deliveredAt: async () => deliveredAt,
  ...over,
});
const plain = { text: "The order was Mug, no shipping address.", record_id: "O22" };
const reply = (...sentences: { text: string; record_id: string }[]) => JSON.stringify({ sentences });
const model = (...replies: string[]) => {
  let call = 0;
  return vi.fn<NonNullable<AgentDeps["model"]>>(async () => ({
    text: replies[call++] ?? "bad",
    usage: { prompt_tokens: 10, completion_tokens: 2 },
  }));
};
const record: EvidenceRecord = {
  id: "C22",
  kind: "capture",
  summary: "Payment C22: $6.00 paid on 2026-11-04",
  facts: { amount: 6, currency: "USD", status: "COMPLETED", dates: ["2026-11-04"] },
};
const base: CaseFacts = {
  reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
  amount: 6,
  currency: "USD",
  claimAt,
  hasCapture: true,
  hasOrder: true,
  captureRead: "ok",
  orderRead: "ok",
  trackingRead: "none",
  paymentStatus: "COMPLETED",
  paymentAmount: 6,
  paymentCurrency: "USD",
};

describe("job 22 delivery source", () => {
  it("keeps PayPal SHIPPED separate from a seller delivery and names the source throughout", async () => {
    const run = await runAgent("D22", deps());
    expect(run.decision).toMatchObject({
      verdict: "FIGHT",
      why: "Our shipping record shows it delivered 1 minute before the claim. PayPal tracking says SHIPPED.",
    });
    expect(run.decision.facts).toContainEqual({ label: "Tracking status (PayPal)", value: "SHIPPED", recordId: "T22" });
    expect(run.decision.facts).toContainEqual({
      label: "Delivered (our shipping record)",
      value: deliveredAt,
      recordId: "T22",
    });
    const tracking = run.records.find((r) => r.id === "T22")!;
    expect(tracking.facts).toMatchObject({ status: "SHIPPED", deliverySource: "seller", deliveredAt });
    expect(run.sentences.slice(0, 3)).toEqual([
      { text: "Our shipping record shows it delivered 2026-11-05 00:51 UTC.", record_id: "T22" },
      { text: "The buyer paid $6.00 on 2026-11-04.", record_id: "C22" },
      { text: "The tracking record shows UPS number ZX22, status SHIPPED on PayPal.", record_id: "T22" },
    ]);
    const correct = { text: "Our shipping record shows it delivered 2026-11-05 00:51 UTC.", record_id: "T22" };
    expect(dropUnsupportedNumbers([correct], [tracking]).ok).toEqual([correct]);
    expect(
      dropUnsupportedNumbers([{ text: "UPS shows it delivered.", record_id: "T22" }], [tracking]).bad,
    ).toHaveLength(1);
    expect(JSON.stringify(run)).not.toMatch(/UPS shows (?:it|the parcel) delivered/);
    // Text alone cannot grant seller provenance to a PayPal tracking record.
    expect(
      dropUnsupportedNumbers([correct], [{ ...tracking, facts: { ...tracking.facts, deliverySource: undefined } }]).bad,
    ).toHaveLength(1);
  });

  it("keeps the seller time source when PayPal says DELIVERED without a time", async () => {
    const run = await runAgent(
      "D22",
      deps({ getTracker: async () => ({ status: "DELIVERED", carrier: "UPS", tracking_number: "ZX22" }) }),
    );
    expect(run.records.find((r) => r.id === "T22")?.facts?.deliverySource).toBe("seller");
    expect(run.decision.why).toBe(
      "Our shipping record shows it delivered 1 minute before the claim. PayPal tracking says DELIVERED.",
    );
    expect(noteFrom(run.sentences)).not.toContain("PayPal tracking shows it delivered");
    expect(noteFrom(run.sentences)).toContain("Our shipping record");
  });
});

describe("job 22 evidence before money", () => {
  it("order 503 blocks a six dollar not as described ACCEPT through runAgent", async () => {
    const run = await runAgent(
      "D22",
      deps({
        getDispute: async () => ({ ...dispute, reason: base.reason }),
        getOrder: async () => {
          throw new Error("503 SERVICE_UNAVAILABLE");
        },
      }),
    );
    expect(run.decision).toMatchObject({
      verdict: "REVIEW",
      rule: "READ_FAILED",
      why: "PayPal did not return the order. Analyse again before you answer.",
    });
    expect(run.steps.find((s) => s.tool === "get_order")).toMatchObject({
      ok: false,
      summary: "503 SERVICE_UNAVAILABLE",
    });
    expect(noteFrom(run.sentences)).not.toContain("accept the claim");
    expect(decide({ ...base, orderRead: "none" }).verdict).toBe("ACCEPT");
    expect(decide({ ...base, orderRead: "ok" }).verdict).toBe("ACCEPT");
  });

  it.each([
    { value: "6.00", currency_code: "EUR" },
    { value: "5.99", currency_code: "USD" },
  ])("mismatched payment %j requires review through runAgent", async (amount) => {
    const run = await runAgent("D22", deps({ getCapture: async () => ({ ...capture, amount }) }));
    expect(run.decision).toMatchObject({
      verdict: "REVIEW",
      rule: "RECORDS_DISAGREE",
      why: "The payment and the dispute do not match. Answer this one on PayPal.",
    });
  });

  it.each(["REFUNDED", "PARTIALLY_REFUNDED", "DECLINED", "FAILED", "REVERSED"])(
    "%s payment requires review through runAgent",
    async (status) => {
      const run = await runAgent("D22", deps({ getCapture: async () => ({ ...capture, status }) }));
      expect(run.decision).toMatchObject({
        verdict: "REVIEW",
        rule: "PAYMENT_STATUS",
        why: `PayPal shows this payment as ${status}. Check it on PayPal before you answer.`,
      });
      expect(noteFrom(run.sentences)).not.toContain("The buyer paid");
      expect(run.sentences[0].text).toBe(
        `PayPal lists the payment of $6.00 as ${status.toLowerCase().replace(/_/g, " ")}.`,
      );
    },
  );

  it.each(["PENDING", "COMPLETED"])("%s on an open dispute still fights or accepts on the evidence", async (status) => {
    expect((await runAgent("D22", deps({ getCapture: async () => ({ ...capture, status }) }))).decision.verdict).toBe(
      "FIGHT",
    );
    const run = await runAgent(
      "D22",
      deps({
        getCapture: async () => ({ ...capture, status }),
        getDispute: async () => ({ ...dispute, reason: base.reason }),
        getOrder: async () => ({ id: "O22", purchase_units: [] }),
      }),
    );
    expect(run.decision.verdict).toBe("ACCEPT");
    if (status === "PENDING") expect(noteFrom(run.sentences)).not.toContain("The buyer paid");
  });

  it("a larger payment may cover a smaller dispute", () => {
    expect(decide({ ...base, paymentAmount: 7 }).verdict).toBe("ACCEPT");
  });
});

describe("job 22 consequential claims", () => {
  it("strikes a model payment-status sentence through the checker and an ACCEPT run", async () => {
    const text = "The payment was made successfully with code.";
    const sentence = { text, record_id: "C22" };
    expect(
      dropUnsupportedNumbers(
        [sentence],
        [
          {
            id: "C22",
            kind: "capture",
            summary: "Payment X: $7.50, status PENDING",
            facts: { amount: 7.5, currency: "USD", status: "PENDING" },
          },
        ],
        true,
      ).bad,
    ).toEqual([sentence]);
    const run = await runAgent(
      "D22",
      deps({
        getDispute: async () => ({
          ...dispute,
          reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
          dispute_amount: { value: "6.00", currency_code: "USD" },
        }),
        getCapture: async () => ({ ...capture, status: "PENDING", amount: { value: "7.50", currency_code: "USD" } }),
        getOrder: async () => ({ id: "O22", purchase_units: [] }),
        getTracker: async () => undefined,
        model: model('{"tools":[]}', reply(sentence)),
      }),
    );
    expect(run.decision.verdict).toBe("ACCEPT");
    expect(run.dropped).toContainEqual(sentence);
    expect(run.sentences).not.toContainEqual(sentence);
    expect(runProof().checker.rows.find((row) => row.text === text)).toMatchObject({
      struck: true,
      reason: "Payment status is written only by code.",
    });
  });

  it("strikes payment status even when the model copies a record value", () => {
    const sentence = { text: "The payment of $7.50 was made successfully.", record_id: "C22" };
    const payment: EvidenceRecord = {
      id: "C22",
      kind: "capture",
      summary: "Payment X: $7.50, status PENDING",
      facts: { amount: 7.5, currency: "USD", status: "PENDING" },
    };
    expect(dropUnsupportedNumbers([sentence], [payment], true).bad).toEqual([sentence]);
  });

  it("strikes a model sentence that contains no value from its cited record", () => {
    const sentence = { text: "The payment was recorded in the system.", record_id: "C22" };
    const payment: EvidenceRecord = {
      id: "C22",
      kind: "capture",
      summary: "Payment X: $7.50, status PENDING",
      facts: { amount: 7.5, currency: "USD", status: "PENDING" },
    };
    expect(dropUnsupportedNumbers([sentence], [payment], true).bad).toEqual([sentence]);
  });

  it("keeps an order sentence with a description and destination from its record", () => {
    const text = "The order was Hand thrown mug, shipping to Toronto, ON, CA.";
    const sentence = { text, record_id: "O22" };
    const order: EvidenceRecord = {
      id: "O22",
      kind: "order",
      summary: "Order O22: Hand thrown mug, shipping to Toronto, ON, CA",
    };
    expect(dropUnsupportedNumbers([sentence], [order], true).ok).toEqual([sentence]);
  });

  it.each([
    "The payment was refunded",
    "The buyer paid nothing",
    "The buyer agreed to withdraw the dispute.",
    "The payment was reversed.",
    "The order was cancelled.",
    "The seller consented.",
    "The buyer withdrew the claim.",
    "There was a chargeback.",
    "The buyer committed fraud.",
    "The buyer paid zero.",
    "The buyer paid less.",
    "The buyer paid $0.",
    "The buyer never paid.",
    "The payment is pending.",
    "The payment was declined.",
  ])("strikes unsupported consequential claim: %s", (text) => {
    const sentence = { text, record_id: record.id };
    expect(dropUnsupportedNumbers([sentence], [record])).toEqual({ ok: [], bad: [sentence] });
  });

  it("withdrawal does not survive runAgent or the actual filing note", async () => {
    const text = "The buyer agreed to withdraw the dispute.";
    const run = await runAgent("D22", deps({ model: model('{"tools":[]}', reply({ text, record_id: "C22" })) }));
    expect(run.writer).toBe("template");
    expect(run.dropped).toContainEqual({ text, record_id: "C22" });
    expect(noteFrom(run.sentences)).not.toContain(text);
    const api = {
      provideEvidence: vi.fn<FileDeps["provideEvidence"]>().mockResolvedValue({}),
      provideSupportingInfo: vi.fn<FileDeps["provideSupportingInfo"]>(),
      acceptClaim: vi.fn<FileDeps["acceptClaim"]>(),
      makeOffer: vi.fn<FileDeps["makeOffer"]>(),
    };
    await fileResponse(api, dispute, run.decision, run.sentences);
    expect(api.provideEvidence).toHaveBeenCalledTimes(1);
    expect(api.provideEvidence.mock.calls[0][1].evidences[0].notes).not.toContain(text);
  });

  it("code payment and delivery facts always lead and the draft has at most four sentences", async () => {
    const m = model('{"tools":[]}', '{"facts":["F4","F4","F1","F2"]}');
    const run = await runAgent("D22", deps({ model: m }));
    expect(run.writer).toBe("model");
    expect(run.sentences).toHaveLength(4);
    expect(run.sentences.map((s) => s.record_id)).toEqual(["T22", "O22", "C22", "T22"]);
    expect(run.sentences[1]).toEqual(plain);
    expect(run.sentences[0].text).toBe("Our shipping record shows it delivered 2026-11-05 00:51 UTC.");
  });

  it("cannot hide extra sentences in one model entry", async () => {
    const text = "The item was Mug. The item was Mug.";
    const run = await runAgent("D22", deps({ model: model('{"tools":[]}', reply({ text, record_id: "O22" })) }));
    expect(run.writer).toBe("template");
    expect(run.dropped).toContainEqual({ text, record_id: "O22" });
    expect(run.sentences).toHaveLength(4);
  });

  it("the proof retains old cases and strikes the three new altered sentences", () => {
    const proof = runProof();
    expect(proof.verdicts).toMatchObject({ total: 41, right: 41 });
    expect(proof.checker).toMatchObject({ total: 21, struck: 21 });
    for (const text of [
      "The payment was refunded",
      "The buyer paid nothing",
      "The buyer agreed to withdraw the dispute.",
      "The payment was made successfully with code.",
    ])
      expect(proof.checker.rows.find((r) => r.text === text)).toMatchObject({ struck: true });
    expect(
      proof.verdicts.rows.filter((r) => ["READ_FAILED", "RECORDS_DISAGREE", "PAYMENT_STATUS"].includes(r.rule)),
    ).toHaveLength(11);
  });
});

describe("job 22 writer shape retry", () => {
  it("legacy prose retries once, accepts a fact selection and adds usage", async () => {
    const bad = '{"sentences":["The item was Mug."]}';
    const m = model('{"tools":[]}', bad, '{"facts":["F4","F1","F2"]}');
    const run = await runAgent("D22", deps({ model: m }));
    expect(run.writer).toBe("model");
    expect(m).toHaveBeenCalledTimes(3);
    expect(run.usage).toEqual({ calls: 3, prompt_tokens: 30, completion_tokens: 6 });
    const retry = m.mock.calls[2][0].at(-1)!.content;
    expect(retry).toContain('{"facts":["F2","F1"]}');
    expect(run.sentences[1]).toEqual(plain);
  });

  it("two bad replies fall back to the template after exactly three calls", async () => {
    const m = model('{"tools":[]}', '{"sentences":["no id"]}', "text: Mug record_id: O22 text: UPS record_id: T22");
    const run = await runAgent("D22", deps({ model: m }));
    expect(run.writer).toBe("template");
    expect(m).toHaveBeenCalledTimes(3);
    expect(run.usage).toEqual({ calls: 3, prompt_tokens: 30, completion_tokens: 6 });
    expect(run.sentences).toHaveLength(4);
  });

  it("a readable first reply does not retry", async () => {
    const m = model('{"tools":[]}', '{"facts":["F4","F1"]}');
    const run = await runAgent("D22", deps({ model: m }));
    expect(run.writer).toBe("model");
    expect(m).toHaveBeenCalledTimes(2);
    expect(run.usage).toEqual({ calls: 2, prompt_tokens: 20, completion_tokens: 4 });
  });

  it("an unknown fact id triggers a retry and then a template", async () => {
    const m = model('{"tools":[]}', '{"facts":["F1","F9"]}');
    const run = await runAgent("D22", deps({ model: m }));
    expect(m).toHaveBeenCalledTimes(3);
    expect(run.writer).toBe("template");
    expect(run.dropped).toEqual([{ text: "F9 is not a listed fact", record_id: "F9" }]);
  });
});
