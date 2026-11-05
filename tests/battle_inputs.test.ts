import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { checkCaps } from "../src/caps";
import { makeEnv, fakePayPal, ctx } from "./helpers/env";

const dispute = (over: Record<string, unknown> = {}) => ({
  dispute_id: "PP-BATTLE",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "UNDER_REVIEW",
  dispute_life_cycle_stage: "CHARGEBACK",
  create_time: "2026-10-20T01:00:00Z",
  dispute_amount: { currency_code: "USD", value: "48.00" },
  disputed_transactions: [{ seller_transaction_id: "CAP-BATTLE", custom: "dd-battle" }],
  evidences: [],
  ...over,
});

const capture = (amount: string, currency = "USD") => ({
  id: "CAP-BATTLE",
  status: "COMPLETED",
  amount: { currency_code: currency, value: amount },
  create_time: "2026-10-19T01:00:00Z",
  supplementary_data: { related_ids: { order_id: "ORD-BATTLE" } },
});

async function request(path: string, env: Awaited<ReturnType<typeof makeEnv>>["env"], init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (path.endsWith("/analyse")) headers.set("x-desk-key", "owner-for-test");
  if (path.endsWith("/approve") && !init.body) init = { ...init, body: JSON.stringify({ version: "test-version" }) };
  return worker.fetch(new Request(`https://desk.test${path}`, { ...init, headers }), env, ctx().context);
}

function webhookHeaders() {
  return {
    "content-type": "application/json",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.test/cert",
    "paypal-transmission-id": "transmission-battle",
    "paypal-transmission-sig": "signature-battle",
    "paypal-transmission-time": "2026-10-23T01:00:00Z",
  };
}

const event = (over: Record<string, unknown> = {}) => ({
  id: "battle-event",
  event_type: "CUSTOMER.DISPUTE.CREATED",
  resource: dispute(),
  ...over,
});

afterEach(() => vi.unstubAllGlobals());

