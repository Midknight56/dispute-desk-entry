import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PDFDocument, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { decide, type CaseFacts } from "../src/rules";
import { chartTitle, keywordSpec } from "../src/ask";
import { buildPack } from "../src/pack";
// @ts-expect-error Vitest handles TSX; the server project does not enable JSX.
import { DecisionFacts } from "../web/src/components/CaseStates";
// @ts-expect-error Vitest handles TSX; the server project does not enable JSX.
import Tiles from "../web/src/components/Tiles";
import { tileValues, type Dispute } from "../web/src/format";
import { createInitialLayout } from "../web/src/studio/layout";
import type { Run } from "../web/src/api";

async function contentText(bytes: Uint8Array): Promise<string> {
  const pdf = await PDFDocument.load(bytes);
  const chunks: string[] = [];
  for (const [, object] of pdf.context.enumerateIndirectObjects()) {
    if (object instanceof PDFRawStream) chunks.push(new TextDecoder().decode(decodePDFRawStream(object).decode()));
  }
  return chunks.join("\n").replace(/<([0-9a-f]+)>/gi, (_match, hex: string) => {
    const bytes = hex.match(/.{2}/g)?.map((part) => Number.parseInt(part, 16)) ?? [];
    return String.fromCharCode(...bytes);
  });
}

const baseFacts = (amount: number, currency = "USD"): CaseFacts => ({
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  amount,
  currency,
  claimAt: "2026-10-23T02:00:00Z",
  hasOrder: true,
  hasCapture: true,
});

describe("policy labels and boundaries", () => {
  it("boundary: INR with no delivery record at 9.99 gives ACCEPT, 10.00 gives OFFER, 10.01 gives OFFER", () => {
    const at999 = decide(baseFacts(9.99));
    expect(at999.verdict).toBe("ACCEPT");
    expect(at999.rule).toBe("NO_EVIDENCE_UNDER_LINE");
    expect(at999.policy).toBeDefined();
    expect(at999.policy?.fightLine).toBe("$10.00");
    expect(at999.policy?.offerShare).toBe("half");
    expect(at999.policy?.currency).toBe("USD");
    expect(at999.policy?.note).toBe("Set by this desk, not by PayPal. The desk works in USD only.");

    const at1000 = decide(baseFacts(10.00));
    expect(at1000.verdict).toBe("OFFER");
    expect(at1000.rule).toBe("NO_EVIDENCE_OVER_LINE");
    expect(at1000.policy?.fightLine).toBe("$10.00");

    const at1001 = decide(baseFacts(10.01));
    expect(at1001.verdict).toBe("OFFER");
    expect(at1001.rule).toBe("NO_EVIDENCE_OVER_LINE");
    expect(at1001.policy?.fightLine).toBe("$10.00");
  });

  it("a EUR case gives REVIEW CURRENCY_NOT_SUPPORTED and still carries policy", () => {
    const eurCase = decide(baseFacts(48.0, "EUR"));
    expect(eurCase.verdict).toBe("REVIEW");
    expect(eurCase.rule).toBe("CURRENCY_NOT_SUPPORTED");
    expect(eurCase.policy).toBeDefined();
    expect(eurCase.policy?.currency).toBe("USD");
    expect(eurCase.policy?.fightLine).toBe("$10.00");
    expect(eurCase.policy?.offerShare).toBe("half");
    expect(eurCase.policy?.note).toBe("Set by this desk, not by PayPal. The desk works in USD only.");
  });

  it("DecisionFacts renders Desk policy and note for a run with policy, and renders no such section without it", () => {
    const runWithPolicy = {
      disputeId: "D1",
      decision: {
        verdict: "FIGHT" as const,
        rule: "test",
        why: "Delivered",
        policy: {
          fightLine: "$10.00",
          offerShare: "half",
          currency: "USD" as const,
          reasons: ["MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"],
          note: "Set by this desk, not by PayPal. The desk works in USD only.",
        },
      },
      records: [],
      sentences: [],
      dropped: [],
      steps: [],
      writer: "template" as const,
      chosenTools: [],
      usage: {},
    } as unknown as Run;

    const htmlWith = renderToStaticMarkup(createElement(DecisionFacts, { run: runWithPolicy }));
    expect(htmlWith).toContain("Desk policy");
    expect(htmlWith).toContain("Fight line $10.00. Weak cases offer half back.");
    expect(htmlWith).toContain("Set by this desk, not by PayPal. The desk works in USD only.");
    expect(htmlWith).toContain("Handles: not received, not as described");

    const runWithoutPolicy = {
      ...runWithPolicy,
      decision: {
        verdict: "ACCEPT" as const,
        rule: "test",
        why: "Old run",
      },
    } as unknown as Run;
    const htmlWithout = renderToStaticMarkup(createElement(DecisionFacts, { run: runWithoutPolicy }));
    expect(htmlWithout).not.toContain("Desk policy");
    expect(htmlWithout).not.toContain("Set by this desk, not by PayPal");
    expect(htmlWithout).toBe('<div class="decision-facts"></div>');
  });

  it("the PDF text holds Set by this desk, not by PayPal when policy is present", async () => {
    const bytes = await buildPack({
      disputeId: "D-PACK-1",
      amount: "48.00",
      currency: "USD",
      reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
      verdict: "FIGHT",
      why: "Delivered before claim",
      policy: {
        fightLine: "$10.00",
        offerShare: "half",
        currency: "USD",
        reasons: ["MERCHANDISE_OR_SERVICE_NOT_RECEIVED", "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED"],
        note: "Set by this desk, not by PayPal. The desk works in USD only.",
      },
      sentences: [],
      records: [],
      generatedAt: "2026-11-05T01:00:00Z",
    });
    const text = await contentText(bytes);
    expect(text).toContain("Set by this desk, not by PayPal");
    expect(text).toContain("Fight line $10.00. Weak cases offer half back.");
    expect(text).toContain("Handles: not received, not as described");
  });

  it("renames On hold to Open dispute amount on the tile and Studio KPI", () => {
    const disputes: Dispute[] = [
      {
        id: "D1",
        amount: "50.00",
        currency: "USD",
        status: "WAITING_FOR_SELLER_RESPONSE",
        stage: "INQUIRY",
        reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
        due: null,
        custom_id: null,
        updated_at: "2026-10-23T00:00:00Z",
      },
    ];
    const values = tileValues(disputes);
    expect(values.openAmount).toBe(50);

    const tileHtml = renderToStaticMarkup(createElement(Tiles, { values, loaded: true }));
    expect(tileHtml).toContain("Open dispute amount");
    expect(tileHtml).not.toContain("On hold");

    const layout = createInitialLayout();
    const kpiTitle = layout.pages[0].widgets.onHold.format.title.text;
    expect(kpiTitle).toBe("Open dispute amount");
    expect(JSON.stringify(layout)).not.toContain("On hold");
  });

  it("chartTitle for metric held returns Open dispute amount", () => {
    const title = chartTitle({ chart: "bar", groupBy: "stage", metric: "held", period: "all" });
    expect(title).toContain("Open dispute amount");
    expect(title).not.toContain("Money on hold");
  });

  it("keywordSpec maps open dispute amount and open amount to held metric", () => {
    expect(keywordSpec("open dispute amount by stage").metric).toBe("held");
    expect(keywordSpec("open amount by status").metric).toBe("held");
    expect(keywordSpec("money on hold by stage").metric).toBe("held");
  });
});
