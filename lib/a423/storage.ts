import type { Json, WorkflowJob } from '@allorc/a423-sdk/workflow';
import type {
  DurableQueue,
  KeyValueStore,
  QueueItem,
  Safety,
  SqliteJobStore,
  SqliteStorage,
  SpendingStore,
  TransactionRecord,
  TransactionStore,
} from '@allorc/a423-sdk/storage';
import { randomUUID } from 'crypto';
import { sqlAll, sqlExec, sqlGet, sqlRun, sqlTransaction, type SqlExecutor } from '@/lib/db/sql';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS a423_jobs(id TEXT PRIMARY KEY, version INTEGER NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS a423_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT, job_id TEXT NOT NULL, sequence INTEGER NOT NULL, payload TEXT NOT NULL, UNIQUE(job_id, sequence));
CREATE TABLE IF NOT EXISTS a423_transactions(id TEXT PRIMARY KEY, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS a423_nonces(scope TEXT PRIMARY KEY, next_nonce INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS a423_nonce_reservations(scope TEXT NOT NULL, operation_id TEXT NOT NULL, nonce INTEGER NOT NULL, PRIMARY KEY(scope, operation_id), UNIQUE(scope, nonce));
CREATE TABLE IF NOT EXISTS a423_kv(namespace TEXT NOT NULL, id TEXT NOT NULL, payload TEXT NOT NULL, PRIMARY KEY(namespace, id));
CREATE TABLE IF NOT EXISTS a423_queue(id TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, status TEXT NOT NULL, available_at INTEGER NOT NULL, lease TEXT, lease_until INTEGER NOT NULL DEFAULT 0, attempts INTEGER NOT NULL DEFAULT 0, result TEXT);
CREATE INDEX IF NOT EXISTS a423_queue_ready ON a423_queue(status, available_at, lease_until);
CREATE TABLE IF NOT EXISTS a423_spend(id TEXT PRIMARY KEY, scope TEXT NOT NULL, amount TEXT NOT NULL, day TEXT NOT NULL, at INTEGER NOT NULL);
CREATE INDEX IF NOT EXISTS a423_spend_scope ON a423_spend(scope, day);
`;

function parse<T>(value: unknown): T {
  return JSON.parse(String(value)) as T;
}

async function projectEvents(tx: SqlExecutor, job: WorkflowJob): Promise<void> {
  for (const event of job.events) {
    await tx.run('INSERT OR IGNORE INTO a423_events(job_id, sequence, payload) VALUES(?,?,?)', [
      job.id,
      event.sequence,
      JSON.stringify({ ...event, job_id: job.id }),
    ]);
  }
}

/**
 * A423 SDK storage backed by libSQL. Local dev uses a local libSQL file; Vercel
 * production uses Turso through the same client. This replaces the SDK's
 * node:sqlite driver, which cannot persist on serverless filesystems.
 */
export function createA423Storage(): SqliteStorage {
  let ready: Promise<void> | null = null;
  const ensure = () => (ready ??= sqlExec(SCHEMA));

  const kv: KeyValueStore = {
    async get(namespace, id) {
      await ensure();
      const row = await sqlGet<{ payload: string }>('SELECT payload FROM a423_kv WHERE namespace=? AND id=?', [namespace, id]);
      return row ? parse(row.payload) : null;
    },
    async put(namespace, id, value) {
      await ensure();
      await sqlRun('INSERT INTO a423_kv VALUES(?,?,?) ON CONFLICT(namespace,id) DO UPDATE SET payload=excluded.payload', [
        namespace,
        id,
        JSON.stringify(value),
      ]);
    },
    async create(namespace, id, value) {
      await ensure();
      const result = await sqlRun('INSERT OR IGNORE INTO a423_kv VALUES(?,?,?)', [namespace, id, JSON.stringify(value)]);
      return result.changes > 0;
    },
    async take(namespace, id) {
      await ensure();
      return sqlTransaction(async (tx) => {
        const row = await tx.get<{ payload: string }>('SELECT payload FROM a423_kv WHERE namespace=? AND id=?', [namespace, id]);
        await tx.run('DELETE FROM a423_kv WHERE namespace=? AND id=?', [namespace, id]);
        return row ? parse(row.payload) : null;
      });
    },
    async list(namespace) {
      await ensure();
      const rows = await sqlAll<{ id: string; payload: string }>('SELECT id,payload FROM a423_kv WHERE namespace=? ORDER BY id', [namespace]);
      return rows.map((row) => ({ id: row.id, value: parse(row.payload) }));
    },
  };

  const jobs: SqliteJobStore = {
    async get(id) {
      await ensure();
      const row = await sqlGet<{ payload: string }>('SELECT payload FROM a423_jobs WHERE id=?', [id]);
      return row ? parse<WorkflowJob>(row.payload) : null;
    },
    async create(job) {
      await ensure();
      return sqlTransaction(async (tx) => {
        const result = await tx.run('INSERT OR IGNORE INTO a423_jobs VALUES(?,?,?)', [job.id, job.version, JSON.stringify(job)]);
        if (result.changes) await projectEvents(tx, job);
        return result.changes > 0;
      });
    },
    async compareAndSet(id, version, job) {
      if (job.id !== id || job.version !== version + 1) throw new Error('Invalid CAS record');
      await ensure();
      return sqlTransaction(async (tx) => {
        const result = await tx.run('UPDATE a423_jobs SET version=?,payload=? WHERE id=? AND version=?', [
          job.version,
          JSON.stringify(job),
          id,
          version,
        ]);
        if (result.changes) await projectEvents(tx, job);
        return result.changes > 0;
      });
    },
    async list(options = {}) {
      await ensure();
      const { actor, limit = 100, after = '' } = options;
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('Invalid limit');
      const rows = await sqlAll<{ payload: string }>('SELECT payload FROM a423_jobs WHERE id>? ORDER BY id LIMIT ?', [after, 1000]);
      return rows
        .map((row) => parse<WorkflowJob>(row.payload))
        .filter((job) => !actor || Object.values(job.participants).includes(actor))
        .slice(0, limit);
    },
    async events(options) {
      await ensure();
      const { actor, after = 0, limit = 100 } = options;
      if (!actor || !Number.isSafeInteger(after) || after < 0 || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) {
        throw new TypeError('Invalid event query');
      }
      const rows = await sqlAll<{ cursor: number; job_id: string; payload: string }>(
        'SELECT cursor,job_id,payload FROM a423_events WHERE cursor>? ORDER BY cursor LIMIT ?',
        [after, 1000],
      );
      const out: Array<{ cursor: number; job_id: string; sequence: number; type: string; actor_id: string; at: string; data: Json }> = [];
      for (const row of rows) {
        const job = await sqlGet<{ payload: string }>('SELECT payload FROM a423_jobs WHERE id=?', [row.job_id]);
        if (!job) continue;
        const parsed = parse<WorkflowJob>(job.payload);
        if (!Object.values(parsed.participants).includes(actor)) continue;
        out.push({ ...parse<Record<string, unknown>>(row.payload), cursor: Number(row.cursor) } as typeof out[number]);
        if (out.length >= limit) break;
      }
      return out;
    },
    async getSafety(id) {
      return kv.get('safety', id) as Promise<Safety | null>;
    },
    async setSafety(id, value) {
      await kv.put('safety', id, value);
    },
  };

  const transactions: TransactionStore = {
    async get(id) {
      await ensure();
      const row = await sqlGet<{ payload: string }>('SELECT payload FROM a423_transactions WHERE id=?', [id]);
      return row ? parse<TransactionRecord>(row.payload) : null;
    },
    async create(id, record) {
      await ensure();
      const result = await sqlRun('INSERT OR IGNORE INTO a423_transactions VALUES(?,?)', [id, JSON.stringify(record)]);
      return result.changes > 0;
    },
    async list() {
      await ensure();
      const rows = await sqlAll<{ id: string; payload: string }>('SELECT id,payload FROM a423_transactions ORDER BY id');
      return rows.map((row) => ({ id: row.id, ...parse<TransactionRecord>(row.payload) }));
    },
    async appendReplacement(id, expectedHash, replacement) {
      await ensure();
      await sqlTransaction(async (tx) => {
        const row = await tx.get<{ payload: string }>('SELECT payload FROM a423_transactions WHERE id=?', [id]);
        if (!row) throw new Error('Unknown transaction');
        const record = parse<TransactionRecord>(row.payload);
        const last = record.replacements?.at(-1)?.hash || record.hash;
        if (last !== expectedHash) throw new Error('Replacement conflict');
        record.replacements = [...(record.replacements || []), replacement];
        await tx.run('UPDATE a423_transactions SET payload=? WHERE id=?', [JSON.stringify(record), id]);
      });
    },
    async reserveNonce(scope, minimum, operationId) {
      if (!Number.isSafeInteger(minimum) || minimum < 0) throw new TypeError('Invalid nonce');
      await ensure();
      return sqlTransaction(async (tx) => {
        const old = await tx.get<{ nonce: number }>(
          'SELECT nonce FROM a423_nonce_reservations WHERE scope=? AND operation_id=?',
          [scope, operationId],
        );
        if (old) return Number(old.nonce);
        const row = await tx.get<{ next_nonce: number }>('SELECT next_nonce FROM a423_nonces WHERE scope=?', [scope]);
        const nonce = Math.max(minimum, row?.next_nonce ?? 0);
        await tx.run(
          'INSERT INTO a423_nonces VALUES(?,?) ON CONFLICT(scope) DO UPDATE SET next_nonce=excluded.next_nonce',
          [scope, nonce + 1],
        );
        await tx.run('INSERT INTO a423_nonce_reservations VALUES(?,?,?)', [scope, operationId, nonce]);
        return nonce;
      });
    },
  };

  const queue: DurableQueue = {
    async enqueue({ id, kind, payload, availableAt = Date.now() }) {
      if (!id || !kind || !Number.isSafeInteger(availableAt)) throw new TypeError('Invalid queue item');
      await ensure();
      const result = await sqlRun(
        "INSERT OR IGNORE INTO a423_queue(id,kind,payload,status,available_at) VALUES(?,?,?,'ready',?)",
        [id, kind, JSON.stringify(payload), availableAt],
      );
      return result.changes > 0;
    },
    async claim({ kind, leaseMs = 30000, now = Date.now() }) {
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1 || !Number.isSafeInteger(now)) throw new TypeError('Invalid lease');
      await ensure();
      return sqlTransaction(async (tx) => {
        const row = await tx.get<Record<string, unknown>>(
          `SELECT * FROM a423_queue
            WHERE kind=? AND ((status='ready' AND available_at<=?) OR (status='leased' AND lease_until<=?))
            ORDER BY available_at,id LIMIT 1`,
          [kind, now, now],
        );
        if (!row) return null;
        const lease = randomUUID();
        await tx.run("UPDATE a423_queue SET status='leased',lease=?,lease_until=?,attempts=attempts+1 WHERE id=?", [
          lease,
          now + leaseMs,
          String(row.id),
        ]);
        return {
          id: String(row.id),
          kind: String(row.kind),
          payload: parse(row.payload),
          lease,
          attempts: Number(row.attempts) + 1,
          result: row.result ? parse(row.result) : null,
        } satisfies QueueItem;
      });
    },
    async heartbeat(id, lease, { leaseMs = 30000, now = Date.now() } = {}) {
      await ensure();
      const result = await sqlRun(
        "UPDATE a423_queue SET lease_until=? WHERE id=? AND lease=? AND status='leased' AND lease_until>?",
        [now + leaseMs, id, lease, now],
      );
      return result.changes > 0;
    },
    async checkpoint(id, lease, result, { now = Date.now() } = {}) {
      await ensure();
      const updated = await sqlRun(
        "UPDATE a423_queue SET result=? WHERE id=? AND lease=? AND status='leased' AND lease_until>?",
        [JSON.stringify(result), id, lease, now],
      );
      return updated.changes > 0;
    },
    async complete(id, lease, result, { now = Date.now() } = {}) {
      await ensure();
      const updated = await sqlRun(
        "UPDATE a423_queue SET status='done',result=? WHERE id=? AND lease=? AND status='leased' AND lease_until>?",
        [JSON.stringify(result), id, lease, now],
      );
      return updated.changes > 0;
    },
    async retry(id, lease, { delayMs = 1000, now = Date.now(), maxAttempts = 10 } = {}) {
      await ensure();
      const updated = await sqlRun(
        `UPDATE a423_queue SET status=CASE WHEN attempts>=? THEN 'failed' ELSE 'ready' END,
                available_at=?,lease=NULL,lease_until=0
          WHERE id=? AND lease=? AND status='leased' AND lease_until>?`,
        [maxAttempts, now + delayMs, id, lease, now],
      );
      return updated.changes > 0;
    },
    async get(id) {
      await ensure();
      const row = await sqlGet<Record<string, unknown>>('SELECT * FROM a423_queue WHERE id=?', [id]);
      if (!row) return null;
      return {
        id: String(row.id),
        kind: String(row.kind),
        payload: parse(row.payload),
        status: String(row.status),
        attempts: Number(row.attempts),
        result: row.result ? parse(row.result) : null,
      };
    },
  };

  const spending: SpendingStore = {
    async reserve({ id, scope, amount, perTransaction, daily, total, now = Date.now() }) {
      const value = (x: string) => {
        if (typeof x !== 'string' || !/^(0|[1-9][0-9]*)$/.test(x)) throw new TypeError('Use raw decimal amount strings');
        return BigInt(x);
      };
      const n = value(amount);
      const day = new Date(now).toISOString().slice(0, 10);
      if (!id || !scope) throw new TypeError('Spend identity/scope required');
      await ensure();
      return sqlTransaction(async (tx) => {
        const old = await tx.get<{ scope: string; amount: string }>('SELECT * FROM a423_spend WHERE id=?', [id]);
        if (old) {
          if (old.scope !== scope || old.amount !== amount) throw new Error('Spending idempotency conflict');
        }
        const rows = await tx.all<{ amount: string; day: string }>('SELECT amount,day FROM a423_spend WHERE scope=? AND id<>?', [scope, id]);
        const all = rows.reduce((acc, row) => acc + BigInt(row.amount), 0n);
        const today = rows.filter((row) => row.day === day).reduce((acc, row) => acc + BigInt(row.amount), 0n);
        if (perTransaction === undefined || daily === undefined || total === undefined) {
          throw new Error('Explicit per-transaction, daily and total caps required');
        }
        if (
          (perTransaction !== null && n > value(perTransaction))
          || (daily !== null && n + today > value(daily))
          || (total !== null && n + all > value(total))
        ) {
          const error = new Error('Spending limit exceeded') as Error & { code?: string };
          error.code = 'SPENDING_LIMIT_EXCEEDED';
          throw error;
        }
        await tx.run(
          'INSERT INTO a423_spend VALUES(?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET day=excluded.day,at=excluded.at',
          [id, scope, amount, day, now],
        );
        return true;
      });
    },
    async release(id) {
      await ensure();
      await sqlRun('DELETE FROM a423_spend WHERE id=?', [id]);
    },
  };

  return {
    jobs,
    transactions,
    queue,
    spending,
    kv,
    async resetDevelopmentData(options) {
      const { chainId, confirm, assertChainReset, includeAuthority = false, dryRun = true } = options;
      if (![1337, 31337].includes(chainId) || confirm !== 'RESET_LOCAL_A423' || typeof assertChainReset !== 'function' || await assertChainReset() !== true) {
        throw new Error('Reset requires confirmed local chain reset');
      }
      await ensure();
      const tables = ['a423_jobs', 'a423_events', 'a423_transactions', 'a423_nonces', 'a423_nonce_reservations', 'a423_queue', 'a423_spend'];
      const counts: Record<string, number> = {};
      for (const name of tables) {
        const row = await sqlGet<{ n: number }>(`SELECT COUNT(*) AS n FROM ${name}`);
        counts[name] = Number(row?.n ?? 0);
      }
      if (!dryRun) {
        await sqlTransaction(async (tx) => {
          for (const name of tables) await tx.run(`DELETE FROM ${name}`);
          if (includeAuthority) await tx.run('DELETE FROM a423_kv');
          else await tx.run("DELETE FROM a423_kv WHERE namespace NOT LIKE 'authority:%'");
        });
      }
      return { dryRun, counts, includeAuthority };
    },
    close() { /* shared libSQL client; closed by the process */ },
  } satisfies SqliteStorage;
}
