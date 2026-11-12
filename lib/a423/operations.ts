import { createHash, randomUUID } from 'crypto';
import type { AdapterResult, Json, Operation } from '@allorc/a423-sdk/workflow';
import { sqlExec, sqlGet, sqlRun, sqlTransaction } from '@/lib/db/sql';

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

export async function ensureIntegrationSchema(): Promise<void> {
  await sqlExec(SCHEMA);
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

export async function getOperation(operationId: string): Promise<OperationRow | null> {
  const row = await sqlGet<Record<string, unknown>>('SELECT * FROM a423_operations WHERE operation_id = ?', [operationId]);
  return row ? rowToOperation(row) : null;
}

/**
 * Claim an operation for execution. New operations are inserted; an expired
 * lease can be re-claimed. A live lease returns `claimed: false` so callers
 * observe rather than resubmit. Adapters must still check the chain first.
 */
export async function claimOperation(
  operation: Operation,
  jobId: string,
  leaseMs = 120_000,
  now = Date.now(),
  force = false,
): Promise<{ row: OperationRow; claimed: boolean }> {
  const at = now;
  return sqlTransaction(async (tx) => {
    const inserted = await tx.run(
      `INSERT OR IGNORE INTO a423_operations
         (operation_id, job_id, action, actor, idempotency_key, status, provider_ref, evidence, attempts, lease_until, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'executing', '{}', NULL, 1, ?, ?, ?)`,
      [operation.id, jobId, operation.action, operation.actor, operation.key, at + leaseMs, at, at],
    );
    let claimed = inserted.changes === 1;
    if (!claimed) {
      const updated = force
        ? await tx.run(
            `UPDATE a423_operations
                SET status = 'executing', lease_until = ?, attempts = attempts + 1, updated_at = ?
              WHERE operation_id = ? AND status IN ('executing', 'pending')`,
            [at + leaseMs, at, operation.id],
          )
        : await tx.run(
            `UPDATE a423_operations
                SET status = 'executing', lease_until = ?, attempts = attempts + 1, updated_at = ?
              WHERE operation_id = ? AND status IN ('executing', 'pending')
                AND (lease_until IS NULL OR lease_until < ?)`,
            [at + leaseMs, at, operation.id, at],
          );
      claimed = updated.changes === 1;
    }
    const row = await tx.get<Record<string, unknown>>('SELECT * FROM a423_operations WHERE operation_id = ?', [operation.id]);
    if (!row) throw new Error(`operation ${operation.id} disappeared during claim`);
    return { row: rowToOperation(row), claimed };
  });
}

export async function updateOperation(
  operationId: string,
  patch: {
    status?: OperationRow['status'];
    providerRef?: Record<string, Json>;
    evidence?: AdapterResult;
    leaseUntil?: number | null;
  },
): Promise<void> {
  const current = await getOperation(operationId);
  if (!current) throw new Error(`unknown operation ${operationId}`);
  await sqlRun(
    `UPDATE a423_operations
        SET status = ?, provider_ref = ?, evidence = ?, lease_until = ?, updated_at = ?
      WHERE operation_id = ?`,
    [
      patch.status ?? current.status,
      JSON.stringify(patch.providerRef ?? current.provider_ref),
      patch.evidence === undefined ? (current.evidence ? JSON.stringify(current.evidence) : null) : JSON.stringify(patch.evidence),
      patch.leaseUntil === undefined ? current.lease_until : patch.leaseUntil,
      Date.now(),
      operationId,
    ],
  );
}

export async function mergeProviderRef(operationId: string, ref: Record<string, Json>): Promise<Record<string, Json>> {
  const current = await getOperation(operationId);
  if (!current) throw new Error(`unknown operation ${operationId}`);
  const merged = { ...current.provider_ref, ...ref };
  await sqlRun('UPDATE a423_operations SET provider_ref = ?, updated_at = ? WHERE operation_id = ?', [
    JSON.stringify(merged),
    Date.now(),
    operationId,
  ]);
  return merged;
}

export async function finalizeOperation(
  operationId: string,
  status: 'pending' | 'confirmed' | 'rejected',
  result: AdapterResult,
  retryAfterMs = 15_000,
): Promise<void> {
  const lease = status === 'pending' ? Date.now() + retryAfterMs : null;
  await sqlRun(
    `UPDATE a423_operations
        SET status = ?, evidence = ?, lease_until = ?, updated_at = ?
      WHERE operation_id = ?`,
    [status, JSON.stringify(result), lease, Date.now(), operationId],
  );
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

function rowToArtifact(row: Record<string, unknown>): WorkflowArtifact {
  return {
    id: String(row.id),
    job_id: String(row.job_id),
    agent_id: String(row.agent_id),
    path: String(row.path),
    mime: String(row.mime),
    content: row.content instanceof ArrayBuffer
      ? Buffer.from(row.content)
      : Buffer.from(row.content as Uint8Array),
    sha256: String(row.sha256),
    manifest: JSON.parse(String(row.manifest_json ?? '{}')) as Record<string, Json>,
    created_at: Number(row.created_at),
  };
}

export async function storeWorkflowArtifact(opts: {
  jobId: string;
  agentId: string;
  path: string;
  mime?: string;
  content: Buffer;
  manifest?: Record<string, Json>;
}): Promise<WorkflowArtifact> {
  const id = `art-${randomUUID()}`;
  const sha256 = createHash('sha256').update(opts.content).digest('hex');
  const mime = opts.mime ?? 'text/markdown';
  const manifest = opts.manifest ?? {};
  await sqlRun(
    `INSERT INTO a423_artifacts (id, job_id, agent_id, path, mime, content, sha256, manifest_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, opts.jobId, opts.agentId, opts.path, mime, opts.content, sha256, JSON.stringify(manifest), Date.now()],
  );
  const artifact = await getWorkflowArtifact(id);
  if (!artifact) throw new Error('artifact insert did not persist');
  return artifact;
}

export async function getLatestWorkflowArtifact(jobId: string): Promise<WorkflowArtifact | null> {
  const row = await sqlGet<Record<string, unknown>>(
    'SELECT * FROM a423_artifacts WHERE job_id = ? ORDER BY created_at DESC LIMIT 1',
    [jobId],
  );
  return row ? rowToArtifact(row) : null;
}

export async function getWorkflowArtifact(id: string): Promise<WorkflowArtifact | null> {
  const row = await sqlGet<Record<string, unknown>>('SELECT * FROM a423_artifacts WHERE id = ?', [id]);
  return row ? rowToArtifact(row) : null;
}
