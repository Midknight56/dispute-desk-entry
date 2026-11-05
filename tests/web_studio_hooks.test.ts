import { describe, expect, it } from 'vitest';

describe('Studio React hook imports', () => {
  it('imports every React hook used by the Studio entry point', async () => {
    const fsModule = 'node:fs';
    const { readFileSync } = (await import(fsModule)) as unknown as {
      readFileSync: (path: string, encoding: string) => string;
    };
    const source = readFileSync('web/src/studio/main.tsx', 'utf8');
    const reactImport = source.match(/import\s*\{([^}]+)\}\s*from\s*['"]react['"]/s)?.[1] ?? '';
    const imported = new Set(reactImport.match(/\buse[A-Z]\w*\b/g) ?? []);
    const used = new Set((source.match(/\buse(?:Callback|Context|DeferredValue|Effect|Id|ImperativeHandle|InsertionEffect|LayoutEffect|Memo|Reducer|Ref|State|SyncExternalStore|Transition)\s*\(/g) ?? []).map((call: string) => call.match(/\buse\w+/)?.[0] ?? ''));

    expect([...used].sort()).toEqual([...imported].filter((hook) => used.has(hook)).sort());
    expect([...used].filter((hook) => !imported.has(hook))).toEqual([]);
  });
});
