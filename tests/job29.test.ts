import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { operationTookEffect, type FilingOperation } from "../src/file";
import { store } from "../src/store";
import { resetTokenMemory } from "../src/token";
import { ctx, fakePayPal, makeEnv } from "./helpers/env";

const id = "PP-J29";
const dispute = {
  dispute_id: id,
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_life_cycle_stage: "INQUIRY",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  dispute_amount: { value: "6.00", currency_code: "USD" },
  disputed_transactions: [{ seller_transaction_id: "CAP-J29", custom: "dd-j29" }],
  links: [{ rel: "accept_claim" }],
};
const basis = {
  amount: "6.00",
  currency: "USD",
  status: dispute.status,
  stage: "INQUIRY",
  reason: dispute.reason,
  captureId: "CAP-J29",
  offerAmount: null as string | null,
};
const run = {
  version: "j29-version",
  basis,
  decision: { verdict: "ACCEPT", why: "No delivery record." },
  sentences: [{ text: "The claim is accepted.", record_id: "CAP-J29" }],
  records: [],
  dropped: [],
  steps: [],
  writer: "template",
  usage: { calls: 0, prompt_tokens: 0, completion_tokens: 0 },
};
const operation: FilingOperation = {
  action: "accept",
  at: "2026-11-05T10:00:00Z",
  versionAt: run.version,
  state: "uncertain",
  requestId: "j29-stored-request",
};
const later = "2026-11-05T10:00:01Z";
const earlier = "2026-11-05T09:59:59Z";
const resolved = {
  ...dispute,
  status: "RESOLVED",
  links: [],
  update_time: later,
  dispute_outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR", amount_refunded: dispute.dispute_amount },
};
const offer = (value = "3.00", time = later, actor = "SELLER", currency = "USD") => ({
  actor,
  offer_time: time,
  event_type: "PROPOSED", offer_type: "REFUND", notes: run.sentences[0].text,
  offer_amount: { value, currency_code: currency },
});
type TestEnv = Awaited<ReturnType<typeof makeEnv>>["env"];
const routes = (d: unknown = dispute) => ({
  [`GET /v1/customer/disputes/${id}`]: { json: d },
  [`POST /v1/customer/disputes/${id}/accept-claim`]: { json: {} },
  "GET /v2/payments/captures/CAP-J29": { json: { id: "CAP-J29", status: "COMPLETED", amount: dispute.dispute_amount } },
});
async function seed(env: TestEnv, draft: unknown = run) {
  await store(env.DB).putDispute({ id, status: dispute.status, data: { dispute, run: draft } });
}
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

