/**
 * One-time/idempotent migration from the local libSQL app database to Turso.
 *
 *   npx tsx scripts/migrate-to-turso.ts
 *
 * Requires TURSO_DATABASE_URL and TURSO_AUTH_TOKEN in the environment or in
 * .env.production.local. Secrets are never printed.
 */
import { readFileSync } from 'fs';
import { join } from 'path';
import dotenv from 'dotenv';
import { createClient } from '@libsql/client';

dotenv.config({ path: '.env.production.local' });

const url = process.env.TURSO_DATABASE_URL;
const authToken = process.env.TURSO_AUTH_TOKEN;
if (!url || !authToken) throw new Error('TURSO_DATABASE_URL and TURSO_AUTH_TOKEN are required');
const tursoUrl: string = url;
const tursoToken: string = authToken;

async function main() {
  process.env.DATABASE_URL = tursoUrl;

  const [{ ensureGovernorSchema }, { ensureIntegrationSchema }, { createA423Storage }] = await Promise.all([
    import('../lib/a423/governor'),
    import('../lib/a423/operations'),
    import('../lib/a423/storage'),
  ]);

  const local = createClient({ url: 'file:./data/agent-treasury.db' });
  const turso = createClient({ url: tursoUrl, authToken: tursoToken });

  const schemaSql = readFileSync(join(__dirname, 'schema.sql'), 'utf8')
    .replace(/^\s*--.*$/gm, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  for (const statement of schemaSql.split(';').map((item) => item.trim()).filter((item) => item && !/^PRAGMA\b/i.test(item))) {
    await turso.execute(statement);
  }
  await ensureGovernorSchema();
  await ensureIntegrationSchema();
  const storage = createA423Storage();
  await storage.kv.get('__migration__', 'init');
  storage.close();

  const tables = [
    'users', 'agents', 'agent_wallets', 'agent_runs', 'agent_events',
    'a423_organizations', 'a423_agent_registry', 'a423_verification_challenges', 'a423_verifications',
    'a423_jobs', 'a423_events', 'a423_transactions', 'a423_nonces', 'a423_nonce_reservations',
    'a423_kv', 'a423_queue', 'a423_spend',
    'a423_operations', 'a423_artifacts',
  ];

  for (const table of tables) {
    const localRows = await local.execute(`SELECT * FROM ${table}`).catch(() => null);
    if (!localRows || localRows.rows.length === 0) {
      console.log(`skip ${table}`);
      continue;
    }
    const remoteCols = (await turso.execute(`SELECT * FROM ${table} LIMIT 0`)).columns;
    const cols = localRows.columns.filter((column) => remoteCols.includes(column));
    if (cols.length === 0) {
      console.log(`skip ${table} (no common columns)`);
      continue;
    }
    const placeholders = cols.map(() => '?').join(',');
    for (const row of localRows.rows) {
      await turso.execute({
        sql: `INSERT OR REPLACE INTO ${table} (${cols.join(',')}) VALUES (${placeholders})`,
        args: cols.map((column) => row[column] as never),
      });
    }
    console.log(`copied ${table}: ${localRows.rows.length}`);
  }

  const checks = ['agents', 'agent_wallets', 'a423_jobs', 'a423_kv', 'a423_artifacts'];
  for (const table of checks) {
    const row = await turso.execute(`SELECT COUNT(*) AS n FROM ${table}`);
    console.log(`${table}: ${row.rows[0]?.n}`);
  }

  local.close();
  turso.close();
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
