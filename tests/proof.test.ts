import { describe, expect, it } from "vitest";
import { checkSentence, proofCases, runProof } from "../src/proof";
import { decide } from "../src/rules";

describe("proof page", () => {
  it("matches every planned verdict and strikes every changed sentence", () => {
    const proof = runProof();
    expect(proof.verdicts.total).toBe(41);
    expect(proof.checker.total).toBe(21);
    expect(proof.checker.struck).toBe(21);
    expect(proof.verdicts.rows.every((row) => row.expected === row.got)).toBe(true);
    expect(
      proof.verdicts.rows.every(
        (row) => decide(proofCases.find((c) => c.label === row.label)!.facts).verdict === row.expected,
      ),
    ).toBe(true);
    expect(proof.checker.rows.filter((row) => row.kind !== "Kept sentence").every((row) => row.struck)).toBe(true);
    expect(proof.checker.rows.filter((row) => row.kind === "Kept sentence").every((row) => !row.struck)).toBe(true);
    expect(
      proof.checker.rows
        .filter((row) => row.kind === "Buyer words as fact")
        .every((row) => row.reason === "The buyer's own words are not proof."),
    ).toBe(true);
  });

  it("keeps a true sentence and strikes a made up one", () => {
    expect(checkSentence("The buyer paid $48.00.", "CAP1").status).toBe("kept");
    expect(checkSentence("The buyer paid $999.00.", "CAP1").status).toBe("struck");
  });

  it("includes every new review rule and every altered fact", () => {
    const proof = runProof();
    expect(proof.verdicts.rows.filter((row) => row.got === "REVIEW")).toHaveLength(14);
    expect(proof.checker.rows.filter((row) => row.kind === "Changed fact")).toHaveLength(12);
  });

  it("refuses text over 400 characters", () => {
    expect(checkSentence("x".repeat(401), "CAP1")).toEqual({
      status: "struck",
      reason: "Keep the sentence to 400 characters or fewer.",
    });
  });
});
