import { describe, expect, it } from "vitest";
// @ts-expect-error Node tests import the plain JavaScript deploy check.
import { readFileSync } from "node:fs";
// @ts-expect-error The deploy check is intentionally plain Node JavaScript.
import { deprecationLine, modelIdFrom, modelPageUrl } from "../tools/model_check.mjs";

describe("deploy model guard", () => {
  it("reads the configured model from the real agent source", () => {
    const source = readFileSync(new URL("../src/agent.ts", import.meta.url), "utf8");
    const id = modelIdFrom(source);
    expect(id).toBe("@cf/ibm-granite/granite-4.0-h-micro");
    expect(modelPageUrl(id)).toBe("https://developers.cloudflare.com/workers-ai/models/granite-4.0-h-micro/");
  });

  it("detects deprecation wording and accepts a page without it", () => {
    expect(deprecationLine("<tr><td>Planned Deprecation</td><td>11/20/2026</td></tr>"))
      .toContain("Planned Deprecation");
    expect(deprecationLine("<html><td>Function calling</td><td>Yes</td></html>")).toBeUndefined();
  });

  it("keeps the configured model off the deprecated model list", () => {
    const source = readFileSync(new URL("../src/agent.ts", import.meta.url), "utf8");
    expect(modelIdFrom(source)).not.toBe("@cf/meta/llama-3.2-3b-instruct");
  });
});
