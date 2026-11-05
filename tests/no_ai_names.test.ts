import { describe, expect, it } from "vitest";
const helperPath: string = "../tools/no_ai_names.mjs";
const { decode, findTextHits, findWordMatches, scanPathNames, scanRefNames } = await import(helperPath);

describe("encoded name scanning helpers", () => {
  it("decodes the encoded list", () => {
    expect(decode("naguebcvp")).toBe(decode().split(" ")[3]);
  });

  it("matches whole words without matching longer words", () => {
    const name = decode().split(" ")[0];
    expect(findWordMatches(`x${name}y ${name.toUpperCase()} ${name}`)).toEqual([name.toUpperCase(), name]);
  });

  it("returns no hits for clean text", () => {
    expect(findTextHits("A clean line.\nAnother clean line.")).toEqual([]);
  });

  it("scans path names as whole words", () => {
    const sample = decode("pynhqr");
    const matchingPath = `docs/${sample}-notes.md`;
    expect(scanPathNames([matchingPath, `docs/${sample}ish.md`], [sample])).toEqual([
      { path: matchingPath, word: sample },
    ]);
  });

  it("scans ref names as whole words", () => {
    const sample = decode("pynhqr");
    const matchingRef = `refs/heads/${sample}-fix`;
    expect(scanRefNames([matchingRef, `refs/tags/${sample}tte`], [sample])).toEqual([
      { ref: matchingRef, word: sample },
    ]);
  });
});
