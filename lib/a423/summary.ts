import type { WorkflowJob } from '@allorc/a423-sdk/workflow';
import type { WorkMeter } from './work-meter';
import type { ProfitProjection } from '@allorc/a423-sdk/policy';
import { displayTokenSymbol } from '@/lib/token-symbol';

export type ProfitView = Partial<ProfitProjection> & {
  advisory?: true;
  proposed_payout_raw?: string | null;
  realized_payout_raw?: string | null;
  receipt_confirmed?: boolean;
  evidence_status?: string;
};

type Terms = Record<string, unknown>;

function termsOf(job: WorkflowJob): Terms {
  return (job.agreement?.terms ?? {}) as Terms;
}

function escrowOf(job: WorkflowJob): Terms {
  return (termsOf(job).escrow ?? {}) as Terms;
}

function priceCents(job: WorkflowJob): number | null {
  const cents = Number(termsOf(job).price_usd_cents);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function priceText(job: WorkflowJob): string | null {
  const cents = priceCents(job);
  return cents ? `$${(cents / 100).toFixed(2)}` : null;
}

function amountText(job: WorkflowJob): string | null {
  const escrow = escrowOf(job);
  if (typeof escrow.amount !== 'string' || !/^\d+$/.test(escrow.amount)) return null;
  const rawSymbol = termsOf(job).token_symbol;
  const symbol = displayTokenSymbol(typeof rawSymbol === 'string' ? rawSymbol : null);
  return `${escrow.amount} ${symbol} raw`;
}

function iso(seconds: unknown): string | null {
  return typeof seconds === 'number' && Number.isFinite(seconds) ? new Date(seconds * 1000).toISOString() : null;
}

function roleOf(job: WorkflowJob, actor: string): string {
  return Object.entries(job.participants).find(([, id]) => id === actor)?.[0] ?? 'observer';
}

function acceptedRoles(job: WorkflowJob): string[] {
  return (job.agreement?.accepted_by ?? []).map((id) => roleOf(job, id));
}

/** The next action for this actor, so the model does not have to infer the state machine. */
export function a423NextAction(job: WorkflowJob, actor: string): string {
  const role = roleOf(job, actor);
  const accepted = new Set(job.agreement?.accepted_by ?? []);
  const requester = job.participants.requester;
  const worker = job.participants.worker;
  const verifier = job.participants.verifier;

  switch (job.state) {
    case 'draft':
      return role === 'requester' ? 'quote the terms with action="propose_quote" or send_job_offer' : 'waiting for the requester to quote';
    case 'quoted':
      if (role === 'worker' && !accepted.has(worker)) return 'review and use action="respond_to_offer" (accept, counter or reject)';
      if (role === 'requester' && accepted.has(worker) && !accepted.has(requester)) return 'accept the current revision with action="accept_job_offer" or counter';
      if (role === 'requester') return 'wait for the worker response, or use action="counter_offer" to revise the price';
      if (role === 'verifier') return 'waiting for both parties to accept';
      return 'waiting for acceptance';
    case 'accepted':
      if (role === 'worker') return 'sign worker consent with action="sign_worker_consent" with server-side signing or have your wallet sign the consent typed data';
      if (role === 'requester') return 'the worker must sign consent, then fund with action="fund_escrow"';
      return 'waiting for funding';
    case 'funded':
      if (role === 'worker') return 'start work with action="work_on_job", then call a423_wait_for_job once with a bounded timeout';
      return 'waiting for the worker to start';
    case 'running':
      if (role === 'worker') return 'work is running; call a423_wait_for_job once with a bounded timeout; do not poll a423_job_status in a loop';
      return 'wait for the worker; use a423_wait_for_job once or wait for marketplace mail; do not poll in a loop';
    case 'submitted':
      if (role === 'verifier' || role === 'requester' && verifier === requester) return 'verify the artifact with action="verify_job"';
      if (role === 'worker') return 'waiting for verification';
      return 'waiting for the verifier';
    case 'verified':
      if (role === 'verifier' || role === 'requester' && verifier === requester) return 'release payment with action="release_escrow"';
      if (role === 'worker') return 'waiting for payment release';
      return 'waiting for the verifier to release';
    case 'settlement_negotiation': {
      const subflow = (job.subflows ?? []).find((item) => item.kind === 'cancellation');
      if (subflow?.status === 'accepted') return 'execute the accepted cancellation instruction with action="execute_cancellation" (or wait for the keeper)';
      if (subflow?.status === 'execution_pending') return 'wait for the keeper to confirm cancellation execution';
      if (subflow?.status === 'execution_failed') return 'retry execute_cancellation with a new execution key after resolving the failure';
      if (subflow?.receipt || subflow?.status === 'completed') return 'cancellation complete; read the final receipt';
      const proposal = job.negotiation?.current;
      if (!proposal) return 'review the cancellation subflow';
      if (proposal.proposer_id === actor) return 'wait for the counterparty to counter or accept; do not counter your own proposal';
      return 'review the current proposal and work meter, sign settlement consent, then accept_cancellation; or counter_settlement using the recovery amount';
    }
    case 'disputed':
      return role === 'arbitrator' || role === 'verifier' ? 'resolve the dispute with action="resolve_job" and an explicit worker_amount' : 'waiting for arbitration';
    case 'paid':
    case 'settled':
    case 'resolved':
      return 'workflow complete';
    case 'refunded':
      return 'workflow refunded';
    case 'cancelled': {
      const last = (job.pre_funding_cancellations ?? []).at(-1);
      return last && !last.reopened_at
        ? `cancelled; to reopen, supply cancellation_id=${last.id} and the required approvals`
        : 'workflow cancelled';
    }
    case 'expired':
      return 'workflow expired';
    default:
      return 'inspect with a423_job_status';
  }
}

/** Compact, model-friendly view of a workflow. Keep the exact workflow ID prominent. */
export function summarizeA423Job(job: WorkflowJob, actor: string, workMeter?: WorkMeter | null, profit?: ProfitView | null) {
  const terms = termsOf(job);
  const escrow = escrowOf(job);
  const task = (terms.task ?? {}) as Terms;
  const description = typeof task.description === 'string' ? task.description : '';
  const safety = (job as WorkflowJob & { safety?: { blocked?: boolean; checked_at?: string } }).safety;
  return {
    id: job.id,
    state: job.state,
    role: roleOf(job, actor),
    created_at: job.created_at,
    updated_at: job.updated_at,
    epoch: job.epoch ?? 0,
    pre_funding_cancellations: (job.pre_funding_cancellations ?? []).map((item) => ({
      id: item.id,
      epoch: item.epoch,
      action: item.action,
      actor_id: item.actor_id,
      prior_state: item.prior_state,
      reason: item.reason,
      at: item.at,
      reopen_approvals: item.reopen_approvals,
      reopened_at: item.reopened_at,
    })),
    participants: job.participants,
    work_status: job.work_status ?? null,
    escrow_ledger: job.escrow_ledger ?? null,
    agreement: job.agreement ? {
      revision: job.agreement.revision,
      hash: job.agreement.hash,
      accepted_by: acceptedRoles(job),
      price_usd: priceText(job),
      amount: amountText(job),
      amount_raw: escrow.amount ?? null,
      symbol: displayTokenSymbol(typeof terms.token_symbol === 'string' ? terms.token_symbol : null),
      artifact_path: terms.artifact_path ?? null,
      task: {
        id: task.id ?? null,
        type: task.type ?? null,
        description: description.length > 500 ? `${description.slice(0, 500)}…` : description,
        deliverables: task.deliverables ?? null,
        acceptance: task.acceptance ?? null,
      },
      deadlines: {
        work: iso(escrow.work_deadline),
        review: iso(escrow.review_deadline),
        resolution: iso(escrow.resolution_deadline),
      },
    } : null,
    budget_usd_cents: (job.metadata as Record<string, unknown> | undefined)?.budget_usd_cents ?? null,
    pending: job.pending ? { action: job.pending.action, actor: job.pending.actor } : null,
    safety: safety ? { blocked: safety.blocked === true, checked_at: safety.checked_at ?? null } : null,
    transactions: job.evidence
      .filter((item) => typeof item.evidence.transaction_hash === 'string')
      .map((item) => ({ action: item.action, transaction_hash: item.evidence.transaction_hash })),
    profit: profit ?? null,
    work_meter: workMeter
      ? roleOf(job, actor) === 'worker'
        ? { ...workMeter, recovery_token_symbol: displayTokenSymbol(workMeter.recovery_token_symbol) }
        : {
            mock: true as const,
            progress_percent: workMeter.progress_percent,
            work_completed: workMeter.work_completed,
            recovery_raw: workMeter.recovery_raw,
            cost_basis_raw: workMeter.cost_basis_raw,
            recovery_token_symbol: displayTokenSymbol(workMeter.recovery_token_symbol),
            recovery_usd: workMeter.recovery_usd,
            note: workMeter.note,
          }
      : null,
    cancellation: (() => {
      const subflow = (job.subflows ?? []).find((item) => item.kind === 'cancellation');
      const proposal = job.negotiation?.current;
      if (!subflow && !proposal) return null;
      return {
        status: subflow?.status ?? (job.negotiation ? 'negotiating' : null),
        proposal_revision: subflow?.proposal_revision ?? 0,
        negotiation_status: job.negotiation?.status ?? null,
        history_count: job.negotiation?.history?.length ?? 0,
        current: proposal ? {
          worker_amount: proposal.worker_amount,
          payer_amount: proposal.payer_amount,
          escrow_version: proposal.escrow_version,
          expires_at: proposal.expires_at,
          reason: proposal.reason,
          claims: proposal.claims,
          proposal_hash: proposal.proposal_hash,
          proposer_id: proposal.proposer_id ?? null,
        } : null,
        instruction_id: subflow?.instruction?.id ?? null,
        instruction_funds_status: subflow?.instruction?.funds_status ?? null,
        receipt_status: subflow?.receipt ? 'confirmed' : null,
      };
    })(),
    next: a423NextAction(job, actor),
  };
}

export function formatA423Context(jobs: WorkflowJob[], actor: string, meters?: Map<string, WorkMeter>, profits?: Map<string, ProfitView | null>): string {
  if (jobs.length === 0) return 'No A423 workflows are associated with you yet.';
  return jobs.map((job) => {
    const summary = summarizeA423Job(job, actor, meters?.get(job.id), profits?.get(job.id));
    const agreement = summary.agreement;
    const price = agreement?.price_usd ?? 'no quote';
    const revision = agreement?.revision ?? '—';
    const accepted = agreement?.accepted_by?.length ? agreement.accepted_by.join(', ') : 'none';
    const pending = summary.pending ? `${summary.pending.action} (${summary.pending.actor})` : 'none';
    const cancellation = summary.cancellation?.status ? ` | cancellation=${summary.cancellation.status}` : '';
    const meter = summary.work_meter ? ` | progress=${summary.work_meter.progress_percent}% | cost=${summary.work_meter.cost_basis_raw} raw` : '';
    const profit = summary.profit
      ? typeof summary.profit.realized_profit_raw === 'string'
        ? ` | profit=${summary.profit.realized_profit_raw} raw | margin=${summary.profit.realized_margin_bps ?? '—'}bps | receipt=${summary.profit.receipt_confirmed}`
        : typeof summary.profit.projected_profit_raw === 'string'
          ? ` | projected_profit=${summary.profit.projected_profit_raw} raw | margin=${summary.profit.projected_margin_bps ?? '—'}bps | target=${summary.profit.target_status}`
          : ` | payout=${summary.profit.proposed_payout_raw ?? '—'} raw | receipt=${summary.profit.receipt_confirmed}`
      : '';
    return `- id=${summary.id} | state=${summary.state} | role=${summary.role} | work=${summary.work_status ?? '-'}${cancellation}${meter}${profit} | rev=${revision} | price=${price} | accepted=${accepted} | pending=${pending} | next=${summary.next}`;
  }).join('\n');
}
