import { afterEach, describe, expect, it, vi } from "vitest";
import { runAgent, sentenceFacts, type AgentDeps, type AgentRun } from "../src/agent";
import { MODEL_BOUNDS, NEURONS_PER_RUN_MAX } from "../src/caps";
import { noteFrom, fileResponse, type FileDeps } from "../src/file";
import { checkSentence, runProof } from "../src/proof";
import { supportedSentence } from "../src/sentence-facts";
import worker from "../src/index";
import acceptReplay from "../samples/replay-accept.json";
import fightReplay from "../samples/replay-fight.json";
import { ctx, makeEnv } from "./helpers/env";

const claimAt = "2026-10-20T12:00:00Z";
const deliveredAt = "2026-10-19T12:00:00Z";
const dispute = {
  dispute_id: "D28",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  create_time: claimAt,
  dispute_amount: { value: "48.00", currency_code: "USD" },
  disputed_transactions: [{ seller_transaction_id: "C28", custom: "sale28" }],
};
const capture = {
  id: "C28",
  status: "COMPLETED",
  amount: dispute.dispute_amount,
  create_time: "2026-10-18T00:00:00Z",
  supplementary_data: { related_ids: { order_id: "O28" } },
};
const order = {
  id: "O28",
  purchase_units: [
    {
      description: "Mug",
      shipping: {
        address: { admin_area_2: "Toronto", admin_area_1: "ON", country_code: "CA" },
        trackers: [{ id: "T28" }],
      },
    },
  ],
};
const payment = { text: "The buyer paid $48.00 on 2026-10-18.", record_id: "C28" };
const delivery = { text: "Our shipping record shows it delivered 2026-10-19 12:00 UTC.", record_id: "T28" };
const deps = (over: Partial<AgentDeps> = {}): AgentDeps => ({
  getDispute: async () => dispute,
  getCapture: async () => capture,
  getOrder: async () => order,
  getTracker: async () => ({ status: "DELIVERED", carrier: "UPS", tracking_number: "ZX28" }),
  deliveredAt: async () => deliveredAt,
  ...over,
});
function model(...replies: string[]) {
  let i = 0;
  return vi.fn<NonNullable<AgentDeps["model"]>>(async () => ({ text: replies[i++] ?? "unreadable" }));
}
function guarded(run: AgentRun) {
  expect(run.sentences.length).toBeGreaterThan(0);
  expect(run.sentences.length).toBeLessThanOrEqual(4);
  expect(new Set(run.sentences.map((s) => `${s.record_id}:${s.text}`)).size).toBe(run.sentences.length);
  for (const sentence of run.sentences) {
    const record = run.records.find((r) => r.id === sentence.record_id)!;
    expect(supportedSentence(sentence.text, record)).toBe(true);
  }
}
afterEach(() => vi.restoreAllMocks());

