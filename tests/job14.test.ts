import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent, dropUnsupportedNumbers, type AgentDeps, type EvidenceRecord } from "../src/agent";
import { decide, finalDecision, type CaseFacts, type Decision } from "../src/rules";
import { fileResponse, noteFrom, type FileDeps } from "../src/file";
import worker from "../src/index";
import { makeEnv, fakePayPal, ctx } from "./helpers/env";
import { resetTokenMemory } from "../src/token";

const base: CaseFacts = {
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  amount: 6,
  currency: "USD",
  claimAt: "2026-10-20T12:00:00Z",
  hasCapture: true,
  hasOrder: true,
  captureRead: "ok",
  trackingRead: "none",
  disputeId: "D14",
  captureId: "CAP14",
};
const dispute = {
  dispute_id: "D14",
  reason: base.reason,
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_life_cycle_stage: "INQUIRY",
  create_time: base.claimAt,
  dispute_amount: { value: "6.00", currency_code: "USD" },
  disputed_transactions: [{ seller_transaction_id: "CAP14", custom: "dd-14" }],
  links: [{ rel: "accept_claim" }, { rel: "make_offer" }, { rel: "provide_evidence" }],
};
const cap = {
  id: "CAP14",
  status: "COMPLETED",
  amount: { value: "6.00", currency_code: "USD" },
  create_time: "2026-10-18T12:00:00Z",
  supplementary_data: { related_ids: { order_id: "ORD14" } },
};
const order = { id: "ORD14", status: "COMPLETED", purchase_units: [{ description: "Mug", shipping: {} }] };
const deps = (over: Partial<AgentDeps> = {}): AgentDeps => ({
  getDispute: async () => dispute,
  getCapture: async () => cap,
  getOrder: async () => order,
  getTracker: async () => ({ status: "DELIVERED", carrier: "UPS", tracking_number: "0012345678" }),
  deliveredAt: async () => "2026-10-19T12:00:00Z",
  ...over,
});
const filingDeps = () => ({
  provideEvidence: vi.fn<FileDeps["provideEvidence"]>().mockResolvedValue({}),
  provideSupportingInfo: vi.fn<FileDeps["provideSupportingInfo"]>().mockResolvedValue({}),
  acceptClaim: vi.fn<FileDeps["acceptClaim"]>().mockResolvedValue({}),
  makeOffer: vi.fn<FileDeps["makeOffer"]>().mockResolvedValue({}),
});
const trackingOrder = { ...order, purchase_units: [{ shipping: { trackers: [{ id: "TRACK14" }] } }] };

afterEach(() => {
  vi.unstubAllGlobals();
  resetTokenMemory();
});