describe("job 29 positive filing proof", () => {
  it.each([
    ["buyer refund", resolved],
    [
      "buyer outcome without optional refund",
      { ...resolved, dispute_outcome: { outcome_code: "RESOLVED_BUYER_FAVOUR" } },
    ],
  ])("does not infer accept from %s", (_label, d) => {
    expect(operationTookEffect(d, operation, run.sentences, basis)).toBe(false);
  });

  it.each([
    ["missing links", { ...dispute, links: [] }],
    ["resolution without outcome", { ...resolved, dispute_outcome: undefined }],
    ["seller outcome", { ...resolved, dispute_outcome: { outcome_code: "RESOLVED_SELLER_FAVOUR" } }],
    ["old resolution", { ...resolved, update_time: earlier }],
    ["same time", { ...resolved, update_time: operation.at }],
    ["missing time", { ...resolved, update_time: undefined }],
    ["invalid time", { ...resolved, update_time: "invalid" }],
    [
      "partial refund",
      {
        ...resolved,
        dispute_outcome: { ...resolved.dispute_outcome, amount_refunded: { value: "3.00", currency_code: "USD" } },
      },
    ],
    [
      "other currency",
      {
        ...resolved,
        dispute_outcome: { ...resolved.dispute_outcome, amount_refunded: { value: "6.00", currency_code: "EUR" } },
      },
    ],
  ])("does not confirm accept on %s", (_label, d) => {
    expect(operationTookEffect(d, operation, run.sentences, basis)).toBe(false);
  });

  it.each(["evidence", "supporting"] as const)("requires matching timed %s records", action => {
    const op = { ...operation, action };
    const d = action === "evidence"
      ? { evidences: [{ source: "SUBMITTED_BY_SELLER", evidence_type: "PROOF_OF_FULFILLMENT", notes: run.sentences[0].text, date: later }] }
      : { supporting_info: [{ source: "SUBMITTED_BY_SELLER", notes: run.sentences[0].text, provided_time: later }] };
    expect(operationTookEffect(d, op, run.sentences, basis)).toBe(true);
    expect(operationTookEffect({ ...dispute, messages: [{ posted_by: "SELLER", content: "Other", time_posted: later }] }, op, run.sentences, basis)).toBe(false);
    expect(operationTookEffect({ evidences: [{ source: "SUBMITTED_BY_SELLER", notes: run.sentences[0].text, date: earlier }] }, op, run.sentences, basis)).toBe(false);
  });

  it("confirms only a later seller offer for the approved amount and currency", () => {
    const op = { ...operation, action: "offer" as const };
    const approved = { ...basis, offerAmount: "3.00" };
    expect(operationTookEffect({ ...dispute, offer: { history: [offer("3.0")] } }, op, run.sentences, approved)).toBe(true);
    for (const entry of [
      offer("2.00"),
      offer("3.00", earlier),
      offer("3.00", operation.at),
      offer("3.00", later, "BUYER"),
      offer("3.00", later, "SELLER", "EUR"),
      offer("3.00", "invalid"),
    ]) {
      expect(operationTookEffect({ ...dispute, links: [], offer: { history: [entry] } }, op, run.sentences, approved)).toBe(
        false,
      );
    }
  });

  it.each([
    ["another amount", offer("2.00")],
    ["an earlier time", offer("3.00", earlier)],
  ])("keeps an offer with %s uncertain without another write when links are absent", async (_label, entry) => {
    const { env } = await makeEnv();
    await seed(env, {
      ...run,
      basis: { ...basis, offerAmount: "3.00" },
      decision: { verdict: "OFFER", offerAmount: "3.00" },
    });
    await store(env.DB).mergeData(id, { operation: { ...operation, action: "offer" } });
    const calls = fakePayPal(routes({ ...dispute, links: [], offer: { history: [entry] } }));
    expect((await post(env)).status).toBe(202);
    const saved = (await store(env.DB).getDispute(id))!.data;
    expect(saved.filed).toBeUndefined();
    expect(saved.operation.state).toBe("uncertain");
    expect(calls.filter((c) => c.method !== "GET" && c.path !== "/v1/oauth2/token")).toHaveLength(0);
  });

  it.each(["accept", "evidence", "supporting", "offer"] as const)(
    "keeps %s uncertain with no links and no proof",
    async (action) => {
      const { env } = await makeEnv();
      const verdict = action === "accept" ? "ACCEPT" : action === "offer" ? "OFFER" : "FIGHT";
      await seed(env, {
        ...run,
        basis: { ...basis, offerAmount: action === "offer" ? "3.00" : null },
        decision: { verdict, ...(action === "offer" ? { offerAmount: "3.00" } : {}) },
      });
      await store(env.DB).mergeData(id, { operation: { ...operation, action } });
      const calls = fakePayPal(routes({ ...dispute, links: [] }));
      const response = await post(env);
      expect(response.status).toBe(202);
      expect(await response.json()).toMatchObject({
        error: expect.stringContaining("PayPal did not confirm"),
        operation: { state: "uncertain" },
      });
      const saved = (await store(env.DB).getDispute(id))!.data;
      expect(saved.filed).toBeUndefined();
      expect(saved.filing).toBeUndefined();
      expect(saved.operation).toEqual({ ...operation, action });
      expect(calls.filter((c) => c.method !== "GET" && c.path !== "/v1/oauth2/token")).toHaveLength(0);
      // When the action returns, retry the same write with its original key and start time.
      if (action === "accept") {
        fakePayPal({ ...routes(), [`POST /v1/customer/disputes/${id}/accept-claim`]: { json: {}, status: 503 } });
        expect((await post(env)).status).toBe(202);
        expect((await store(env.DB).getDispute(id))!.data.operation).toMatchObject({
          requestId: operation.requestId,
          at: operation.at,
        });
      }
    },
  );
});

