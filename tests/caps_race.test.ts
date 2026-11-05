import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { NEURONS_PER_RUN_MAX, NEURONS_PER_ASK_MAX } from "../src/caps";
import { resetTokenMemory } from "../src/token";
import { makeEnv, fakePayPal, ctx } from "./helpers/env";

const dispute = {
  dispute_id: "PP-1",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "UNDER_REVIEW",
  dispute_life_cycle_stage: "CHARGEBACK",
  dispute_amount: { currency_code: "USD", value: "48.00" },
  disputed_transactions: [{ seller_transaction_id: "CAP-1", custom: "dd-0001" }],
  evidences: [],
};

const routes = {
  "GET /v1/customer/disputes/PP-1": { json: dispute },
  "GET /v2/payments/captures/CAP-1": { json: { id: "CAP-1", amount: { value: "48.00" } } },
  "GET /v2/checkout/orders/ORD-1": { json: { id: "ORD-1", purchase_units: [] } },
};

async function request(path: string, env: Awaited<ReturnType<typeof makeEnv>>["env"], init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (path.endsWith("/analyse")) headers.set("x-desk-key", "owner-for-test");
  if (path.endsWith("/approve") && !init.body) init = { ...init, body: JSON.stringify({ version: "test-version" }) };
  return worker.fetch(new Request(`https://desk.test${path}`, { ...init, headers }), env, ctx().context);
}

async function seedDispute(DB: Awaited<ReturnType<typeof makeEnv>>["DB"]) {
  await DB.prepare(
    "INSERT INTO disputes (id,status,stage,reason,amount,currency,due,custom_id,data,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      "PP-1",
      "UNDER_REVIEW",
      "CHARGEBACK",
      dispute.reason,
      "48.00",
      "USD",
      null,
      "dd-0001",
      JSON.stringify({ dispute }),
      new Date().toISOString(),
    )
    .run();
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetTokenMemory();
});

describe("usage cap races", () => {
  it("allows only one model run for concurrent analyses at the visitor run cap", async () => {
    const { env, DB, replies } = await makeEnv();
    await seedDispute(DB);
    fakePayPal(routes);
    const visitor = await (
      await import("../src/usage")
    ).visitorId(new Request("https://desk.test", { headers: { "user-agent": "same-visitor" } }));
    const day = new Date().toISOString().slice(0, 10);
    for (let i = 0; i < 19; i++) {
      await DB.prepare("INSERT INTO runs (day,visitor,dispute_id,writer,neurons,at) VALUES (?,?,?,?,?,?)")
        .bind(day, visitor, `old-${i}`, "template", 0, `old-${i}`)
        .run();
    }
    replies.push(
      { response: '{"tools":[]}', usage: { prompt_tokens: 10, completion_tokens: 1 } },
      { response: '{"sentences":[]}', usage: { prompt_tokens: 10, completion_tokens: 1 } },
      { response: '{"tools":[]}', usage: { prompt_tokens: 10, completion_tokens: 1 } },
      { response: '{"sentences":[]}', usage: { prompt_tokens: 10, completion_tokens: 1 } },
    );
    let modelCalls = 0;
    const originalRun = env.AI.run.bind(env.AI);
    env.AI.run = (async (...args: Parameters<typeof env.AI.run>) => {
      modelCalls++;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return originalRun(...args);
    }) as typeof env.AI.run;
    const [a, b] = await Promise.all([
      request("/api/disputes/PP-1/analyse", env, { method: "POST", headers: { "user-agent": "same-visitor" } }),
      request("/api/disputes/PP-1/analyse", env, { method: "POST", headers: { "user-agent": "same-visitor" } }),
    ]);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(modelCalls).toBe(3); // One admitted analysis, including its single writer shape retry.
    expect(replies).toHaveLength(1);
    expect(
      await DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE day = ? AND visitor = ?")
        .bind(day, visitor)
        .first<{ n: number }>()
        .then((row) => row?.n),
    ).toBe(21);
  });

  it("keeps the maximum neurons when an ask reply has no usage object", async () => {
    const { env, LEDGER, replies } = await makeEnv();
    replies.push({ response: '{"chart":"bar","groupBy":"stage","metric":"count","period":"all"}' });
    const response = await request("/api/ask", env, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "disputes by stage" }),
    });
    expect(response.status).toBe(200);
    expect(
      await LEDGER.prepare("SELECT neurons FROM ai_calls")
        .first<{ neurons: number }>()
        .then((row) => row?.neurons),
    ).toBe(NEURONS_PER_ASK_MAX);
  });

  it("keeps the maximum neurons when analyse replies have no usage objects", async () => {
    const { env, DB, LEDGER, replies } = await makeEnv();
    await seedDispute(DB);
    fakePayPal(routes);
    replies.push({ response: '{"tools":[]}' }, { response: '{"sentences":[]}' });
    const response = await request("/api/disputes/PP-1/analyse", env, {
      method: "POST",
      headers: { "user-agent": "usage-visitor" },
    });
    expect(response.status).toBe(200);
    expect(
      await LEDGER.prepare("SELECT neurons FROM ai_calls")
        .first<{ neurons: number }>()
        .then((row) => row?.neurons),
    ).toBe(NEURONS_PER_RUN_MAX);
  });
});
