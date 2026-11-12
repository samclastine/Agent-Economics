import { getSqlClient } from './client';

export type SqlValue = string | number | bigint | null | Uint8Array;

export type SqlRunResult = { changes: number; lastInsertRowid: number | bigint | null };

export type SqlExecutor = {
  get<T>(sql: string, args?: SqlValue[]): Promise<T | undefined>;
  all<T>(sql: string, args?: SqlValue[]): Promise<T[]>;
  run(sql: string, args?: SqlValue[]): Promise<SqlRunResult>;
};

async function execute(sql: string, args: SqlValue[] = []) {
  return getSqlClient().execute({ sql, args });
}

export async function sqlExec(sql: string): Promise<void> {
  const client = getSqlClient();
  const cleaned = sql
    .replace(/^\s*--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const statements = cleaned
    .split(';')
    .map((statement) => statement.trim())
    .filter((statement) => statement && !/^PRAGMA\b/i.test(statement));
  for (const statement of statements) await client.execute(statement);
}

export async function sqlGet<T>(sql: string, args: SqlValue[] = []): Promise<T | undefined> {
  const result = await execute(sql, args);
  return result.rows[0] as T | undefined;
}

export async function sqlAll<T>(sql: string, args: SqlValue[] = []): Promise<T[]> {
  const result = await execute(sql, args);
  return result.rows as T[];
}

export async function sqlRun(sql: string, args: SqlValue[] = []): Promise<SqlRunResult> {
  const result = await execute(sql, args);
  return {
    changes: result.rowsAffected,
    lastInsertRowid: result.lastInsertRowid == null ? null : Number(result.lastInsertRowid),
  };
}

/**
 * Write transaction. The callback receives an executor bound to the transaction;
 * do not use the global sql helpers inside it or the write will escape the tx.
 */
export async function sqlTransaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
  const client = getSqlClient();
  const tx = await client.transaction('write');
  const executor: SqlExecutor = {
    async get<R>(sql: string, args: SqlValue[] = []) {
      const result = await tx.execute({ sql, args });
      return result.rows[0] as R | undefined;
    },
    async all<R>(sql: string, args: SqlValue[] = []) {
      const result = await tx.execute({ sql, args });
      return result.rows as R[];
    },
    async run(sql: string, args: SqlValue[] = []) {
      const result = await tx.execute({ sql, args });
      return {
        changes: result.rowsAffected,
        lastInsertRowid: result.lastInsertRowid == null ? null : Number(result.lastInsertRowid),
      };
    },
  };
  try {
    const value = await fn(executor);
    await tx.commit();
    return value;
  } catch (error) {
    await tx.rollback().catch(() => undefined);
    throw error;
  }
}
