import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { makeEnv, fakePayPal, ctx } from "./helpers/env";
import { resetTokenMemory } from "../src/token";

const dispute = (over: Record<string, unknown> = {}) => ({
  dispute_id: "PP-BATTLE",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "UNDER_REVIEW",
  dispute_life_cycle_stage: "CHARGEBACK",
  dispute_amount: { currency_code: "USD", value: "48.00" },
  disputed_transactions: [{ seller_transaction_id: "CAP-1", custom: "dd-0001" }],
  evidences: [],
  links: [{ rel: "provide_evidence" }],
  ...over,
});

const run = {
  version: "test-version",
  decision: { verdict: "FIGHT", why: "evidence" },
  sentences: [{ text: "Evidence supports the seller.", record_id: "CAP-1" }],
  records: [{ kind: "capture", id: "CAP-1" }],
  dropped: [],
  steps: [],
  writer: "template",
  usage: { calls: 0, prompt_tokens: 0, completion_tokens: 0 },
};

async function request(path: string, env: Awaited<ReturnType<typeof makeEnv>>["env"], init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  if (path.endsWith("/analyse")) headers.set("x-desk-key", "owner-for-test");
  if (path.endsWith("/approve") && !init.body) init = { ...init, body: JSON.stringify({ version: "test-version" }) };
  return worker.fetch(new Request(`https://desk.test${path}`, { ...init, headers }), env, ctx().context);
}

async function seed(DB: Awaited<ReturnType<typeof makeEnv>>["DB"], d = dispute(), withRun = false) {
  await DB.prepare(
    "INSERT INTO disputes (id,status,stage,reason,amount,currency,due,custom_id,data,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
  )
    .bind(
      d.dispute_id,
      d.status,
      d.dispute_life_cycle_stage,
      d.reason,
      "48",
      "USD",
      null,
      "dd-0001",
      JSON.stringify({ dispute: d, ...(withRun ? { run: { ...run, basis: {
        amount: d.dispute_amount.value, currency: d.dispute_amount.currency_code,
        status: d.status, stage: d.dispute_life_cycle_stage, reason: d.reason,
        captureId: d.disputed_transactions[0].seller_transaction_id, offerAmount: null,
      } } } : {}) }),
      new Date().toISOString(),
    )
    .run();
}

afterEach(() => {
  vi.unstubAllGlobals();
  resetTokenMemory();
});

