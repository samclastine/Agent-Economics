import { tool } from '@langchain/core/tools';
import { z } from 'zod';
import { getDb } from '@/lib/db/client';
import { agents, agentWallets } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { publicClient, getTokenMeta } from '@/lib/chain/config';
import { ERC20_ABI } from '@/lib/chain/abis';
import { sendPeerMessage } from '@/lib/agents/peer';
import { summarizeA423Job } from '@/lib/a423/summary';
import { getWorkMeterForProjection } from '@/lib/a423/work-meter';
import type { WorkflowJob } from '@allorc/a423-sdk/workflow';
import { chatToolCall } from '@/lib/a423/chat04';
import type { Address } from 'viem';

const STATUS_COOLDOWN_MS = 5000;
const WAIT_WINDOW_MS = 15_000;
const WAIT_REENTRY_MS = 15_000;
const lastStatusAt = new Map<string, number>();
const lastWaitAt = new Map<string, number>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isWorkflowJob(value: unknown): value is WorkflowJob {
  return !!value && typeof value === 'object'
    && typeof (value as { id?: unknown }).id === 'string'
    && typeof (value as { state?: unknown }).state === 'string'
    && !!(value as { participants?: unknown }).participants;
}

async function walletSummary(agentId: string) {
  const db = getDb();
  const wallet = await db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, agentId) });
  const meta = await getTokenMeta();
  let tokenBalance = '0';
  let ethBalance = '0';
  if (wallet) {
    try {
      const pc = publicClient();
      const [bal, eth] = await Promise.all([
        pc.readContract({
          address: meta.address,
          abi: ERC20_ABI,
          functionName: 'balanceOf',
          args: [wallet.address as Address],
        }).catch(() => 0n),
        pc.getBalance({ address: wallet.address as Address }),
      ]);
      tokenBalance = bal.toString();
      ethBalance = eth.toString();
    } catch { /* chain may be down */ }
  }
  return {
    address: wallet?.address ?? null,
    tokenBalanceRaw: tokenBalance,
    tokenSymbol: meta.symbol,
    ethBalanceWei: ethBalance,
    paused: wallet?.paused ?? false,
    note: 'Escrowed and pending amounts are not spendable.',
  };
}

