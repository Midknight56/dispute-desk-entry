import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { approvalBasis, fileResponse, operationTookEffect, type FilingOperation } from "../src/file";
import { runAgent } from "../src/agent";
import { store } from "../src/store";
import { resetTokenMemory } from "../src/token";
import { ctx, fakePayPal, makeEnv } from "./helpers/env";
import { supportedSentence } from "../src/sentence-facts";

const id = "PP-R4";
const at = "2026-11-05T10:00:00Z";
const later = "2026-11-05T10:01:00Z";
const dispute = {
  dispute_id: id,
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_life_cycle_stage: "INQUIRY",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  dispute_amount: { value: "6.00", currency_code: "USD" },
  disputed_transactions: [{ seller_transaction_id: "CAP-R4", custom: "dd-r4" }],
  links: [{ rel: "make_offer" }],
};
const sentences = [{ text: "The buyer paid $6.00.", record_id: "CAP-R4" }];
const basis = approvalBasis(dispute, "3.00");
const operation: FilingOperation = {
  action: "offer",
  requestId: "r4-original",
  versionAt: "r4-version",
  state: "uncertain",
  at,
};
const run = {
  version: operation.versionAt,
  basis,
  decision: { verdict: "OFFER", offerAmount: "3.00", why: "Partial offer." },
  sentences,
  records: [],
  dropped: [],
  steps: [],
  writer: "template",
  usage: { calls: 0 },
};
const proposal = {
  actor: "SELLER",
  event_type: "PROPOSED",
  offer_type: "REFUND",
  offer_time: later,
  offer_amount: { value: "3.00", currency_code: "USD" },
  notes: sentences[0].text,
};
type TestEnv = Awaited<ReturnType<typeof makeEnv>>["env"];
function post(env: TestEnv, action = "approve", version = run.version) {
  return worker.fetch(
    new Request(`https://desk.test/api/disputes/${id}/${action}`, {
      method: "POST",
      headers: { "x-desk-key": env.DESK_OWNER_KEY! },
      body: JSON.stringify({ version }),
    }),
    env,
    ctx().context,
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetTokenMemory();
});

describe("review4 item 1", () => {
  it("recognizes a schema shaped seller refund proposal", async () => {
    const d = { ...dispute, links: [], offer: { history: [proposal] } };
    expect(operationTookEffect(d, operation, sentences, basis)).toBe(true);
    const { env } = await makeEnv();
    await store(env.DB).putDispute({ id, status: dispute.status, data: { dispute, run, operation } });
    const calls = fakePayPal({ [`GET /v1/customer/disputes/${id}`]: { json: d } });
    expect((await post(env)).status).toBe(200);
    expect((await store(env.DB).getDispute(id))!.data.filed.ok).toBe(true);
    expect(calls.filter((c) => c.method !== "GET" && c.path !== "/v1/oauth2/token")).toHaveLength(0);
  });
  it.each([
    { actor: "BUYER" },
    { event_type: "ACCEPTED" },
    { offer_type: "REFUND_WITH_RETURN" },
    { offer_amount: { value: "2.00", currency_code: "USD" } },
    { offer_amount: { value: "3.00", currency_code: "EUR" } },
    { offer_time: at },
    { offer_time: "invalid" },
    { notes: "Different content" },
    { notes: undefined },
  ])("does not correlate a different proposal %j", (patch) => {
    expect(
      operationTookEffect({ ...dispute, offer: { history: [{ ...proposal, ...patch }] } }, operation, sentences, basis),
    ).toBe(false);
  });
});

