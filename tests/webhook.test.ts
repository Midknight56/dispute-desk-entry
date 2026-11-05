import { describe, it, expect } from "vitest";
import { handleWebhook, type WebhookDeps } from "../src/webhooks";

const RAW =
  '{"id":"WH-1","event_type":"CUSTOMER.DISPUTE.CREATED","create_time":"2026-10-23T01:00:00Z",  "resource":{"dispute_id":"PP-D-1"}}';

function headers() {
  return {
    "paypal-auth-algo": "SHA256withRSA",
    "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT",
    "paypal-transmission-id": "t-1",
    "paypal-transmission-sig": "sig",
    "paypal-transmission-time": "2026-10-23T01:00:01Z",
  };
}

function deps(verified: boolean) {
  const stored = new Map<string, string>();
  const processed: string[] = [];
  const later: Promise<unknown>[] = [];
  const seenRaw: string[] = [];
  const d: WebhookDeps = {
    async verify(_h, raw) {
      seenRaw.push(raw);
      return verified;
    },
    async storeIfNew(ev, raw) {
      if (stored.has(ev.id)) return false;
      stored.set(ev.id, raw);
      return true;
    },
    async process(ev) {
      processed.push(ev.id);
    },
    async markProcessed() {},
    waitUntil(p) {
      later.push(p);
    },
  };
  return { d, stored, processed, later, seenRaw };
}

function post(body = RAW) {
  return new Request("https://desk.test/webhooks/paypal", { method: "POST", headers: headers(), body });
}

describe("PayPal webhook route", () => {
  it("answers 400 and stores nothing when verification is not SUCCESS", async () => {
    const t = deps(false);
    const res = await handleWebhook(post(), t.d);
    expect(res.status).toBe(400);
    expect(t.stored.size).toBe(0);
    expect(t.processed.length).toBe(0);
  });

  it("passes the raw body to verification byte for byte", async () => {
    const t = deps(true);
    await handleWebhook(post(), t.d);
    expect(t.seenRaw[0]).toBe(RAW);
  });

  it("stores and processes the same event id once when it arrives twice", async () => {
    const t = deps(true);
    const a = await handleWebhook(post(), t.d);
    const b = await handleWebhook(post(), t.d);
    await Promise.all(t.later);
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(t.stored.size).toBe(1);
    expect(t.processed).toEqual(["WH-1"]);
  });

  it("answers 200 before processing finishes", async () => {
    const t = deps(true);
    let done = false;
    t.d.process = () =>
      new Promise((r) =>
        setTimeout(() => {
          done = true;
          r();
        }, 50),
      );
    const res = await handleWebhook(post(), t.d);
    expect(res.status).toBe(200);
    expect(done).toBe(false);
    await Promise.all(t.later);
    expect(done).toBe(true);
  });

  it("answers 400 to a body that is not an event", async () => {
    const t = deps(true);
    const res = await handleWebhook(post("not json"), t.d);
    expect(res.status).toBe(400);
    expect(t.stored.size).toBe(0);
  });
});
