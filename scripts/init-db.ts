import 'dotenv/config';
import { readFileSync } from 'fs';
import { join } from 'path';
import { sqlExec } from '../lib/db/sql';

/** Apply scripts/schema.sql through the configured libSQL client (local or Turso). */
async function main() {
  await sqlExec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
  console.log('libSQL schema applied');
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