describe("review4 item 2", () => {
  it.each(["fight", "accept"])(
    "serves a checked %s reconstruction and a real evidence pack with an empty pool",
    async (kind) => {
      const { env } = await makeEnv();
      const response = await worker.fetch(
        new Request(`https://desk.test/api/judge/next?kind=${kind}`),
        env,
        ctx().context,
      );
      const { replay }: any = await response.json();
      expect(replay.run.sentences.length).toBeGreaterThan(0);
      expect(replay.label).toMatch(/draft reconstruction/i);
      expect(replay.run.writer).toBe("template");
      expect(replay.run.decision.why.length).toBeGreaterThan(0);
      for (const sentence of replay.run.sentences) {
        const record = replay.run.records.find((r: any) => r.id === sentence.record_id);
        expect(record).toBeDefined();
        expect(supportedSentence(sentence.text, { ...record, decision: replay.run.decision })).toBe(true);
      }
      const pack = await worker.fetch(
        new Request(`https://desk.test/api/disputes/${replay.dispute.id}/pack.pdf`),
        env,
        ctx().context,
      );
      expect(pack.status).toBe(200);
      expect(pack.headers.get("content-type")).toBe("application/pdf");
      expect(new TextDecoder().decode((await pack.arrayBuffer()).slice(0, 5))).toBe("%PDF-");
      expect(await store(env.DB).getDispute(replay.dispute.id)).toBeNull();
    },
  );
});
describe("review4 item 3", () => {
  it("uses checked template facts when selection contains unknown ids", async () => {
    const result = await runAgent(id, {
      getDispute: async () => ({ ...dispute, dispute_amount: { value: "48.00", currency_code: "USD" } }),
      getCapture: async () => ({
        id: "CAP-R4",
        status: "COMPLETED",
        amount: { value: "48.00", currency_code: "USD" },
        supplementary_data: { related_ids: { order_id: "ORD-R4" } },
      }),
      getOrder: async () => ({ id: "ORD-R4", purchase_units: [{ description: "Mugs" }] }),
      getTracker: async () => undefined,
      deliveredAt: async () => undefined,
      model: async (_messages, kind) => ({
        text: kind === "toolChoice" ? '{"tools":["get_order"]}' : '{"facts":["F998","F999"]}',
      }),
    });
    expect(result.decision.verdict).toBe("OFFER");
    expect(result.writer).toBe("template");
    expect(result.sentences.length).toBeGreaterThan(0);
    for (const sentence of result.sentences)
      expect(
        supportedSentence(
          sentence.text,
          result.records.find((r) => r.id === sentence.record_id)!,
        ),
      ).toBe(true);
  });
  it.each([{ draft: [] }, { draft: [{ text: "   ", record_id: "CAP-R4" }] }])(
    "refuses an empty filing note before any write %j",
    async ({ draft }) => {
      const write = vi.fn();
      const result = await fileResponse(
        { makeOffer: write, acceptClaim: write, provideEvidence: write, provideSupportingInfo: write },
        dispute,
        {
          verdict: "OFFER",
          rule: "TEST",
          why: "Partial offer",
          facts: [],
          missing: [],
          changeIf: "",
          disagreements: [],
          offerAmount: "3.00",
        },
        draft,
      );
      expect(result.ok).toBe(false);
      expect(result.detail).toMatch(/empty/i);
      expect(write).not.toHaveBeenCalled();
    },
  );
});

describe("review4 item 4", () => {
  it.each(["supporting", "evidence"] as const)("keeps unrelated or old %s activity uncertain", async (action) => {
    const op = { ...operation, action };
    const entries = [
      { posted_by: "SELLER", content: "Please wait while we investigate", time_posted: later },
      { posted_by: "SELLER", content: sentences[0].text, time_posted: at },
      { posted_by: "SELLER", content: sentences[0].text },
    ];
    for (const entry of entries) {
      const d = {
        ...dispute,
        links: [],
        messages: [entry],
        evidences: [
          {
            source: "SUBMITTED_BY_SELLER",
            evidence_type: "PROOF_OF_FULFILLMENT",
            notes: entry.content,
            date: entry.time_posted,
          },
        ],
      };
      const { env } = await makeEnv();
      await store(env.DB).putDispute({
        id,
        status: dispute.status,
        data: {
          dispute,
          run: { ...run, basis: { ...basis, offerAmount: null }, decision: { verdict: "FIGHT" } },
          operation: op,
        },
      });
      const calls = fakePayPal({ [`GET /v1/customer/disputes/${id}`]: { json: d } });
      expect((await post(env)).status).toBe(202);
      const saved = (await store(env.DB).getDispute(id))!.data;
      expect(saved.filed).toBeUndefined();
      expect(saved.operation.state).toBe("uncertain");
      expect(calls.filter((c) => c.method !== "GET" && c.path !== "/v1/oauth2/token")).toHaveLength(0);
    }
  });
  it("requires evidence type and submitted tracking identity as well as note and time", () => {
    const op = {
      ...operation,
      action: "evidence" as const,
      proof: { note: sentences[0].text, trackingNumber: "TRACK-R4" },
    };
    const evidence = {
      source: "SUBMITTED_BY_SELLER",
      evidence_type: "PROOF_OF_FULFILLMENT",
      notes: sentences[0].text,
      date: later,
      evidence_info: { tracking_info: [{ tracking_number: "TRACK-R4" }] },
    };
    expect(operationTookEffect({ evidences: [evidence] }, op, sentences, basis)).toBe(true);
    expect(operationTookEffect({ evidences: [{ ...evidence, evidence_type: "OTHER" }] }, op, sentences, basis)).toBe(
      false,
    );
    expect(operationTookEffect({ evidences: [{ ...evidence, evidence_info: {} }] }, op, sentences, basis)).toBe(false);
    expect(
      operationTookEffect(
        { messages: [{ posted_by: "SELLER", content: sentences[0].text, time_posted: later }] },
        op,
        sentences,
        basis,
      ),
    ).toBe(false);
    expect(
      operationTookEffect(
        { supporting_info: [{ source: "SUBMITTED_BY_SELLER", notes: sentences[0].text, provided_time: later }] },
        { ...operation, action: "supporting" },
        sentences,
        basis,
      ),
    ).toBe(true);
  });
  it("does not infer a seller acceptance from a later buyer outcome", () => {
    expect(
      operationTookEffect(
        {
          ...dispute,
          status: "RESOLVED",
          update_time: later,
          dispute_outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR", amount_refunded: dispute.dispute_amount },
        },
        { ...operation, action: "accept" },
        sentences,
        basis,
      ),
    ).toBe(false);
  });
});

