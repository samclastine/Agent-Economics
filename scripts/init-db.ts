import 'dotenv/config';
import Database from 'better-sqlite3';
import { readFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

/** Apply scripts/schema.sql to the configured SQLite database. Idempotent. */
const path = (process.env.DATABASE_URL ?? 'file:./data/agent-treasury.db').replace(/^file:/, '');
if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
const db = new Database(path);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
db.close();
console.log(`sqlite schema applied at ${path}`);
