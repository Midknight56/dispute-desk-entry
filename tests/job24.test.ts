import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { workersAi } from "../src/index";
import { runAgent } from "../src/agent";
import {
  boundMessages,
  MODEL_BOUNDS,
  CHAT_TEMPLATE_TOKENS,
  NEURONS_PER_RUN_MAX,
  NEURONS_PER_ASK_MAX,
  neuronsFor,
  type CallKind,
  type ModelMessage,
} from "../src/caps";
import { finishRun, reserveNeurons, reserveRun, utcDay } from "../src/usage";
import { store } from "../src/store";
import { resetTokenMemory } from "../src/token";
import { ctx, fakePayPal, makeEnv } from "./helpers/env";

const dispute = {
  dispute_id: "D24",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  status: "UNDER_REVIEW",
  dispute_amount: { value: "48.00", currency_code: "USD" },
  disputed_transactions: [{ seller_transaction_id: "C24", custom: "dd-j24" }],
};
type TestEnv = Awaited<ReturnType<typeof makeEnv>>["env"];
function post(env: TestEnv, action = "ask", body = { q: "disputes by status" }) {
  return worker.fetch(
    new Request(`https://desk.test/api/${action}`, {
      method: "POST",
      headers: { "x-desk-key": "owner-for-test" },
      body: JSON.stringify(body),
    }),
    env,
    ctx().context,
  );
}
async function ledger(env: TestEnv) {
  return (
    await env.LEDGER.prepare("SELECT id, neurons FROM ai_calls ORDER BY id").all<{ id: number; neurons: number }>()
  ).results;
}
async function seed(env: TestEnv) {
  await store(env.DB).putDispute({ id: "D24", status: dispute.status, data: { dispute } });
  fakePayPal({
    "GET /v1/customer/disputes/D24": { json: dispute },
    "GET /v2/payments/captures/C24": { json: { id: "C24", status: "COMPLETED", amount: dispute.dispute_amount } },
  });
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  resetTokenMemory();
});