describe("review4 item 5", () => {
  it("keeps the original uncertain outcome blocked when a retry is refused", async () => {
    const { env } = await makeEnv();
    await store(env.DB).putDispute({ id, status: dispute.status, data: { dispute, run, operation } });
    const calls = fakePayPal({
      [`GET /v1/customer/disputes/${id}`]: { json: dispute },
      [`POST /v1/customer/disputes/${id}/make-offer`]: { json: { name: "ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE" }, status: 422 },
    });
    expect((await post(env)).status).toBe(202);
    const saved = (await store(env.DB).getDispute(id))!.data;
    expect(saved.operation).toMatchObject({ state: "uncertain", requestId: operation.requestId });
    expect(saved.filed).toBeUndefined();
    expect((await post(env, "analyse")).status).toBe(409);
    expect(calls.find(call => call.path.endsWith("/make-offer"))?.headers.get("PayPal-Request-Id")).toBe(operation.requestId);
  });
  it("keeps the original uncertain filing in an explicit conflict with a PayPal handoff", async () => {
    const { env } = await makeEnv();
    const original = { ...operation, action: "accept" };
    const originalRun = { ...run, basis: approvalBasis(dispute), decision: { verdict: "ACCEPT" } };
    await store(env.DB).putDispute({
      id,
      status: dispute.status,
      data: { dispute, run: originalRun, operation: original },
    });
    const changed = { ...dispute, dispute_amount: { value: "600.00", currency_code: "USD" } };
    const calls = fakePayPal({ [`GET /v1/customer/disputes/${id}`]: { json: changed } });
    const response = await post(env);
    expect(response.status).toBe(202);
    const body: any = await response.json();
    expect(body.conflict).toMatchObject({ changed: ["amount"], paypalUrl: "https://www.sandbox.paypal.com/" });
    expect(body.error).not.toMatch(/Analyse again/);
    const analysis = await post(env, "analyse");
    expect(analysis.status).toBe(409);
    expect(await analysis.json()).toMatchObject({ conflict: body.conflict });
    expect((await post(env)).status).toBe(202);
    const saved = (await store(env.DB).getDispute(id))!.data;
    expect(saved.operation).toEqual(original);
    expect(saved.run).toEqual(originalRun);
    expect(saved.filed).toBeUndefined();
    expect(saved.filing).toBeUndefined();
    expect(calls.filter((c) => c.method !== "GET" && c.path !== "/v1/oauth2/token")).toHaveLength(0);
  });
  it("clears a filing known never sent so changed facts can be analysed", async () => {
    const { env } = await makeEnv();
    await store(env.DB).putDispute({
      id,
      status: dispute.status,
      data: { dispute, run, operation: { ...operation, state: "sending", sent: false } },
    });
    const d = { ...dispute, dispute_amount: { value: "600.00", currency_code: "USD" } };
    fakePayPal({ [`GET /v1/customer/disputes/${id}`]: { json: d } });
    expect((await post(env)).status).toBe(409);
    expect((await store(env.DB).getDispute(id))!.data.operation).toBeUndefined();
    expect((await post(env, "analyse")).status).toBe(200);
  });
  it("reconciles an original offer after facts change without submitting again", async () => {
    const { env } = await makeEnv();
    await store(env.DB).putDispute({ id, status: dispute.status, data: { dispute, run, operation } });
    const replies = {
      [`GET /v1/customer/disputes/${id}`]: {
        json: {
          ...dispute,
          dispute_amount: { value: "600.00", currency_code: "USD" },
          links: [],
          offer: { history: [] as unknown[] },
        },
      },
    };
    const calls = fakePayPal(replies);
    expect((await post(env)).status).toBe(202);
    replies[`GET /v1/customer/disputes/${id}`].json.offer.history = [proposal];
    expect((await post(env)).status).toBe(200);
    const saved = (await store(env.DB).getDispute(id))!.data;
    expect(saved.filed.ok).toBe(true);
    expect(saved.filingConflict).toBeUndefined();
    expect(calls.filter((c) => c.method !== "GET" && c.path !== "/v1/oauth2/token")).toHaveLength(0);
  });
});
