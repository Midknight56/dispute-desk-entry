import { describe, it, expect } from "vitest";
// @ts-ignore The server types have no Node modules; Vitest runs this in Node.
import fs from "node:fs";

// The README must name the conflicts that really stop a case (src/rules.ts), not say every disagreement does.
const readme = fs.readFileSync("README.md", "utf8").replace(/\s+/g, " ");

describe("README review claims", () => {
  it("does not say that every disagreement stops at review", () => {
    expect(readme).not.toMatch(/records that disagree, a currency/);
  });

  it("names the conflicts that stop a case and the ones that only show", () => {
    expect(readme).toContain("a payment smaller than the dispute or in another currency");
    expect(readme).toContain("a payment already refunded or reversed");
    expect(readme).toContain("are shown on the case but do not stop it");
  });
});

describe("README judge case claims", () => {
  it("says the deadline and the filing action are checked", () => {
    expect(readme).toContain("has a response deadline more than a day away");
    expect(readme).toContain("offers the filing action the judge needs");
  });
});
