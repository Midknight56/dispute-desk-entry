import { NEURONS_PER_ASK_MAX, NEURONS_PER_RUN_MAX } from "../src/caps";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { paypal } from "../src/paypal";
import { store } from "../src/store";
import { resetTokenMemory } from "../src/token";
import { ctx, fakePayPal, makeEnv } from "./helpers/env";
import { createD1, readSqlFile } from "./helpers/d1";

const id = "PP-J13";
const dispute = {
  dispute_id: id,
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "UNDER_REVIEW",
  dispute_life_cycle_stage: "CHARGEBACK",
  dispute_amount: { value: "48.00", currency_code: "USD" },
  disputed_transactions: [{ seller_transaction_id: "CAP-1", custom: "dd-j13" }],
  links: [{ rel: "accept_claim" }, { rel: "provide_evidence" }],
};
const run = {
  basis: {
    amount: "48.00", currency: "USD", status: dispute.status, stage: "CHARGEBACK",
    reason: dispute.reason, captureId: "CAP-1", offerAmount: null,
  },
  version: "test-version",
  decision: { verdict: "ACCEPT", why: "No delivery evidence." },
  records: [],
  sentences: [{ text: "We accept the claim and refund in full.", record_id: id }],
  dropped: [],
  steps: [],
  writer: "template",
  usage: { calls: 0, prompt_tokens: 0, completion_tokens: 0 },
};
const routes = () => ({
  [`GET /v1/customer/disputes/${id}`]: { json: dispute },
  "GET /v2/payments/captures/CAP-1": { json: { id: "CAP-1", status: "COMPLETED", amount: dispute.dispute_amount } },
  [`POST /v1/customer/disputes/${id}/accept-claim`]: { json: {} },
});
type TestEnv = Awaited<ReturnType<typeof makeEnv>>["env"];
async function seed(env: TestEnv, savedRun: unknown = run) {
  await store(env.DB).putDispute({
    id,
    status: dispute.status,
    stage: dispute.dispute_life_cycle_stage,
    data: { dispute, run: savedRun },
  });
}
function post(env: TestEnv, action: string, body?: unknown) {
  return worker.fetch(
    new Request(`https://desk.test/api/${action}`, {
      method: "POST",
      headers: { "x-desk-key": "owner-for-test", "content-type": "application/json" },
      body: JSON.stringify(body ?? (action.endsWith("/approve") ? { version: "test-version" } : {})),
    }),
    env,
    ctx().context,
  );
}
async function allowance(env: TestEnv, app = "dispute-desk", neurons = 693) {
  await env.LEDGER.prepare("INSERT INTO ai_calls(app,day,neurons,at) VALUES(?,?,?,?)")
    .bind(app, new Date().toISOString().slice(0, 10), neurons, "seed")
    .run();
}
async function ledger(env: TestEnv) {
  return (
    await env.LEDGER.prepare("SELECT neurons, at FROM ai_calls ORDER BY id").all<{ neurons: number; at: string }>()
  ).results;
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetTokenMemory();
});

describe("job 13 filing", () => {
  it("saves accepted filing before refresh and refuses a second write after refresh fails", async () => {
    const { env } = await makeEnv();
    await seed(env);
    const replies: Record<string, { json: unknown; status?: number }> = routes();
    const calls = fakePayPal(replies);
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/accept-claim")) {
        replies[`GET /v1/customer/disputes/${id}`] = { json: { name: "SERVER_ERROR" }, status: 503 };
      }
      if (String(input).endsWith(`disputes/${id}`) && calls.some((call) => call.path.endsWith("/accept-claim"))) {
        expect((await store(env.DB).getDispute(id))?.data.filed).toMatchObject({ ok: true, at: expect.any(String) });
      }
      return response;
    });
    const first = await post(env, `disputes/${id}/approve`);
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({
      filed: { ok: true, at: expect.any(String) },
      status: dispute.status,
      stage: dispute.dispute_life_cycle_stage,
      refresh: "failed",
    });
    expect((await store(env.DB).getDispute(id))?.data.filing).toBeUndefined();
    const second = await post(env, `disputes/${id}/approve`);
    expect(second.status).toBe(409);
    expect(await second.json()).toMatchObject({ error: "already filed" });
    expect(calls.filter((call) => call.path.endsWith("/accept-claim"))).toHaveLength(1);
    expect((await store(env.DB).recentFeed()).some((row) => row.title === "refresh failed")).toBe(true);
  });

  it("reuses stable ids for both tracking writes when a tracking step is retried", async () => {
    const { env } = await makeEnv();
    await seed(env, {
      ...run,
      decision: { verdict: "FIGHT", why: "delivery" },
      records: [{ kind: "tracking", id: "ship-dd-j13" }],
    });
    await env.DB.prepare(
      "INSERT INTO shipments(custom_id,order_id,capture_id,carrier,tracking_number,delivered_at,created_at) VALUES(?,?,?,?,?,?,?)",
    )
      .bind("dd-j13", "ORD-1", "CAP-1", "UPS", "TRACK-1", "2026-10-20T00:00:00Z", "now")
      .run();
    const calls = fakePayPal({
      ...routes(),
      "POST /v2/checkout/orders/ORD-1/track": {
        json: { purchase_units: [{ shipping: { trackers: [{ id: "TRK-1" }] } }] },
      },
      "PUT /v1/shipping/trackers/TRK-1": { json: { name: "SERVER_ERROR" }, status: 503 },
    });
    for (let attempt = 0; attempt < 2; attempt++) expect((await post(env, `disputes/${id}/approve`)).status).toBe(502);
    const track = calls.filter((call) => call.path.endsWith("/track"));
    const delivered = calls.filter((call) => call.method === "PUT");
    for (const [writes, expected] of [
      [track, `dd-${id}-track`],
      [delivered, `dd-${id}-delivered`],
    ] as const) {
      expect(writes).toHaveLength(2);
      expect(writes.map((call) => call.headers.get("PayPal-Request-Id"))).toEqual([expected, expected]);
      expect(expected.length).toBeLessThanOrEqual(100);
    }
  });
});

