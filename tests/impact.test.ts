// @ts-ignore
import fs from 'node:fs';
// @ts-ignore
import os from 'node:os';
// @ts-ignore
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { decide } from '../src/rules';
// @ts-ignore
import { finishTask, loadAllCases, score, startTask } from '../tools/measure_review.mjs';

describe('impact review fixtures and measure tool', () => {
  const fixtures = loadAllCases();

  it('loads five sanitized impact cases', () => {
    expect(fixtures).toHaveLength(5);
    for (const fixture of fixtures) {
      expect(fixture.id).toMatch(/^PP-D-IMPACT-[1-5]$/);
      expect(fixture.title).toBeTruthy();
      expect(fixture.records).toBeDefined();
      expect(fixture.facts).toBeDefined();
      expect(fixture.answer).toBeDefined();
    }
  });

  it("each fixture's answer.verdict equals decide(fixture.facts)", () => {
    for (const fixture of fixtures) {
      const decision = decide(fixture.facts);
      expect(decision.verdict).toBe(fixture.answer.verdict);
    }
  });

  it('score() marks a right answer right, a wrong verdict wrong, finds a missed must find fact and a hit trap', () => {
    const key = {
      verdict: 'FIGHT',
      mustFind: ['delivered before claim', 'tracking status DELIVERED'],
      traps: ['says PayPal confirmed delivery', 'package not delivered'],
    };

    // Right answer with all must find facts and no traps
    const rightResult = score(key, {
      verdict: 'FIGHT',
      facts: ['delivered before claim', 'tracking status DELIVERED'],
      claims: ['valid seller tracking'],
      approve: 'yes',
    });
    expect(rightResult.verdictRight).toBe(true);
    expect(rightResult.missingFacts).toHaveLength(0);
    expect(rightResult.trapsHit).toHaveLength(0);

    // Wrong verdict
    const wrongVerdictResult = score(key, {
      verdict: 'OFFER',
      facts: ['delivered before claim', 'tracking status DELIVERED'],
      claims: [],
      approve: 'no',
    });
    expect(wrongVerdictResult.verdictRight).toBe(false);

    // Missed must find fact
    const missedResult = score(key, {
      verdict: 'FIGHT',
      facts: ['delivered before claim'],
      claims: [],
      approve: 'yes',
    });
    expect(missedResult.missingFacts).toContain('tracking status DELIVERED');

    // Hit trap
    const hitTrapResult = score(key, {
      verdict: 'FIGHT',
      facts: ['delivered before claim', 'tracking status DELIVERED'],
      claims: ['says PayPal confirmed delivery'],
      approve: 'yes',
    });
    expect(hitTrapResult.trapsHit).toContain('says PayPal confirmed delivery');
  });

  describe('startTask then finishTask', () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'impact_measure_test_'));

    afterAll(() => {
      try {
        fs.rmSync(tempDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    });

    it('writes one result line with elapsed seconds of 0 or more in a temp folder', () => {
      const caseId = 'PP-D-IMPACT-1';
      const tester = 'test_agent';

      startTask(caseId, tester, { outDir: tempDir, print: false });

      const finishRecord = finishTask(
        caseId,
        tester,
        {
          verdict: 'FIGHT',
          facts: 'delivered before claim;tracking status DELIVERED',
          claims: 'standard delivery',
          approve: 'yes',
        },
        { outDir: tempDir, print: false },
      );

      expect(finishRecord.elapsedSeconds).toBeGreaterThanOrEqual(0);
      expect(finishRecord.case).toBe(caseId);

      const resultsPath = path.join(tempDir, 'results.jsonl');
      expect(fs.existsSync(resultsPath)).toBe(true);

      const content = fs.readFileSync(resultsPath, 'utf8').trim();
      const lines = content.split('\n');
      expect(lines).toHaveLength(1);

      const parsed = JSON.parse(lines[0]);
      expect(parsed.tester).toBe(tester);
      expect(parsed.case).toBe(caseId);
      expect(parsed.elapsedSeconds).toBeGreaterThanOrEqual(0);
      expect(parsed.approve).toBe('yes');
      expect(parsed.scores).toBeDefined();
      expect(parsed.scores.verdictRight).toBe(true);
    });
  });

  it('fixtures contain no @ character and no street address pattern', () => {
    // Street address pattern: street number followed by name and street type
    const streetPattern = /\b\d+\s+[A-Za-z]+(?:\s+[A-Za-z]+)?\s+(?:street|st|avenue|ave|road|rd|drive|dr|boulevard|blvd|lane|ln|court|ct|way)\b/i;

    for (const fixture of fixtures) {
      const serialized = JSON.stringify(fixture);
      expect(serialized).not.toContain('@');
      expect(streetPattern.test(serialized)).toBe(false);
    }
  });
});
