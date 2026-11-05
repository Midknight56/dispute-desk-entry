import { beforeEach, describe, expect, it } from "vitest";
import { paypal, PayPalError } from "../src/paypal";
import { resetTokenMemory, type TokenEnv } from "../src/token";

function setup(answer: unknown = {}) {
  const calls: { url: string; method: string; headers: Headers; body: BodyInit | null | undefined }[] = [];
  const kv = {
    async get() {
      return null;
    },
    async put() {},
  };
  const env: TokenEnv = {
    PAYPAL_CLIENT_ID: "id",
    PAYPAL_CLIENT_SECRET: "secret",
    PAYPAL_BASE: "https://api.test",
    TOKEN: kv as unknown as KVNamespace,
  };
  const fetchFn = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const target = String(url);
    if (target.endsWith("/v1/oauth2/token"))
      return new Response(JSON.stringify({ access_token: "tok", expires_in: 3600 }), { status: 200 });
    calls.push({ url: target, method: init.method ?? "GET", headers: new Headers(init.headers), body: init.body });
    const next = typeof answer === "function" ? (answer as (url: string) => unknown)(target) : answer;
    return next instanceof Response ? next : new Response(JSON.stringify(next), { status: 200 });
  }) as typeof fetch;
  return { calls, api: paypal(env, fetchFn) };
}

function expectCall(call: ReturnType<typeof setup>["calls"][number], path: string, method: string, body?: unknown) {
  expect(call.url).toBe(`https://api.test${path}`);
  expect(call.method).toBe(method);
  expect(call.headers.get("authorization")).toBe("Bearer tok");
  if (["POST", "PUT", "PATCH"].includes(method)) expect(call.headers.get("paypal-request-id")).toBeTruthy();
  if (body !== undefined) {
    expect(call.headers.get("content-type")).toBe("application/json");
    expect(JSON.parse(String(call.body))).toEqual(body);
  }
}