describe("job 28 typed fact selection", () => {
  it("renders required delivery then the F3 F1 selection and stores the selection", async () => {
    const m = model('{"tools":[]}', '{"facts":["F3","F1"]}');
    const run = await runAgent("D28", deps({ model: m }));
    expect(run.writer).toBe("model");
    expect(run.selected).toEqual(["F3", "F1"]);
    expect(run.sentences).toEqual([delivery, payment]);
    expect(m).toHaveBeenCalledTimes(2);
    guarded(run);
    const facts = sentenceFacts(run.decision, run.records);
    expect(facts.map((f) => [f.id, f.kind, f.record_id])).toEqual([
      ["F1", "payment", "C28"],
      ["F2", "tracking", "T28"],
      ["F3", "delivery", "T28"],
      ["F4", "order", "O28"],
      ["F5", "claim", "D28"],
    ]);
    const prompt = m.mock.calls[1][0].map((message) => message.content).join("\n");
    expect(prompt).toContain(`Verdict: FIGHT. Reason: ${run.decision.why}`);
    for (const fact of facts) expect(prompt).toContain(`${fact.id} [${fact.record_id}]: ${fact.text}`);
    expect(prompt).toContain('{"facts":["F2","F1"]}');
    expect(prompt.length).toBeLessThanOrEqual(MODEL_BOUNDS.writer.characters);
  });

  it("puts required facts before picks, preserves picked order, caps lines and removes duplicates", async () => {
    const run = await runAgent("D28", deps({ model: model('{"tools":[]}', '{"facts":["F5","F4","F1","F2"]}') }));
    expect(run.sentences.map((s) => s.record_id)).toEqual(["T28", "D28", "O28", "C28"]);
    expect(run.sentences[0]).toEqual(delivery);
    guarded(run);
    const duplicate = await runAgent("D28", deps({ model: model('{"tools":[]}', '{"facts":["F3","F3","F1","F1"]}') }));
    expect(duplicate.sentences).toEqual([delivery, payment]);
    guarded(duplicate);
  });

  it("rejects an unknown id and uses the checked template after retry", async () => {
    const m = model('{"tools":[]}', '{"facts":["F9","F1"]}');
    const run = await runAgent("D28", deps({ model: m }));
    expect(run.writer).toBe("template");
    expect(run.sentences.length).toBeGreaterThan(0);
    expect(run.dropped).toEqual([{ text: "F9 is not a listed fact", record_id: "F9" }]);
    expect(m).toHaveBeenCalledTimes(3);
    guarded(run);
  });

  it("uses a good retry after an unreadable reply", async () => {
    const m = model('{"tools":[]}', "not JSON", '{"facts":["F4","F1"]}');
    const run = await runAgent("D28", deps({ model: m }));
    expect(run.writer).toBe("model");
    expect(run.selected).toEqual(["F4", "F1"]);
    expect(run.sentences.map((s) => s.record_id)).toEqual(["T28", "O28", "C28"]);
    expect(m).toHaveBeenCalledTimes(3);
    expect(m.mock.calls.map((call) => call[1])).toEqual(["toolChoice", "writer", "writerRetry"]);
    guarded(run);
  });

  it("uses the template after exactly two unreadable writer replies", async () => {
    const m = model('{"tools":[]}', "not JSON", '{"sentences":[]}');
    const run = await runAgent("D28", deps({ model: m }));
    expect(run.writer).toBe("template");
    expect(run.selected).toBeUndefined();
    expect(m).toHaveBeenCalledTimes(3);
    expect(run.sentences[0]).toEqual(delivery);
    guarded(run);
  });

  it("retries a writer error once and uses the good selection", async () => {
    const m = model('{"tools":[]}', "unused", '{"facts":["F3","F1"]}');
    m.mockImplementationOnce(async () => ({ text: '{"tools":[]}' }))
      .mockImplementationOnce(async () => {
        throw new Error("unavailable");
      })
      .mockImplementationOnce(async () => ({ text: '{"facts":["F3","F1"]}' }));
    const run = await runAgent("D28", deps({ model: m }));
    expect(run.writer).toBe("model");
    expect(m).toHaveBeenCalledTimes(3);
    guarded(run);
  });

  it.each(["model", "template"])(
    "ACCEPT always leads with payment and full acceptance in the %s path",
    async (path) => {
      const run = await runAgent(
        "D28",
        deps({
          getDispute: async () => ({ ...dispute, dispute_amount: { value: "6.00", currency_code: "USD" } }),
          getCapture: async () => ({ ...capture, status: "PENDING", amount: { value: "6.00", currency_code: "USD" } }),
          getOrder: async () => ({ ...order, purchase_units: [{ description: "Download", shipping: {} }] }),
          model: path === "model" ? model('{"tools":[]}', '{"facts":["F3","F2"]}') : undefined,
        }),
      );
      expect(run.writer).toBe(path);
      expect(run.decision.verdict).toBe("ACCEPT");
      expect(run.sentences.slice(0, 2)).toEqual([
        { text: "PayPal lists the payment of $6.00 as pending.", record_id: "C28" },
        { text: "We accept the claim and refund in full.", record_id: "D28" },
      ]);
      guarded(run);
    },
  );

  it("reserves only 64 writer output tokens and keeps exact worst case arithmetic", () => {
    expect(MODEL_BOUNDS.writer.maxTokens).toBe(64);
    expect(MODEL_BOUNDS.writerRetry.maxTokens).toBe(64);
    expect(NEURONS_PER_RUN_MAX).toBe(47.02);
  });
});

const inventions = [
  "The buyer paid $48.00 for a counterfeit item.",
  "The buyer paid $48.00 and the parcel was empty.",
  "The buyer paid $48.00 for a broken mug.",
];
describe("job 28 no prose reaches the note", () => {
  it.each(inventions)("strikes a true amount with an invented clause: %s", async (text) => {
    expect(checkSentence(text, "CAP1").status).toBe("struck");
    expect(runProof().checker.rows.find((row) => row.text === text)).toMatchObject({ struck: true });
    for (const path of ["selection", "retry", "fallback", "absent"] as const) {
      const prose = JSON.stringify({ sentences: [{ text, record_id: "C28" }] });
      const good = JSON.stringify({ facts: ["F3", "F1"], sentences: [{ text, record_id: "C28" }], note: text });
      const m =
        path === "absent"
          ? undefined
          : path === "selection"
            ? model('{"tools":[]}', good)
            : model('{"tools":[]}', prose, path === "retry" ? good : prose);
      const run = await runAgent("D28", deps({ model: m }));
      expect(run.writer).toBe(path === "selection" || path === "retry" ? "model" : "template");
      expect(noteFrom(run.sentences)).not.toContain(text);
      const api = {
        provideEvidence: vi.fn<FileDeps["provideEvidence"]>().mockResolvedValue({}),
        provideSupportingInfo: vi.fn<FileDeps["provideSupportingInfo"]>(),
        acceptClaim: vi.fn<FileDeps["acceptClaim"]>(),
        makeOffer: vi.fn<FileDeps["makeOffer"]>(),
      };
      await fileResponse(api, { ...dispute, links: [{ rel: "provide_evidence" }] }, run.decision, run.sentences);
      expect(api.provideEvidence).toHaveBeenCalledTimes(1);
      expect(JSON.stringify(api.provideEvidence.mock.calls[0])).not.toContain(text);
      guarded(run);
    }
  });
});