describe("job 13 webhooks and pages", () => {
  it("retries failed event processing and skips simultaneous deliveries after success", async () => {
    const { env } = await makeEnv();
    const replies: Record<string, { json: unknown; status?: number }> = {
      "POST /v1/notifications/verify-webhook-signature": { json: { verification_status: "SUCCESS" } },
      [`GET /v1/customer/disputes/${id}`]: { json: { name: "SERVER_ERROR" }, status: 503 },
    };
    const calls = fakePayPal(replies);
    const deliver = async () => {
      const c = ctx();
      const response = await worker.fetch(
        new Request("https://desk.test/webhooks/paypal", {
          method: "POST",
          body: JSON.stringify({ id: "WH-J13", event_type: "CUSTOMER.DISPUTE.CREATED", resource: dispute }),
          headers: Object.fromEntries(
            ["auth-algo", "cert-url", "transmission-id", "transmission-sig", "transmission-time"].map((key) => [
              `paypal-${key}`,
              "test",
            ]),
          ),
        }),
        env,
        c.context,
      );
      expect(response.status).toBe(200);
      await c.wait();
    };
    await deliver();
    expect(await env.DB.prepare("SELECT processed_at FROM events").first()).toEqual({ processed_at: null });
    replies[`GET /v1/customer/disputes/${id}`] = { json: dispute };
    await deliver();
    expect(await env.DB.prepare("SELECT processed_at FROM events").first()).toEqual({
      processed_at: expect.any(String),
    });
    await Promise.all([deliver(), deliver()]);
    expect(calls.filter((call) => call.path.endsWith(`disputes/${id}`))).toHaveLength(2);
    expect(
      (await env.DB.prepare("SELECT status FROM disputes WHERE id = ?").bind(id).first<{ status: string }>())?.status,
    ).toBe(dispute.status);
  });

  it("backfills a pre migration event so redelivery does not process it again", async () => {
    const db = await createD1([
      "migrations/0001_init.sql",
      "migrations/0002_runs.sql",
      "migrations/0003_pool.sql",
      "migrations/0004_shipments.sql",
      "migrations/0005_meta.sql",
      "migrations/0006_sales.sql",
    ]);
    await db
      .prepare("INSERT INTO events (id,event_type,resource_id,create_time,received_at,raw) VALUES (?,?,?,?,?,?)")
      .bind("WH-OLD", "CUSTOMER.DISPUTE.CREATED", id, null, "2026-01-01T00:00:00.000Z", "{}")
      .run();
    db.exec(await readSqlFile("migrations/0007_event_done.sql"));
    expect(
      await store(db).storeEventIfNew(
        { id: "WH-OLD", event_type: "CUSTOMER.DISPUTE.CREATED", resource: dispute },
        "{}",
      ),
    ).toBe(false);
  });

  it("reads both dispute pages", async () => {
    const { env } = await makeEnv();
    const calls = fakePayPal({
      "GET /v1/customer/disputes?page_size=50": {
        json: {
          items: [{ id: "first" }],
          links: [{ rel: "next", href: "https://api.test/v1/customer/disputes?page=2" }],
        },
      },
      "GET /v1/customer/disputes?page=2": { json: { items: [{ id: "second" }] } },
    });
    expect(await paypal(env).listDisputes()).toEqual([{ id: "first" }, { id: "second" }]);
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(2);
  });

  it.each([
    "https://evil.test/v1/customer/disputes?page=2",
    "https://api.test/v1/payments",
    "http://api.test/v1/customer/disputes",
    "https://api.test:444/v1/customer/disputes",
    "http://[",
  ])("does not follow an unsafe next link %s", async (href) => {
    const { env } = await makeEnv();
    const calls = fakePayPal({
      "GET /v1/customer/disputes": { json: { items: [{ id: "first" }], links: [{ rel: "next", href }] } },
    });
    expect(await paypal(env).listDisputes()).toEqual([{ id: "first" }]);
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(1);
  });

  it("stops after twenty dispute pages", async () => {
    const { env } = await makeEnv();
    const calls = fakePayPal({
      "GET /v1/customer/disputes": {
        json: { items: [{ id: "item" }], links: [{ rel: "next", href: "https://api.test/v1/customer/disputes" }] },
      },
    });
    expect(await paypal(env).listDisputes()).toHaveLength(20);
    expect(calls.filter((call) => call.method === "GET")).toHaveLength(20);
  });
});

