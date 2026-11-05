import { PDFDocument, PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { buildPack, layoutLine } from "../src/pack";
import { runAgent, type AgentDeps } from "../src/agent";
import worker from "../src/index";
import { makeEnv, ctx } from "./helpers/env";

async function contentText(bytes: Uint8Array): Promise<string> {
  const pdf = await PDFDocument.load(bytes);
  const chunks: string[] = [];
  // Read declared PDF stream lengths. A compressed checksum may itself end in CR or LF.
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) chunks.push(new TextDecoder().decode(decodePDFRawStream(object).decode()));
  }
  return chunks.join("\n").replace(/<([0-9a-f]+)>/gi, (_match, hex: string) => {
    const bytes = hex.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? [];
    return String.fromCharCode(...bytes);
  });
}

it("reads a PDF content stream whose compressed checksum ends in CR", async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage();
  let found = false;
  for (let i = 0; i < 256; i++) {
    const stream = pdf.context.flateStream(`BT (payload) Tj ET${"!".repeat(i)}`);
    if (stream.getContents().at(-1) !== 13) continue;
    page.node.set(PDFName.of("Contents"), pdf.context.register(stream));
    found = true;
    break;
  }
  expect(found).toBe(true);
  expect(await contentText(await pdf.save())).toContain("(payload)");
});

