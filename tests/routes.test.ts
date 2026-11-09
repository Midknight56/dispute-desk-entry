import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { actionableRoutes, makeEnv, fakePayPal, ctx } from "./helpers/env";
import { resetTokenMemory } from "../src/token";

const dispute = (over: Record<string, unknown> = {}) => ({
  dispute_id: "PP-1",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "UNDER_REVIEW",
  dispute_life_cycle_stage: "CHARGEBACK",
  create_time: "2026-10-20T01:00:00Z",
  dispute_amount: { currency_code: "USD", value: "48.00" },
  disputed_transactions: [{ seller_transaction_id: "CAP-1", custom: "dd-0001" }],
  evidences: [{ evidence_type: "CREATE", source: "SUBMITTED_BY_BUYER", notes: "Item did not arrive." }],
  links: [{ rel: "provide_evidence" }],
  ...over,
});

const capture = {
  id: "CAP-1",
  status: "COMPLETED",
  amount: { currency_code: "USD", value: "48.00" },
  create_time: "2026-10-19T01:00:00Z",
  supplementary_data: { related_ids: { order_id: "ORD-1" } },
};
const order = {
  id: "ORD-1",
  status: "COMPLETED",
  purchase_units: [
    { description: "Test item", shipping: { address: { country_code: "CA" }, trackers: [{ id: "TRK-1" }] } },
  ],
};
const tracker = { transaction_id: "CAP-1", tracking_number: "TRACK-1", status: "DELIVERED", carrier: "UPS" };
const ppRoutes = (d = dispute()) => ({
  "GET /v1/customer/disputes/PP-1": { json: d },
  "GET /v2/payments/captures/CAP-1": { json: capture },
  "GET /v2/checkout/orders/ORD-1": { json: order },
  "GET /v1/shipping/trackers/TRK-1": { json: tracker },
  "POST /v1/customer/disputes/PP-1/provide-evidence": { json: {} },
});

async function request(path: string, env: Awaited<ReturnType<typeof makeEnv>>["env"], init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (path.endsWith("/analyse")) headers.set("x-desk-key", "owner-for-test");
  if (path.endsWith("/approve") && !init.body) init = { ...init, body: JSON.stringify({ version: "test-version" }) };
  return worker.fetch(new Request(`https://desk.test${path}`, { ...init, headers }), env, ctx().context);
}

async function seedDispute(
  DB: Awaited<ReturnType<typeof makeEnv>>["DB"],
  d = dispute(),
  data: Record<string, unknown> = {},
) {
  await DB.prepare(
    "INSERT INTO disputes (id,status,stage,reason,amount,currency,due,custom_id,data,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      d.dispute_id,
      d.status,
      d.dispute_life_cycle_stage,
      d.reason,
      (d.dispute_amount as any)?.value ?? "48.00",
      "USD",
      null,
      "dd-0001",
      JSON.stringify({ dispute: d, ...data }),
      new Date().toISOString(),
    )
    .run();
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetTokenMemory();
});

