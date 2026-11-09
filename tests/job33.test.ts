import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { store } from "../src/store";
import { resetTokenMemory } from "../src/token";
import { ctx, fakePayPal, makeEnv } from "./helpers/env";

const id = "PP-J33";
const claimDispute = {
  dispute_id: id,
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_life_cycle_stage: "CHARGEBACK",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  dispute_amount: { value: "10.00", currency_code: "USD" },
  disputed_transactions: [{ seller_transaction_id: "CAP-J33", custom: "dd-j33" }],
  links: [{ rel: "provide_evidence" }],
};
const inquiryDispute = {
  ...claimDispute,
  dispute_life_cycle_stage: "INQUIRY",
};
const makeRun = (stage: string) => ({
  basis: {
    amount: "10.00",
    currency: "USD",
    status: claimDispute.status,
    stage,
    reason: claimDispute.reason,
    captureId: "CAP-J33",
    offerAmount: null,
  },
  version: "version-j33",
  decision: { verdict: "FIGHT", why: "Evidence provided." },
  records: [{ id: "CAP-J33", kind: "capture", summary: "Capture completed" }],
  sentences: [{ text: "The item was delivered.", record_id: "CAP-J33" }],
  dropped: [],
  steps: [],
  writer: "template",
  usage: { calls: 0, prompt_tokens: 0, completion_tokens: 0 },
});

type TestEnv = Awaited<ReturnType<typeof makeEnv>>["env"];

const routes = (d: any = claimDispute) => ({
  [`GET /v1/customer/disputes/${id}`]: { json: d },
  [`POST /v1/customer/disputes/${id}/provide-evidence`]: { json: {} },
  "GET /v2/payments/captures/CAP-J33": {
    json: {
      id: "CAP-J33",
      status: "COMPLETED",
      amount: d.dispute_amount,
    },
  },
});

async function seed(env: TestEnv, d: any = claimDispute, draft = makeRun(d.dispute_life_cycle_stage)) {
  await store(env.DB).putDispute({
    id,
    status: d.status,
    stage: d.dispute_life_cycle_stage,
    amount: d.dispute_amount.value,
    currency: d.dispute_amount.currency_code,
    reason: d.reason,
    customId: "dd-j33",
    data: { dispute: d, run: draft },
  });
}

function post(env: TestEnv, action = "approve", version = "version-j33") {
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

describe("job 33 pack required for claim stage evidence", () => {
  it("rejects claim stage FIGHT when pack build throws, then files after fix", async () => {
    const { env } = await makeEnv();
    await seed(env, claimDispute);
    const calls = fakePayPal(routes(claimDispute));
    vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("pack build failed"));

    const response = await post(env, "approve");
    expect(response.status).toBe(502);
    expect(await response.json()).toEqual({
      error: "The evidence pack could not be built. Nothing was sent to PayPal. Try again.",
    });

    const writeCalls = calls.filter((c) => c.method !== "GET" && c.path !== "/v1/oauth2/token");
    expect(writeCalls).toHaveLength(0);

    const stored = await store(env.DB).getDispute(id);
    expect(stored?.data.filed).toBeUndefined();
    expect(stored?.data.filing).toBeUndefined();
    expect(stored?.data.operation).toBeUndefined();

    const feed = await env.DB.prepare("SELECT detail FROM feed ORDER BY seq DESC LIMIT 5").all<{ detail: string }>();
    expect(feed.results.some((row) => row.detail.includes("pack could not be built"))).toBe(true);

    const secondResponse = await post(env, "approve");
    expect(secondResponse.status).toBe(200);
    const secondWriteCalls = calls.filter((c) => c.method !== "GET" && c.path !== "/v1/oauth2/token");
    expect(secondWriteCalls.some((c) => c.path.endsWith("/provide-evidence"))).toBe(true);

    const storedAfter = await store(env.DB).getDispute(id);
    expect(storedAfter?.data.filed?.ok).toBe(true);
  });

  it("still files INQUIRY stage FIGHT when pack build throws", async () => {
    const { env } = await makeEnv();
    await seed(env, inquiryDispute);
    const calls = fakePayPal(routes(inquiryDispute));
    vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("pack build failed"));

    const response = await post(env, "approve");
    expect(response.status).toBe(200);

    const writeCalls = calls.filter((c) => c.method !== "GET" && c.path !== "/v1/oauth2/token");
    expect(writeCalls.some((c) => c.path.endsWith("/provide-evidence"))).toBe(true);

    const stored = await store(env.DB).getDispute(id);
    expect(stored?.data.filed?.ok).toBe(true);

    const feed = await env.DB.prepare("SELECT detail FROM feed ORDER BY seq DESC LIMIT 5").all<{ detail: string }>();
    expect(feed.results.some((row) => row.detail.includes("pack could not be built"))).toBe(true);
  });
  it("keeps an earlier uncertain filing on record when the pack fails", async () => {
    const { env } = await makeEnv();
    const run = makeRun("CHARGEBACK");
    const operation = {
      action: "evidence", sent: true, state: "uncertain", requestId: "dd-j33-earlier", versionAt: run.version,
      at: "2026-11-01T00:00:00.000Z", approved: { basisJson: JSON.stringify(run.basis), sentences: run.sentences },
    };
    await store(env.DB).putDispute({
      id, status: claimDispute.status, stage: "CHARGEBACK", amount: "10.00", currency: "USD",
      reason: claimDispute.reason, customId: "dd-j33", data: { dispute: claimDispute, run, operation },
    });
    const calls = fakePayPal(routes(claimDispute));
    vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("pack build failed"));
    const response = await post(env, "approve");
    expect(response.status).toBe(502);
    expect(calls.filter((c) => c.method !== "GET" && c.path !== "/v1/oauth2/token")).toHaveLength(0);
    const stored = await store(env.DB).getDispute(id);
    expect(stored?.data.operation?.state).toBe("uncertain");
    expect(stored?.data.operation?.requestId).toBe("dd-j33-earlier");
    expect(stored?.data.filed).toBeUndefined();
  });
});