describe("job 28 source and missing order", () => {
  it("PayPal DELIVERED without a time keeps seller time provenance in facts, why and lines", async () => {
    const run = await runAgent("D28", deps());
    expect(run.decision.verdict).toBe("FIGHT");
    expect(run.decision.why).toBe(
      "Our shipping record shows it delivered 1 day before the claim. PayPal tracking says DELIVERED.",
    );
    expect(run.decision.facts).toContainEqual({
      label: "Tracking status (PayPal)",
      value: "DELIVERED",
      recordId: "T28",
    });
    expect(run.decision.facts).toContainEqual({
      label: "Delivered (our shipping record)",
      value: deliveredAt,
      recordId: "T28",
    });
    expect(run.records.find((r) => r.id === "T28")?.facts).toMatchObject({
      statusSource: "paypal",
      deliverySource: "seller",
      deliveredAt,
    });
    expect(noteFrom(run.sentences)).not.toContain("PayPal tracking shows it delivered");
    guarded(run);
  });

  it("a time actually held on a tracker can name PayPal as its time source", async () => {
    const sellerTime = vi.fn(async () => "2026-10-21T12:00:00Z");
    const run = await runAgent(
      "D28",
      deps({
        getTracker: async () => ({
          status: "DELIVERED",
          carrier: "UPS",
          tracking_number: "ZX28",
          delivered_at: deliveredAt,
        }),
        deliveredAt: sellerTime,
      }),
    );
    expect(sellerTime).not.toHaveBeenCalled();
    expect(run.records.find((r) => r.id === "T28")?.facts?.deliverySource).toBe("paypal");
    expect(run.sentences[0].text).toBe("PayPal tracking shows it delivered 2026-10-19 12:00 UTC.");
    guarded(run);
  });

  it.each(["MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"])(
    "a completed USD 6 capture with no order id gives REVIEW for %s",
    async (reason) => {
      const getOrder = vi.fn();
      const onStep = vi.fn();
      const run = await runAgent(
        "D28",
        deps({
          getDispute: async () => ({ ...dispute, reason, dispute_amount: { value: "6.00", currency_code: "USD" } }),
          getCapture: async () => ({
            ...capture,
            amount: { value: "6.00", currency_code: "USD" },
            supplementary_data: {},
          }),
          getOrder,
          onStep,
        }),
      );
      expect(run.decision).toMatchObject({ verdict: "REVIEW", rule: "READ_FAILED" });
      const missing = { tool: "get_order", ref: "", ok: false, summary: "No order id on the payment", ms: 0 };
      expect(run.steps).toContainEqual(missing);
      expect(onStep).toHaveBeenCalledWith(missing);
      expect(getOrder).not.toHaveBeenCalled();
      expect(noteFrom(run.sentences)).not.toContain("accept the claim");
      expect(runProof().verdicts.rows.find((row) => row.label === "Payment has no order id")).toMatchObject({
        expected: "REVIEW",
        got: "REVIEW",
      });
    },
  );
});

describe("job 28 checked replays", () => {
  it.each(["accept", "fight"] as const)(
    "checks the %s replay from an empty pool without changing its source",
    async (kind) => {
      const original = kind === "accept" ? acceptReplay : fightReplay;
      const before = JSON.stringify(original);
      const { env } = await makeEnv();
      const response = await worker.fetch(
        new Request(`https://desk.test/api/judge/next?kind=${kind}`),
        env,
        ctx().context,
      );
      expect(response.status).toBe(200);
      const { replay } = (await response.json()) as { replay: { label: string; run: AgentRun } };
      expect(replay.label).toBe("Draft reconstruction from saved sandbox records. No new filing was made.");
      for (const sentence of replay.run.sentences)
        expect(
          supportedSentence(
            sentence.text,
            replay.run.records.find((r) => r.id === sentence.record_id)!,
          ),
        ).toBe(true);
      const unsupported = original.run.sentences.filter(
        (sentence) =>
          !supportedSentence(
            sentence.text,
            original.run.records.find((r) => r.id === sentence.record_id)!,
          ),
      );
      expect(replay.run.dropped).toEqual([...original.run.dropped, ...unsupported]);
      expect(replay.run.sentences.length).toBeGreaterThan(0);
      expect(replay.run.writer).toBe("template");
      expect(replay.run.dropped).toContainEqual(original.run.sentences[kind === "accept" ? 0 : 1]);
      expect(JSON.stringify(original)).toBe(before);
    },
  );
});