export function buildTools(agentId: string) {
  const getWallet = tool(
    async () => JSON.stringify(await walletSummary(agentId)),
    {
      name: 'get_wallet',
      description: 'Read my wallet balances: spendable token balance and native gas balance.',
      schema: z.object({}),
    },
  );

  const messageAgent = tool(
    async ({ toAgentId, text, jobId }) => {
      void sendPeerMessage({ fromAgentId: agentId, toAgentId, text, jobId: jobId ?? null }).catch(() => undefined);
      return JSON.stringify({ sent: true, toAgentId });
    },
    {
      name: 'message_agent',
      description: 'Send a marketplace message to another agent (negotiation, questions, status). Their agent session is triggered and their reply comes back to you automatically.',
      schema: z.object({
        toAgentId: z.string().uuid(),
        text: z.string().min(1),
        jobId: z.string().uuid().optional(),
      }),
    },
  );

  const a423Action = tool(
    async ({ action, job_id, input, idempotency_key }) => {
      try {
        const payload = {
          ...(input ?? {}),
          ...(job_id ? { job_id } : {}),
          ...(idempotency_key ? { idempotency_key } : {}),
        };
        const result = await chatToolCall(agentId, action, payload);
        // Keep the model's context small and put the exact workflow ID first.
        if (isWorkflowJob(result)) return JSON.stringify(summarizeA423Job(result, agentId));
        return JSON.stringify(result);
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
    },
    {
      name: 'a423_job_action',
      description: 'A423 0.9 workflow action. The actor is bound server-side; never pass actor IDs. If you do not know the workflow ID, call a423_list_jobs FIRST — never guess an ID. The workflow ID is the id returned by a423_list_jobs/send_job_offer, not the task.id. Put all action arguments inside input, including job_id. New offers: send_job_offer with worker_id, description, usdCents, taskType, artifactPath. Worker: respond_to_offer (decision=accept|reject|counter). Either party: counter_offer. Then accept_job_offer, sign_worker_consent (worker, server-side signing), fund_escrow (requester), work_on_job (worker, after funding), verify_job, release_escrow, refund_escrow, dispute_job, resolve_job, timeout_job, cancel_job. submit_job is only for an explicit 32-byte result_hash; the normal execution runner submits the artifact after work_on_job. Cancellation subflow: propose_settlement or counter_settlement with worker_amount (raw units), expected_revision, expires_at, reason, claims; both parties sign sign_cancellation_consent; then accept_cancellation; the keeper forwards and the final cancellation receipt is only available after confirmed execution. execute_cancellation can forward the accepted instruction explicitly. accept_settlement remains the direct dual-signature settlement. Work pauses during settlement_negotiation.',
      schema: z.object({
        action: z.enum(['send_job_offer','respond_to_offer','counter_offer','accept_job_offer','decline_job_offer','sign_worker_consent','propose_quote','accept_quote','fund_escrow','work_on_job','submit_job','verify_job','release_escrow','refund_escrow','dispute_job','resolve_job','timeout_job','cancel_job','propose_settlement','counter_settlement','accept_settlement','sign_cancellation_consent','accept_cancellation','execute_cancellation','request_cancellation']),
        job_id: z.string().optional(),
        input: z.record(z.string(), z.unknown()).optional(),
        idempotency_key: z.string().optional(),
      }),
    },
  );

  const a423Status = tool(
    async ({ job_id }) => {
      try {
        const { getA423Bridge } = await import('@/lib/a423/bridge04');
        const bridge = await getA423Bridge();
        const job = await bridge.app.workflow.get(job_id, agentId);
        const escrow = (job.agreement?.terms as Record<string, unknown> | undefined)?.escrow as Record<string, unknown> | undefined;
        const workDeadline = Number(escrow?.work_deadline);
        let deadlinePassed = false;
        if (job.state === 'running' && Number.isFinite(workDeadline)) {
          const pending = await bridge.provider.getBlock('pending');
          deadlinePassed = (pending?.timestamp ?? Math.floor(Date.now() / 1000)) >= workDeadline;
        }
        const statusKey = `${agentId}:${job_id}`;
        if (job.state === 'running' && !deadlinePassed) {
          const last = lastStatusAt.get(statusKey) ?? 0;
          const elapsed = Date.now() - last;
          if (elapsed < STATUS_COOLDOWN_MS) await sleep(STATUS_COOLDOWN_MS - elapsed);
          lastStatusAt.set(statusKey, Date.now());
        } else {
          lastStatusAt.delete(statusKey);
        }
        const meter = await getWorkMeterForProjection(job);
        const profit = await bridge.app.applicationOptions.profitFor?.(job, agentId) ?? null;
        const summary = summarizeA423Job(job, agentId, meter, profit);
        return JSON.stringify({
          ...summary,
          work_deadline_passed: deadlinePassed,
          next: deadlinePassed
            ? job.participants.worker === agentId
              ? 'work deadline passed; submit and settlement proposals are no longer accepted; notify the requester to refund'
              : job.participants.requester === agentId
                ? 'work deadline passed; refund the escrow with action="refund_escrow"'
                : 'work deadline passed; the requester should refund'
            : summary.next,
          poll_after_ms: null,
          note: deadlinePassed
            ? 'Do not poll; the requester should refund, or the worker should notify the requester.'
            : job.state === 'running'
              ? 'One status read is enough. Do not poll; call a423_wait_for_job at most once if you are the worker, or wait for marketplace mail.'
              : 'State is settled for this turn. Report it and stop.',
        });
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
    },
    { name: 'a423_job_status', description: 'Read one A423 workflow by its exact workflow ID (participant only): state, role, revision, accepted_by, price, deadlines, transactions and next action. If you do not have the ID, call a423_list_jobs first.', schema: z.object({ job_id: z.string() }) },
  );

  const acceptJobOffer = tool(
    async ({ job_id }) => {
      try {
        const result = await chatToolCall(agentId, 'accept_job_offer', { job_id });
        return isWorkflowJob(result) ? JSON.stringify(summarizeA423Job(result, agentId)) : JSON.stringify(result);
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
    },
    {
      name: 'accept_job_offer',
      description: 'Accept the current A423 agreement revision for this agent. This is a real tool: call it directly with the exact job_id. It is equivalent to a423_job_action with action="accept_job_offer". Never merely narrate a tool call; emit the tool call.',
      schema: z.object({ job_id: z.string() }),
    },
  );

  const a423WaitForJob = tool(
    async ({ job_id }) => {
      try {
        const { getA423Bridge } = await import('@/lib/a423/bridge04');
        const bridge = await getA423Bridge();
        const key = `${agentId}:${job_id}`;
        let job = await bridge.app.workflow.get(job_id, agentId);
        const escrow = (job.agreement?.terms as Record<string, unknown> | undefined)?.escrow as Record<string, unknown> | undefined;
        const workDeadline = Number(escrow?.work_deadline);
        const chainNow = async () => {
          const pending = await bridge.provider.getBlock('pending');
          return pending?.timestamp ?? Math.floor(Date.now() / 1000);
        };
        let deadlinePassed = job.state === 'running' && Number.isFinite(workDeadline)
          ? (await chainNow()) >= workDeadline
          : false;

        const summarize = async (extra: Record<string, unknown>) => {
          const meter = await getWorkMeterForProjection(job);
          const profit = await bridge.app.applicationOptions.profitFor?.(job, agentId) ?? null;
          return JSON.stringify({
            ...summarizeA423Job(job, agentId, meter, profit),
            waited_ms: 0,
            work_deadline_passed: deadlinePassed,
            poll_after_ms: null,
            ...extra,
          });
        };

        if (deadlinePassed) {
          lastWaitAt.set(key, Date.now());
          return summarize({
            code: 'WORK_DEADLINE_PASSED',
            note: job.participants.worker === agentId
              ? 'Work deadline passed. Submit and settlement proposals are no longer accepted; notify the requester to refund. Do not call this tool again and do not poll.'
              : 'Work deadline passed. The requester should refund. Do not call this tool again and do not poll.',
          });
        }

        const running = job.state === 'running' || !!job.pending;
        if (!running) {
          lastWaitAt.delete(key);
          return summarize({
            code: 'WAIT_ALREADY_COMPLETED',
            note: `Job is already ${job.state}; no wait was needed. Do not call this tool again this turn. Report the state and stop.`,
          });
        }

        const now = Date.now();
        const previous = lastWaitAt.get(key) ?? 0;
        if (now - previous < WAIT_REENTRY_MS) {
          return summarize({
            code: 'WAIT_ALREADY_COMPLETED',
            retry_after_ms: WAIT_REENTRY_MS - (now - previous),
            note: 'A wait for this job already ran in the last 15 seconds. Do not call this tool again this turn; report the current state and stop.',
          });
        }

        const startedAt = Date.now();
        lastWaitAt.set(key, startedAt);
        while (job.state === 'running' || !!job.pending) {
          if (job.state === 'running' && Number.isFinite(workDeadline)) {
            deadlinePassed = (await chainNow()) >= workDeadline;
            if (deadlinePassed) break;
          }
          if (Date.now() - startedAt >= WAIT_WINDOW_MS) break;
          await sleep(1500);
          job = await bridge.app.workflow.get(job_id, agentId);
        }

        const waited = Date.now() - startedAt;
        const stillRunning = job.state === 'running' || !!job.pending;
        lastWaitAt.set(key, Date.now());
        return summarize({
          waited_ms: waited,
          code: deadlinePassed ? 'WORK_DEADLINE_PASSED' : stillRunning ? 'WAIT_TIMED_OUT' : 'WAIT_COMPLETED',
          note: deadlinePassed
            ? job.participants.worker === agentId
              ? 'Work deadline passed. Submit and settlement proposals are no longer accepted; notify the requester to refund. Do not poll.'
              : 'Work deadline passed. The requester should refund. Do not poll.'
            : stillRunning
              ? 'Job is still running after a bounded 15 second wait. Do not poll; report progress and end this turn. Wait for marketplace mail or a new user message.'
              : 'Wait completed. Report the resulting state. Do not call this tool or a423_job_status again this turn.',
        });
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
    },
    {
      name: 'a423_wait_for_job',
      description: 'Wait at most 15 seconds for a running A423 job to leave the running state (submitted, settled, refunded, expired, etc.). Call at most once per turn and pass ONLY job_id; this tool has no until or timeout_ms parameters. If the result code is WAIT_ALREADY_COMPLETED, WAIT_TIMED_OUT, or WORK_DEADLINE_PASSED, do not call it again and do not poll a423_job_status — report and stop.',
      schema: z.object({ job_id: z.string() }),
    },
  );

  const a423ListJobs = tool(
    async ({ status, limit }) => {
      try {
        const { getA423Bridge } = await import('@/lib/a423/bridge04');
        const bridge = await getA423Bridge();
        const rows = await bridge.storage.jobs.list({ actor: agentId, limit: Math.min(Math.max(limit ?? 10, 1), 50) });
        const filtered = status && status !== 'all' ? rows.filter((job) => job.state === status) : rows;
        const sorted = [...filtered].sort((a, b) => Date.parse(b.updated_at ?? b.created_at ?? '') - Date.parse(a.updated_at ?? a.created_at ?? ''));
        const selected = sorted.slice(0, 25);
        const [meters, profits] = await Promise.all([
          Promise.all(selected.map(async (job) => {
            try { return await getWorkMeterForProjection(job); } catch { return null; }
          })),
          Promise.all(selected.map(async (job) => {
            try { return await bridge.app.applicationOptions.profitFor?.(job, agentId) ?? null; } catch { return null; }
          })),
        ]);
        return JSON.stringify(selected.map((job, index) => summarizeA423Job(job, agentId, meters[index], profits[index])));
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
    },
    {
      name: 'a423_list_jobs',
      description: 'List your A423 workflows with the exact workflow ID, state, your role, price, accepted_by, pending action and next step. Call this FIRST whenever you do not know the job ID or the user says "the job"/"the offer". The workflow ID is the `id` field — never use task.id or guess an ID.',
      schema: z.object({
        status: z.string().optional(),
        limit: z.number().int().min(1).max(50).optional(),
      }),
    },
  );

  const a423Policy = tool(
    async ({ job_id }) => {
      try {
        const { getA423Bridge } = await import('@/lib/a423/bridge04');
        const bridge = await getA423Bridge();
        if (!bridge.app.profit) return JSON.stringify({ error: 'profit policy not configured' });
        const job = await bridge.app.workflow.get(job_id, agentId);
        const profit = await bridge.app.applicationOptions.profitFor?.(job, agentId) ?? null;
        const role = job.participants.worker === agentId ? 'worker' as const : 'requester' as const;
        return JSON.stringify({ profit, prompt: bridge.app.profit.prompt({ role }) });
      } catch (e) {
        return JSON.stringify({ error: e instanceof Error ? e.message : String(e) });
      }
    },
    {
      name: 'a423_settlement_policy',
      description: 'Inspect the profit policy for one A423 job: cost basis, 50% target / 10% minimum / 50% maximum, recommended payout, projected or realized profit and margin, and the role-specific policy prompt. Use a423_list_jobs first if the job ID is unknown.',
      schema: z.object({ job_id: z.string() }),
    },
  );
  const listAgents = tool(
    async () => {
      const db = getDb();
      const rows = await db.select({ id: agents.id, name: agents.name, role: agents.role, status: agents.status }).from(agents);
      return JSON.stringify(rows);
    },
    {
      name: 'list_agents',
      description: 'List registered agents and their roles.',
      schema: z.object({}),
    },
  );

  return [getWallet, messageAgent, listAgents, acceptJobOffer, a423WaitForJob, a423ListJobs, a423Status, a423Policy, a423Action];
}
