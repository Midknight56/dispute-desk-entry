import { describe, expect, it } from 'vitest';

const read = async (path: string): Promise<string> => {
  const fsModule = 'fs';
  const fs = (await import(fsModule)) as { readFileSync: (file: string, encoding: string) => string };
  return fs.readFileSync(path, 'utf8');
};

describe('proof page wording', () => {
  it('says the verdicts match the desk rules, not that they are right', async () => {
    const page = await read('web/src/proof/main.tsx');
    expect(page).toContain("match the desk's rules");
    expect(page).not.toContain('verdicts right');
  });
});