describe("battle flows", () => {
  it("returns a clear analysis error and releases its reservation after PayPal fails", async () => {
    const { env, DB } = await makeEnv();
    await seed(DB);
    fakePayPal({ "GET /v1/customer/disputes/PP-BATTLE": { json: { name: "SERVER_ERROR" }, status: 500 } });
    const response = await request("/api/disputes/PP-BATTLE/analyse", env, { method: "POST" });
    expect(response.status).toBeGreaterThanOrEqual(400);
    expect(await response.json()).toHaveProperty("error");
    expect(
      await DB.prepare("SELECT COUNT(*) AS n FROM runs")
        .first<{ n: number }>()
        .then((r) => r?.n),
    ).toBe(0);
  });

  it("files at most once when two approval requests overlap", async () => {
    const { env, DB } = await makeEnv();
    await seed(DB, dispute(), true);
    let release!: () => void;
    const waiting = new Promise<void>((resolve) => (release = resolve));
    const calls = fakePayPal({
      "GET /v1/customer/disputes/PP-BATTLE": { json: dispute() },
      "POST /v1/customer/disputes/PP-BATTLE/provide-evidence": { json: {} },
    });
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("provide-evidence")) await waiting;
      return fetch(input, init);
    });
    const init = { method: "POST", headers: { "x-desk-key": "owner-for-test" } };
    const first = request("/api/disputes/PP-BATTLE/approve", env, init);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondPromise = request("/api/disputes/PP-BATTLE/approve", env, init);
    release();
    const second = await secondPromise;
    const firstResponse = await first;
    expect([firstResponse.status, second.status].filter((status) => status === 200)).toHaveLength(1);
    expect(await second.json()).toMatchObject({ error: "already filed" });
    expect(calls.filter((call) => call.path.endsWith("/provide-evidence"))).toHaveLength(1);
  });

  it("refuses approval before analysis without calling PayPal", async () => {
    const { env, DB } = await makeEnv();
    await seed(DB);
    const calls = fakePayPal({});
    const response = await request("/api/disputes/PP-BATTLE/approve", env, {
      method: "POST",
      headers: { "x-desk-key": "owner-for-test" },
    });
    expect(response.status).toBe(409);
    expect(calls.filter((call) => call.path.includes("/customer/disputes/")).length).toBe(0);
  });

  it("files a FIGHT with a PDF evidence pack", async () => {
    const { env, DB } = await makeEnv();
    await seed(DB, dispute(), true);
    let form: FormData | undefined;
    const calls = fakePayPal({
      "GET /v1/customer/disputes/PP-BATTLE": { json: dispute() },
      "POST /v1/customer/disputes/PP-BATTLE/provide-evidence": { json: {} },
    });
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("provide-evidence")) form = init?.body as FormData;
      return fetch(input, init);
    });
    const response = await request("/api/disputes/PP-BATTLE/approve", env, {
      method: "POST",
      headers: { "x-desk-key": "owner-for-test" },
    });
    expect(response.status).toBe(200);
    const file = form?.get("file1") as File;
    expect(file.name).toMatch(/-evidence\.pdf$/);
    expect(new TextDecoder().decode(new Uint8Array(await file.arrayBuffer())).startsWith("%PDF")).toBe(true);
    expect(calls.filter((call) => call.path.endsWith("/provide-evidence"))).toHaveLength(1);
  });

  it("files the evidence when the pack cannot be built", async () => {
    const { env, DB } = await makeEnv();
    await seed(DB, dispute(), true);
    vi.spyOn(crypto.subtle, "digest").mockRejectedValueOnce(new Error("pack failure"));
    let form: FormData | undefined;
    fakePayPal({
      "GET /v1/customer/disputes/PP-BATTLE": { json: dispute() },
      "POST /v1/customer/disputes/PP-BATTLE/provide-evidence": { json: {} },
    });
    const fetch = globalThis.fetch;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(input).includes("provide-evidence")) form = init?.body as FormData;
      return fetch(input, init);
    });
    const response = await request("/api/disputes/PP-BATTLE/approve", env, {
      method: "POST",
      headers: { "x-desk-key": "owner-for-test" },
    });
    expect(response.status, JSON.stringify(await response.clone().json())).toBe(200);
    expect(form?.get("file1")).toBeNull();
    const feed = await DB.prepare("SELECT detail FROM feed ORDER BY seq DESC LIMIT 5").all<{ detail: string }>();
    expect(feed.results.some((row) => row.detail.includes("pack"))).toBe(true);
  });

  it("refuses filing a resolved case without calling PayPal to file", async () => {
    const { env, DB } = await makeEnv();
    await seed(DB, dispute({ status: "RESOLVED" }), true);
    const calls = fakePayPal({
      "GET /v1/customer/disputes/PP-BATTLE": { json: dispute({ status: "RESOLVED" }) },
    });
    const response = await request("/api/disputes/PP-BATTLE/approve", env, {
      method: "POST",
      headers: { "x-desk-key": "owner-for-test" },
    });
    expect(response.status).toBe(422);
    expect(calls.filter((call) => call.path.endsWith("/provide-evidence"))).toHaveLength(0);
  });

  it("keeps an analysed case pending after PayPal cannot confirm filing", async () => {
    const { env, DB } = await makeEnv();
    await seed(DB, dispute(), true);
    fakePayPal({
      "GET /v1/customer/disputes/PP-BATTLE": { json: dispute() },
      "POST /v1/customer/disputes/PP-BATTLE/provide-evidence": { json: { name: "SERVER_ERROR" }, status: 500 },
    });
    const response = await request("/api/disputes/PP-BATTLE/approve", env, {
      method: "POST",
      headers: { "x-desk-key": "owner-for-test" },
    });
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ operation: { state: "uncertain" } });
    const stored = await DB.prepare("SELECT data FROM disputes WHERE id = ?")
      .bind("PP-BATTLE")
      .first<{ data: string }>();
    expect(JSON.parse(stored!.data)).toHaveProperty("run");
    expect(JSON.parse(stored!.data)).not.toHaveProperty("filed");
    expect(JSON.parse(stored!.data).operation.state).toBe("uncertain");
  });

  it("frees a filing claim left by a request that died, but not a fresh one", async () => {
    for (const [age, expected] of [
      [200_000, 200],
      [1_000, 409],
    ] as const) {
      const { env, DB } = await makeEnv();
      await seed(DB, dispute(), true);
      await DB.prepare("UPDATE disputes SET data = json_set(data, '$.filing', ?) WHERE id = ?")
        .bind(Date.now() - age, "PP-BATTLE")
        .run();
      const calls = fakePayPal({
        "GET /v1/customer/disputes/PP-BATTLE": { json: dispute() },
        "POST /v1/customer/disputes/PP-BATTLE/provide-evidence": { json: {} },
      });
      const response = await request("/api/disputes/PP-BATTLE/approve", env, {
        method: "POST",
        headers: { "x-desk-key": "owner-for-test" },
      });
      expect(response.status).toBe(expected);
      expect(calls.filter((call) => call.path.endsWith("/provide-evidence"))).toHaveLength(expected === 200 ? 1 : 0);
      resetTokenMemory();
      vi.unstubAllGlobals();
    }
  });
});
