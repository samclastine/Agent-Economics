/**
 * Durable A423 0.9 worker: evidence monitoring, maintenance (reconcile + explicit
 * resume), execution queue, and challenge pruning. Run under a process manager.
 */
import 'dotenv/config';
import {
  createWebhookDispatcher,
  enqueueRunningJobs,
  runExecutionOnce,
  runMaintenanceOnce,
  watchEvidenceOnce,
} from '@allorc/a423-sdk/operations';
import { createEscrowIndexer } from '@allorc/a423-sdk/escrow';
import { getA423Bridge } from './bridge04';
import { repairAllMalformedPendingSubmits } from './pending';
import { sqlAll, sqlRun } from '@/lib/db/sql';

const debug = process.env.A423_WORKER_DEBUG === '1';
const STAGE_TIMEOUT_MS = Number(process.env.A423_WORKER_STAGE_TIMEOUT_MS ?? 30_000);
const EXECUTION_TIMEOUT_MS = Number(process.env.A423_WORKER_EXECUTION_TIMEOUT_MS ?? 300_000);
/**
 * Keep one stalled SDK/RPC call from freezing the whole worker. The underlying
 * promise is not force-cancelled, but the tick can move on and retry later.
 */
async function stage<T>(name: string, fn: () => Promise<T>, timeoutMs = STAGE_TIMEOUT_MS): Promise<T | undefined> {
  const started = Date.now();
  if (debug) console.log('[a423-worker] stage start', name);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const value = await Promise.race([
      fn(),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${name} timed out after ${timeoutMs}ms`)), timeoutMs);
      }),
    ]);
    if (debug) console.log('[a423-worker] stage done', name, `${Date.now() - started}ms`);
    return value;
  } catch (error) {
    console.error('[a423-worker] stage failed', name, error instanceof Error ? error.message : String(error));
    return undefined;
  } finally {
    if (timer) clearTimeout(timer);
  }
}


/**
 * A cancelled/paused job can leave a ready execution item behind. The SDK
 * execution runner correctly refuses to work on a non-running job, but the
 * stale item would otherwise be retried ten times and delay live work. Remove
 * only execution items whose parent workflow is no longer running.
 */
async function pruneStaleExecutionQueue(): Promise<number> {
  let removed = 0;
  try {
    const rows = await sqlAll<{ id: string; payload: string }>(
      "SELECT id, payload FROM a423_queue WHERE kind='execution' AND status IN ('ready','leased')",
    );
    for (const row of rows) {
      let jobId: string | null = null;
      try {
        jobId = (JSON.parse(row.payload) as { job_id?: string }).job_id ?? null;
      } catch { /* malformed queue rows are safe to discard */ }
      if (!jobId) {
        await sqlRun('DELETE FROM a423_queue WHERE id=?', [row.id]);
        removed += 1;
        continue;
      }
      const job = await sqlAll<{ payload: string }>('SELECT payload FROM a423_jobs WHERE id=?', [jobId]);
      if (job.length === 0) {
        await sqlRun('DELETE FROM a423_queue WHERE id=?', [row.id]);
        removed += 1;
        continue;
      }
      const state = (JSON.parse(job[0].payload) as { state?: string }).state;
      if (state !== 'running') {
        await sqlRun('DELETE FROM a423_queue WHERE id=?', [row.id]);
        removed += 1;
      }
    }
  } catch (error) {
    console.error('[a423-worker] queue prune failed', error instanceof Error ? error.message : String(error));
  }
  return removed;
}

async function notifySubmitted(bridge: Awaited<ReturnType<typeof getA423Bridge>>, jobId: string): Promise<void> {
  const job = await bridge.storage.jobs.get(jobId);
  if (!job || job.state !== 'submitted' || job.pending) return;
  if (job.participants.verifier === job.participants.worker) return;
  const submission = job.submission as { result_hash?: string } | null;
  const key = `${job.id}:${submission?.result_hash ?? job.version}`;
  if (await bridge.storage.kv.get('a423:submit-notified', key)) return;
  await bridge.storage.kv.put('a423:submit-notified', key, { at: new Date().toISOString() });
  const { sendPeerMessage } = await import('@/lib/agents/peer');
  void sendPeerMessage({
    fromAgentId: job.participants.worker,
    toAgentId: job.participants.verifier,
    jobId: job.id,
    text: `WORK SUBMITTED on ${job.id}. The artifact commitment is on-chain. `
      + `Verify the artifact and release payment with a423_job_action.`,
  }).catch((error) => {
    console.warn('[a423-worker] submit notification failed:', error instanceof Error ? error.message : String(error));
  });
}


async function notifyCancellationComplete(bridge: Awaited<ReturnType<typeof getA423Bridge>>, jobId: string): Promise<void> {
  const job = await bridge.storage.jobs.get(jobId);
  if (!job) return;
  const subflow = (job.subflows ?? []).find((item) => item.kind === 'cancellation');
  if (!subflow?.receipt || subflow.status !== 'completed') return;
  const key = `a423:cancel-notified:${subflow.receipt.id}`;
  if (await bridge.storage.kv.get('a423:cancel-notified', key)) return;
  await bridge.storage.kv.put('a423:cancel-notified', key, { at: new Date().toISOString() });
  const { sendPeerMessage } = await import('@/lib/agents/peer');
  void sendPeerMessage({
    fromAgentId: job.participants.worker,
    toAgentId: job.participants.requester,
    jobId: job.id,
    text: `CANCELLATION SETTLED on ${job.id}. The final cancellation receipt is confirmed; acceptance alone was not payment. `
      + `Read /api/a423/jobs/${job.id}/cancellation/receipt or the dashboard receipt for the actual worker/payer allocations.`,
  }).catch((error) => {
    console.warn('[a423-worker] cancellation notification failed:', error instanceof Error ? error.message : String(error));
  });
}

export async function runWorkerTick() {
  const bridge = await stage('bridge', () => getA423Bridge());
  if (!bridge) return;
  const app = bridge.app.applicationOptions;
  const worker = bridge.app.workerOptions;

  const repaired = await stage('repair', () => repairAllMalformedPendingSubmits());
  if (repaired?.length) console.log('[a423-worker] rejected malformed pending submits', repaired.join(', '));
  if (process.env.A423_EVIDENCE_REVALIDATION === 'off') {
    if (debug) console.log('[a423-worker] evidence revalidation disabled');
  } else {
    await stage('evidence', () => watchEvidenceOnce({ store: app.store, revalidate: app.revalidate }));
  }
  const maintenance = await stage('maintenance', () => runMaintenanceOnce({
    workflow: app.workflow,
    store: app.store,
    actorFor: worker.actorFor,
    allowExecute: worker.allowExecute === true,
  }));
  for (const result of maintenance ?? []) {
    if (result.error) console.error('[a423-worker] maintenance failed', result.id, result.error);
    else {
      if (result.state === 'submitted' && !result.pending) await stage(`notify-submitted:${result.id}`, () => notifySubmitted(bridge, result.id));
      if (result.state === 'settled' && !result.pending) await stage(`notify-settled:${result.id}`, () => notifyCancellationComplete(bridge, result.id));
    }
  }

  const pruned = await pruneStaleExecutionQueue();
  if (pruned > 0) console.log('[a423-worker] pruned stale execution queue items', pruned);
  await stage('enqueue', () => enqueueRunningJobs({ store: app.store, queue: app.queue }));
  if (typeof worker.execute === 'function') {
    const job = await stage('execution', () => runExecutionOnce({
      workflow: app.workflow,
      queue: app.queue,
      execute: worker.execute,
      beforeExecute: worker.beforeExecute,
      canContinue: worker.canContinue,
      leaseMs: 120_000,
    }), EXECUTION_TIMEOUT_MS);
    if (job) {
      console.log('[a423-worker] execution submitted', job.id, job.state);
      await stage(`notify-executed:${job.id}`, () => notifySubmitted(bridge, job.id));
    }
  }
  const indexer = createEscrowIndexer({
    provider: bridge.provider,
    chainId: bridge.chainId,
    contractAddress: bridge.escrowAddress,
    confirmations: bridge.confirmations,
    fromBlock: Number(process.env.A423_INDEX_FROM_BLOCK ?? 0),
    kv: bridge.storage.kv,
    onEvent: async (event) => { console.log('[a423-index]', event.event, event.transaction_hash); },
    onReorg: async (info) => { console.warn('[a423-index] reorg', info); },
  });
  await stage('indexer', () => indexer());

  const subscriptions = process.env.A423_WEBHOOK_SUBSCRIPTIONS
    ? (JSON.parse(process.env.A423_WEBHOOK_SUBSCRIPTIONS) as Array<{ id: string; actor: string; url: string; after?: number }>)
    : [];
  if (subscriptions.length > 0) {
    await stage('webhooks', async () => {
      const secrets = JSON.parse(process.env.A423_WEBHOOK_SECRETS ?? '{}') as Record<string, string>;
      const webhooks = createWebhookDispatcher({
        queue: bridge.storage.queue,
        kv: bridge.storage.kv,
        subscriptions,
        secretFor: async (id) => {
          const secret = secrets[id];
          if (!secret || secret.length < 32) throw new Error(`webhook secret for ${id} missing/too short`);
          return secret;
        },
      });
      await webhooks.project(bridge.storage.jobs);
      for (let i = 0; i < 10; i++) if (!await webhooks.deliverOne()) break;
    });
  }

  await stage('challenges', () => bridge.authority.pruneChallenges());
}