describe("job 13 neuron reservations", () => {
  it.each(["analyse", "ask"])("admits one concurrent %s run with exactly one maximum left", async (action) => {
    const { env } = await makeEnv();
    await seed(env);
    const maximum = action === "ask" ? NEURONS_PER_ASK_MAX : NEURONS_PER_RUN_MAX;
    await allowance(env, "dispute-desk", 700 - maximum);
    fakePayPal(routes());
    let release!: () => void;
    let started!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const firstCall = new Promise<void>((resolve) => {
      started = resolve;
    });
    const model = vi.spyOn(env.AI, "run").mockImplementation(async () => {
      started();
      await gate;
      return { response: "{}", usage: {} };
    });
    const invoke = () =>
      post(
        env,
        action === "ask" ? "ask" : `disputes/${id}/analyse`,
        action === "ask" ? { q: "show status" } : undefined,
      );
    const pending = [invoke(), invoke()];
    await firstCall;
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    const responses = await Promise.all(pending);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const bodies = (await Promise.all(responses.map((response) => response.json()))) as any[];
    expect(bodies.map((body) => body.neurons).sort((a, b) => a - b)).toEqual([0, maximum]);
    expect(model).toHaveBeenCalledTimes(action === "ask" ? 1 : 3);
    const rows = await ledger(env);
    expect(rows).toHaveLength(2);
    expect(rows.reduce((sum, row) => sum + row.neurons, 0)).toBe(700);
    if (action === "analyse")
      expect(
        bodies.filter(
          (body) => body.cap === "The app has used its neuron allowance. Here is the recorded run instead.",
        ),
      ).toHaveLength(1);
  });

  it.each(["analyse", "ask"])("keeps the maximum when the %s model throws", async (action) => {
    const { env } = await makeEnv();
    await seed(env);
    fakePayPal(routes());
    vi.spyOn(env.AI, "run").mockRejectedValue(new Error("model unavailable"));
    const response = await post(
      env,
      action === "ask" ? "ask" : `disputes/${id}/analyse`,
      action === "ask" ? { q: "show status" } : undefined,
    );
    expect(response.status).toBe(200);
    expect((await ledger(env)).map((row) => row.neurons)).toEqual([action === "ask" ? NEURONS_PER_ASK_MAX : NEURONS_PER_RUN_MAX]);
  });

  it.each(["analyse", "ask"])("updates the same reservation to measured %s usage", async (action) => {
    const { env } = await makeEnv();
    await seed(env);
    fakePayPal(routes());
    vi.spyOn(env.AI, "run").mockImplementation(async () => {
      expect((await ledger(env)).map((row) => row.neurons)).toEqual([action === "ask" ? NEURONS_PER_ASK_MAX : NEURONS_PER_RUN_MAX]);
      return { response: "{}", usage: { prompt_tokens: 100, completion_tokens: 0 } };
    });
    const response = await post(
      env,
      action === "ask" ? "ask" : `disputes/${id}/analyse`,
      action === "ask" ? { q: "show status" } : undefined,
    );
    expect(response.status).toBe(200);
    expect((await ledger(env)).map((row) => row.neurons)).toEqual([action === "ask" ? 0.16 : 0.47]);
  });

  it("also reserves the shared account allowance atomically", async () => {
    const { env } = await makeEnv();
    await allowance(env, "other-app", 9000 - NEURONS_PER_ASK_MAX);
    const model = vi.spyOn(env.AI, "run").mockResolvedValue({ response: "{}", usage: {} });
    await Promise.all([post(env, "ask", { q: "status" }), post(env, "ask", { q: "status" })]);
    expect(model).toHaveBeenCalledTimes(1);
    expect((await ledger(env)).reduce((sum, row) => sum + row.neurons, 0)).toBe(9000);
  });

  it("stores a reservation timestamp as a plain ISO date", async () => {
    const { env } = await makeEnv();
    await post(env, "ask", { q: "status" });
    const [row] = await ledger(env);
    expect(Number.isNaN(Date.parse(row.at))).toBe(false);
    expect(new Date(row.at).toISOString()).toBe(row.at);
  });
});