describe("job 29 approval facts", () => {
  it.each([
    ["amount", { dispute_amount: { value: "600.00", currency_code: "USD" } }],
    ["currency", { dispute_amount: { value: "6.00", currency_code: "EUR" } }],
    ["stage", { dispute_life_cycle_stage: "CHARGEBACK" }],
    ["reason", { reason: "OTHER" }],
    ["status", { status: "UNDER_REVIEW" }],
    ["captureId", { disputed_transactions: [{ seller_transaction_id: "CAP-OTHER", custom: "dd-j29" }] }],
  ])("rejects a changed %s before any write and clears the claim", async (field, patch) => {
    const { env } = await makeEnv();
    await seed(env);
    const calls = fakePayPal(routes({ ...dispute, ...patch }));
    const response = await post(env);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({
      error: "PayPal shows different facts now. Analyse again before you approve.",
      changed: [field],
    });
    const saved = (await store(env.DB).getDispute(id))!.data;
    expect(saved.filed).toBeUndefined();
    expect(saved.filing).toBeUndefined();
    expect(saved.operation).toBeUndefined();
    expect(calls.filter((c) => c.method !== "GET" && c.path !== "/v1/oauth2/token")).toHaveLength(0);
  });

  it("rejects an old run with no basis", async () => {
    const { env } = await makeEnv();
    const { basis: _basis, ...legacy } = run;
    await seed(env, legacy);
    const calls = fakePayPal(routes());
    const response = await post(env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ changed: ["basis"] });
    expect(calls.filter((c) => c.path.endsWith("/accept-claim"))).toHaveLength(0);
    expect((await store(env.DB).getDispute(id))!.data.filing).toBeUndefined();
  });

  it("rejects a changed offer amount", async () => {
    const { env } = await makeEnv();
    await seed(env, {
      ...run,
      basis: { ...basis, offerAmount: "3.00" },
      decision: { verdict: "OFFER", offerAmount: "4.00" },
    });
    const calls = fakePayPal(routes({ ...dispute, links: [{ rel: "make_offer" }] }));
    const response = await post(env);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ changed: ["offerAmount"] });
    expect(calls.filter((c) => c.path.endsWith("/make-offer"))).toHaveLength(0);
  });

  it("files unchanged facts", async () => {
    const { env } = await makeEnv();
    await seed(env);
    const calls = fakePayPal(routes());
    expect((await post(env)).status).toBe(200);
    expect(calls.filter((c) => c.path.endsWith("/accept-claim"))).toHaveLength(1);
    expect((await store(env.DB).getDispute(id))!.data.filed.ok).toBe(true);
  });

  it("stores the basis actually analysed even if the final refresh changes the amount", async () => {
    const { env } = await makeEnv();
    await seed(env);
    fakePayPal(routes());
    const fetch = globalThis.fetch;
    let reads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith(`/disputes/${id}`) && ++reads > 1)
        return Response.json({ ...dispute, dispute_amount: { value: "600.00", currency_code: "USD" } });
      return fetch(input, init);
    });
    const response = await post(env, "analyse");
    expect(response.status).toBe(200);
    const body: any = await response.json();
    expect(body.run.basis).toEqual(basis);
    const saved = (await store(env.DB).getDispute(id))!.data;
    expect(saved.run.basis).toEqual(basis);
    expect(saved.dispute.dispute_amount.value).toBe("600.00");
    const approval = await post(env, "approve", body.run.version);
    expect(approval.status).toBe(409);
    expect(await approval.json()).toMatchObject({ changed: ["amount"] });
  });
});
