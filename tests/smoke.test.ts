import { describe, expect, it } from "vitest";

const helperPath: string = "../tools/smoke.mjs";
const {
  checkHealth,
  checkHome,
  checkStudio,
  checkDisputes,
  checkUsage,
  checkPool,
  checkForgedWebhook,
  checkApproveWithoutKey,
  checkMissingDispute,
} = await import(helperPath);

const htmlHeaders = new Headers({
  "content-type": "text/html; charset=utf-8",
  "content-security-policy": "default-src 'self'; object-src 'none'",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "referrer-policy": "strict-origin-when-cross-origin",
});

describe("smoke response checks", () => {
  it("checks the health response", () => {
    expect(checkHealth(200, new Headers(), '{"ok":true,"app":"dispute-desk"}')).toBe("ok");
    expect(checkHealth(200, new Headers(), '{"ok":false}')).not.toBe("ok");
  });

  it("checks home HTML and security headers", () => {
    expect(checkHome(200, htmlHeaders, "<html></html>")).toBe("ok");
    expect(checkHome(200, new Headers({ "content-type": "text/html" }), "<html></html>")).toContain(
      "content-security-policy",
    );
  });

  it("checks studio HTML", () => {
    expect(checkStudio(200, htmlHeaders, "<html></html>")).toBe("ok");
    expect(checkStudio(200, new Headers({ "content-type": "application/json" }), "{}")).not.toBe("ok");
  });

  it("checks disputes and usage JSON", () => {
    expect(checkDisputes(200, new Headers(), "[]")).toBe("ok");
    expect(checkDisputes(200, new Headers(), "{}")).not.toBe("ok");
    expect(
      checkUsage(
        200,
        new Headers(),
        '{"day":"2026-10-23","runs":2,"appNeurons":3,"appCap":4,"accountNeurons":5,"accountCap":6}',
      ),
    ).toBe("ok");
    expect(
      checkUsage(
        200,
        new Headers(),
        '{"day":"2026-10-23","runs":2,"appNeurons":5,"appCap":4,"accountNeurons":5,"accountCap":6}',
      ),
    ).toContain("exceeded");
  });

  it("checks judge pool entries", () => {
    expect(checkPool(200, new Headers(), '[{"kind":"fight","total":3,"free":2}]')).toBe("ok");
    expect(checkPool(200, new Headers(), '[{"kind":"fight","total":1,"free":2}]')).not.toBe("ok");
  });

  it("checks refused and missing dispute responses", () => {
    expect(checkForgedWebhook(400, new Headers(), "signature not verified")).toBe("ok");
    expect(checkApproveWithoutKey(403, new Headers(), "{}")).toBe("ok");
    expect(checkApproveWithoutKey(200, new Headers(), "{}")).not.toBe("ok");
    expect(checkMissingDispute(404, new Headers(), "{}")).toBe("ok");
  });
});
