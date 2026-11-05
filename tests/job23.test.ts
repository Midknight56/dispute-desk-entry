import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { drainPendingEvents, syncDispute } from "../src/index";
import { fileResponse, type FileDeps } from "../src/file";
import { store } from "../src/store";
import { resetTokenMemory } from "../src/token";
import { ctx, fakePayPal, makeEnv } from "./helpers/env";

const id = "PP-J23";
const dispute = {
  dispute_id: id,
  status: "WAITING_FOR_SELLER_RESPONSE",
  dispute_life_cycle_stage: "INQUIRY",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  dispute_amount: { value: "6.00", currency_code: "USD" },
  disputed_transactions: [{ seller_transaction_id: "CAP-J23", custom: "dd-j23" }],
  links: [{ rel: "accept_claim" }],
};
const run = {
  basis: {
    amount: "6.00", currency: "USD", status: dispute.status, stage: "INQUIRY",
    reason: dispute.reason, captureId: "CAP-J23", offerAmount: null,
  },
  version: "version-j23",
  decision: { verdict: "ACCEPT", why: "No delivery record." },
  records: [],
  sentences: [{ text: "The claim is accepted.", record_id: "CAP-J23" }],
  dropped: [],
  steps: [],
  writer: "template",
  usage: { calls: 0, prompt_tokens: 0, completion_tokens: 0 },
};
type TestEnv = Awaited<ReturnType<typeof makeEnv>>["env"];
const routes = () => ({
  [`GET /v1/customer/disputes/${id}`]: { json: dispute },
  [`POST /v1/customer/disputes/${id}/accept-claim`]: { json: {} },
  "GET /v2/payments/captures/CAP-J23": {
    json: {
      id: "CAP-J23",
      status: "COMPLETED",
      amount: dispute.dispute_amount,
      supplementary_data: { related_ids: { order_id: "ORDER-J23" } },
    },
  },
  "GET /v2/checkout/orders/ORDER-J23": { json: { id: "ORDER-J23", purchase_units: [] } },
  "GET /v1/customer/disputes": { json: { items: [] } },
  "POST /v1/notifications/verify-webhook-signature": { json: { verification_status: "SUCCESS" } },
});
async function seed(env: TestEnv, draft: unknown = run, d: unknown = dispute) {
  await store(env.DB).putDispute({ id, status: dispute.status, data: { dispute: d, run: draft } });
}
function post(env: TestEnv, action: string, version = run.version) {
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
async function maintenance(env: TestEnv) {
  const c = ctx();
  const response = await worker.fetch(new Request("https://desk.test/api/disputes"), env, c.context);
  expect(response.status).toBe(200);
  await c.wait();
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function pauseDisputeWrite(env: TestEnv) {
  const entered = deferred();
  const release = deferred();
  const prepare = env.DB.prepare.bind(env.DB);
  let paused = false;
  vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
    const stmt = prepare(sql);
    if (!paused && sql.startsWith("INSERT INTO disputes")) {
      paused = true;
      const write = stmt.run.bind(stmt);
      vi.spyOn(stmt, "run").mockImplementation(async () => {
        entered.resolve();
        await release.promise;
        return write();
      });
    }
    return stmt;
  });
  return { entered: entered.promise, release: release.resolve };
}
async function pending(env: TestEnv, event: { id: string; event_type: string; resource: unknown }, age = 180_000) {
  await store(env.DB).storeEventIfNew(event as any, JSON.stringify(event));
  await env.DB.prepare("UPDATE events SET received_at = ? WHERE id = ?")
    .bind(new Date(Date.now() - age).toISOString(), event.id)
    .run();
}
const capture = (eventId: string) => ({
  id: eventId,
  event_type: "PAYMENT.CAPTURE.COMPLETED",
  resource: {
    id: `CAP-${eventId}`,
    custom_id: "dd-j23",
    amount: { value: "6.00", currency_code: "USD" },
    create_time: "2026-11-01T00:00:00.000Z",
    supplementary_data: { related_ids: { order_id: "ORDER-J23" } },
  },
});
async function deliver(env: TestEnv, event: unknown) {
  const c = ctx();
  const response = await worker.fetch(
    new Request("https://desk.test/webhooks/paypal", {
      method: "POST",
      body: JSON.stringify(event),
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
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetTokenMemory();
});

describe("job 23 filing persistence", () => {
  it("keeps a full approval when a sync with an old snapshot finishes later", async () => {
    const { env } = await makeEnv();
    await seed(env);
    fakePayPal(routes());
    const paused = pauseDisputeWrite(env);
    const syncing = syncDispute(env, id);
    await paused.entered;
    expect((await store(env.DB).getDispute(id))?.data.filed).toBeUndefined();
    expect((await post(env, "approve")).status).toBe(200);
    const filed = (await store(env.DB).getDispute(id))?.data.filed;
    expect(filed).toMatchObject({ ok: true, at: expect.any(String) });
    await store(env.DB).mergeData(id, { sellerMemo: "saved during sync" });
    paused.release();
    await syncing;
    expect((await store(env.DB).getDispute(id))?.data).toMatchObject({
      filed,
      operation: { state: "done" },
      sellerMemo: "saved during sync",
      run,
    });
  });

  it("keeps filed and desk fields when a new analysis saves its run", async () => {
    const { env } = await makeEnv();
    await seed(env);
    fakePayPal(routes());
    expect((await post(env, "approve")).status).toBe(200);
    const filed = (await store(env.DB).getDispute(id))?.data.filed;
    const paused = pauseDisputeWrite(env);
    const analysis = post(env, "analyse");
    await paused.entered;
    await store(env.DB).mergeData(id, { sellerMemo: "saved during analysis" });
    paused.release();
    expect((await analysis).status).toBe(200);
    expect((await store(env.DB).getDispute(id))?.data).toMatchObject({ filed, sellerMemo: "saved during analysis" });
    expect((await store(env.DB).getDispute(id))?.data.run.version).not.toBe(run.version);
  });
});

describe("job 23 uncertain filings", () => {
  it.each(["network", "server"])(
    "persists sending before the accept write and preserves uncertainty after %s failure",
    async (failure) => {
      const { env } = await makeEnv();
      await seed(env);
      fakePayPal(routes());
      const fetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        if (String(input).endsWith("/accept-claim")) {
          const data = (await store(env.DB).getDispute(id))!.data;
          expect(data.operation).toMatchObject({
            action: "accept",
            versionAt: run.version,
            state: "sending",
            at: expect.any(String),
          });
          expect(data.operation.requestId).toBe(new Headers(init?.headers).get("PayPal-Request-Id"));
          if (failure === "network") throw new Error("connection lost after sending");
          return Response.json({ name: "SERVER_ERROR" }, { status: 503 });
        }
        return fetch(input, init);
      });
      const response = await post(env, "approve");
      expect(response.status).toBe(202);
      const body: any = await response.json();
      expect(body).toMatchObject({
        error: "PayPal did not confirm the filing. The desk will check before it sends anything else.",
        operation: { state: "uncertain", requestId: expect.any(String) },
      });
      expect((await store(env.DB).getDispute(id))?.data.operation).toEqual(body.operation);
      const analysed = await post(env, "analyse");
      expect(analysed.status).toBe(409);
      expect(await analysed.json()).toEqual({ error: "A filing is waiting for PayPal. Use Check PayPal before you continue." });
      expect((await store(env.DB).getDispute(id))?.data.run).toEqual(run);
    },
  );

  it.each([false, true])(
    "keeps an uncertain accept with uncorrelated buyer outcome and refund amount present %s",
    async (withRefund) => {
      const { env } = await makeEnv();
      await seed(env);
      const replies: Record<string, { json: unknown; status?: number }> = routes();
      const calls = fakePayPal(replies);
      const fetch = globalThis.fetch;
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const response = await fetch(input, init);
        if (String(input).endsWith("/accept-claim")) throw new Error("connection lost");
        return response;
      });
      expect((await post(env, "approve")).status).toBe(202);
      const operation = (await store(env.DB).getDispute(id))!.data.operation;
      replies[`GET /v1/customer/disputes/${id}`] = {
        json: {
          ...dispute,
          status: "RESOLVED", links: [],
          update_time: new Date(Date.parse(operation.at) + 1000).toISOString(),
          dispute_outcome: {
            outcome_code: "RESOLVED_BUYER_FAVOUR",
            ...(withRefund ? { amount_refunded: dispute.dispute_amount } : {}),
          },
        },
      };
      const response = await post(env, "approve");
      expect(response.status).toBe(202);
      expect((await store(env.DB).getDispute(id))?.data.filed).toBeUndefined();
      expect((await store(env.DB).getDispute(id))?.data.operation).toEqual(operation);
      expect(calls.filter((c) => c.path.endsWith("/accept-claim"))).toHaveLength(1);
    },
  );

  it("retries an uncertain accept with the same stored request id", async () => {
    const { env } = await makeEnv();
    await seed(env);
    const calls = fakePayPal(routes());
    const fetch = globalThis.fetch;
    let attempts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/accept-claim") && ++attempts === 1) throw new Error("connection lost");
      return response;
    });
    expect((await post(env, "approve")).status).toBe(202);
    const operation = (await store(env.DB).getDispute(id))!.data.operation;
    expect((await post(env, "approve")).status).toBe(200);
    const writes = calls.filter((c) => c.path.endsWith("/accept-claim"));
    expect(writes).toHaveLength(2);
    expect(writes.map((c) => c.headers.get("PayPal-Request-Id"))).toEqual([operation.requestId, operation.requestId]);
    expect(writes[0].body).toBe(writes[1].body);
    expect((await store(env.DB).getDispute(id))?.data.operation.state).toBe("done");
  });

  it("rechecks the operation after winning a delayed filing claim", async () => {
    const { env } = await makeEnv();
    await seed(env);
    const calls = fakePayPal(routes());
    const fetch = globalThis.fetch;
    const sending = deferred(),
      finishFirst = deferred();
    let attempts = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const response = await fetch(input, init);
      if (String(input).endsWith("/accept-claim") && ++attempts === 1) {
        sending.resolve();
        await finishFirst.promise;
        throw new Error("connection lost");
      }
      return response;
    });
    const first = post(env, "approve");
    await sending.promise;
    const prepare = env.DB.prepare.bind(env.DB);
    const claiming = deferred(),
      releaseClaim = deferred();
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      const stmt = prepare(sql);
      if (sql.startsWith("UPDATE disputes SET data = json_set(data, '$.filing'")) {
        const write = stmt.run.bind(stmt);
        vi.spyOn(stmt, "run").mockImplementation(async () => {
          claiming.resolve();
          await releaseClaim.promise;
          return write();
        });
      }
      return stmt;
    });
    const second = post(env, "approve");
    await claiming.promise;
    finishFirst.resolve();
    expect((await first).status).toBe(202);
    releaseClaim.resolve();
    expect((await second).status).toBe(200);
    const ids = calls.filter((c) => c.path.endsWith("/accept-claim")).map((c) => c.headers.get("PayPal-Request-Id"));
    expect(ids).toHaveLength(2);
    expect(ids[0]).toBe(ids[1]);
  });

  it("keeps an uncertain operation when reconciliation cannot read PayPal", async () => {
    const { env } = await makeEnv();
    await seed(env);
    const operation = {
      action: "accept",
      requestId: "pending-id",
      versionAt: run.version,
      state: "uncertain",
      at: new Date().toISOString(),
    };
    await store(env.DB).mergeData(id, { operation });
    const calls = fakePayPal({ [`GET /v1/customer/disputes/${id}`]: { json: {}, status: 503 } });
    const response = await post(env, "approve");
    expect(response.status).toBe(202);
    expect((await store(env.DB).getDispute(id))?.data.operation).toMatchObject(operation);
    expect(calls.filter((c) => c.path.endsWith("/accept-claim"))).toHaveLength(0);
  });

  it("blocks a fresh sending operation and reconciles an expired sending hold", async () => {
    const { env } = await makeEnv();
    await seed(env);
    const operation = {
      action: "accept",
      requestId: "stored-id",
      versionAt: run.version,
      state: "sending",
      at: new Date().toISOString(),
    };
    await store(env.DB).mergeData(id, { operation, filing: Date.now() });
    const calls = fakePayPal(routes());
    expect((await post(env, "analyse")).status).toBe(409);
    expect((await post(env, "approve")).status).toBe(409);
    expect(calls).toHaveLength(0);
    await store(env.DB).mergeData(id, { filing: Date.now() - 180_000 });
    expect((await post(env, "approve")).status).toBe(200);
    expect(calls.find((c) => c.path.endsWith("/accept-claim"))?.headers.get("PayPal-Request-Id")).toBe("stored-id");
  });

  it("does not replace the run when an approval starts after analysis read it", async () => {
    const { env } = await makeEnv();
    await seed(env);
    const replies: Record<string, { json: unknown; status?: number }> = routes();
    replies[`POST /v1/customer/disputes/${id}/accept-claim`] = { json: {}, status: 503 };
    fakePayPal(replies);
    const paused = pauseDisputeWrite(env);
    const analysis = post(env, "analyse");
    await paused.entered;
    expect((await post(env, "approve")).status).toBe(202);
    paused.release();
    expect((await analysis).status).toBe(409);
    expect((await store(env.DB).getDispute(id))?.data.run).toEqual(run);
  });

  it("records a clear refusal and permits a new draft with a new request id", async () => {
    const { env } = await makeEnv();
    await seed(env);
    const replies: Record<string, { json: unknown; status?: number }> = routes();
    replies[`POST /v1/customer/disputes/${id}/accept-claim`] = { json: { name: "ACTION_NOT_ALLOWED" }, status: 422 };
    const calls = fakePayPal(replies);
    expect((await post(env, "approve")).status).toBe(422);
    expect((await store(env.DB).getDispute(id))?.data.operation).toMatchObject({
      state: "refused",
      detail: expect.stringContaining("422"),
    });
    const analysis = await post(env, "analyse");
    expect(analysis.status).toBe(200);
    const { run: draft }: any = await analysis.json();
    replies[`POST /v1/customer/disputes/${id}/accept-claim`] = { json: {} };
    expect((await post(env, "approve", draft.version)).status).toBe(200);
    const ids = calls.filter((c) => c.path.endsWith("/accept-claim")).map((c) => c.headers.get("PayPal-Request-Id"));
    expect(ids).toHaveLength(2);
    expect(ids[0]).not.toBe(ids[1]);
  });

  it.each([
    ["FIGHT", "provide_evidence", "evidence", "provideEvidence"],
    ["FIGHT", "provide_supporting_info", "supporting", "provideSupportingInfo"],
    ["ACCEPT", "accept_claim", "accept", "acceptClaim"],
    ["OFFER", "make_offer", "offer", "makeOffer"],
  ] as const)("passes the stored id through %s via %s", async (verdict, rel, action, method) => {
    const deps = { provideEvidence: vi.fn(), provideSupportingInfo: vi.fn(), acceptClaim: vi.fn(), makeOffer: vi.fn() };
    const result = await fileResponse(
      deps as FileDeps,
      { ...dispute, links: [{ rel }] },
      {
        verdict,
        rule: "approved",
        why: "approved",
        facts: [],
        missing: [],
        changeIf: "",
        disagreements: [],
        offerAmount: "3.00",
      },
      run.sentences,
      undefined,
      undefined,
      { action, requestId: "persisted-operation-id" },
    );
    expect(result.ok).toBe(true);
    const args = deps[method].mock.calls[0];
    expect(args[method === "provideSupportingInfo" ? 2 : 1].requestId).toBe("persisted-operation-id");
  });

  it.each([
    [
      "FIGHT",
      "provide_evidence",
      "provide-evidence",
      { evidences: [{ source: "SUBMITTED_BY_SELLER", evidence_type: "PROOF_OF_FULFILLMENT", notes: run.sentences[0].text, date: "2099-01-01T00:00:00Z" }] },
    ],
    [
      "FIGHT", "provide_supporting_info", "provide-supporting-info",
      { supporting_info: [{ source: "SUBMITTED_BY_SELLER", notes: run.sentences[0].text, provided_time: "2099-01-01T00:00:00Z" }] },
    ],
    [
      "OFFER",
      "make_offer",
      "make-offer",
      { offer: { history: [{ actor: "SELLER", event_type: "PROPOSED", offer_type: "REFUND", offer_time: "2099-01-01T00:00:00Z",
        offer_amount: { value: "3.00", currency_code: "USD" }, notes: run.sentences[0].text,
      }] } },
    ],
  ] as const)("reconciles %s with %s using PayPal state", async (verdict, rel, path, effect) => {
    const { env } = await makeEnv();
    const d = { ...dispute, links: [{ rel }] };
    await seed(env, {
      ...run, basis: { ...run.basis, offerAmount: "3.00" },
      decision: { verdict, why: "approved", offerAmount: "3.00" },
    }, d);
    const replies: Record<string, { json: unknown; status?: number }> = routes();
    replies[`GET /v1/customer/disputes/${id}`] = { json: d };
    replies[`POST /v1/customer/disputes/${id}/${path}`] = { json: {}, status: 503 };
    const calls = fakePayPal(replies);
    expect((await post(env, "approve")).status).toBe(202);
    replies[`GET /v1/customer/disputes/${id}`] = { json: { ...d, ...effect } };
    expect((await post(env, "approve")).status).toBe(200);
    expect(calls.filter((c) => c.path.endsWith(`/${path}`))).toHaveLength(1);
    expect((await store(env.DB).getDispute(id))?.data.operation.state).toBe("done");
  });
});

