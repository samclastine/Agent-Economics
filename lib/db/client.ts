import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import * as schema from './schema';

type Holder = { sqlite: Database.Database; db: ReturnType<typeof drizzle<typeof schema>> };
const globalForDb = globalThis as unknown as { __agentTreasuryDb?: Holder };

function databasePath(): string {
  const url = process.env.DATABASE_URL ?? 'file:./data/agent-treasury.db';
  return url.replace(/^file:/, '');
}

function openDb(): Holder {
  const path = databasePath();
  if (path !== ':memory:') {
    mkdirSync(dirname(path), { recursive: true });
  }
  const sqlite = new Database(path);
  sqlite.pragma('journal_mode = WAL');
  sqlite.pragma('synchronous = NORMAL');
  sqlite.pragma('foreign_keys = ON');
  sqlite.pragma('busy_timeout = 5000');
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function holder(): Holder {
  if (!globalForDb.__agentTreasuryDb) {
    globalForDb.__agentTreasuryDb = openDb();
  }
  return globalForDb.__agentTreasuryDb;
}

export function getDb() {
  return holder().db;
}

/** Raw SQLite handle for whole-record CAS and digest-based workflow storage. */
export function getSqlite() {
  return holder().sqlite;
}

export { schema };
