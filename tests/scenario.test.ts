import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { decide } from "../src/rules";
import {
  compareScenario,
  DELIVERED_ONE_HOUR_AFTER,
  DELIVERED_TWO_DAYS_BEFORE,
  FIXTURES,
  getFixtureFacts,
  scenarioOptions,
} from "../src/scenario";
import { ctx, makeEnv } from "./helpers/env";
// @ts-expect-error Vitest handles TSX; the server project does not enable JSX.
import DecisionExplorer from "../web/src/proof/DecisionExplorer";

describe("scenario comparison", () => {
  it("delivery 2 days before the claim gives FIGHT; the same case with delivery 1 hour after the claim gives OFFER", () => {
    const result = compareScenario("delivered", {
      field: "deliveredAt",
      value: DELIVERED_ONE_HOUR_AFTER,
    });
    expect(result.original.verdict).toBe("FIGHT");
    expect(result.original.rule).toBe("INR_DELIVERED_BEFORE_CLAIM");
    expect(result.changed.verdict).toBe("OFFER");
    expect(result.changed.rule).toBe("WEAK_EVIDENCE");
    expect(result.changedField).toBe("deliveredAt");
    expect(result.original.sentences.length).toBeGreaterThan(0);
    expect(result.changed.sentences.length).toBeGreaterThan(0);
  });

  it("tracking read failed on delivered gives REVIEW", () => {
    const result = compareScenario("delivered", {
      field: "trackingRead",
      value: "failed",
    });
    expect(result.original.verdict).toBe("FIGHT");
    expect(result.changed.verdict).toBe("REVIEW");
    expect(result.changed.rule).toBe("READ_FAILED");
  });

  it("order read failed on refund gives REVIEW (a missing order blocks the refund)", () => {
    const result = compareScenario("refund", {
      field: "orderRead",
      value: "failed",
    });
    expect(result.original.verdict).toBe("ACCEPT");
    expect(result.changed.verdict).toBe("REVIEW");
    expect(result.changed.rule).toBe("READ_FAILED");
  });

  it("amount 6 to 12 on refund moves ACCEPT to OFFER (check with decide() first that this is today's rule)", () => {
    const refundBase = getFixtureFacts("refund");
    expect(decide({ ...refundBase, amount: 6 }).verdict).toBe("ACCEPT");
    expect(decide({ ...refundBase, amount: 12 }).verdict).toBe("OFFER");

    const result = compareScenario("refund", {
      field: "amount",
      value: 12,
    });
    expect(result.original.verdict).toBe("ACCEPT");
    expect(result.original.rule).toBe("NO_EVIDENCE_UNDER_LINE");
    expect(result.changed.verdict).toBe("OFFER");
    expect(result.changed.rule).toBe("NO_EVIDENCE_OVER_LINE");
  });

  it("the fixtures are unchanged after many calls (deep equal to a fresh copy)", () => {
    const freshDelivered = JSON.parse(JSON.stringify(FIXTURES.delivered));
    const freshRefund = JSON.parse(JSON.stringify(FIXTURES.refund));

    for (let i = 0; i < 20; i++) {
      compareScenario("delivered", { field: "deliveredAt", value: DELIVERED_ONE_HOUR_AFTER });
      compareScenario("delivered", { field: "deliveredAt", value: "" });
      compareScenario("delivered", { field: "trackingRead", value: "failed" });
      compareScenario("refund", { field: "amount", value: 12 });
      compareScenario("refund", { field: "orderRead", value: "failed" });
      compareScenario("refund", { field: "deliveredAt", value: DELIVERED_TWO_DAYS_BEFORE });
    }

    expect(FIXTURES.delivered).toEqual(freshDelivered);
    expect(FIXTURES.refund).toEqual(freshRefund);
  });

  it("throws a plain error on unknown fixture or field", () => {
    expect(() => compareScenario("unknown", { field: "amount", value: 12 })).toThrow("Unknown fixture");
    expect(() => compareScenario("delivered", { field: "unknownField", value: 12 })).toThrow("Unknown field");
    expect(() => compareScenario("refund", { field: "amount", value: 9999 })).toThrow("Amount must be between 1 and 500");
    expect(() => compareScenario("refund", { field: "trackingRead", value: "invalid" })).toThrow("Tracking read must be ok or failed");
  });

  it("provides scenario options for fixtures and fields", () => {
    const options = scenarioOptions();
    expect(options.fixtures.map((f) => f.id)).toEqual(["delivered", "refund"]);
    expect(options.fields.map((f) => f.name)).toEqual(["deliveredAt", "trackingRead", "orderRead", "amount"]);
  });
});

