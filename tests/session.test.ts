import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { session, sessionCookie } from "../src/session";
import { visitorId, utcDay } from "../src/usage";
import { store } from "../src/store";
import { resetTokenMemory } from "../src/token";
import { actionableRoutes, ctx, fakePayPal, makeEnv } from "./helpers/env";

const id = "PP-SESSION";
const dispute = {
  dispute_id: id,
  status: "UNDER_REVIEW",
  dispute_life_cycle_stage: "CHARGEBACK",
  reason: "OTHER",
  disputed_transactions: [{ custom: "dd-session", seller_transaction_id: "CAP-1" }],
  links: [{ rel: "accept_claim" }],
};
const savedRun = {
  basis: {
    amount: null, currency: null, status: dispute.status, stage: "CHARGEBACK",
    reason: "OTHER", captureId: "CAP-1", offerAmount: null,
  },
  version: "stored-version",
  decision: { verdict: "ACCEPT", why: "No delivery evidence." },
  records: [],
  sentences: [{ text: "We accept the claim and refund in full.", record_id: id }],
  dropped: [],
  steps: [],
};
type TestEnv = Awaited<ReturnType<typeof makeEnv>>["env"];
function request(env: TestEnv, path: string, cookie = "", body?: unknown, key?: string) {
  return worker.fetch(
    new Request(`https://desk.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        cookie,
        "user-agent": "same-browser",
        "cf-connecting-ip": "192.0.2.1",
        ...(key ? { "x-desk-key": key } : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    ctx().context,
  );
}
const cookieOf = (response: Response) => response.headers.get("set-cookie")!.split(";")[0];
async function seed(env: TestEnv) {
  await store(env.DB).putDispute({
    id,
    status: dispute.status,
    stage: dispute.dispute_life_cycle_stage,
    data: { dispute, run: savedRun },
  });
  for (const [position, caseId] of [id, "PP-OTHER"].entries())
    await env.DB.prepare("INSERT INTO pool (dispute_id, kind, position, added_at) VALUES (?, ?, ?, ?)")
      .bind(caseId, "fight", position, "now")
      .run();
}
beforeEach(() => {
  fakePayPal(actionableRoutes([id, "PP-OTHER"]));
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetTokenMemory();
});
describe("visitor sessions and draft approval", () => {
  it("assigns separate cases at the same address and browser and keeps the same cookie case and me", async () => {
    const { env } = await makeEnv();
    await seed(env);
    const a = await request(env, "/api/judge/next");
    const cookie = cookieOf(a);
    const b = await request(env, "/api/judge/next");
    expect(await a.json()).toMatchObject({ disputeId: id });
    expect(await b.json()).toMatchObject({ disputeId: "PP-OTHER" });
    const again = await request(env, "/api/judge/next", cookie);
    expect(await again.json()).toMatchObject({ disputeId: id, fresh: false });
    expect(again.headers.has("set-cookie")).toBe(false);
    expect(await (await request(env, "/api/me", cookie)).json()).toEqual({
      cases: [{ dispute_id: id, kind: "fight" }],
    });
    expect(a.headers.get("set-cookie")).toContain("; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000");
  });
  it("rejects tampered signatures and does not let the new session own or analyse the old case", async () => {
    const { env } = await makeEnv();
    await seed(env);
    const a = await request(env, "/api/judge/next");
    const cookie = cookieOf(a);
    const tampered = cookie.slice(0, -2) + (cookie.at(-2) === "A" ? "B" : "A") + cookie.slice(-1);
    const parsed = await session(new Request("https://desk.test", { headers: { cookie: tampered } }), env);
    expect(parsed.fresh).toBe(true);
    expect(parsed.id).not.toBe(cookie.split("=")[1].split(".")[0]);
    expect(await (await request(env, "/api/me", tampered)).json()).toEqual({ cases: [] });
    const calls = fakePayPal({});
    const denied = await request(env, `/api/disputes/${id}/analyse`, tampered, {});
    expect(denied.status).toBe(403);
    expect(await denied.json()).toEqual({ error: "This case belongs to another visitor." });
    expect((await store(env.DB).getDispute(id))?.data.run).toEqual(savedRun);
    expect(calls).toHaveLength(0);
  });
  it("signs the UUID with the configured HMAC secret and rejects a different secret", async () => {
    const { env } = await makeEnv();
    const response = await request(env, "/api/me");
    const cookie = cookieOf(response);
    const [id, signature] = cookie.slice("dd_session=".length).split(".");
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(env.SESSION_SECRET!),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const signed = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(id));
    const expected = btoa(String.fromCharCode(...new Uint8Array(signed)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    expect(signature).toBe(expected);
    const req = new Request("https://desk.test", { headers: { cookie } });
    expect(await session(req, env)).toEqual({ id, fresh: false });
    expect((await session(req, { SESSION_SECRET: "different-secret" })).fresh).toBe(true);
  });
  it("answers without a secret and starts a new session even with an earlier valid cookie", async () => {
    const { env } = await makeEnv();
    const cookie = (await sessionCookie(crypto.randomUUID(), env)).split(";")[0];
    delete env.SESSION_SECRET;
    const a = await request(env, "/api/me", cookie);
    const b = await request(env, "/api/me", cookieOf(a));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(cookieOf(a)).not.toBe(cookieOf(b));
  });
  it("requires the stored version before any filing and accepts that version for the holder", async () => {
    const { env } = await makeEnv();
    await seed(env);
    const cookie = cookieOf(await request(env, "/api/judge/next"));
    const calls = fakePayPal({
      [`GET /v1/customer/disputes/${id}`]: { json: dispute },
      [`POST /v1/customer/disputes/${id}/accept-claim`]: { json: {} },
    });
    for (const body of [{}, { version: "old-version" }, null]) {
      const response = await request(env, `/api/disputes/${id}/approve`, cookie, body);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({
        error: "The draft changed. Read it again before you approve.",
        run: savedRun,
      });
    }
    expect(calls).toHaveLength(0);
    expect((await store(env.DB).getDispute(id))?.data.filing).toBeUndefined();
    expect((await request(env, `/api/disputes/${id}/approve`, cookie, { version: savedRun.version })).status).toBe(200);
    expect(calls.filter((c) => c.path.endsWith("/accept-claim"))).toHaveLength(1);
  });
  it("refuses a draft replaced between reading the run and claiming the filing", async () => {
    const { env, DB } = await makeEnv();
    await seed(env);
    const calls = fakePayPal({});
    const prepare = DB.prepare.bind(DB);
    vi.spyOn(DB, "prepare").mockImplementation((sql: string) => {
      if (sql.startsWith("UPDATE disputes SET data = json_set(data, '$.filing'")) {
        // The replacement commits just before the conditional filing claim.
        void prepare("UPDATE disputes SET data = json_set(data, '$.run.version', 'newer-version') WHERE id = ?")
          .bind(id)
          .run();
      }
      return prepare(sql);
    });
    const response = await request(
      env,
      `/api/disputes/${id}/approve`,
      "",
      { version: savedRun.version },
      env.DESK_OWNER_KEY,
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      error: "The draft changed. Read it again before you approve.",
      run: { version: "newer-version" },
    });
    expect(calls).toHaveLength(0);
  });
  it("stores a new version on every analysis and returns it on the detail route for holders and owners", async () => {
    const { env } = await makeEnv();
    await seed(env);
    const cookie = cookieOf(await request(env, "/api/judge/next"));
    fakePayPal({
      [`GET /v1/customer/disputes/${id}`]: { json: dispute },
      "GET /v2/payments/captures/CAP-1": { json: { id: "CAP-1", status: "COMPLETED", amount: { value: "5" } } },
    });
    const a: any = await (await request(env, `/api/disputes/${id}/analyse`, cookie, {})).json();
    const b: any = await (await request(env, `/api/disputes/${id}/analyse`, "", {}, env.DESK_OWNER_KEY)).json();
    expect(a.run.version).toMatch(/^[0-9a-f-]{36}$/);
    expect(b.run.version).not.toBe(a.run.version);
    expect(await (await request(env, `/api/disputes/${id}`)).json()).toMatchObject({
      data: { run: { version: b.run.version } },
    });
  });
  it("keeps the run cap by address when a visitor changes cookies", async () => {
    const { env, DB } = await makeEnv();
    const capVisitor = await visitorId(
      new Request("https://desk.test", { headers: { "user-agent": "same-browser", "cf-connecting-ip": "192.0.2.1" } }),
    );
    for (let i = 0; i < 20; i++)
      await DB.prepare("INSERT INTO runs (day, visitor, dispute_id, writer, neurons, at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(utcDay(), capVisitor, "ask", "template", 0, `old-${i}`)
        .run();
    const model = vi.spyOn(env.AI, "run");
    const a = await request(env, "/api/ask", "", { q: "by status" });
    const b = await request(env, "/api/ask", "", { q: "by status" });
    expect(cookieOf(a)).not.toBe(cookieOf(b));
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(model).not.toHaveBeenCalled();
    expect(await DB.prepare("SELECT COUNT(*) AS n FROM runs WHERE visitor = ?").bind(capVisitor).first()).toEqual({
      n: 22,
    });
  });
});

it("passes all nine smoke checks locally and preserves the signed session cookie", async () => {
  const { env } = await makeEnv();
  env.ASSETS = {
    fetch: async () => new Response("<html></html>", { headers: { "content-type": "text/html" } }),
  } as unknown as Fetcher;
  // Prevent background sync and mock every provider request.
  await env.DB.prepare("INSERT INTO meta (key, value) VALUES ('last_sync', ?)").bind(new Date().toISOString()).run();
  const provider = fakePayPal({
    "POST /v1/notifications/verify-webhook-signature": { json: { verification_status: "FAILURE" } },
  });
  const providerFetch = globalThis.fetch;
  let cookie = "";
  let requests = 0;
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    if (String(input).startsWith("https://api.test")) return providerFetch(input, init);
    const req = new Request(String(input), init);
    if (requests++) expect(req.headers.get("cookie")).toBe(cookie);
    const response = await worker.fetch(req, env, ctx().context);
    if (response.headers.has("set-cookie")) cookie = cookieOf(response);
    return response;
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const path: string = "../tools/smoke.mjs";
  const { runSmoke } = await import(path);
  try {
    await runSmoke();
    expect(requests).toBe(9);
    expect(log.mock.calls.filter(([line]) => String(line).startsWith("ok "))).toHaveLength(9);
    expect(log.mock.calls.some(([line]) => String(line).startsWith("FAIL"))).toBe(false);
    expect(provider.some((call) => call.path.includes("verify-webhook-signature"))).toBe(true);
  } finally {
    log.mockRestore();
  }
});