describe("battle inputs", () => {
  it("stores simultaneous pending webhook deliveries once, safely processes both, and ignores done replays", async () => {
    const { env, DB } = await makeEnv();
    const d = dispute();
    const calls = fakePayPal({
      "POST /v1/notifications/verify-webhook-signature": { json: { verification_status: "SUCCESS" } },
      "GET /v1/customer/disputes/PP-BATTLE": { json: d },
    });
    const c = ctx();
    const post = (payload: unknown) =>
      worker.fetch(
        new Request("https://desk.test/webhooks/paypal", {
          method: "POST",
          headers: webhookHeaders(),
          body: JSON.stringify(payload),
        }),
        env,
        c.context,
      );
    const responses = await Promise.all([post(event()), post(event())]);
    await c.wait();
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(
      await DB.prepare("SELECT COUNT(*) AS n FROM events")
        .first<{ n: number }>()
        .then((r) => r?.n),
    ).toBe(1);
    expect(
      await DB.prepare("SELECT COUNT(*) AS n FROM feed WHERE kind = 'webhook'")
        .first<{ n: number }>()
        .then((r) => r?.n),
    ).toBe(2);
    expect(calls.filter((call) => call.path === "/v1/customer/disputes/PP-BATTLE")).toHaveLength(2);

    const changedReplay = event({ resource: dispute({ status: "RESOLVED" }) });
    const replay = await post(changedReplay);
    await c.wait();
    expect(replay.status).toBe(200);
    expect(
      await DB.prepare("SELECT COUNT(*) AS n FROM feed WHERE kind = 'webhook'")
        .first<{ n: number }>()
        .then((r) => r?.n),
    ).toBe(2);
    expect(calls.filter((call) => call.path === "/v1/customer/disputes/PP-BATTLE")).toHaveLength(2);
  });

  it("rejects malformed, empty, unsigned and incomplete webhook events without storing them", async () => {
    const { env, DB } = await makeEnv();
    fakePayPal({ "POST /v1/notifications/verify-webhook-signature": { json: { verification_status: "FAILURE" } } });
    const post = (body: string, headers: Record<string, string> = webhookHeaders()) =>
      request("/webhooks/paypal", env, { method: "POST", headers, body });
    for (const body of [
      "not-json",
      "",
      "{}",
      JSON.stringify({ id: "no-type" }),
      JSON.stringify({ event_type: "no-id" }),
    ]) {
      expect((await post(body)).status).toBe(400);
    }
    expect((await post(JSON.stringify(event()), { "content-type": "application/json" })).status).toBe(400);
    expect(
      await DB.prepare("SELECT COUNT(*) AS n FROM events")
        .first<{ n: number }>()
        .then((r) => r?.n),
    ).toBe(0);
  });

  it("handles a 2 MB webhook body and ignores unknown and other-app disputes", async () => {
    const { env, DB } = await makeEnv();
    const calls = fakePayPal({
      "POST /v1/notifications/verify-webhook-signature": { json: { verification_status: "SUCCESS" } },
    });
    const c = ctx();
    const post = (payload: unknown) =>
      worker.fetch(
        new Request("https://desk.test/webhooks/paypal", {
          method: "POST",
          headers: webhookHeaders(),
          body: JSON.stringify(payload),
        }),
        env,
        c.context,
      );
    const big = event({ padding: "x".repeat(2 * 1024 * 1024) });
    expect((await post(big)).status).toBe(200);
    await c.wait();
    const unknown = event({ id: "unknown-dispute", resource: dispute({ dispute_id: "PP-UNKNOWN" }) });
    expect((await post(unknown)).status).toBe(200);
    await c.wait();
    const other = event({ id: "other-app", resource: dispute({ disputed_transactions: [{ custom: "other-123" }] }) });
    expect((await post(other)).status).toBe(200);
    await c.wait();
    expect(
      await DB.prepare("SELECT COUNT(*) AS n FROM disputes")
        .first<{ n: number }>()
        .then((r) => r?.n),
    ).toBe(0);
    expect(calls.filter((call) => call.path.startsWith("/v1/customer/disputes/")).length).toBeLessThanOrEqual(2);
  });

  it.each(["0.00", "-5.00", "1e3", "999999999.99", undefined, "1500"])(
    "keeps dispute and capture money sane for amount %s",
    async (amount) => {
      const { env, DB, replies } = await makeEnv();
      replies.push({ response: '{"tools":["get_tracking"]}', usage: {} }, { response: "", usage: {} });
      const d = dispute({
        dispute_amount: amount === undefined ? undefined : { currency_code: "USD", value: amount },
      });
      const cap = capture(amount ?? "0.00");
      const calls = fakePayPal({
        "GET /v1/customer/disputes/PP-BATTLE": { json: d },
        "GET /v2/payments/captures/CAP-BATTLE": { json: cap },
        "GET /v2/checkout/orders/ORD-BATTLE": {
          json: { id: "ORD-BATTLE", purchase_units: [{ shipping: { trackers: [{ id: "TRK-BATTLE" }] } }] },
        },
        "GET /v1/shipping/trackers/TRK-BATTLE": {
          json: { carrier: "UPS", tracking_number: "TRACK-1", status: "SHIPPED" },
        },
      });
      const response = await request("/api/disputes/PP-BATTLE/analyse", env, { method: "POST" });
      expect(response.status).toBe(200);
      const result = (await response.json()) as any;
      expect(
        Number.isFinite(result.run.decision.offerAmount === undefined ? 0 : Number(result.run.decision.offerAmount)),
      ).toBe(true);
      if (result.run.decision.offerAmount !== undefined) {
        expect(Number(result.run.decision.offerAmount)).toBeGreaterThanOrEqual(0);
        expect(Number(result.run.decision.offerAmount)).toBeLessThanOrEqual(Math.max(0, Number(amount ?? 0)));
      }
      expect(JSON.stringify(result.run)).not.toContain("NaN");
      expect(result.run.records.every((record: any) => !record.summary.includes("-5.00"))).toBe(true);
      expect(calls.some((call) => call.path === "/v2/payments/captures/CAP-BATTLE")).toBe(true);
      const stored = await DB.prepare("SELECT amount FROM disputes WHERE id = ?")
        .bind("PP-BATTLE")
        .first<{ amount: string }>();
      expect(stored?.amount ?? "").not.toContain("NaN");
    },
  );

  it("keeps non-USD dispute and capture amounts readable", async () => {
    const { env } = await makeEnv();
    const d = dispute({ dispute_amount: { currency_code: "JPY", value: "1500" } });
    fakePayPal({
      "GET /v1/customer/disputes/PP-BATTLE": { json: d },
      "GET /v2/payments/captures/CAP-BATTLE": { json: capture("1500", "JPY") },
    });
    const result = (await (await request("/api/disputes/PP-BATTLE/analyse", env, { method: "POST" })).json()) as any;
    expect(result.run.records.some((r: any) => /JPY 1500(?:\s|$)/.test(r.summary))).toBe(true);
    expect(result.run.decision.verdict).toBe("REVIEW");
    expect(result.run.decision.offerAmount).toBeUndefined();
    expect(JSON.stringify(result.run)).not.toContain("NaN");
  });

  it("shows a safe dispute amount in the list", async () => {
    const { env, DB } = await makeEnv();
    await DB.prepare(
      "INSERT INTO disputes (id,status,stage,reason,amount,currency,data,updated_at) VALUES (?,?,?,?,?,?,?,?)",
    )
      .bind("PP-NEGATIVE", "UNDER_REVIEW", "CHARGEBACK", "UNAUTHORISED", "-5.00", "USD", "{}", "now")
      .run();
    const response = await request("/api/disputes", env);
    const rows = (await response.json()) as any[];
    expect(rows.find((row) => row.id === "PP-NEGATIVE")?.amount).toBe("0.00");
  });

  it("rejects hostile ids before PayPal", async () => {
    const { env } = await makeEnv();
    (env as any).ASSETS = { fetch: async () => new Response("not found", { status: 404 }) };
    const calls = fakePayPal({});
    for (const id of ["..%2FPP-1", "%252e%252e", "A".repeat(500), "", "PP-💥"]) {
      const response = await request(`/api/disputes/${id}/analyse`, env, { method: "POST" });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid dispute id." });
    }
    expect(calls.filter((call) => call.path.startsWith("/v1/customer/disputes/")).length).toBe(0);
  });

  it("enforces each exact cap and one over, including parallel reservations", async () => {
    expect(checkCaps({ visitorRuns: 19, dayRuns: 99, appNeurons: 693, accountNeurons: 8993 }).ok).toBe(true);
    expect(checkCaps({ visitorRuns: 20, dayRuns: 0, appNeurons: 0, accountNeurons: 0 }).ok).toBe(false);
    expect(checkCaps({ visitorRuns: 0, dayRuns: 100, appNeurons: 0, accountNeurons: 0 }).ok).toBe(false);
    expect(checkCaps({ visitorRuns: 0, dayRuns: 0, appNeurons: 694, accountNeurons: 0 }).ok).toBe(false);
    expect(checkCaps({ visitorRuns: 0, dayRuns: 0, appNeurons: 0, accountNeurons: 8994 }).ok).toBe(false);

    const { env, DB, LEDGER, replies } = await makeEnv();
    const d = dispute();
    replies.push(
      ...Array.from({ length: 50 }, () => ({ response: "{}", usage: { prompt_tokens: 100, completion_tokens: 10 } })),
    );
    fakePayPal({ "GET /v1/customer/disputes/PP-BATTLE": { json: d } });
    const c = ctx();
    const calls = await Promise.all(
      Array.from({ length: 25 }, () =>
        worker.fetch(
          new Request("https://desk.test/api/disputes/PP-BATTLE/analyse", {
            method: "POST",
            headers: { "user-agent": "same-visitor", "x-desk-key": "owner-for-test" },
          }),
          env,
          c.context,
        ),
      ),
    );
    await c.wait();
    expect(calls.every((r) => r.status === 200)).toBe(true);
    expect(
      await LEDGER.prepare("SELECT COUNT(*) AS n FROM ai_calls")
        .first<{ n: number }>()
        .then((r) => r?.n),
    ).toBeLessThanOrEqual(20);
  });

  it("bounds a 50 KB ask question and handles an empty user agent", async () => {
    const { env, replies } = await makeEnv();
    replies.push({ response: '{"chart":"bar","groupBy":"reason","metric":"count","period":"all"}', usage: {} });
    const response = await request("/api/ask", env, {
      method: "POST",
      headers: { "content-type": "application/json", "user-agent": "" },
      body: JSON.stringify({ q: "x".repeat(50 * 1024) }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ spec: { chart: "bar" } });
  });
});