describe("scenario route", () => {
  it("answers 200 for a good body and 400 for an unknown field; it never calls env.AI.run", async () => {
    const { env } = await makeEnv();
    const fakeRun = vi.fn().mockImplementation(() => {
      throw new Error("AI should not be called");
    });
    env.AI = { run: fakeRun } as any;

    const goodRes = await worker.fetch(
      new Request("https://desk.test/api/proof/scenario", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fixture: "delivered",
          change: { field: "deliveredAt", value: DELIVERED_ONE_HOUR_AFTER },
        }),
      }),
      env,
      ctx().context,
    );
    expect(goodRes.status).toBe(200);
    const goodData = (await goodRes.json()) as any;
    expect(goodData).toMatchObject({
      original: { verdict: "FIGHT" },
      changed: { verdict: "OFFER" },
      changedField: "deliveredAt",
    });

    const badRes = await worker.fetch(
      new Request("https://desk.test/api/proof/scenario", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fixture: "delivered",
          change: { field: "unknownField", value: "xyz" },
        }),
      }),
      env,
      ctx().context,
    );
    expect(badRes.status).toBe(400);

    const badFixture = await worker.fetch(
      new Request("https://desk.test/api/proof/scenario", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fixture: "nonexistent",
          change: { field: "amount", value: 12 },
        }),
      }),
      env,
      ctx().context,
    );
    expect(badFixture.status).toBe(400);

    const missingChange = await worker.fetch(
      new Request("https://desk.test/api/proof/scenario", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fixture: "delivered" }),
      }),
      env,
      ctx().context,
    );
    expect(missingChange.status).toBe(400);

    expect(fakeRun).not.toHaveBeenCalled();
  });

  it("answers 200 for GET /api/proof/scenario listing fixtures and allowed fields", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      new Request("https://desk.test/api/proof/scenario", { method: "GET" }),
      env,
      ctx().context,
    );
    expect(res.status).toBe(200);
    const data = (await res.json()) as any;
    expect(data.fixtures.map((f: { id: string }) => f.id)).toEqual(["delivered", "refund"]);
    expect(data.fields.map((f: { name: string }) => f.name)).toEqual([
      "deliveredAt",
      "trackingRead",
      "orderRead",
      "amount",
    ]);
  });
});

describe("DecisionExplorer panel", () => {
  it("renders both columns and the title", () => {
    const html = renderToStaticMarkup(createElement(DecisionExplorer, {}));
    expect(html).toContain("One changed fact");
    expect(html).toContain("Change one fact and see what the desk would decide. Nothing is filed and no model is called.");
    expect(html).toContain("As recorded");
    expect(html).toContain("With one change");
    expect(html).toContain("This would change it");
    expect(html).toContain("Draft lines");
    expect(html).toContain(">Case<");
    expect(html).toContain("Fact to change");
    expect(html).toContain("Value");
  });

  it("contains none of sample, hypothetical, simulat, or synthetic in lower case", () => {
    const html = renderToStaticMarkup(createElement(DecisionExplorer, {})).toLowerCase();
    expect(html).not.toContain("sample");
    expect(html).not.toContain("hypothetical");
    expect(html).not.toContain("simulat");
    expect(html).not.toContain("synthetic");
  });
});
