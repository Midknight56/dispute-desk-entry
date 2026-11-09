import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { compareScenario } from "../src/scenario";
import { ctx, makeEnv } from "./helpers/env";
// @ts-expect-error Vitest handles TSX; the server project does not enable JSX.
import DecisionExplorer from "../web/src/proof/DecisionExplorer";

describe("one changed fact explains its draft lines", () => {
  it("a failed tracking read removes the shipping lines and keeps the payment line", () => {
    const c = compareScenario("delivered", { field: "trackingRead", value: "failed" });
    expect(c.lineDiff.removed.length).toBeGreaterThan(0);
    expect(c.lineDiff.removed.filter((l) => l.recordKind === "tracking").length).toBe(2);
    expect(c.lineDiff.kept.map((l) => l.recordKind)).toEqual(["capture"]);
    expect(c.lineDiff.kept[0].recordId).toBe("CAP_DELIVERED");
    expect(c.lineDiff.added).toEqual([]);
    expect(c.explain).toContain("The shipping record could not be read.");
    expect(c.explain).toContain("2 shipping lines");
    expect(c.explain).toContain("CAP_DELIVERED");
    expect(c.explain).toContain("Nothing will be filed.");
    for (const sentence of c.explain.split(/(?<=\.)\s+/)) {
      expect(sentence.split(/\s+/).length).toBeLessThan(30);
    }
    expect(c.explain).not.toMatch(/\w\s[-–—]\s\w/);
  });

  it("every line names the record it came from", () => {
    const c = compareScenario("delivered", { field: "deliveredAt", value: "2026-10-20T13:00:00Z" });
    for (const line of [...c.original.lines, ...c.changed.lines]) {
      expect(line.recordId).toBeTruthy();
      expect(line.recordSummary).toContain(line.recordId);
    }
    expect(c.original.lines.map((l) => l.text)).toEqual(c.original.sentences);
    expect(c.lineDiff.added.map((l) => l.text)).toEqual(["Our shipping record shows it delivered 2026-10-20 13:00 UTC."]);
    expect(c.explain).toContain("The verdict moves from FIGHT to OFFER.");
  });

  it("a change that leaves the lines alone says so", () => {
    const c = compareScenario("delivered", { field: "amount", value: 24 });
    expect(c.lineDiff.added).toEqual([]);
    expect(c.lineDiff.removed).toEqual([]);
    expect(c.explain).toContain("The draft lines did not change.");
  });

  it("the route returns the line diff and the explanation", async () => {
    const { env } = await makeEnv();
    const res = await worker.fetch(
      new Request("https://desk.test/api/proof/scenario", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ fixture: "delivered", change: { field: "trackingRead", value: "failed" } }),
      }),
      env,
      ctx().context,
    );
    const body = (await res.json()) as any;
    expect(body.lineDiff.kept[0].recordId).toBe("CAP_DELIVERED");
    expect(typeof body.explain).toBe("string");
  });

  it("the explorer shows what changed, with a tag and a source on each line", () => {
    const comparison = compareScenario("delivered", { field: "trackingRead", value: "failed" });
    const html = renderToStaticMarkup(createElement(DecisionExplorer, { initialComparison: comparison }));
    expect(html).toContain("What changed in the draft");
    expect(html).toContain(">Removed<");
    expect(html).toContain(">Kept<");
    expect(html).toContain("from Payment CAP_DELIVERED");
    expect(html).toContain("line-removed");
  });
});
