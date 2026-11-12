import { createClient, type Client } from '@libsql/client';
import { drizzle } from 'drizzle-orm/libsql';
import { mkdirSync } from 'fs';
import { dirname } from 'path';
import * as schema from './schema';

type AppDb = ReturnType<typeof drizzle<typeof schema>>;
type Holder = { client: Client; db: AppDb; url: string };

const globalForDb = globalThis as unknown as { __agentTreasuryDb?: Holder };

function databaseUrl(): string {
  const url = process.env.TURSO_DATABASE_URL ?? process.env.DATABASE_URL ?? 'file:./data/agent-treasury.db';
  return url.startsWith('libsql://') || url.startsWith('http://') || url.startsWith('https://') || url.startsWith('file:')
    ? url
    : `file:${url}`;
}

function openDb(): Holder {
  const url = databaseUrl();
  if (url.startsWith('file:')) {
    const path = url.slice('file:'.length);
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  }
  const client = createClient({
    url,
    ...(url.startsWith('libsql://') || url.startsWith('http://') || url.startsWith('https://')
      ? { authToken: process.env.TURSO_AUTH_TOKEN }
      : {}),
  });
  return { client, db: drizzle(client, { schema }), url };
}

function holder(): Holder {
  if (!globalForDb.__agentTreasuryDb) globalForDb.__agentTreasuryDb = openDb();
  return globalForDb.__agentTreasuryDb;
}

export function getDb(): AppDb {
  return holder().db;
}

/** Async libSQL client for raw SQL and transactional work. */
export function getSqlClient(): Client {
  return holder().client;
}

export function databaseKind(): 'turso' | 'local' {
  return holder().url.startsWith('file:') ? 'local' : 'turso';
}

export { schema };
