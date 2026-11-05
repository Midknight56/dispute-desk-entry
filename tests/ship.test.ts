import { afterEach, expect, it, vi } from "vitest";
import { sessionCookie } from "../src/session";
import worker from "../src/index";
import { makeEnv, fakePayPal, ctx } from "./helpers/env";
import { resetTokenMemory } from "../src/token";
import { assign } from "../src/judge";

const captured = "2026-10-26T00:00:00Z";
const request = async (env: any, path: string, init: RequestInit = {}) => {
  const headers = new Headers(init.headers);
  headers.set("user-agent", "judge");
  headers.set("cookie", (await sessionCookie("11111111-1111-4111-8111-111111111111", env)).split(";")[0]);
  return worker.fetch(new Request(`https://desk.test${path}`, { ...init, headers }), env, ctx().context);
};
afterEach(() => {
  vi.unstubAllGlobals();
  resetTokenMemory();
});

it("shipState is soon at 47h59m and late at 48h00m", async () => {
  const { shipState } = await import("../src/ship");
  expect(
    shipState({ captured_at: captured, tracker_id: null }, Date.parse(captured) + 47 * 3600000 + 59 * 60000),
  ).toEqual({ state: "soon", due_in_ms: 60000 });
  expect(shipState({ captured_at: captured, tracker_id: null }, Date.parse(captured) + 48 * 3600000)).toEqual({
    state: "late",
    due_in_ms: 0,
  });
});
it("shipState with a tracker is on_paypal at any age", async () => {
  const { shipState } = await import("../src/ship");
  for (const age of [0, 72 * 3600000])
    expect(shipState({ captured_at: captured, tracker_id: "T1" }, Date.parse(captured) + age)).toEqual({
      state: "on_paypal",
      due_in_ms: 0,
    });
});
async function seed() {
  const setup = await makeEnv();
  await setup.DB.prepare("INSERT INTO sales VALUES ('CAP-1','ORD-1','dd-s001','8.00','USD',?,?)")
    .bind(captured, captured)
    .run();
  await setup.DB.prepare(
    "INSERT INTO shipments (custom_id,order_id,capture_id,carrier,tracking_number,created_at) VALUES ('dd-s001','ORD-1','CAP-1','UPS','1Z123',?)",
  )
    .bind(captured)
    .run();
  await setup.DB.prepare("INSERT INTO pool (dispute_id,kind,position,added_at) VALUES ('CAP-1','ship',1,?)")
    .bind(captured)
    .run();
  return setup;
}
it("capture webhook stores a sale once and ignores custom ids outside dd-", async () => {
  const { env, DB } = await makeEnv();
  fakePayPal({ "POST /v1/notifications/verify-webhook-signature": { json: { verification_status: "SUCCESS" } } });
  const headers = Object.fromEntries(
    ["auth-algo", "cert-url", "transmission-id", "transmission-sig", "transmission-time"].map((k) => [
      "paypal-" + k,
      "test",
    ]),
  );
  const event = {
    id: "EV1",
    event_type: "PAYMENT.CAPTURE.COMPLETED",
    resource: {
      id: "CAP-1",
      custom_id: "dd-s001",
      amount: { value: "8.00", currency_code: "USD" },
      create_time: captured,
      supplementary_data: { related_ids: { order_id: "ORD-1" } },
    },
  };
  for (const ev of [
    event,
    event,
    { ...event, id: "EV2" },
    { ...event, id: "EV3", resource: { ...event.resource, id: "CAP-2", custom_id: "elsewhere" } },
  ]) {
    const c = ctx();
    expect(
      (
        await worker.fetch(
          new Request("https://desk.test/webhooks/paypal", { method: "POST", headers, body: JSON.stringify(ev) }),
          env,
          c.context,
        )
      ).status,
    ).toBe(200);
    await c.wait();
  }
  expect((await DB.prepare("SELECT * FROM sales").all()).results).toEqual([
    expect.objectContaining({
      capture_id: "CAP-1",
      order_id: "ORD-1",
      amount: "8.00",
      currency: "USD",
      captured_at: captured,
    }),
  ]);
});
it("sales list excludes unshipped and disputed sales and marks yours", async () => {
  const { env, DB } = await seed();
  await DB.prepare("INSERT INTO sales VALUES ('CAP-2','ORD-2','dd-s002','6.00','USD',?,?)")
    .bind(captured, captured)
    .run();
  expect(await (await request(env, "/api/sales")).json()).toEqual([
    expect.objectContaining({ capture_id: "CAP-1", yours: false }),
  ]);
  await request(env, "/api/judge/next?kind=ship");
  expect(await (await request(env, "/api/sales")).json()).toEqual([
    expect.objectContaining({ capture_id: "CAP-1", yours: true }),
  ]);
  await DB.prepare("INSERT INTO disputes (id,custom_id,data,updated_at) VALUES ('PP-1','dd-s001','{}',?)")
    .bind(captured)
    .run();
  expect(await (await request(env, "/api/sales")).json()).toEqual([]);
  expect((await request(env, "/api/sales/CAP-1/track", { method: "POST" })).status).toBe(404);
});
it("judge assigns ship captures and counts them", async () => {
  const { env } = await seed();
  expect(
    assign([{ dispute_id: "CAP-1", kind: "ship", position: 1, handed_to: null, handed_at: null }], "judge", "ship")
      .disputeId,
  ).toBe("CAP-1");
  expect(await (await request(env, "/api/judge/next?kind=ship")).json()).toMatchObject({
    disputeId: "CAP-1",
    replay: false,
  });
  expect(await (await request(env, "/api/judge/pool")).json()).toContainEqual({ kind: "ship", total: 1, free: 0 });
});
it("track refuses another visitor and invalid or missing captures", async () => {
  const { env } = await seed();
  const calls = fakePayPal({});
  expect((await request(env, "/api/sales/CAP-1/track", { method: "POST" })).status).toBe(403);
  expect((await request(env, "/api/sales/bad%21/track", { method: "POST" })).status).toBe(400);
  expect((await request(env, "/api/sales/MISSING/track", { method: "POST" })).status).toBe(404);
  expect(calls).toHaveLength(0);
});
it("track already on PayPal returns already with no call", async () => {
  const { env, DB } = await seed();
  await request(env, "/api/judge/next?kind=ship");
  await DB.prepare("UPDATE shipments SET tracker_id = 'T1'").run();
  const calls = fakePayPal({});
  const res = await request(env, "/api/sales/CAP-1/track", { method: "POST" });
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ already: true });
  expect(calls).toHaveLength(0);
});
it("track success sends notifyPayer false, stores tracker and feed without cap use", async () => {
  const { env, DB } = await seed();
  const calls = fakePayPal({
    "POST /v2/checkout/orders/ORD-1/track": {
      json: { purchase_units: [{ shipping: { trackers: [{ id: "T1" }] } }] },
      status: 201,
    },
  });
  const res = await request(env, "/api/sales/CAP-1/track", {
    method: "POST",
    headers: { "x-desk-key": "owner-for-test" },
  });
  expect(res.status).toBe(200);
  expect(await res.json()).toMatchObject({ state: "on_paypal" });
  expect(JSON.parse(calls.find((c) => c.path.endsWith("/track"))!.body!)).toEqual({
    capture_id: "CAP-1",
    tracking_number: "1Z123",
    carrier: "UPS",
    notify_payer: false,
  });
  expect(await DB.prepare("SELECT tracker_id FROM shipments").first()).toEqual({ tracker_id: "T1" });
  expect((await DB.prepare("SELECT * FROM feed").all()).results).toContainEqual(
    expect.objectContaining({
      kind: "call",
      title: "POST /v2/checkout/orders/{id}/track",
      ref: "CAP-1",
      detail: "tracking on PayPal before any dispute",
    }),
  );
  expect((await DB.prepare("SELECT * FROM runs").all()).results).toEqual([]);
});
it("track PayPal failure returns 502 and stores nothing", async () => {
  const { env, DB } = await seed();
  await request(env, "/api/judge/next?kind=ship");
  fakePayPal({ "POST /v2/checkout/orders/ORD-1/track": { json: { name: "FAIL" }, status: 500 } });
  expect((await request(env, "/api/sales/CAP-1/track", { method: "POST" })).status).toBe(502);
  expect(await DB.prepare("SELECT tracker_id FROM shipments").first()).toEqual({ tracker_id: null });
  expect((await DB.prepare("SELECT * FROM feed").all()).results).toEqual([]);
});