describe("Worker routes", () => {
  it("returns a validation response for a null proof checker body", async () => {
    const { env } = await makeEnv();
    const response = await request("/api/proof/check", env, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "null",
    });
    expect(response.status).toBe(400);
  });

  it("serves the live proof and checks a sentence without external calls", async () => {
    const { env, replies } = await makeEnv();
    const proof = await request("/api/proof", env);
    expect(proof.status).toBe(200);
    expect(await proof.json()).toMatchObject({
      verdicts: { total: 41 },
      checker: { total: 21, struck: 21 },
    });
    const checked = await request("/api/proof/check", env, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "The buyer paid $48.00.", record_id: "CAP1" }),
    });
    expect(await checked.json()).toMatchObject({ status: "kept" });
    const tooLong = await request("/api/proof/check", env, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "x".repeat(401), record_id: "CAP1" }),
    });
    expect(await tooLong.json()).toMatchObject({ status: "struck" });
    expect(replies).toHaveLength(0);
  });

  it("adds security headers to health and disputes responses", async () => {
    const { env } = await makeEnv();
    const expected = {
      "x-content-type-options": "nosniff",
      "referrer-policy": "strict-origin-when-cross-origin",
      "x-frame-options": "DENY",
      "permissions-policy": "camera=(), microphone=(), geolocation=()",
    };
    for (const path of ["/health", "/api/disputes"]) {
      const response = await request(path, env);
      for (const [name, value] of Object.entries(expected)) expect(response.headers.get(name)).toBe(value);
    }
  });

  it("reports today's aggregate usage without visitor data", async () => {
    const { env, DB, LEDGER } = await makeEnv();
    const day = new Date().toISOString().slice(0, 10);
    await DB.prepare("INSERT INTO runs (day,visitor,dispute_id,writer,neurons,at) VALUES (?,?,?,?,?,?)")
      .bind(day, "hashed-visitor", "PP-1", "template", 7, new Date().toISOString())
      .run();
    await LEDGER.prepare("INSERT INTO ai_calls (app,day,neurons,at) VALUES (?,?,?,?)")
      .bind("dispute-desk", day, 7, new Date().toISOString())
      .run();
    const response = await request("/api/usage", env);
    expect(await response.json()).toEqual({
      day,
      runs: 1,
      appNeurons: 7,
      appCap: 700,
      accountNeurons: 7,
      accountCap: 9000,
      freeDay: 10000,
      perRun: 7,
    });
  });

  it("answers 404 with a reason when Analyse is asked about a dispute PayPal does not know", async () => {
    const { env } = await makeEnv();
    fakePayPal({});
    const res = await request("/api/disputes/PP-NOT-OURS-1/analyse", env, { method: "POST" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "not one of this desk's disputes" });
  });

  it("rejects invalid dispute ids before database or PayPal access on each route", async () => {
    const { env } = await makeEnv();
    const calls = fakePayPal({});
    for (const [path, method] of [
      ["/api/disputes/invalid%21", "GET"],
      ["/api/disputes/invalid%21/analyse", "POST"],
      ["/api/disputes/invalid%21/approve", "POST"],
      ["/api/disputes/invalid%21/pack.pdf", "GET"],
    ]) {
      const response = await request(path, env, { method });
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Invalid dispute id." });
    }
    expect(calls).toHaveLength(0);
  });

  it("builds an evidence pack from a stored run without external calls", async () => {
    const { env, DB } = await makeEnv();
    const calls = fakePayPal({});

    const missing = await request("/api/disputes/PP-MISSING/pack.pdf", env);
    expect(missing.status).toBe(404);

    await seedDispute(DB);
    const unanalyzed = await request("/api/disputes/PP-1/pack.pdf", env);
    expect(unanalyzed.status).toBe(409);
    expect(await unanalyzed.json()).toEqual({ error: "analyse this dispute first" });

    await DB.prepare("UPDATE disputes SET data = json_set(data, '$.run', json(?)) WHERE id = ?")
      .bind(
        JSON.stringify({
          decision: { verdict: "FIGHT", why: "The evidence supports delivery." },
          sentences: [{ text: "UPS delivered the parcel.", record_id: "TRK-1" }],
          records: [{ id: "TRK-1", kind: "tracking", summary: "Delivered by UPS." }],
        }),
        "PP-1",
      )
      .run();
    await DB.prepare("UPDATE disputes SET data = json_set(data, '$.filed', json(?)) WHERE id = ?")
      .bind(JSON.stringify({ call: "provide-evidence", at: "2026-10-23T01:00:00Z" }), "PP-1")
      .run();

    const response = await request("/api/disputes/PP-1/pack.pdf", env);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/pdf");
    expect(response.headers.get("content-disposition")).toBe('attachment; filename="PP-1-evidence.pdf"');
    expect(new TextDecoder().decode(await response.arrayBuffer()).startsWith("%PDF")).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("verifies and stores one owned webhook event, skips duplicates, and ignores failures and other apps", async () => {
    const { env, DB } = await makeEnv();
    const d = dispute();
    const calls = fakePayPal({
      "POST /v1/notifications/verify-webhook-signature": { json: { verification_status: "SUCCESS" } },
      "GET /v1/customer/disputes/PP-1": { json: d },
    });
    const event = { id: "event-for-test", event_type: "CUSTOMER.DISPUTE.CREATED", resource: d };
    const post = (body: unknown) =>
      request("/webhooks/paypal", env, { method: "POST", headers: webhookHeaders(), body: JSON.stringify(body) });
    const c = ctx();
    const first = await worker.fetch(
      new Request("https://desk.test/webhooks/paypal", {
        method: "POST",
        headers: webhookHeaders(),
        body: JSON.stringify(event),
      }),
      env,
      c.context,
    );
    await c.wait();
    const second = await worker.fetch(
      new Request("https://desk.test/webhooks/paypal", {
        method: "POST",
        headers: webhookHeaders(),
        body: JSON.stringify(event),
      }),
      env,
      c.context,
    );
    await c.wait();
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(((await (await request("/api/disputes", env)).json()) as any[]).map((r) => r.id)).toContain("PP-1");
    expect(
      ((await (await request("/api/feed", env)).json()) as any[]).filter((r) => r.kind === "webhook"),
    ).toHaveLength(1);
    expect(calls.filter((call) => call.path === "/v1/customer/disputes/PP-1")).toHaveLength(1);

    fakePayPal({ "POST /v1/notifications/verify-webhook-signature": { json: { verification_status: "FAILURE" } } });
    expect((await post({ ...event, id: "failure-event" })).status).toBe(400);
    expect(
      await DB.prepare("SELECT COUNT(*) AS n FROM events")
        .first<{ n: number }>()
        .then((r) => r?.n),
    ).toBe(1);

    fakePayPal({ "POST /v1/notifications/verify-webhook-signature": { json: { verification_status: "SUCCESS" } } });
    expect(
      (
        await post({
          ...event,
          id: "other-event",
          resource: dispute({ disputed_transactions: [{ custom: "other-app-1" }] }),
        })
      ).status,
    ).toBe(200);
    expect(((await (await request("/api/disputes", env)).json()) as any[]).map((r) => r.id)).toEqual(["PP-1"]);
  });

  it("guards approve by visitor ownership and owner key, files once, then rejects a duplicate", async () => {
    const { env, DB } = await makeEnv();
    const d = dispute();
    await seedDispute(DB, d, {
      run: {
        basis: {
          amount: d.dispute_amount.value, currency: d.dispute_amount.currency_code,
          status: d.status, stage: d.dispute_life_cycle_stage, reason: d.reason,
          captureId: d.disputed_transactions[0].seller_transaction_id, offerAmount: null,
        },
        version: "test-version",
        decision: { verdict: "FIGHT" },
        sentences: [{ text: "A backed fact.", record_id: "CAP-1" }],
        records: [{ kind: "capture" }],
      },
    });
    const calls = fakePayPal(ppRoutes(d));
    const visitor = await request("/api/disputes/PP-1/approve", env, {
      method: "POST",
      headers: { "user-agent": "visitor-one" },
    });
    expect(visitor.status).toBe(403);
    const owner = await request("/api/disputes/PP-1/approve", env, {
      method: "POST",
      headers: { "x-desk-key": "owner-for-test" },
    });
    expect(owner.status).toBe(200);
    expect(calls.some((call) => call.path.endsWith("/provide-evidence"))).toBe(true);
    const again = await request("/api/disputes/PP-1/approve", env, {
      method: "POST",
      headers: { "x-desk-key": "owner-for-test" },
    });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: "already filed" });
  });

  it("assigns pool cases per visitor, replays when the pool is exhausted, and lists the visitor's cases", async () => {
    const { env, DB } = await makeEnv();
    await DB.prepare("INSERT INTO pool (dispute_id,kind,position,added_at) VALUES (?,?,?,?)")
      .bind("PP-1", "fight", 1, "now")
      .run();
    await DB.prepare("INSERT INTO pool (dispute_id,kind,position,added_at) VALUES (?,?,?,?)")
      .bind("PP-2", "fight", 2, "now")
      .run();
    fakePayPal(actionableRoutes(["PP-1", "PP-2"]));
    const cookies = new Map<string, string>();
    const get = async (ua: string) => {
      const response = await request("/api/judge/next?kind=fight", env, {
        headers: { "user-agent": ua, cookie: cookies.get(ua) ?? "" },
      });
      if (response.headers.has("set-cookie")) cookies.set(ua, response.headers.get("set-cookie")!.split(";")[0]);
      return response;
    };
    const a = await get("visitor-a");
    const b = await get("visitor-b");
    const aAgain = await get("visitor-a");
    const replay = await get("visitor-c");
    expect(((await a.json()) as any).disputeId).not.toBe(((await b.json()) as any).disputeId);
    expect(((await aAgain.json()) as any).disputeId).toBe("PP-1");
    expect(((await replay.json()) as any).replay).toBeTruthy();
    const mine = await request("/api/me", env, {
      headers: { "user-agent": "visitor-a", cookie: cookies.get("visitor-a")! },
    });
    expect(await mine.json()).toMatchObject({ cases: [{ dispute_id: "PP-1", kind: "fight" }] });
  });

  it("analyses a stored dispute with model usage and uses the template at the account cap", async () => {
    const { env, DB, LEDGER, replies } = await makeEnv();
    const d = dispute();
    await seedDispute(DB, d);
    fakePayPal(ppRoutes(d));
    replies.push(
      { response: '{"tools":["get_order","get_tracking"]}', usage: { prompt_tokens: 300, completion_tokens: 40 } },
      {
        response:
          '{"sentences":[{"text":"The buyer paid $48.00 on 2026-10-19.","record_id":"CAP-1"},{"text":"UPS delivered the parcel.","record_id":"TRK-1"}]}',
        usage: { prompt_tokens: 400, completion_tokens: 60 },
      },
    );
    const response = await request("/api/disputes/PP-1/analyse", env, { method: "POST" });
    const result = (await response.json()) as any;
    expect(response.status).toBe(200);
    expect(result.run.decision.verdict).toBeTruthy();
    expect(result.run.sentences.length).toBeGreaterThan(0);
    expect(
      await DB.prepare("SELECT COUNT(*) AS n FROM runs")
        .first<{ n: number }>()
        .then((r) => r?.n),
    ).toBe(1);
    expect(
      await LEDGER.prepare("SELECT neurons FROM ai_calls")
        .first<{ neurons: number }>()
        .then((r) => r?.neurons),
    ).toBe(result.neurons);

    const { env: capped, DB: cappedDb, LEDGER: cappedLedger, replies: cappedReplies } = await makeEnv();
    await seedDispute(cappedDb, d);
    fakePayPal(ppRoutes(d));
    await cappedLedger
      .prepare("INSERT INTO ai_calls (app,day,neurons,at) VALUES (?,?,?,?)")
      .bind("another-app", new Date().toISOString().slice(0, 10), 9000, "now")
      .run();
    const cappedResult = (await (
      await request("/api/disputes/PP-1/analyse", capped, { method: "POST" })
    ).json()) as any;
    expect(cappedResult.run.writer).toBe("template");
    expect(cappedReplies).toHaveLength(0);
    expect(
      await cappedLedger
        .prepare("SELECT COUNT(*) AS n FROM ai_calls")
        .first<{ n: number }>()
        .then((r) => r?.n),
    ).toBe(1);
  });

  it("answers ask questions from a model spec and stored disputes, and rejects an empty question", async () => {
    const { env, DB, replies } = await makeEnv();
    const d1 = dispute({
      dispute_id: "PP-1",
      dispute_life_cycle_stage: "CHARGEBACK",
      dispute_amount: { value: "48.00" },
    });
    const d2 = dispute({ dispute_id: "PP-2", dispute_life_cycle_stage: "INQUIRY", dispute_amount: { value: "12.50" } });
    await seedDispute(DB, d1);
    await seedDispute(DB, d2);
    replies.push({
      response: '{"chart":"bar","groupBy":"stage","metric":"amount","period":"all"}',
      usage: { prompt_tokens: 50, completion_tokens: 20 },
    });
    const response = await request("/api/ask", env, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "money on hold by stage" }),
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      spec: { groupBy: "stage", metric: "amount" },
      title: expect.any(String),
      rows: expect.arrayContaining([
        { key: "Claim", value: 48 },
        { key: "Inquiry", value: 12.5 },
      ]),
    });
    const empty = await request("/api/ask", env, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ q: "" }),
    });
    expect(empty.status).toBe(400);
  });
});

function webhookHeaders() {
  return {
    "content-type": "application/json",
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.test/cert",
    "paypal-transmission-id": "transmission-for-test",
    "paypal-transmission-sig": "signature-for-test",
    "paypal-transmission-time": "2026-10-23T01:00:00Z",
  };
}
