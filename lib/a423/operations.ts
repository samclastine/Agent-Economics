import { createHash, randomUUID } from 'crypto';
import type { AdapterResult, Json, Operation } from '@allorc/a423-sdk/workflow';
import { getSqlite } from '@/lib/db/client';

/**
 * Durable provider-operation ledger. `operation_id` is the SDK's stable id;
 * it is the deduplication key for every effect, across retries and crashes.
 * Transaction identifiers are written here BEFORE the adapter waits.
 */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS a423_operations (
  operation_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  action TEXT NOT NULL,
  actor TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  status TEXT NOT NULL,
  provider_ref TEXT NOT NULL DEFAULT '{}',
  evidence TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS a423_operations_job_idx ON a423_operations(job_id, action);
CREATE TABLE IF NOT EXISTS a423_runs (
  run_key TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'queued',
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  started_at INTEGER,
  finished_at INTEGER
);
CREATE INDEX IF NOT EXISTS a423_runs_status_idx ON a423_runs(status);
CREATE TABLE IF NOT EXISTS a423_artifacts (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  agent_id TEXT NOT NULL,
  path TEXT NOT NULL,
  mime TEXT NOT NULL DEFAULT 'text/markdown',
  content BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  manifest_json TEXT NOT NULL DEFAULT '{}',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS a423_artifacts_job_idx ON a423_artifacts(job_id);
`;

export function ensureIntegrationSchema(): void {
  getSqlite().exec(SCHEMA);
}

export type OperationRow = {
  operation_id: string;
  job_id: string;
  action: string;
  actor: string;
  idempotency_key: string;
  status: 'executing' | 'pending' | 'confirmed' | 'rejected';
  provider_ref: Record<string, Json>;
  evidence: AdapterResult | null;
  attempts: number;
  lease_until: number | null;
  created_at: number;
  updated_at: number;
};

function rowToOperation(row: Record<string, unknown>): OperationRow {
  return {
    operation_id: String(row.operation_id),
    job_id: String(row.job_id),
    action: String(row.action),
    actor: String(row.actor),
    idempotency_key: String(row.idempotency_key),
    status: row.status as OperationRow['status'],
    provider_ref: JSON.parse(String(row.provider_ref ?? '{}')) as Record<string, Json>,
    evidence: row.evidence ? (JSON.parse(String(row.evidence)) as AdapterResult) : null,
    attempts: Number(row.attempts ?? 0),
    lease_until: row.lease_until == null ? null : Number(row.lease_until),
    created_at: Number(row.created_at),
    updated_at: Number(row.updated_at),
  };
}

export function getOperation(operationId: string): OperationRow | null {
  const row = getSqlite().prepare('SELECT * FROM a423_operations WHERE operation_id = ?').get(operationId) as
    | Record<string, unknown>
    | undefined;
  return row ? rowToOperation(row) : null;
}

/**
 * Claim an operation for execution. New operations are inserted; an expired
 * lease can be re-claimed. A live lease returns `claimed: false` so callers
 * observe rather than resubmit. Adapters must still check the chain first.
 */
export function claimOperation(
  operation: Operation,
  jobId: string,
  leaseMs = 120_000,
  now = Date.now(),
  force = false,
): { row: OperationRow; claimed: boolean } {
  const sqlite = getSqlite();
  const at = now;
  const inserted = sqlite.prepare(
    `INSERT OR IGNORE INTO a423_operations
       (operation_id, job_id, action, actor, idempotency_key, status, provider_ref, evidence, attempts, lease_until, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'executing', '{}', NULL, 1, ?, ?, ?)`,
  ).run(
    operation.id,
    jobId,
    operation.action,
    operation.actor,
    operation.key,
    at + leaseMs,
    at,
    at,
  );
  if (inserted.changes === 0) {
    const updated = force
      ? sqlite.prepare(
          `UPDATE a423_operations
              SET status = 'executing', lease_until = ?, attempts = attempts + 1, updated_at = ?
            WHERE operation_id = ? AND status IN ('executing', 'pending')`,
        ).run(at + leaseMs, at, operation.id)
      : sqlite.prepare(
          `UPDATE a423_operations
              SET status = 'executing', lease_until = ?, attempts = attempts + 1, updated_at = ?
            WHERE operation_id = ? AND status IN ('executing', 'pending')
              AND (lease_until IS NULL OR lease_until < ?)`,
        ).run(at + leaseMs, at, operation.id, at);
    if (updated.changes === 1) {
      return { row: getOperation(operation.id)!, claimed: true };
    }
  }
  return { row: getOperation(operation.id)!, claimed: inserted.changes === 1 };
}

export function updateOperation(
  operationId: string,
  patch: {
    status?: OperationRow['status'];
    providerRef?: Record<string, Json>;
    evidence?: AdapterResult;
    leaseUntil?: number | null;
  },
): void {
  const current = getOperation(operationId);
  if (!current) throw new Error(`unknown operation ${operationId}`);
  getSqlite().prepare(
    `UPDATE a423_operations
        SET status = ?, provider_ref = ?, evidence = ?, lease_until = ?, updated_at = ?
      WHERE operation_id = ?`,
  ).run(
    patch.status ?? current.status,
    JSON.stringify(patch.providerRef ?? current.provider_ref),
    patch.evidence === undefined ? (current.evidence ? JSON.stringify(current.evidence) : null) : JSON.stringify(patch.evidence),
    patch.leaseUntil === undefined ? current.lease_until : patch.leaseUntil,
    Date.now(),
    operationId,
  );
}

export function mergeProviderRef(operationId: string, ref: Record<string, Json>): Record<string, Json> {
  const current = getOperation(operationId);
  if (!current) throw new Error(`unknown operation ${operationId}`);
  const merged = { ...current.provider_ref, ...ref };
  getSqlite().prepare('UPDATE a423_operations SET provider_ref = ?, updated_at = ? WHERE operation_id = ?')
    .run(JSON.stringify(merged), Date.now(), operationId);
  return merged;
}

export function finalizeOperation(
  operationId: string,
  status: 'pending' | 'confirmed' | 'rejected',
  result: AdapterResult,
  retryAfterMs = 15_000,
): void {
  const lease = status === 'pending' ? Date.now() + retryAfterMs : null;
  getSqlite().prepare(
    `UPDATE a423_operations
        SET status = ?, evidence = ?, lease_until = ?, updated_at = ?
      WHERE operation_id = ?`,
  ).run(status, JSON.stringify(result), lease, Date.now(), operationId);
}

// ---------------------------------------------------------------------------
// Durable execution queue (the app executes work; the SDK never does)
// ---------------------------------------------------------------------------

export type RunRow = {
  run_key: string;
  job_id: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  attempts: number;
  error: string | null;
  created_at: number;
  started_at: number | null;
  finished_at: number | null;
};

export function enqueueRun(runKey: string, jobId: string): { row: RunRow; created: boolean } {
  const sqlite = getSqlite();
  const now = Date.now();
  const inserted = sqlite.prepare(
    'INSERT OR IGNORE INTO a423_runs (run_key, job_id, status, attempts, created_at) VALUES (?, ?, \'queued\', 1, ?)',
  ).run(runKey, jobId, now);
  if (inserted.changes === 0) {
    // A failed run may be retried by a new start action; dedupe the run key but
    // reset the row. A queued/running/done run is reused unchanged.
    sqlite.prepare(
      `UPDATE a423_runs SET status = 'queued', error = NULL, finished_at = NULL,
              attempts = attempts + 1, created_at = ?
        WHERE run_key = ? AND status = 'failed'`,
    ).run(now, runKey);
  }
  const row = sqlite.prepare('SELECT * FROM a423_runs WHERE run_key = ?').get(runKey) as Record<string, unknown>;
  return {
    row: {
      run_key: String(row.run_key),
      job_id: String(row.job_id),
      status: row.status as RunRow['status'],
      attempts: Number(row.attempts),
      error: row.error == null ? null : String(row.error),
      created_at: Number(row.created_at),
      started_at: row.started_at == null ? null : Number(row.started_at),
      finished_at: row.finished_at == null ? null : Number(row.finished_at),
    },
    created: inserted.changes === 1,
  };
}

export function getRun(runKey: string): RunRow | null {
  const row = getSqlite().prepare('SELECT * FROM a423_runs WHERE run_key = ?').get(runKey) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    run_key: String(row.run_key),
    job_id: String(row.job_id),
    status: row.status as RunRow['status'],
    attempts: Number(row.attempts),
    error: row.error == null ? null : String(row.error),
    created_at: Number(row.created_at),
    started_at: row.started_at == null ? null : Number(row.started_at),
    finished_at: row.finished_at == null ? null : Number(row.finished_at),
  };
}

export function claimQueuedRuns(limit = 10): RunRow[] {
  const sqlite = getSqlite();
  const rows = sqlite.prepare(
    `SELECT * FROM a423_runs WHERE status = 'queued' ORDER BY created_at ASC LIMIT ?`,
  ).all(limit) as Record<string, unknown>[];
  const now = Date.now();
  for (const row of rows) {
    sqlite.prepare(
      `UPDATE a423_runs SET status = 'running', started_at = ?, attempts = attempts + 1
        WHERE run_key = ? AND status = 'queued'`,
    ).run(now, row.run_key);
  }
  return rows.map((row) => ({
    run_key: String(row.run_key),
    job_id: String(row.job_id),
    status: 'running' as const,
    attempts: Number(row.attempts) + 1,
    error: null,
    created_at: Number(row.created_at),
    started_at: now,
    finished_at: null,
  }));
}

export function finishRun(runKey: string, status: 'done' | 'failed', error?: string): void {
  getSqlite().prepare(
    'UPDATE a423_runs SET status = ?, error = ?, finished_at = ? WHERE run_key = ?',
  ).run(status, error ?? null, Date.now(), runKey);
}

// ---------------------------------------------------------------------------
// Artifact bytes (content-addressed by SHA-256, stored as BLOB)
// ---------------------------------------------------------------------------

export type WorkflowArtifact = {
  id: string;
  job_id: string;
  agent_id: string;
  path: string;
  mime: string;
  content: Buffer;
  sha256: string;
  manifest: Record<string, Json>;
  created_at: number;
};

export function storeWorkflowArtifact(opts: {
  jobId: string;
  agentId: string;
  path: string;
  mime?: string;
  content: Buffer;
  manifest?: Record<string, Json>;
}): WorkflowArtifact {
  const id = `art-${randomUUID()}`;
  const sha256 = createHash('sha256').update(opts.content).digest('hex');
  const mime = opts.mime ?? 'text/markdown';
  const manifest = opts.manifest ?? {};
  getSqlite().prepare(
    `INSERT INTO a423_artifacts (id, job_id, agent_id, path, mime, content, sha256, manifest_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, opts.jobId, opts.agentId, opts.path, mime, opts.content, sha256, JSON.stringify(manifest), Date.now());
  return getWorkflowArtifact(id)!;
}

export function getLatestWorkflowArtifact(jobId: string): WorkflowArtifact | null {
  const row = getSqlite().prepare(
    'SELECT * FROM a423_artifacts WHERE job_id = ? ORDER BY created_at DESC LIMIT 1',
  ).get(jobId) as Record<string, unknown> | undefined;
  return row ? getWorkflowArtifact(String(row.id)) : null;
}

export function getWorkflowArtifact(id: string): WorkflowArtifact | null {
  const row = getSqlite().prepare('SELECT * FROM a423_artifacts WHERE id = ?').get(id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    job_id: String(row.job_id),
    agent_id: String(row.agent_id),
    path: String(row.path),
    mime: String(row.mime),
    content: Buffer.from(row.content as Buffer),
    sha256: String(row.sha256),
    manifest: JSON.parse(String(row.manifest_json ?? '{}')) as Record<string, Json>,
    created_at: Number(row.created_at),
  };
}
