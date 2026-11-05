import { ok, fail } from '@/lib/api';
import { getDb } from '@/lib/db/client';
import { agents } from '@/lib/db/schema';
import { getA423Bridge } from '@/lib/a423/bridge04';
import { getWorkMeterForProjection } from '@/lib/a423/work-meter';

export const runtime = 'nodejs';

export async function GET() {
  try {
    const db = getDb();
    const agentRows = await db.select({ id: agents.id, name: agents.name, role: agents.role }).from(agents);
    let a423: unknown = null;
    let a423Error: string | null = null;
    try {
      const bridge = await getA423Bridge();
      const actor = process.env.A423_DASHBOARD_ACTOR || agentRows[0]?.id;
      if (actor) {
        const a423Jobs = await Promise.all(
          (await bridge.storage.jobs.list({ actor, limit: 100 })).map(async (job) => {
            const consentRecord = job.agreement
              ? await bridge.storage.kv.get('a423:worker-consent', `${job.id}:${job.agreement.hash}`) as { created_at?: string; revision?: number; agreement_hash?: string } | null
              : null;
            const proposalHash = job.negotiation?.current?.proposal_hash;
            const [payerConsent, workerConsent] = proposalHash
              ? await Promise.all([
                  bridge.storage.kv.get('a423:cancellation-consent', `${job.id}:${proposalHash}:${job.participants.requester}`),
                  bridge.storage.kv.get('a423:cancellation-consent', `${job.id}:${proposalHash}:${job.participants.worker}`),
                ])
              : [null, null];
            return {
              ...job,
              safety: await bridge.storage.jobs.getSafety(job.id),
              work_meter: await getWorkMeterForProjection(job),
              profit: await bridge.app.applicationOptions.profitFor?.(job, job.participants.worker) ?? null,
              consent: consentRecord
                ? {
                    signed: true,
                    at: consentRecord.created_at,
                    revision: consentRecord.revision,
                    hash: consentRecord.agreement_hash,
                  }
                : { signed: false },
              cancellation_signers: (() => {
                // A saved instruction is only created after both signatures
                // were verified, even when they were supplied directly to the
                // accept route instead of the signing tool.
                const acceptedInstruction = (job.subflows ?? [])
                  .find((subflow) => subflow.kind === 'cancellation')?.instruction;
                return {
                  payer: !!payerConsent || !!acceptedInstruction,
                  worker: !!workerConsent || !!acceptedInstruction,
                  proposal_hash: proposalHash ?? null,
                };
              })(),
            };
          }),
        );
        const walletTransactions = a423Jobs.flatMap((job) =>
          job.evidence
            .filter((e) => e.evidence.transaction_hash)
            .map((e) => ({ job_id: job.id, action: e.action, ...e.evidence })),
        );
        a423 = { jobs: a423Jobs, wallet_transactions: walletTransactions };
      }
    } catch (error) {
      a423Error = error instanceof Error ? error.message : String(error);
    }
    return ok({ agents: agentRows, a423, a423Error });
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'error', 500);
  }
}