describe("job 24 bounded model spending", () => {
  it("reads Granite chat completions and the legacy response shape", async () => {
    const { env } = await makeEnv();
    const accounting = { uncertain: false };
    env.AI.run = vi.fn()
      .mockResolvedValueOnce({
        id: "chatcmpl-test",
        object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: '{"facts": ["F1", "F3"]}' }, finish_reason: "stop" }],
        usage: { prompt_tokens: 82, completion_tokens: 12, total_tokens: 94, neurons: 0.24831607937812805 },
      })
      .mockResolvedValueOnce({ response: "legacy reply", usage: { prompt_tokens: 8, completion_tokens: 3 } });
    const model = workersAi(env, accounting);
    const messages: ModelMessage[] = [{ role: "user", content: "write" }];
    await expect(model(messages, "writer")).resolves.toEqual({
      text: '{"facts": ["F1", "F3"]}',
      usage: { prompt_tokens: 82, completion_tokens: 12, total_tokens: 94, neurons: 0.24831607937812805 },
    });
    await expect(model(messages, "writer")).resolves.toMatchObject({ text: "legacy reply" });
    expect(accounting.uncertain).toBe(false);
  });

  it("computes both route maxima from every call bound", () => {
    const max = (kind: CallKind) =>
      neuronsFor({
        prompt_tokens: MODEL_BOUNDS[kind].characters + CHAT_TEMPLATE_TOKENS,
        completion_tokens: MODEL_BOUNDS[kind].maxTokens,
      });
    expect(CHAT_TEMPLATE_TOKENS).toBe(64);
    expect(NEURONS_PER_RUN_MAX).toBeCloseTo(max("toolChoice") + max("writer") + max("writerRetry"), 10);
    expect(NEURONS_PER_ASK_MAX).toBe(max("ask"));
    expect(NEURONS_PER_ASK_MAX).toBe(2.39);
  });

  it.each(Object.keys(MODEL_BOUNDS) as CallKind[])("cuts %s records while preserving all system rules", (kind) => {
    const system = { role: "system", content: "Keep every rule.\nUse records only." } as const;
    const records = Array.from({ length: 1000 }, (_, i) => `[R${i}] A complete record.`).join("\n");
    const original: ModelMessage[] = [system, { role: "user", content: records }];
    const bounded = boundMessages(original, kind);
    expect(bounded[0]).toEqual(system);
    expect(bounded.reduce((sum, m) => sum + m.content.length, 0)).toBeLessThanOrEqual(MODEL_BOUNDS[kind].characters);
    expect(bounded[1].content).toContain("(more records left out)");
    expect(bounded[1].content).toContain("[R0] A complete record.");
    expect(
      bounded[1].content
        .replace("(more records left out)", "")
        .split("\n")
        .every((line) => records.split("\n").includes(line)),
    ).toBe(true);
    expect(original[1].content).toBe(records);
    expect(boundMessages([system, { role: "user", content: "short" }], kind)[1].content).toBe("short");
  });

  it("bounds all three agent calls before invoking the model", async () => {
    const calls: { messages: ModelMessage[]; kind: CallKind }[] = [];
    await runAgent("D24", {
      getDispute: async () => ({ ...dispute, evidences: [{ source: "SUBMITTED_BY_BUYER", notes: "z".repeat(20000) }] }),
      getCapture: async () => ({
        id: "C24",
        status: "COMPLETED",
        amount: dispute.dispute_amount,
        supplementary_data: { related_ids: { order_id: "O24" } },
      }),
      getOrder: async () => ({ id: "O24", purchase_units: [{ description: "mug ".repeat(5000), shipping: {} }] }),
      getTracker: async () => ({}),
      deliveredAt: async () => undefined,
      model: async (messages, kind) => {
        calls.push({ messages, kind });
        return { text: "unreadable".repeat(2000), usage: { prompt_tokens: 10, completion_tokens: 2 } };
      },
    });
    expect(calls.map((c) => c.kind)).toEqual(["toolChoice", "writer", "writerRetry"]);
    for (const { messages, kind } of calls) {
      expect(messages.reduce((n, m) => n + m.content.length, 0)).toBeLessThanOrEqual(MODEL_BOUNDS[kind].characters);
      expect(messages[0].content).toContain(kind === "toolChoice" ? "naming the tools" : "Code writes every line");
    }
    expect(calls[0].messages[1].content).toContain("(more records left out)");
    expect(calls[1].messages[1].content).toContain("(more records left out)");
    expect(calls[2].messages.at(-1)?.content).toContain("(more records left out)");
  });

  it("refuses an ask at 698 neurons before the model can spend", async () => {
    const { env, replies } = await makeEnv();
    await env.LEDGER.prepare("INSERT INTO ai_calls(app,day,neurons,at) VALUES(?,?,?,?)")
      .bind("dispute-desk", utcDay(), 698, "seed")
      .run();
    replies.push({ response: "{}", usage: { prompt_tokens: 500, completion_tokens: 400 } });
    const model = vi.spyOn(env.AI, "run");
    const response = await post(env);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ by: "words", neurons: 0 });
    expect(model).not.toHaveBeenCalled();
    expect((await ledger(env)).map((r) => r.neurons)).toEqual([698]);
  });

  it("reserves three calls then settles the same row to their measured sum", async () => {
    const { env } = await makeEnv();
    await seed(env);
    const tokens = [
      { prompt_tokens: 100, completion_tokens: 10 },
      { prompt_tokens: 200, completion_tokens: 20 },
      { prompt_tokens: 300, completion_tokens: 30 },
    ];
    const ids: number[] = [];
    let i = 0;
    vi.spyOn(env.AI, "run").mockImplementation(async (_model, input: any) => {
      const [row] = await ledger(env);
      ids.push(row.id);
      expect(row.neurons).toBe(NEURONS_PER_RUN_MAX);
      const kind = (["toolChoice", "writer", "writerRetry"] as const)[i];
      expect(input.max_tokens).toBe(MODEL_BOUNDS[kind].maxTokens);
      expect(input.messages.reduce((n: number, m: ModelMessage) => n + m.content.length, 0)).toBeLessThanOrEqual(
        MODEL_BOUNDS[kind].characters,
      );
      return { response: "{}", usage: tokens[i++] };
    });
    const response = await post(env, "disputes/D24/analyse");
    expect(response.status).toBe(200);
    const result: any = await response.json();
    expect(result.run.usage).toEqual({ calls: 3, prompt_tokens: 600, completion_tokens: 60 });
    expect(result.neurons).toBe(neuronsFor({ prompt_tokens: 600, completion_tokens: 60 }));
    expect(new Set(ids).size).toBe(1);
    expect(await ledger(env)).toEqual([{ id: ids[0], neurons: result.neurons }]);
  });

  it("passes the ask output limit and settles measured usage", async () => {
    const { env } = await makeEnv();
    const model = vi.spyOn(env.AI, "run").mockImplementation(async (_model, input: any) => {
      expect((await ledger(env))[0].neurons).toBe(NEURONS_PER_ASK_MAX);
      expect(input.max_tokens).toBe(MODEL_BOUNDS.ask.maxTokens);
      expect(input.messages.reduce((n: number, m: ModelMessage) => n + m.content.length, 0)).toBeLessThanOrEqual(
        MODEL_BOUNDS.ask.characters,
      );
      return {
        response: '{"chart":"bar","groupBy":"status","metric":"count","period":"all"}',
        usage: { prompt_tokens: 100, completion_tokens: 30 },
      };
    });
    const response = await post(env);
    expect(await response.json()).toMatchObject({
      by: "model",
      neurons: neuronsFor({ prompt_tokens: 100, completion_tokens: 30 }),
    });
    expect(model).toHaveBeenCalledOnce();
    expect((await ledger(env))[0].neurons).toBe(neuronsFor({ prompt_tokens: 100, completion_tokens: 30 }));
  });

  it.each([
    undefined,
    {},
    { prompt_tokens: 100 },
    { prompt_tokens: -1, completion_tokens: 1 },
    { prompt_tokens: NaN, completion_tokens: 1 },
  ])("keeps the ask maximum with unknown usage %j", async (usage) => {
    const { env } = await makeEnv();
    vi.spyOn(env.AI, "run").mockResolvedValue({ response: "{}", usage } as any);
    const response = await post(env);
    expect(await response.json()).toMatchObject({ neurons: NEURONS_PER_ASK_MAX });
    expect((await ledger(env))[0].neurons).toBe(NEURONS_PER_ASK_MAX);
  });

  it("keeps the full analyse maximum when only one call has unknown usage", async () => {
    const { env, replies } = await makeEnv();
    await seed(env);
    replies.push(
      { response: "{}", usage: { prompt_tokens: 100, completion_tokens: 10 } },
      { response: "{}" },
      { response: "{}", usage: { prompt_tokens: 100, completion_tokens: 10 } },
    );
    const result: any = await (await post(env, "disputes/D24/analyse")).json();
    expect(result.run.usage).toEqual({ calls: 3, prompt_tokens: 200, completion_tokens: 20 });
    expect(result.neurons).toBe(NEURONS_PER_RUN_MAX);
    expect((await ledger(env))[0].neurons).toBe(NEURONS_PER_RUN_MAX);
  });

  it("finishRun leaves an uncertain reservation at its maximum", async () => {
    const { env } = await makeEnv();
    const at = await reserveRun(env.DB, { day: utcDay(), visitor: "v", disputeId: "ask" });
    const id = await reserveNeurons(env.LEDGER, utcDay(), "ask");
    await finishRun(env.DB, env.LEDGER, at!, id, { day: utcDay(), writer: "words", neurons: 0, uncertain: true });
    expect((await ledger(env))[0].neurons).toBe(NEURONS_PER_ASK_MAX);
  });

  it("keeps the maximum when analyse fails after reservation", async () => {
    const { env } = await makeEnv();
    await seed(env);
    fakePayPal({});
    const model = vi.spyOn(env.AI, "run");
    expect((await post(env, "disputes/D24/analyse")).status).toBe(502);
    expect(model).not.toHaveBeenCalled();
    expect((await ledger(env))[0].neurons).toBe(NEURONS_PER_RUN_MAX);
  });
});
