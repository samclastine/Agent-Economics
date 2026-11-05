import type { WorkflowJob } from '@allorc/a423-sdk/workflow';
import { getA423Bridge } from './bridge04';

/**
 * A submit operation without a result_hash can never execute. It is created if
 * an agent calls submit_job without an artifact commitment. Rejecting it is a
 * local recovery step; normal submissions are produced by the execution runner
 * and always carry a 32-byte result_hash.
 */
export function isMalformedPendingSubmit(job: WorkflowJob | null): boolean {
  if (!job?.pending || job.pending.action !== 'submit') return false;
  const input = job.pending.input as { result_hash?: unknown } | null;
  return typeof input?.result_hash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(input.result_hash);
}

export async function repairMalformedPendingSubmit(job: WorkflowJob): Promise<WorkflowJob> {
  const bridge = await getA423Bridge();
  const current = await bridge.storage.jobs.get(job.id);
  if (!current) throw new Error(`workflow ${job.id} not found`);
  if (!isMalformedPendingSubmit(current)) return current;
  const pending = current.pending!;
  // 0.8.1 provides an audited, adapter-proven recovery path. It only rejects
  // syntactically impossible submissions with no journal/on-chain evidence.
  return bridge.app.workflow.rejectPendingOperation(
    current.id,
    {
      operation_id: pending.id,
      reason: 'Invalid submit input: result_hash missing; execution runner submits artifacts',
    },
    { actor: pending.actor },
  );
}

export async function repairAllMalformedPendingSubmits(): Promise<string[]> {
  const bridge = await getA423Bridge();
  const jobs = await bridge.storage.jobs.list({ limit: 100 });
  const repaired: string[] = [];
  for (const job of jobs) {
    if (!isMalformedPendingSubmit(job)) continue;
    await repairMalformedPendingSubmit(job);
    repaired.push(job.id);
  }
  return repaired;
}
