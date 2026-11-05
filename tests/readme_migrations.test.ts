import { describe, expect, it } from 'vitest';

describe('local migration instructions', () => {
  it('lists every desk migration in the README commands', async () => {
    const fsModule = 'node:fs/promises';
    const { readFile, readdir } = (await import(fsModule)) as unknown as {
      readFile(path: string, encoding: string): Promise<string>;
      readdir(path: string): Promise<string[]>;
    };
    const [readme, files] = await Promise.all([readFile('README.md', 'utf8'), readdir('migrations')]);
    const listed = new Set([...readme.matchAll(/--file=(migrations\/[^\s"`]+)/g)].map((match) => match[1]));
    const usesAllMigrationsLoop = /for file in migrations\/\*\.sql; do[\s\S]*?wrangler d1 execute dispute-desk --local --file="\$file"[\s\S]*?done/.test(readme);
    const missing = files
      .filter((file) => file.endsWith('.sql'))
      .map((file) => `migrations/${file}`)
      .filter((file) => !listed.has(file) && !usesAllMigrationsLoop);
    expect(missing).toEqual([]);
  });
});