describe("PayPal client", () => {
  beforeEach(() => resetTokenMemory());

  it("accepts without inventing a reason and keeps REFUND", async () => {
    const { api, calls } = setup();
    await api.acceptClaim("D1", { note: "We accept.", requestId: "dd-D1-accept" });
    expectCall(calls[0], "/v1/customer/disputes/D1/accept-claim", "POST", {
      note: "We accept.",
      accept_claim_type: "REFUND",
    });
    expect(calls[0].headers.get("paypal-request-id")).toBe("dd-D1-accept");
    expect(JSON.parse(String(calls[0].body))).not.toHaveProperty("accept_claim_reason");
  });

  it("creates an order", async () => {
    const { api, calls } = setup({
      id: "O1",
      status: "CREATED",
      links: [{ rel: "payer-action", href: "https://approve" }],
    });
    expect(
      await api.createOrder({
        value: "12.00",
        customId: "dd-1",
        description: "Book",
        returnUrl: "https://r",
        cancelUrl: "https://c",
      }),
    ).toEqual({ id: "O1", status: "CREATED", approveUrl: "https://approve" });
    expectCall(calls[0], "/v2/checkout/orders", "POST", {
      intent: "CAPTURE",
      purchase_units: [
        {
          reference_id: "dd-1",
          custom_id: "dd-1",
          description: "Book",
          amount: { currency_code: "USD", value: "12.00" },
        },
      ],
      payment_source: {
        paypal: {
          experience_context: {
            shipping_preference: "GET_FROM_FILE",
            user_action: "PAY_NOW",
            return_url: "https://r",
            cancel_url: "https://c",
          },
        },
      },
    });
  });

  it("rejects an invalid custom id without a request", async () => {
    const { api, calls } = setup();
    await expect(
      api.createOrder({ value: "1", customId: "bad", description: "x", returnUrl: "r", cancelUrl: "c" }),
    ).rejects.toThrow();
    expect(calls).toHaveLength(0);
  });

  it("gets an order", async () => {
    const { api, calls } = setup({ id: "O1" });
    await api.getOrder("O1");
    expectCall(calls[0], "/v2/checkout/orders/O1", "GET");
  });
  it("captures an order", async () => {
    const { api, calls } = setup({
      id: "O1",
      status: "COMPLETED",
      purchase_units: [{ payments: { captures: [{ id: "C1", status: "COMPLETED" }] } }],
    });
    expect(await api.captureOrder("O1")).toEqual({
      orderId: "O1",
      status: "COMPLETED",
      captureId: "C1",
      captureStatus: "COMPLETED",
    });
    expectCall(calls[0], "/v2/checkout/orders/O1/capture", "POST", {});
  });
  it("adds tracking", async () => {
    const { api, calls } = setup({ purchase_units: [{ shipping: { trackers: [{ id: "T1" }] } }] });
    await api.addTracking("O1", { captureId: "C1", trackingNumber: "N1", carrier: "UPS" });
    expectCall(calls[0], "/v2/checkout/orders/O1/track", "POST", {
      capture_id: "C1",
      tracking_number: "N1",
      carrier: "UPS",
      notify_payer: false,
    });
  });
  it("updates tracker status", async () => {
    const { api, calls } = setup({});
    await api.setTrackerStatus("T1", { captureId: "C1", trackingNumber: "N1", carrier: "UPS", status: "SHIPPED" });
    expectCall(calls[0], "/v1/shipping/trackers/T1", "PUT", {
      transaction_id: "C1",
      tracking_number: "N1",
      status: "SHIPPED",
      carrier: "UPS",
    });
  });
  it("gets a tracker", async () => {
    const { api, calls } = setup({});
    await api.getTracker("T1");
    expectCall(calls[0], "/v1/shipping/trackers/T1", "GET");
  });
  it("lists disputes", async () => {
    const { api, calls } = setup({ items: [{ id: "D1" }] });
    expect(await api.listDisputes()).toEqual([{ id: "D1" }]);
    expectCall(calls[0], "/v1/customer/disputes?page_size=50", "GET");
  });
  it("gets a dispute", async () => {
    const { api, calls } = setup({ id: "D1" });
    await api.getDispute("D1");
    expectCall(calls[0], "/v1/customer/disputes/D1", "GET");
  });

  it("provides evidence with files as multipart", async () => {
    const { api, calls } = setup({});
    await api.provideEvidence("D1", {
      evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT" }],
      files: [
        { name: "a.txt", type: "text/plain", data: "a" },
        { name: "b.txt", type: "text/plain", data: "b" },
      ],
    });
    const c = calls[0];
    expect(c.url).toBe("https://api.test/v1/customer/disputes/D1/provide-evidence");
    expect(c.method).toBe("POST");
    expect(c.headers.get("authorization")).toBe("Bearer tok");
    expect(c.headers.get("paypal-request-id")).toBeTruthy();
    expect(c.body).toBeInstanceOf(FormData);
    expect(c.headers.has("content-type")).toBe(false);
    const form = c.body as FormData;
    expect(JSON.parse(await (form.get("input") as Blob).text())).toEqual({
      evidences: [{ evidence_type: "PROOF_OF_FULFILLMENT" }],
    });
    expect(form.get("file1")).toBeInstanceOf(File);
    expect(form.get("file2")).toBeInstanceOf(File);
  });

  it("accepts a claim", async () => {
    const { api, calls } = setup({});
    await api.acceptClaim("D1", {
      note: "n",
      acceptClaimReason: "FULL_REFUND",
      refundAmount: { currency_code: "USD", value: "5" },
    });
    expectCall(calls[0], "/v1/customer/disputes/D1/accept-claim", "POST", {
      note: "n",
      accept_claim_reason: "FULL_REFUND",
      accept_claim_type: "REFUND",
      refund_amount: { currency_code: "USD", value: "5" },
    });
  });
  it("makes an offer", async () => {
    const { api, calls } = setup({});
    await api.makeOffer("D1", { note: "n", amount: { currency_code: "USD", value: "5" } });
    expectCall(calls[0], "/v1/customer/disputes/D1/make-offer", "POST", {
      note: "n",
      offer_amount: { currency_code: "USD", value: "5" },
      offer_type: "REFUND",
    });
  });
  it("sends a message", async () => {
    const { api, calls } = setup({});
    await api.sendMessage("D1", "hello");
    expectCall(calls[0], "/v1/customer/disputes/D1/send-message", "POST", { message: "hello" });
  });
  it("adjudicates", async () => {
    const { api, calls } = setup({});
    await api.adjudicate("D1", "SELLER_FAVOR");
    expectCall(calls[0], "/v1/customer/disputes/D1/adjudicate", "POST", { adjudication_outcome: "SELLER_FAVOR" });
  });
  it("requires evidence", async () => {
    const { api, calls } = setup({});
    await api.requireEvidence("D1", "BUYER_EVIDENCE");
    expectCall(calls[0], "/v1/customer/disputes/D1/require-evidence", "POST", { action: "BUYER_EVIDENCE" });
  });
  it("refunds a capture", async () => {
    const { api, calls } = setup({});
    await api.refundCapture("C1", { currency_code: "USD", value: "2" });
    expectCall(calls[0], "/v2/payments/captures/C1/refund", "POST", { amount: { currency_code: "USD", value: "2" } });
  });

  it("verifies raw webhook text", async () => {
    const { api, calls } = setup({ verification_status: "SUCCESS" });
    const raw = '{"id":"WH-1",  "event_type":"CUSTOMER.DISPUTE.CREATED"}';
    const h = new Headers({
      "paypal-auth-algo": "a",
      "paypal-cert-url": "c",
      "paypal-transmission-id": "i",
      "paypal-transmission-sig": "s",
      "paypal-transmission-time": "t",
    });
    expect(await api.verifyWebhookSignature(h, "W1", raw)).toBe(true);
    const c = calls[0];
    expectCall(c, "/v1/notifications/verify-webhook-signature", "POST");
    expect(String(c.body)).toContain(raw);
    expect(JSON.parse(String(c.body)).webhook_event).toEqual(JSON.parse(raw));
  });
  it("returns false for failed and incomplete webhook verification", async () => {
    const { api, calls } = setup({ verification_status: "FAILURE" });
    const h = new Headers({
      "paypal-auth-algo": "a",
      "paypal-cert-url": "c",
      "paypal-transmission-id": "i",
      "paypal-transmission-sig": "s",
      "paypal-transmission-time": "t",
    });
    expect(await api.verifyWebhookSignature(h, "W1", "{}")).toBe(false);
    expect(await api.verifyWebhookSignature(new Headers(), "W1", "{}")).toBe(false);
    expect(calls).toHaveLength(1);
  });

  it("creates a webhook", async () => {
    const { api, calls } = setup({ id: "W1" });
    expect(await api.createWebhook("https://x", ["A", "B"])).toEqual({ id: "W1" });
    expectCall(calls[0], "/v1/notifications/webhooks", "POST", {
      url: "https://x",
      event_types: [{ name: "A" }, { name: "B" }],
    });
  });
  it("lists webhooks", async () => {
    const { api, calls } = setup({ webhooks: [{ id: "W1" }] });
    await api.listWebhooks();
    expectCall(calls[0], "/v1/notifications/webhooks", "GET");
  });
  it("deletes a webhook", async () => {
    const { api, calls } = setup(new Response(null, { status: 204 }));
    await api.deleteWebhook("W1");
    expectCall(calls[0], "/v1/notifications/webhooks/W1", "DELETE");
  });

  it("uses the requested idempotency key", async () => {
    const { api, calls } = setup({});
    await api.sendMessage("D1", "x", { requestId: "mine" });
    expect(calls[0].headers.get("paypal-request-id")).toBe("mine");
  });
  it("exposes PayPal error details", async () => {
    const { api } = setup(
      new Response(JSON.stringify({ name: "UNPROCESSABLE_ENTITY", debug_id: "abc", details: [{ issue: "X" }] }), {
        status: 422,
      }),
    );
    const err = await api.getOrder("O1").catch((e) => e);
    expect(err).toBeInstanceOf(PayPalError);
    expect(err).toMatchObject({ status: 422, name: "UNPROCESSABLE_ENTITY", debugId: "abc", issues: ["X"] });
  });
  it("returns an empty object for 204", async () => {
    const { api } = setup(new Response(null, { status: 204 }));
    expect(await api.getOrder("O1")).toEqual({});
  });
});
