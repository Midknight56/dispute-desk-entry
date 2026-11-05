import { describe, expect, it } from 'vitest';
import { readUsage } from '../src/usage';
import { createD1 } from './helpers/d1';

describe('clean local database setup', () => {
  it('reads zero usage from fresh databases built only from migrations', async () => {
    const fsModule = 'node:fs/promises';
    const { readdir } = (await import(fsModule)) as unknown as { readdir(path: string): Promise<string[]> };
    const appFiles = (await readdir('migrations')).filter((file) => file.endsWith('.sql')).sort().map((file) => `migrations/${file}`);
    const ledgerFiles = (await readdir('migrations-ledger')).filter((file) => file.endsWith('.sql')).sort().map((file) => `migrations-ledger/${file}`);
    const db = await createD1(appFiles);
    const ledger = await createD1(ledgerFiles);
    await expect(readUsage(db, ledger, 'visitor', '2026-11-05')).resolves.toEqual({
      visitorRuns: 0,
      dayRuns: 0,
      appNeurons: 0,
      accountNeurons: 0,
    });
  });
});
