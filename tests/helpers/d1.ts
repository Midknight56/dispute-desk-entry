import initSqlJs, { type Database, type SqlValue } from 'sql.js';

export async function readSqlFile(file: string) {
  const fsModule = 'node:fs/promises';
  const { readFile } = (await import(fsModule)) as unknown as {
    readFile(path: string, encoding: string): Promise<string>;
  };
  return readFile(file, 'utf8');
}

export async function createD1(sqlFiles: string[]) {
  const SQL = await initSqlJs();
  const sqlite = new SQL.Database();
  for (const file of sqlFiles) sqlite.run(await readSqlFile(file));

  function statement(sql: string, values: SqlValue[] = []) {
    const stmt = sqlite.prepare(sql);
    stmt.bind(values);
    const rows: Record<string, unknown>[] = [];
    while (stmt.step()) rows.push(stmt.getAsObject() as Record<string, unknown>);
    stmt.free();
    return rows;
  }

  const db = {
    exec(sql: string) {
      sqlite.run(sql);
    },
    prepare(sql: string) {
      let values: SqlValue[] = [];
      const prepared = {
        bind(...args: unknown[]) {
          values = args as SqlValue[];
          return prepared;
        },
        async first<T>(col?: string): Promise<T | null> {
          const row = statement(sql, values)[0];
          return ((col ? row?.[col] : row) as T | undefined) ?? null;
        },
        async all<T>() {
          return { results: statement(sql, values) as T[] };
        },
        async run() {
          sqlite.run(sql, values);
          return { meta: { changes: sqlite.getRowsModified(), last_row_id: sqlite.exec("SELECT last_insert_rowid() AS id")[0]?.values[0]?.[0] } };
        },
      };
      return prepared;
    },
    async batch<T>(statements: { run(): Promise<unknown> }[]) {
      sqlite.run('BEGIN');
      try {
        const results = [];
        for (const stmt of statements) results.push(await stmt.run());
        sqlite.run('COMMIT');
        return results as T[];
      } catch (error) {
        sqlite.run('ROLLBACK');
        throw error;
      }
    },
  };

  return db as unknown as D1Database & { close(): void; raw: Database };
}
