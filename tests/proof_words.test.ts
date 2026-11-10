import { describe, it, expect } from "vitest";
// @ts-ignore The server types have no Node modules; Vitest runs this in Node.
import fs from "node:fs";

describe("proof page words", () => {
  it("has plain labels without sample records", () => {
    const main = fs.readFileSync("web/src/proof/main.tsx", "utf8");
    expect(main).not.toContain("Sample records");
    expect(main).toContain("Records the checker reads");
  });
});