describe("decision disagreements through the agent and PDF", () => {
  it("job 22 pack names the seller delivery source while PayPal still says SHIPPED", async () => {
    const run = await runAgent("D22", {
      getDispute: async () => ({
        dispute_id: "D22",
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        create_time: "2026-11-05T00:52:00Z",
        dispute_amount: { value: "6.00", currency_code: "USD" },
        disputed_transactions: [{ seller_transaction_id: "C22" }],
      }),
      getCapture: async () => ({
        id: "C22",
        status: "PENDING",
        amount: { value: "6.00", currency_code: "USD" },
        supplementary_data: { related_ids: { order_id: "O22" } },
      }),
      getOrder: async () => ({ id: "O22", purchase_units: [{ shipping: { trackers: [{ id: "T22" }] } }] }),
      getTracker: async () => ({ status: "SHIPPED", carrier: "UPS", tracking_number: "ZX22" }),
      deliveredAt: async () => "2026-11-05T00:51:00Z",
    });
    expect(run.decision.verdict).toBe("FIGHT");
    const bytes = await buildPack({
      disputeId: "D22",
      amount: 6,
      currency: "USD",
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      verdict: run.decision.verdict,
      why: run.decision.why,
      records: JSON.parse(JSON.stringify(run.records)),
      sentences: run.sentences,
      generatedAt: "2026-11-05T01:00:00Z",
    });
    const text = (await contentText(bytes)).replace(/\s*Tj\s*T\*\s*ET\s*Q\s*q\s*BT[\s\S]*?Tm\s*/g, " ");
    expect(text).toContain("Our shipping record shows it delivered 1 minute before the claim.");
    expect(text).toContain("Delivered (our shipping record): 2026-11-05T00:51:00Z [T22]");
    expect(text).toContain("The tracking record shows UPS number ZX22, status SHIPPED on PayPal.");
    expect(text).toContain("Our shipping record shows it delivered 2026-11-05 00:51 UTC.");
    expect(text).not.toContain("UPS shows it delivered");
    expect(text).not.toContain("The buyer paid");
  });

  it.each([
    ["SHIPPED", "48.00", 1, "PayPal says SHIPPED"],
    ["DELIVERED", "50.00", 1, "The dispute is $48.00, but the payment is $50.00."],
    ["DELIVERED", "48.00", 0, ""],
    ["SHIPPED", "50.00", 2, "PayPal says SHIPPED"],
  ])("keeps %s and payment %s disagreements in the stored pack", async (status, amount, count, expected) => {
    const run = await runAgent("D15", {
      getDispute: async () => ({
        dispute_id: "D15",
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        create_time: "2026-11-04",
        dispute_amount: { value: "48.00", currency_code: "USD" },
        disputed_transactions: [{ seller_transaction_id: "C15" }],
      }),
      getCapture: async () => ({
        id: "C15",
        status: "COMPLETED",
        amount: { value: amount, currency_code: "USD" },
        supplementary_data: { related_ids: { order_id: "O15" } },
      }),
      getOrder: async () => ({ id: "O15", purchase_units: [{ shipping: { trackers: [{ id: "T15" }] } }] }),
      getTracker: async () => ({ status, carrier: "UPS", tracking_number: "N15" }),
      deliveredAt: async () => "2026-11-01",
    });
    expect(run.decision.disagreements).toHaveLength(count);
    if (count) expect(run.decision.disagreements.join(" ")).toContain(expected);
    if (status === "SHIPPED")
      expect(run.decision.disagreements.join(" ")).toContain("seller's shipping record says delivered on 2026-11-01");
    // Exercise the actual pack route after JSON storage, with no extra pack fields supplied.
    const { env, DB } = await makeEnv();
    await DB.prepare("INSERT INTO disputes (id, amount, currency, reason, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind("D15", "48.00", "USD", "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", JSON.stringify({ run }), "2026-11-05")
      .run();
    const response = await worker.fetch(new Request("https://desk.test/api/disputes/D15/pack.pdf"), env, ctx().context);
    expect(response.status).toBe(200);
    const text = await contentText(new Uint8Array(await response.arrayBuffer()));
    if (count) {
      expect(text).toContain("Records that disagree:");
      // PDF text can wrap between words.
      for (const disagreement of run.decision.disagreements)
        for (const word of disagreement.split(" ")) expect(text).toContain(word);
    } else expect(text).not.toContain("Records that disagree:");
    // Explicit pack inputs also carry the list, independently of embedded stored decisions.
    const direct = await contentText(await buildPack({ ...input(), disagreements: run.decision.disagreements }));
    expect(direct.includes("Records that disagree:")).toBe(count > 0);
  });
});

function input(count = 3) {
  const sentences = Array.from({ length: count }, (_, index) => ({
    text: `The buyer received the order and confirmed delivery ${index + 1}.`,
    record_id: `7NV342678501075${index}U`,
  }));
  return {
    disputeId: "dp_test_123",
    amount: 48,
    currency: "USD",
    reason: "product_not_received",
    verdict: "Respond",
    why: "The delivery record confirms the order reached the buyer.",
    sentences,
    records: sentences.map((sentence, index) => ({
      id: sentence.record_id,
      kind: "Delivery record",
      summary: `Carrier scan for package ${index + 1}.`,
    })),
    generatedAt: "2026-10-23T12:00:00Z",
  };
}

describe("evidence pack PDF", () => {
  it("moving delivery across the claim changes the verdict, facts, change condition and stored pack together", async () => {
    const { env, DB } = await makeEnv();
    const packs: string[] = [];
    const decisions = [];
    for (const deliveredAt of ["2026-10-19T12:00:00Z", "2026-10-21T12:00:00Z"]) {
      const deps: AgentDeps = {
        getDispute: async () => ({
          dispute_id: "D14",
          reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
          create_time: "2026-10-20T12:00:00Z",
          dispute_amount: { value: "48.00", currency_code: "USD" },
          disputed_transactions: [{ seller_transaction_id: "CAP14" }],
        }),
        getCapture: async () => ({
          id: "CAP14",
          status: "COMPLETED",
          amount: { value: "48.00", currency_code: "USD" },
          create_time: "2026-10-18",
          supplementary_data: { related_ids: { order_id: "ORD14" } },
        }),
        getOrder: async () => ({ id: "ORD14", purchase_units: [{ shipping: { trackers: [{ id: "T14" }] } }] }),
        getTracker: async () => ({ status: "DELIVERED", carrier: "UPS", tracking_number: "ZX9" }),
        deliveredAt: async () => deliveredAt,
      };
      const run = await runAgent("D14", deps);
      decisions.push(run.decision);
      // Exercise the unchanged production pack caller after the run has crossed the JSON storage boundary.
      await DB.prepare(
        "INSERT OR REPLACE INTO disputes (id, amount, currency, reason, data, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
      )
        .bind("D14", "48.00", "USD", "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", JSON.stringify({ run }), "2026-11-05")
        .run();
      const response = await worker.fetch(
        new Request("https://desk.test/api/disputes/D14/pack.pdf"),
        env,
        ctx().context,
      );
      expect(response.status).toBe(200);
      const text = await contentText(new Uint8Array(await response.arrayBuffer()));
      packs.push(text);
      expect(text).toContain(`Verdict: ${run.decision.verdict}`);
      expect(text).toContain(`Delivered (our shipping record): ${deliveredAt} [T14]`);
      expect(text).toContain("Tracking status (PayPal): DELIVERED [T14]");
      expect(text).not.toContain("PayPal tracking shows it delivered");
      expect(text).toContain("Claim opened: 2026-10-20T12:00:00Z [D14]");
      expect(text).toContain("Fight line: $10.00");
      expect(text).toContain("Would change if:");
      // A PDF can wrap the condition into multiple text operators.
      expect(text).toContain(run.decision.changeIf.slice(0, 42));
    }
    expect(decisions.map((d) => d.verdict)).toEqual(["FIGHT", "OFFER"]);
    expect(decisions[0].facts).not.toEqual(decisions[1].facts);
    expect(decisions[0].changeIf).toContain("after 2026-10-20");
    expect(decisions[1].changeIf).toContain("before 2026-10-20");
    expect(packs[0]).not.toBe(packs[1]);
  });

  it("prints supplied facts, missing records and the exact change condition", async () => {
    const source = await contentText(
      await buildPack({
        ...input(0),
        facts: [{ label: "Amount", value: "$6.00", recordId: "CAP14" }],
        missing: ["A delivery record"],
        disagreements: [],
        changeIf: "A delivery record would make the desk fight.",
      }),
    );
    expect(source).toContain("Amount: $6.00 [CAP14]");
    expect(source).toContain("Missing: A delivery record");
    expect(source).toContain("Would change if: A delivery record would make the desk fight.");
  });
  it("leaves heading-sized gaps and prints plain reasons and desk-formatted amounts", async () => {
    for (const size of [20, 12, 14]) {
      const layout = layoutLine(700, size);
      expect(layout.baselineY - layout.nextBaselineY).toBeGreaterThanOrEqual(size * 1.25);
    }

    const data = input();
    data.amount = 8;
    data.reason = "MERCHANDISE_OR_SERVICE_NOT_RECEIVED";
    const source = await contentText(await buildPack(data));
    expect(source).toContain("Reason: Not received");
    expect(source).toContain("Amount: $8.00");
  });

  it("builds a parseable PDF with one or two pages for three sentences", async () => {
    const bytes = await buildPack(input());
    expect(new TextDecoder().decode(bytes.slice(0, 4))).toBe("%PDF");
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBeGreaterThanOrEqual(1);
    expect(parsed.getPageCount()).toBeLessThanOrEqual(2);
    const source = await contentText(bytes);
    for (const record of input().records) expect(source).toContain(record.id);
    expect(source).toContain("Exhibit A");
    expect(source).toContain("Exhibit B");
    expect(source).toContain("Exhibit C");
  });

  it("flows many long sentences onto additional pages", async () => {
    const large = input(60);
    large.sentences = large.sentences.map((sentence) => ({
      ...sentence,
      text: `${sentence.text} ${"Additional documented detail ".repeat(18)}`,
    }));
    const bytes = await buildPack(large);
    const parsed = await PDFDocument.load(bytes);
    expect(parsed.getPageCount()).toBeGreaterThan(2);
    const source = await contentText(bytes);
    expect(source).toContain(large.records[0].id);
    expect(source).toContain(large.records[59].id);
  });

  it("replaces emoji and keeps the check value stable until sentence text changes", async () => {
    const data = input();
    data.sentences[0].text += " ✅";
    await expect(buildPack(data)).resolves.toBeInstanceOf(Uint8Array);
    const first = await contentText(await buildPack(data));
    const repeated = await contentText(await buildPack(data));
    const changedData = {
      ...data,
      sentences: data.sentences.map((sentence, index) =>
        index === 0 ? { ...sentence, text: `${sentence.text} revised` } : sentence,
      ),
    };
    const changed = await contentText(await buildPack(changedData));
    const check = (pdf: string) => pdf.match(/check ([0-9a-f]{12})/)?.[1];
    expect(first).toContain("?");
    expect(check(first)).toBe(check(repeated));
    expect(check(changed)).not.toBe(check(first));
  });

  it("replaces unsupported WinAnsi control characters in summaries", async () => {
    const data = input(1);
    data.records[0].summary = "Buyer note\u0081";
    await expect(buildPack(data)).resolves.toBeInstanceOf(Uint8Array);
    expect(await contentText(await buildPack(data))).toContain("Buyer note?");
  });

  it("builds an exhibit with a record that has no summary", async () => {
    const data = input(1);
    data.records = [{ id: data.records[0].id, kind: "order" }] as typeof data.records;
    await expect(buildPack(data)).resolves.toBeInstanceOf(Uint8Array);
    expect(await contentText(await buildPack(data))).not.toContain("undefined");
  });
});