describe("job 14 review and policy", () => {
  it("capture read 503 gives REVIEW through runAgent before a small refund", async () => {
    const run = await runAgent(
      "D14",
      deps({
        getCapture: async () => {
          throw new Error("503 SERVICE_UNAVAILABLE");
        },
      }),
    );
    expect(run.decision).toMatchObject({
      verdict: "REVIEW",
      rule: "READ_FAILED",
      why: "PayPal did not return the payment. Analyse again before you answer.",
    });
    expect(run.steps.find((s) => s.tool === "get_capture")).toMatchObject({
      ok: false,
      summary: "503 SERVICE_UNAVAILABLE",
    });
  });

  it.each(["EUR", "JPY"])("%s six gives REVIEW through runAgent", async (currency) => {
    const run = await runAgent(
      "D14",
      deps({
        getDispute: async () => ({ ...dispute, dispute_amount: { value: "6", currency_code: currency } }),
        getCapture: async () => ({ ...cap, amount: { value: "6", currency_code: currency } }),
      }),
    );
    expect(run.decision).toMatchObject({ verdict: "REVIEW", rule: "CURRENCY_NOT_SUPPORTED" });
  });

  it("a failed tracker read gives REVIEW even below the fight line", async () => {
    const run = await runAgent(
      "D14",
      deps({
        getOrder: async () => trackingOrder,
        getTracker: async () => {
          throw new Error("503");
        },
      }),
    );
    expect(run.decision).toMatchObject({
      verdict: "REVIEW",
      rule: "READ_FAILED",
      why: "PayPal did not return the tracking. Analyse again before you answer.",
    });
  });

  it("a missing capture response or reference needs review", async () => {
    for (const over of [
      { getCapture: async () => ({}) },
      { getDispute: async () => ({ ...dispute, disputed_transactions: [] }) },
    ])
      expect((await runAgent("D14", deps(over))).decision).toMatchObject({ verdict: "REVIEW", rule: "READ_FAILED" });
  });

  it("an existing tracker is read for not as described and a failure needs review", async () => {
    const run = await runAgent(
      "D14",
      deps({
        getDispute: async () => ({ ...dispute, reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED" }),
        getOrder: async () => trackingOrder,
        getTracker: async () => {
          throw new Error("503");
        },
      }),
    );
    expect(run.decision).toMatchObject({ verdict: "REVIEW", rule: "READ_FAILED" });
  });

  it("missing payment and unsupported reason stop before the delivery rule", () => {
    const delivery = { status: "DELIVERED", deliveredAt: "2026-10-19T12:00:00Z" };
    expect(decide({ ...base, hasCapture: false, tracking: delivery }).rule).toBe("READ_FAILED");
    expect(decide({ ...base, captureRead: "failed", tracking: delivery }).verdict).toBe("REVIEW");
    expect(decide({ ...base, reason: "SERVICE_NOT_RECEIVED", tracking: delivery })).toMatchObject({
      verdict: "REVIEW",
      rule: "REASON_NOT_SUPPORTED",
      why: "This desk does not decide this kind of dispute. Answer it on PayPal.",
    });
  });

  it("failed order or seller shipping reads do not masquerade as no tracking", async () => {
    for (const over of [
      {
        getOrder: async () => {
          throw new Error("503");
        },
      },
      {
        shipment: async () => {
          throw new Error("shipping read failed");
        },
      },
      {
        getOrder: async () => trackingOrder,
        deliveredAt: async () => {
          throw new Error("date read failed");
        },
      },
    ])
      expect((await runAgent("D14", deps(over))).decision.verdict).toBe("REVIEW");
  });

  it("REVIEW files nothing and finalDecision preserves it", async () => {
    const decision = decide({ ...base, hasCapture: false });
    expect(finalDecision(decision, [], base)).toBe(decision);
    const api = filingDeps();
    expect(await fileResponse(api, dispute, decision, [])).toEqual({
      call: "",
      ok: false,
      detail: `needs review: ${decision.why}`,
    });
    Object.values(api).forEach((call) => expect(call).not.toHaveBeenCalled());
  });

  it("policy values change the line and offer share including finalDecision", async () => {
    const policy = { FIGHT_LINE_USD: "5", OFFER_SHARE: "0.25" };
    expect(decide(base).verdict).toBe("ACCEPT");
    expect(decide(base, policy)).toMatchObject({ verdict: "OFFER", offerAmount: "1.50" });
    expect((await runAgent("D14", deps({ policy }))).decision.offerAmount).toBe("1.50");
    const fight = decide({ ...base, tracking: { status: "DELIVERED", deliveredAt: "2026-10-19" } });
    expect(finalDecision(fight, [], base, policy)).toMatchObject({ verdict: "OFFER", offerAmount: "1.50" });
    expect(decide({ ...base, amount: 12 }, { FIGHT_LINE_USD: 20 }).verdict).toBe("ACCEPT");
    expect(decide(base, { FIGHT_LINE_USD: 0, OFFER_SHARE: 0 }).offerAmount).toBe("0.00");
    expect(decide(base, { FIGHT_LINE_USD: 0, OFFER_SHARE: 1 }).offerAmount).toBe("6.00");
  });

  it.each(["bad", "", " ", -1, Infinity, NaN, null, true, {}])("bad policy value %s uses defaults", (bad) => {
    expect(decide(base, { FIGHT_LINE_USD: bad }).verdict).toBe("ACCEPT");
    expect(decide({ ...base, amount: 48 }, { OFFER_SHARE: bad }).offerAmount).toBe("24.00");
  });
  it("an offer share over one uses the default", () => {
    expect(decide({ ...base, amount: 48 }, { OFFER_SHARE: 1.1 }).offerAmount).toBe("24.00");
  });

  it("every verdict explains its facts, missing records and change condition", () => {
    const outcomes = [
      decide(base),
      decide({ ...base, amount: 48 }),
      decide({ ...base, hasCapture: false }),
      decide({ ...base, tracking: { status: "DELIVERED", deliveredAt: "2026-10-19" } }),
    ];
    expect(new Set(outcomes.map((d) => d.verdict)).size).toBe(4);
    outcomes.forEach((d) => {
      expect(d.facts.length).toBeGreaterThan(0);
      expect(d.changeIf.length).toBeGreaterThan(0);
      expect(Array.isArray(d.missing)).toBe(true);
    });
  });
});

describe("job 14 sentence facts", () => {
  const record: EvidenceRecord = {
    id: "CAP14",
    kind: "capture",
    summary: "Payment CAP14: $48.00 paid on 2026-10-19",
    facts: { amount: 48, currency: "USD", status: "COMPLETED", dates: ["2026-10-19"] },
  };
  const check = (text: string, source = record) => dropUnsupportedNumbers([{ text, record_id: source.id }], [source]);
  it.each([
    "The buyer paid $8.00.",
    "The buyer paid EUR 48.00.",
    "The buyer paid $48.00 on 2026-02-30.",
    "The item was delivered.",
    "The buyer never paid.",
  ])("strikes altered fact: %s", (text) => {
    expect(check(text).bad).toEqual([{ text, record_id: record.id }]);
  });
  it.each(["never paid", "did not pay", "unpaid", "payment failed", "no payment"])(
    "requires evidence for %s",
    (claim) => {
      expect(check(`The buyer ${claim}.`).bad).toHaveLength(1);
      expect(check(`The buyer ${claim}.`, { ...record, kind: "order", facts: {} }).bad).toHaveLength(1);
    },
  );
  it("permits an unpaid fact only when the record states it", () => {
    expect(check("The payment failed.", { ...record, facts: { status: "FAILED", unpaid: true } }).ok).toHaveLength(1);
  });
  it.each(["EUR", "€", "â‚¬", "GBP", "£", "Â£", "JPY", "¥", "Â¥", "CAD"])("rejects a false %s currency", (currency) => {
    expect(check(`The buyer paid ${currency} 48.00.`).bad).toHaveLength(1);
  });
  it("compares whole values and real dates including older saved records", () => {
    for (const source of [record, { ...record, facts: undefined }]) {
      expect(check("The buyer paid $48 on October 19, 2026.", source).bad).toHaveLength(1);
      expect(check("The buyer paid $48.00 on 2026-10-19.", source).ok).toHaveLength(1);
      expect(check("The buyer paid $8.00.", source).bad).toHaveLength(1);
      expect(check("The buyer paid $-48.00.", source).bad).toHaveLength(1);
      expect(check("The buyer paid -$48.00.", source).bad).toHaveLength(1);
      expect(check("The buyer paid $48.00 on 2026-10-18.", source).bad).toHaveLength(1);
    }
    expect(check("The buyer paid XPF 48.00.").bad).toHaveLength(1);
    expect(
      check("The buyer paid XPF 48.", { ...record, facts: { amount: 48, currency: "XPF", status: "COMPLETED" } }).ok,
    ).toHaveLength(1);
  });
  it("a numeric tracking number must match exactly including leading zeros", () => {
    const source: EvidenceRecord = {
      id: "T14",
      kind: "tracking",
      summary: "Tracking T14: UPS number 0012345678, status DELIVERED",
      facts: { status: "DELIVERED", trackingNumber: "0012345678" },
    };
    const approved = "The tracking record shows UPS number 0012345678, status DELIVERED on PayPal.";
    expect(check(approved, source).ok).toHaveLength(1);
    expect(check(approved.replace("0012345678", "12345678"), source).bad).toHaveLength(1);
    expect(check(approved.replace("0012345678", "2345"), source).bad).toHaveLength(1);
    const seller = { ...source, id: "ship-14" };
    expect(check("The item was delivered.", seller).bad).toHaveLength(1);
    expect(check("Our shipping record shows the item was delivered.", seller).bad).toHaveLength(1);
    expect(
      check(approved.replace("The tracking record", "Our shipping record").replace(" on PayPal", ""), seller).ok,
    ).toHaveLength(1);
    expect(check("The item was received.", { ...source, facts: { status: "SHIPPED" } }).bad).toHaveLength(1);
    const saved = { ...source, facts: undefined };
    expect(check("UPS delivered 12345678.", saved).bad).toHaveLength(1);
    expect(check(approved, saved).ok).toHaveLength(1);
  });
  it("drops never paid through runAgent and keeps it out of the filing note", async () => {
    let call = 0;
    const run = await runAgent(
      "D14",
      deps({
        model: async () => ({
          text:
            ++call === 1
              ? '{"tools":["get_order"]}'
              : '{"sentences":[{"text":"The buyer never paid.","record_id":"CAP14"}]}',
        }),
      }),
    );
    expect(run.dropped).toContainEqual({ text: "The buyer never paid.", record_id: "CAP14" });
    expect(noteFrom(run.sentences)).not.toContain("never paid");
    const api = filingDeps();
    await fileResponse(api, dispute, run.decision, run.sentences);
    expect(api.acceptClaim.mock.calls[0][1].note).not.toContain("never paid");
  });
  it("template fallback keeps checked sentences for a delivered fight and an accept", async () => {
    for (const [over, verdict] of [
      [{}, "ACCEPT"],
      [{ getOrder: async () => trackingOrder }, "FIGHT"],
    ] as const) {
      const run = await runAgent("D14", deps(over));
      expect(run.writer).toBe("template");
      expect(run.decision.verdict).toBe(verdict);
      expect(run.sentences.length).toBeGreaterThan(0);
      if (verdict === "FIGHT") expect(run.sentences.some((s) => s.record_id === "TRACK14")).toBe(true);
      expect(dropUnsupportedNumbers(run.sentences, run.records).bad).toEqual([]);
    }
  });
  it("a template sentence that fails the same checks stays visible as dropped", async () => {
    const run = await runAgent(
      "D14",
      deps({
        getOrder: async () => ({
          ...trackingOrder,
          purchase_units: [{ ...trackingOrder.purchase_units[0], description: "The item was delivered" }],
        }),
      }),
    );
    expect(run.decision.verdict).toBe("FIGHT");
    expect(run.dropped.some((s) => s.record_id === "ORD14" && s.text.includes("The item was delivered"))).toBe(true);
    expect(noteFrom(run.sentences)).not.toContain("The item was delivered");
  });
});

describe("job 14 filing request ids", () => {
  it.each([
    ["FIGHT", "provide_evidence", "provideEvidence", "evidence"],
    ["FIGHT", "provide_supporting_info", "provideSupportingInfo", "supporting"],
    ["ACCEPT", "accept_claim", "acceptClaim", "accept"],
    ["OFFER", "make_offer", "makeOffer", "offer"],
  ] as const)("%s via %s repeats the stable request id", async (verdict, rel, method, action) => {
    const api = filingDeps();
    const decision: Decision = { ...decide(base), verdict, offerAmount: "3.00" };
    for (const id of ["D14", "D".repeat(150)]) {
      for (let i = 0; i < 2; i++)
        await fileResponse(api as FileDeps, { ...dispute, dispute_id: id, links: [{ rel }] }, decision, [{ text: "Approved response.", record_id: id }]);
      const calls = api[method].mock.calls.slice(-2);
      const options = calls.map(
        (args) => args[method === "provideSupportingInfo" ? 2 : 1] as { requestId: string; acceptClaimType?: string },
      );
      expect(options[0].requestId).toBe(options[1].requestId);
      expect(options[0].requestId.length).toBeLessThanOrEqual(100);
      expect(options[0].requestId).toMatch(new RegExp(`^dd-.*-${action}-[0-9a-f]{12}$`));
      if (id === "D14") expect(options[0].requestId).toMatch(new RegExp(`^dd-D14-${action}-[0-9a-f]{12}$`));
      if (verdict === "ACCEPT") {
        expect(options[0]).not.toHaveProperty("acceptClaimReason");
        expect(options[0].acceptClaimType).toBe("REFUND");
      }
    }
  });

  it("uses a new request id when the draft note changes", async () => {
    const api = filingDeps();
    const decision: Decision = { ...decide(base), verdict: "FIGHT" };
    const draft = (text: string) => [{ text, record_id: "CAP14" }];
    await fileResponse(api, { ...dispute, links: [{ rel: "provide_evidence" }] }, decision, draft("Same note."));
    await fileResponse(api, { ...dispute, links: [{ rel: "provide_evidence" }] }, decision, draft("Same note."));
    await fileResponse(api, { ...dispute, links: [{ rel: "provide_evidence" }] }, decision, draft("Changed note."));
    const ids = api.provideEvidence.mock.calls.map((call) => call[1].requestId);
    expect(ids[0]).toBe(ids[1]);
    expect(ids[2]).not.toBe(ids[0]);
  });
});

describe("job 14 local routes", () => {
  it("reads policy from env through the analyse route", async () => {
    const { env } = await makeEnv();
    Object.assign(env, { FIGHT_LINE_USD: "5", OFFER_SHARE: "0.25" });
    fakePayPal({
      "GET /v1/customer/disputes/D14": { json: dispute },
      "GET /v2/payments/captures/CAP14": { json: cap },
      "GET /v2/checkout/orders/ORD14": { json: order },
    });
    const response = await worker.fetch(
      new Request("https://desk.test/api/disputes/D14/analyse", {
        method: "POST",
        headers: { "x-desk-key": env.DESK_OWNER_KEY! },
      }),
      env,
      ctx().context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ run: { decision: { verdict: "OFFER", offerAmount: "1.50" } } });
  });
  it("a stored REVIEW is refused with 422 and no filing write", async () => {
    const { env, DB } = await makeEnv();
    const run = await runAgent(
      "D14",
      deps({
        getCapture: async () => {
          throw new Error("503");
        },
      }),
    );
    run.version = "stored-version";
    await DB.prepare("INSERT INTO disputes (id, data, updated_at) VALUES (?, ?, ?)")
      .bind("D14", JSON.stringify({ dispute, run: { ...run, basis: {
        amount: dispute.dispute_amount.value, currency: dispute.dispute_amount.currency_code,
        status: dispute.status, stage: dispute.dispute_life_cycle_stage, reason: dispute.reason,
        captureId: dispute.disputed_transactions[0].seller_transaction_id, offerAmount: null,
      } } }), new Date().toISOString())
      .run();
    const calls = fakePayPal({ "GET /v1/customer/disputes/D14": { json: dispute } });
    const response = await worker.fetch(
      new Request("https://desk.test/api/disputes/D14/approve", {
        method: "POST",
        headers: { "x-desk-key": env.DESK_OWNER_KEY!, "content-type": "application/json" },
        body: JSON.stringify({ version: run.version }),
      }),
      env,
      ctx().context,
    );
    expect(response.status).toBe(422);
    expect(await response.json()).toMatchObject({ filed: { ok: false, detail: `needs review: ${run.decision.why}` } });
    expect(calls.filter((c) => c.method === "POST" && c.path !== "/v1/oauth2/token")).toEqual([]);
  });
});