describe("job 23 pending webhook maintenance", () => {
  it("recovers a failed dispute event on the next maintenance without redelivery", async () => {
    const { env } = await makeEnv();
    const replies: Record<string, { json: unknown; status?: number }> = routes();
    replies[`GET /v1/customer/disputes/${id}`] = { json: {}, status: 503 };
    const calls = fakePayPal(replies);
    await deliver(env, { id: "WH-DISPUTE", event_type: "CUSTOMER.DISPUTE.CREATED", resource: dispute });
    expect(await env.DB.prepare("SELECT processed_at, claimed_at FROM events").first()).toEqual({
      processed_at: null,
      claimed_at: null,
    });
    await env.DB.prepare("UPDATE events SET received_at = ?")
      .bind(new Date(Date.now() - 180_000).toISOString())
      .run();
    replies[`GET /v1/customer/disputes/${id}`] = { json: dispute };
    await maintenance(env);
    expect(await env.DB.prepare("SELECT processed_at FROM events").first()).toEqual({
      processed_at: expect.any(String),
    });
    expect((await store(env.DB).getDispute(id))?.data.dispute).toEqual(dispute);
    expect(calls.filter((c) => c.path.includes("verify-webhook"))).toHaveLength(1);
  });

  it("restores a lost capture sale after its first processing throws", async () => {
    const { env } = await makeEnv();
    fakePayPal(routes());
    const prepare = env.DB.prepare.bind(env.DB);
    let failed = false;
    vi.spyOn(env.DB, "prepare").mockImplementation((sql: string) => {
      const stmt = prepare(sql);
      if (!failed && sql.startsWith("INSERT OR IGNORE INTO sales")) {
        failed = true;
        vi.spyOn(stmt, "run").mockRejectedValueOnce(new Error("temporary database failure"));
      }
      return stmt;
    });
    await deliver(env, capture("WH-CAPTURE"));
    expect(await env.DB.prepare("SELECT processed_at FROM events").first()).toEqual({ processed_at: null });
    expect(await env.DB.prepare("SELECT * FROM sales").first()).toBeNull();
    await env.DB.prepare("UPDATE events SET received_at = ?")
      .bind(new Date(Date.now() - 180_000).toISOString())
      .run();
    await maintenance(env);
    expect(await env.DB.prepare("SELECT capture_id, order_id, amount FROM sales").first()).toEqual({
      capture_id: "CAP-WH-CAPTURE",
      order_id: "ORDER-J23",
      amount: "6.00",
    });
    expect(await env.DB.prepare("SELECT processed_at FROM events").first()).toEqual({
      processed_at: expect.any(String),
    });
  });

  it("claims a pending event atomically across two concurrent drains", async () => {
    const { env } = await makeEnv();
    await pending(env, { id: "WH-RACE", event_type: "CUSTOMER.DISPUTE.UPDATED", resource: dispute });
    const calls = fakePayPal(routes());
    const fetch = globalThis.fetch;
    const entered = deferred(),
      release = deferred();
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).endsWith(`disputes/${id}`)) {
        entered.resolve();
        await release.promise;
      }
      return fetch(input, init);
    });
    const a = drainPendingEvents(env),
      b = drainPendingEvents(env);
    await entered.promise;
    release.resolve();
    await Promise.all([a, b]);
    expect(calls.filter((c) => c.path.endsWith(`disputes/${id}`))).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM feed WHERE kind = 'webhook'").first()).toEqual({ n: 1 });
  });

  it("runs maintenance once for overlapping page loads and respects its existing interval", async () => {
    const { env } = await makeEnv();
    await pending(env, capture("WH-PAGES"));
    const calls = fakePayPal(routes());
    await Promise.all([maintenance(env), maintenance(env)]);
    await maintenance(env);
    expect(calls.filter((c) => c.path.startsWith("/v1/customer/disputes?"))).toHaveLength(1);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM feed WHERE kind = 'webhook'").first()).toEqual({ n: 1 });
  });

  it("drains at most five events oldest first and leaves recent events pending", async () => {
    const { env } = await makeEnv();
    fakePayPal(routes());
    for (let i = 0; i < 7; i++) await pending(env, capture(`WH-${i}`), 180_000 + i * 1000);
    await pending(env, capture("WH-RECENT"), 10_000);
    await maintenance(env);
    const feed = await store(env.DB).recentFeed();
    expect(
      feed
        .filter((r) => r.kind === "webhook")
        .map((r) => r.ref)
        .reverse(),
    ).toEqual(["CAP-WH-6", "CAP-WH-5", "CAP-WH-4", "CAP-WH-3", "CAP-WH-2"]);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM events WHERE processed_at IS NULL").first()).toEqual({
      n: 3,
    });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sales").first()).toEqual({ n: 5 });
  });

  it("recovers a claim older than ten minutes and leaves a fresh claim alone", async () => {
    const { env } = await makeEnv();
    fakePayPal(routes());
    await pending(env, capture("WH-EXPIRED"));
    await pending(env, capture("WH-HELD"));
    for (const [eventId, age] of [
      ["WH-EXPIRED", 660_000],
      ["WH-HELD", 60_000],
    ] as const)
      await env.DB.prepare("UPDATE events SET claimed_at = ? WHERE id = ?")
        .bind(new Date(Date.now() - age).toISOString(), eventId)
        .run();
    await maintenance(env);
    expect(await env.DB.prepare("SELECT id FROM events WHERE processed_at IS NOT NULL").all()).toMatchObject({
      results: [{ id: "WH-EXPIRED" }],
    });
  });

  it("leaves a failed retry pending and continues to the next event", async () => {
    const { env } = await makeEnv();
    fakePayPal({
      ...routes(),
      [`GET /v1/customer/disputes/${id}`]: { json: {}, status: 503 },
    });
    await pending(env, { id: "WH-FAIL", event_type: "CUSTOMER.DISPUTE.UPDATED", resource: dispute }, 240_000);
    await pending(env, capture("WH-NEXT"));
    await maintenance(env);
    expect(await env.DB.prepare("SELECT processed_at, claimed_at FROM events WHERE id = 'WH-FAIL'").first()).toEqual({
      processed_at: null,
      claimed_at: null,
    });
    expect(await env.DB.prepare("SELECT processed_at FROM events WHERE id = 'WH-NEXT'").first()).toEqual({
      processed_at: expect.any(String),
    });
    expect(await env.DB.prepare("SELECT capture_id FROM sales").first()).toEqual({ capture_id: "CAP-WH-NEXT" });
  });
});
