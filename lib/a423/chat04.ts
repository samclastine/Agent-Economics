import { randomUUID } from 'crypto';
import type { WorkflowJob } from '@allorc/a423-sdk/workflow';
import { enqueueRunningJobs } from '@allorc/a423-sdk/operations';
import { getA423Bridge } from './bridge04';
import { buildTerms04 } from './terms04';
import { getDb } from '@/lib/db/client';
import { agents, agentWallets } from '@/lib/db/schema';
import { eq } from 'drizzle-orm';
import { usdCentsToTokenRaw } from '@/lib/finance/money';
import { isMalformedPendingSubmit, repairMalformedPendingSubmit } from './pending';
import { freezeWorkMeter } from './work-meter';
import { displayTokenSymbol } from '@/lib/token-symbol';
import { isAllowedPath } from '@/lib/artifacts/validators';

const TOOLS = new Set([
  'send_job_offer', 'propose_quote', 'accept_quote', 'fund_escrow', 'work_on_job',
  'submit_job', 'verify_job', 'release_escrow', 'refund_escrow', 'dispute_job',
  'resolve_job', 'timeout_job', 'cancel_job',
  // App-level negotiation helpers. These wrap the SDK quote/accept actions with
  // safe defaults and marketplace-mail notifications.
  'respond_to_offer', 'counter_offer', 'accept_job_offer', 'decline_job_offer',
  'sign_worker_consent',
  // cancellation subflow
  'propose_settlement', 'counter_settlement', 'accept_settlement',
  'sign_cancellation_consent', 'accept_cancellation', 'execute_cancellation',
  'request_cancellation', 'reopen_job',
]);

const NOTIFY = process.env.A423_PEER_NOTIFICATIONS !== 'false';
const CONSENT_NS = 'a423:worker-consent';
const CANCELLATION_CONSENT_NS = 'a423:cancellation-consent';

type AnyTerms = Record<string, unknown>;

function jobIdOf(input: Record<string, unknown>): string {
  const id = input.job_id ?? input.jobId ?? input.id;
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error('job_id required');
  return id;
}

function positiveCents(input: Record<string, unknown>): number {
  const raw = input.usdCents ?? input.usd_cents ?? input.amount_usd_cents;
  const cents = Number(raw);
  if (!Number.isSafeInteger(cents) || cents <= 0) throw new Error('usdCents must be a positive integer');
  return cents;
}

function termsOf(job: WorkflowJob): AnyTerms {
  return ((job.agreement?.terms ?? {}) as unknown) as AnyTerms;
}

function priceCents(job: WorkflowJob): number | null {
  const cents = Number(termsOf(job).price_usd_cents);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function budgetCents(job: WorkflowJob): number | null {
  const raw = (job.metadata as Record<string, unknown> | undefined)?.budget_usd_cents;
  const cents = Number(raw);
  return Number.isSafeInteger(cents) && cents > 0 ? cents : null;
}

function maxNegotiationRevisions(): number {
  const value = Number(process.env.A423_MAX_NEGOTIATION_REVISIONS ?? 4);
  return Number.isSafeInteger(value) && value >= 2 ? value : 4;
}

function usd(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function tokenAmountText(job: WorkflowJob, raw: string): string {
  const terms = termsOf(job);
  const decimals = Number(terms.token_decimals ?? 18);
  const symbol = displayTokenSymbol(typeof terms.token_symbol === 'string' ? terms.token_symbol : null);
  if (!/^\d+$/.test(raw)) return `${raw} ${symbol} raw`;
  const safeDecimals = Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18;
  const base = 10n ** BigInt(safeDecimals);
  const value = BigInt(raw);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(safeDecimals, '0').replace(/0+$/, '');
  return `${whole.toString()}${fraction ? `.${fraction}` : ''} ${symbol}`;
}

function priceText(job: WorkflowJob): string {
  const terms = termsOf(job);
  const cents = Number(terms.price_usd_cents);
  const escrow = (terms.escrow ?? {}) as AnyTerms;
  const symbol = displayTokenSymbol(typeof terms.token_symbol === 'string' ? terms.token_symbol : null);
  const decimals = Number(terms.token_decimals ?? 18);
  let amount = '';
  if (typeof escrow.amount === 'string' && /^\d+$/.test(escrow.amount)) {
    const raw = BigInt(escrow.amount);
    const base = 10n ** BigInt(Number.isSafeInteger(decimals) ? decimals : 18);
    const whole = raw / base;
    const fraction = (raw % base).toString().padStart(Number.isSafeInteger(decimals) ? decimals : 18, '0').replace(/0+$/, '');
    amount = ` (${whole.toString()}${fraction ? `.${fraction}` : ''} ${symbol})`;
  }
  return Number.isFinite(cents) && cents > 0 ? `$${(cents / 100).toFixed(2)} USD${amount}` : `revision ${job.agreement?.revision ?? 0}${amount}`;
}

function timeText(seconds: unknown): string {
  return typeof seconds === 'number' && Number.isFinite(seconds)
    ? new Date(seconds * 1000).toISOString()
    : 'not set';
}

function describe(job: WorkflowJob): string {
  const terms = termsOf(job);
  const escrow = (terms.escrow ?? {}) as AnyTerms;
  const task = (terms.task ?? {}) as AnyTerms;
  return [
    `A423 job ${job.id}`,
    `Task: ${String(task.description ?? '(no description)')}`,
    `Price: ${priceText(job)}`,
    `Deliverable: ${String(terms.artifact_path ?? '(not set)')}`,
    `Work deadline: ${timeText(escrow.work_deadline)}`,
    `Review deadline: ${timeText(escrow.review_deadline)}`,
    `Resolution deadline: ${timeText(escrow.resolution_deadline)}`,
    `State: ${job.state}; agreement revision ${job.agreement?.revision ?? 0}; accepted by ${(job.agreement?.accepted_by ?? []).length}/2.`,
  ].join('\n');
}

function roleOf(job: WorkflowJob, actor: string): 'requester' | 'worker' | 'verifier' | 'arbitrator' | 'observer' {
  const found = Object.entries(job.participants).find(([, id]) => id === actor);
  return (found?.[0] as 'requester' | 'worker' | 'verifier' | 'arbitrator' | undefined) ?? 'observer';
}

function counterparty(job: WorkflowJob, actor: string): string | null {
  if (job.participants.requester !== actor) return job.participants.requester;
  if (job.participants.worker !== actor) return job.participants.worker;
  return job.participants.verifier !== actor ? job.participants.verifier : null;
}

async function agentName(id: string): Promise<string> {
  const db = getDb();
  const row = await db.query.agents.findFirst({ where: eq(agents.id, id) });
  return row?.name ?? id;
}

async function notify(fromAgentId: string, toAgentId: string, jobId: string, text: string): Promise<void> {
  if (!NOTIFY) return;
  try {
    const fromName = await agentName(fromAgentId);
    const { sendPeerMessage } = await import('@/lib/agents/peer');
    // Delivery is deliberately fire-and-forget: the mailbox event renders in
    // the recipient's chat immediately, while the recipient's agent turn may
    // take a little longer. It must never hold up the escrow action response.
    void sendPeerMessage({
      fromAgentId,
      toAgentId,
      jobId,
      text: `${text}\n\n— ${fromName}`,
    }).catch((error) => {
      console.warn('[a423-chat] peer notification failed:', error instanceof Error ? error.message : String(error));
    });
  } catch (error) {
    console.warn('[a423-chat] peer notification unavailable:', error instanceof Error ? error.message : String(error));
  }
}

async function notifyOffer(job: WorkflowJob): Promise<void> {
  await notify(job.participants.requester, job.participants.worker, job.id, [
    `NEW A423 JOB OFFER — ${job.id}`,
    describe(job),
    '',
    'You are the worker. Review with a423_job_status, then negotiate with a423_job_action:',
    `- accept:  action="respond_to_offer", input={ "job_id": "${job.id}", "decision": "accept" }`,
    `- counter: action="respond_to_offer", input={ "job_id": "${job.id}", "decision": "counter", "usdCents": 120, "note": "..." }`,
    `- decline: action="respond_to_offer", input={ "job_id": "${job.id}", "decision": "reject", "note": "..." }`,
    'Do not start work or claim funds are locked until escrow funding is confirmed.',
  ].join('\n'));
}

async function notifyNegotiation(job: WorkflowJob, actor: string, kind: 'counter' | 'accept' | 'reject', note?: string): Promise<void> {
  const other = counterparty(job, actor);
  if (!other) return;
  const role = roleOf(job, actor);
  const accepted = new Set(job.agreement?.accepted_by ?? []);
  const bothAccepted = ['requester', 'worker'].every((r) => accepted.has(job.participants[r as 'requester' | 'worker']));
  if (kind === 'counter') {
    await notify(actor, other, job.id, [
      `COUNTEROFFER on ${job.id} — ${role} proposed ${priceText(job)} (revision ${job.agreement?.revision ?? 0}).`,
      describe(job),
      '',
      `To accept the revised terms: action="respond_to_offer", input={ "job_id": "${job.id}", "decision": "accept" }.`,
      `To counter back: action="counter_offer", input={ "job_id": "${job.id}", "usdCents": 110, "note": "..." }.`,
    ].join('\n'));
    return;
  }
  if (kind === 'accept') {
    await notify(actor, other, job.id, bothAccepted
      ? [
          `AGREEMENT ACCEPTED on ${job.id} at ${priceText(job)} (revision ${job.agreement?.revision ?? 0}).`,
          'Both requester and worker have accepted the same revision. Escrow is NOT funded yet.',
          role === 'worker'
            ? `Next: the worker can sign consent with action="sign_worker_consent", input={ "job_id": "${job.id}" }; then the requester can fund.`
            : `Next: the worker must sign consent with action="sign_worker_consent", input={ "job_id": "${job.id}" }; then the requester can fund with action="fund_escrow".`,
        ].join('\n')
      : [
          `ACCEPTANCE RECORDED on ${job.id} — ${role} accepted ${priceText(job)} (revision ${job.agreement?.revision ?? 0}).`,
          'Waiting for the other party to accept the same revision. Escrow is NOT funded yet.',
          `Use action="accept_job_offer", input={ "job_id": "${job.id}" } to accept, or action="counter_offer" to revise.`,
        ].join('\n'));
    return;
  }
  await notify(actor, other, job.id, [
    `OFFER DECLINED on ${job.id} by ${role}${note ? `: ${note}` : '.'}`,
    'No work will be performed and no escrow should be funded.',
    role === 'worker'
      ? `The requester can close the workflow with action="cancel_job", input={ "job_id": "${job.id}" }.`
      : 'The offer has been withdrawn.',
  ].join('\n'));
}

async function acceptOffer(actor: string, input: Record<string, unknown>): Promise<WorkflowJob> {
  const bridge = await getA423Bridge();
  const jobId = jobIdOf(input);
  const job = await bridge.app.workflow.get(jobId, actor);
  if (!job.agreement) throw new Error('job has no agreement to accept');
  if (job.agreement.accepted_by.includes(actor)) return job;
  if (actor === job.participants.requester) {
    const budget = budgetCents(job);
    const price = priceCents(job);
    if (budget && price && price > budget) {
      throw new Error(`current price ${usd(price)} exceeds the original budget ${usd(budget)}; decline or ask the owner to approve a higher budget`);
    }
  }
  const updated = await bridge.app.workflow.act(jobId, 'accept', {
    agreement_hash: job.agreement.hash,
    revision: job.agreement.revision,
  }, {
    actor,
    idempotencyKey: String(input.idempotency_key ?? `accept-${jobId}-${job.agreement.revision}-${actor}`),
  });
  await notifyNegotiation(updated, actor, 'accept');
  return updated;
}

function counterTerms(job: WorkflowJob, usdCents: number, nowMs: number): AnyTerms {
  if (!job.agreement) throw new Error('job has no agreement to revise');
  const tokenPrice = process.env.DEMO_TOKEN_PRICE_USD ?? '0.02';
  const amountRaw = usdCentsToTokenRaw(usdCents, tokenPrice, 18).toString();
  const terms = structuredClone(job.agreement.terms) as AnyTerms;
  const escrow = (terms.escrow ?? {}) as AnyTerms;
  escrow.amount = amountRaw;
  terms.price_usd_cents = usdCents;
  terms.expires_at = Math.floor(nowMs / 1000) + 900;
  return terms;
}

async function counterOffer(actor: string, input: Record<string, unknown>, workerOnly = false): Promise<WorkflowJob> {
  const bridge = await getA423Bridge();
  const jobId = jobIdOf(input);
  const job = await bridge.app.workflow.get(jobId, actor);
  if (workerOnly && job.participants.worker !== actor) throw new Error('only the worker can respond to an offer');
  if (!['quoted', 'accepted'].includes(job.state)) throw new Error(`job is ${job.state}; offers can only be countered while quoted or accepted`);
  if (![job.participants.requester, job.participants.worker].includes(actor)) throw new Error('only the requester or worker can counter');
  const revision = job.agreement?.revision ?? 0;
  const maxRevisions = maxNegotiationRevisions();
  if (revision >= maxRevisions) {
    throw new Error(`negotiation revision limit reached (${maxRevisions}); accept the current revision or decline`);
  }
  const lastQuote = [...job.events].reverse().find((event) => event.type === 'quote');
  if (lastQuote?.actor_id === actor) {
    throw new Error('wait for the other party to respond before countering your own offer');
  }
  const usdCents = positiveCents(input);
  if (actor === job.participants.requester) {
    const budget = budgetCents(job);
    if (budget && usdCents > budget) {
      throw new Error(`counter ${usd(usdCents)} exceeds the original budget ${usd(budget)}; decline or ask the owner to approve a higher budget`);
    }
  }
  const latest = await bridge.provider.getBlock('latest');
  const chainNow = Math.max(latest ? Number(latest.timestamp) * 1000 : 0, Date.now());
  const terms = counterTerms(job, usdCents, chainNow);
  const updated = await bridge.app.workflow.act(jobId, 'quote', { terms } as never, {
    actor,
    idempotencyKey: String(input.idempotency_key ?? `counter-${jobId}-${job.agreement?.revision ?? 0}-${usdCents}`),
  });
  await notifyNegotiation(updated, actor, 'counter', typeof input.note === 'string' ? input.note : undefined);
  return updated;
}

async function declineOffer(actor: string, input: Record<string, unknown>): Promise<WorkflowJob> {
  const bridge = await getA423Bridge();
  const jobId = jobIdOf(input);
  const job = await bridge.app.workflow.get(jobId, actor);
  if (!['quoted', 'accepted'].includes(job.state)) throw new Error(`job is ${job.state}; offers can only be declined while quoted or accepted`);
  const note = typeof input.note === 'string' ? input.note : undefined;
  if (actor === job.participants.requester) {
    const updated = await bridge.app.workflow.act(jobId, 'cancel', {}, {
      actor,
      idempotencyKey: String(input.idempotency_key ?? `cancel-${jobId}`),
    });
    await notifyNegotiation(updated, actor, 'reject', note);
    return updated;
  }
  if (actor !== job.participants.worker) throw new Error('only the requester or worker can decline');
  const updated = await bridge.app.workflow.act(jobId, 'decline', {
    ...(note ? { reason: note } : {}),
  }, {
    actor,
    idempotencyKey: String(input.idempotency_key ?? `decline-${jobId}`),
  });
  await notifyNegotiation(updated, actor, 'reject', note);
  return updated;
}

async function sendOffer(actor: string, input: Record<string, unknown>): Promise<WorkflowJob> {
  const bridge = await getA423Bridge();
  const payload: Record<string, unknown> = { ...input };
  if (!payload.terms) {
    payload.terms = await termsForChat(actor, payload);
    payload.worker_id = payload.worker_id;
    payload.verifier_id = payload.verifier_id ?? actor;
    payload.arbitrator_id = payload.arbitrator_id ?? process.env.A423_ARBITER_ID ?? 'a423-arbiter';
  }
  payload.id = payload.id ?? `wf-${randomUUID()}`;
  const requestedCents = Number(payload.usdCents ?? payload.usd_cents ?? 100);
  payload.metadata = {
    ...(typeof payload.metadata === 'object' && payload.metadata ? payload.metadata as Record<string, unknown> : {}),
    created_at: new Date().toISOString(),
    source: 'chat',
    budget_usd_cents: Number.isSafeInteger(requestedCents) && requestedCents > 0 ? requestedCents : 100,
  };
  payload.idempotency_key = payload.idempotency_key ?? `initial_quote-${String(payload.id)}`;
  const job = await bridge.app.chatTools(actor).send_job_offer(payload);
  await notifyOffer(job);
  return job;
}

async function signWorkerConsent(actor: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (process.env.A423_SERVER_CONSENT !== 'true') {
    throw new Error('server-side consent signing is disabled; the worker must sign the EIP-712 consent with their own wallet');
  }
  const bridge = await getA423Bridge();
  const jobId = jobIdOf(input);
  const job = await bridge.app.workflow.get(jobId, actor);
  if (job.participants.worker !== actor) throw new Error('only the worker can sign worker consent');
  if (job.state !== 'accepted') throw new Error(`job is ${job.state}; both parties must accept before worker consent`);
  if (!job.agreement) throw new Error('job has no agreement');
  const consentFor = bridge.app.applicationOptions.consentFor;
  if (!consentFor) throw new Error('worker consent is not configured');
  const typed = await consentFor(job) as { domain: Record<string, unknown>; types: Record<string, unknown>; value: Record<string, unknown> };
  const wallet = await bridge.signerFor(actor);
  const signature = await wallet.signTypedData(typed.domain as never, typed.types as never, typed.value as never);
  await bridge.storage.kv.put(CONSENT_NS, `${job.id}:${job.agreement.hash}`, {
    signature,
    agreement_hash: job.agreement.hash,
    revision: job.agreement.revision,
    worker: actor,
    created_at: new Date().toISOString(),
  });
  await notify(actor, job.participants.requester, job.id, [
    `WORKER CONSENT SIGNED for ${job.id} at revision ${job.agreement.revision}.`,
    `The requester can now fund with action="fund_escrow", input={ "job_id": "${job.id}" }.`,
  ].join('\n'));
  return {
    job_id: job.id,
    state: job.state,
    agreement_hash: job.agreement.hash,
    revision: job.agreement.revision,
    signature,
    note: 'Consent signature stored. Funding will attach it automatically.',
  };
}


function cancellationOf(job: WorkflowJob) {
  return (job.subflows ?? []).find((subflow) => subflow.kind === 'cancellation') ?? null;
}

function currentProposal(job: WorkflowJob) {
  return job.negotiation?.current ?? null;
}

function rawAmountOf(actorInput: Record<string, unknown>, job: WorkflowJob, fallback?: string): string {
  const raw = actorInput.worker_amount ?? actorInput.workerAmount ?? actorInput.amount;
  if (raw !== undefined) {
    const value = String(raw);
    if (!/^(0|[1-9][0-9]*)$/.test(value)) throw new Error('worker_amount must be a nonnegative raw-token integer string');
    const total = (job.agreement?.terms as Record<string, unknown> | undefined)?.escrow as Record<string, unknown> | undefined;
    if (typeof total?.amount === 'string' && BigInt(value) > BigInt(total.amount)) throw new Error('worker_amount exceeds the escrowed amount');
    return value;
  }
  const cents = Number(actorInput.worker_usd_cents ?? actorInput.workerUsdCents);
  if (Number.isSafeInteger(cents) && cents >= 0) {
    return usdCentsToTokenRaw(cents, process.env.DEMO_TOKEN_PRICE_USD ?? '0.02', 18).toString();
  }
  if (fallback !== undefined) return fallback;
  throw new Error('worker_amount is required (raw integer token units)');
}

async function proposeSettlementAction(
  actor: string,
  input: Record<string, unknown>,
  action: 'propose_settlement' | 'counter_settlement',
): Promise<WorkflowJob> {
  const bridge = await getA423Bridge();
  const jobId = jobIdOf(input);
  let job = await bridge.app.workflow.get(jobId, actor);
  if (isMalformedPendingSubmit(job)) job = await repairMalformedPendingSubmit(job);
  if (![job.participants.requester, job.participants.worker].includes(actor)) throw new Error('only the requester or worker can publish a closing proposal');
  if (!job.agreement) throw new Error('job has no agreement');
  const terms = job.agreement.terms as Record<string, unknown>;
  const escrow = (terms.escrow ?? {}) as Record<string, unknown>;
  const resolutionDeadline = Number(escrow.resolution_deadline);
  const latest = await bridge.provider.getBlock('latest');
  // Some local chains have an older last-block timestamp after idle time;
  // use the later of chain and wall time so deadlines remain valid.
  const chainNow = Math.max(Number(latest?.timestamp ?? 0), Math.floor(Date.now() / 1000));
  const proposal = currentProposal(job);
  const expectedRevision = Number(
    input.expected_revision ?? input.expectedRevision
      ?? (action === 'counter_settlement' && proposal ? proposal.escrow_version : 0),
  );
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) throw new Error('expected_revision must be a nonnegative integer');

  let expiresAt = Number(input.expires_at ?? input.expiresAt ?? 0);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= 0) {
    expiresAt = Math.min(chainNow + 3600, resolutionDeadline - 30);
  }
  if (expiresAt <= chainNow) throw new Error('proposal expiry must be in the future; the original resolution deadline has passed, use refund or timeout');
  if (expiresAt > resolutionDeadline) throw new Error('proposal expiry cannot exceed the original resolution deadline');

  const meter = await freezeWorkMeter(job, { now: Date.now() });
  const isWorker = actor === job.participants.worker;
  const policy = bridge.app.profit;
  const evaluation = policy ? await policy.evaluate(job, { freeze: true }) : null;
  const defaultAmount = isWorker ? (evaluation?.recommended_payout ?? meter.recovery_raw) : '0';
  const workerAmount = rawAmountOf(input, job, defaultAmount);
  if (policy && isWorker) {
    const offer = await policy.evaluate(job, { freeze: true, offer_raw: workerAmount });
    if (offer.offer_issue === 'above_budget_or_escrow') throw new Error('worker_amount exceeds the original budget or escrow balance');
    if (offer.offer_issue === 'above_maximum') throw new Error('worker_amount exceeds the maximum profit-policy payout; ask at or below the target margin');
    if (offer.requires_owner_approval) throw new Error('worker_amount is below the minimum margin/cost and requires explicit owner approval');
  }
  const workerText = tokenAmountText(job, workerAmount);
  const reason = String(input.reason ?? '').trim() || (BigInt(workerAmount) > 0n && meter.progress_percent > 0
    ? `The escrow is ${priceText(job)}. Approximately ${meter.progress_percent}% of the work is complete (${meter.work_completed}). I propose ${workerText} to cover work already performed; the remainder returns to the payer.`
    : `${isWorker ? 'The worker' : 'The requester'} proposes a full refund with no payment for completed work.`);
  const providedClaims = Array.isArray(input.claims) ? input.claims : [];
  const claims = providedClaims.length > 0
    ? providedClaims
    : (BigInt(workerAmount) > 0n && meter.progress_percent > 0
      ? [{
          kind: 'work',
          description: `Partial work completed (${meter.progress_percent}%): ${meter.work_completed}`,
          amount: workerAmount,
          evidence: [`work-meter:${job.id}`],
        }]
      : []);
  const payload = {
    worker_amount: workerAmount,
    expected_revision: expectedRevision,
    expires_at: expiresAt,
    reason,
    claims,
  };
  const key = String(input.idempotency_key ?? `${action}-${jobId}-${expectedRevision}-${workerAmount}`);
  const updated = await actWithRetry(actor, jobId, action, payload, key, 8);
  const other = counterparty(updated, actor);
  const p = currentProposal(updated);
  if (other && p) {
    await notify(actor, other, updated.id, [
      `${action === 'counter_settlement' ? 'CLOSING COUNTERPROPOSAL' : 'CLOSING SETTLEMENT PROPOSED'} on ${updated.id}.`,
      `Worker amount: ${tokenAmountText(updated, p.worker_amount)} (${p.worker_amount} raw); payer amount: ${tokenAmountText(updated, p.payer_amount)} (${p.payer_amount} raw); revision ${p.escrow_version}; expires ${new Date(p.expires_at * 1000).toISOString()}.`,
      meter.progress_percent > 0 ? `Worker reports approximately ${meter.progress_percent}% of the work completed.` : 'Worker reports no completed work.',
      `Reason: ${p.reason}`,
      `Work is paused. Review the exact proposal, sign it with action="sign_cancellation_consent", then use action="accept_cancellation" (both signatures required), or counter with counter_settlement.`,
      'No money has moved. Funds remain in escrow until a confirmed cancellation execution.',
    ].join('\n'));
  }
  return updated;
}

async function signCancellationConsent(actor: string, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (process.env.A423_SERVER_CONSENT !== 'true') {
    throw new Error('server-side settlement signing is disabled; each party must sign the settlement consent with their own wallet');
  }
  const bridge = await getA423Bridge();
  const jobId = jobIdOf(input);
  const job = await bridge.app.workflow.get(jobId, actor);
  if (![job.participants.requester, job.participants.worker].includes(actor)) throw new Error('only the requester or worker can sign settlement consent');
  const proposal = currentProposal(job);
  if (!proposal || !job.negotiation || !['open', 'accepted'].includes(job.negotiation.status)) throw new Error('no open closing proposal to sign');
  const consentFor = bridge.app.applicationOptions.settlementConsentFor;
  if (!consentFor) throw new Error('settlement consent is not configured');
  const typed = await consentFor(job) as { domain: Record<string, unknown>; types: Record<string, unknown>; value: Record<string, unknown> };
  const wallet = await bridge.signerFor(actor);
  const signature = await wallet.signTypedData(typed.domain as never, typed.types as never, typed.value as never);
  await bridge.storage.kv.put(CANCELLATION_CONSENT_NS, `${job.id}:${proposal.proposal_hash}:${actor}`, {
    signature,
    job_id: job.id,
    proposal_hash: proposal.proposal_hash,
    escrow_version: proposal.escrow_version,
    actor,
    role: actor === job.participants.requester ? 'payer' : 'worker',
    created_at: new Date().toISOString(),
  });
  const other = counterparty(job, actor);
  if (other) {
    await notify(actor, other, job.id, [
      `CANCELLATION CONSENT SIGNED for ${job.id} on proposal ${proposal.proposal_hash.slice(0, 14)}… revision ${proposal.escrow_version}.`,
      'Sign the same current proposal with action="sign_cancellation_consent", then either party can call action="accept_cancellation".',
    ].join('\n'));
  }
  return {
    job_id: job.id,
    proposal_hash: proposal.proposal_hash,
    escrow_version: proposal.escrow_version,
    role: actor === job.participants.requester ? 'payer' : 'worker',
    signature,
    note: 'Signature stored. Both signatures are required before acceptance.',
  };
}

async function acceptCancellationAction(actor: string, input: Record<string, unknown>): Promise<WorkflowJob> {
  const bridge = await getA423Bridge();
  const jobId = jobIdOf(input);
  const job = await bridge.app.workflow.get(jobId, actor);
  if (![job.participants.requester, job.participants.worker].includes(actor)) throw new Error('only the requester or worker can accept cancellation');
  const proposal = currentProposal(job);
  if (!proposal) throw new Error('no closing proposal to accept');
  const subflow = cancellationOf(job);
  if (subflow?.instruction) return job;
  const stored = async (party: string) => {
    const record = await bridge.storage.kv.get(CANCELLATION_CONSENT_NS, `${job.id}:${proposal.proposal_hash}:${party}`) as { signature?: string } | null;
    return record?.signature;
  };
  const payerSignature = String(input.payer_signature ?? await stored(job.participants.requester) ?? '');
  const workerSignature = String(input.worker_signature ?? await stored(job.participants.worker) ?? '');
  if (!payerSignature || !workerSignature) {
    throw new Error(`both signatures are required for cancellation acceptance (payer=${!!payerSignature}, worker=${!!workerSignature}); each party must call sign_cancellation_consent on the current proposal`);
  }
  const forward = process.env.A423_FORWARD_CANCELLATIONS === 'true';
  const updated = await bridge.app.workflow.acceptCancellation(jobId, {
    expected_revision: proposal.escrow_version,
    proposal_hash: proposal.proposal_hash,
    payer_signature: payerSignature,
    worker_signature: workerSignature,
  }, {
    actor,
    idempotencyKey: String(input.idempotency_key ?? `cancel-accept-${jobId}-${proposal.proposal_hash}`),
    forward,
  });
  const accepted = cancellationOf(updated);
  const other = counterparty(updated, actor);
  if (other) {
    await notify(actor, other, updated.id, [
      `CANCELLATION ACCEPTED on ${updated.id} at revision ${proposal.escrow_version}.`,
      accepted?.instruction
        ? `Accepted instruction ${accepted.instruction.id} saved with funds_status="${accepted.instruction.funds_status}". Funds have NOT moved yet.`
        : 'Acceptance is being processed.',
      forward
        ? 'Execution was forwarded; a confirmed receipt is required before claiming payment.'
        : 'The keeper will forward the accepted instruction. A payment receipt is only available after confirmed settlement.',
    ].join('\n'));
  }
  return updated;
}

async function executeCancellationAction(actor: string, input: Record<string, unknown>): Promise<WorkflowJob> {
  const bridge = await getA423Bridge();
  const jobId = jobIdOf(input);
  const job = await bridge.app.workflow.get(jobId, actor);
  if (job.state === 'settled') return job;
  const instruction = await bridge.app.workflow.cancellationInstruction(jobId, actor);
  if (input.instruction_id && input.instruction_id !== instruction.id) throw new Error('instruction_id does not match the accepted cancellation instruction');
  const execInput: Record<string, unknown> = { instruction_id: instruction.id };
  if (typeof input.transaction_hash === 'string') execInput.transaction_hash = input.transaction_hash;
  const updated = await actWithRetry(actor, jobId, 'execute_cancellation', execInput, String(input.idempotency_key ?? `cancel-execute-${instruction.id}`), 8);
  if (updated.state === 'settled') {
    const other = counterparty(updated, actor);
    if (other) {
      await notify(actor, other, updated.id, `CANCELLATION SETTLED on ${updated.id}. Read the confirmed cancellation receipt for the actual worker/payer allocations.`);
    }
  }
  return updated;
}

async function acceptSettlementAction(actor: string, input: Record<string, unknown>): Promise<WorkflowJob> {
  const bridge = await getA423Bridge();
  const jobId = jobIdOf(input);
  const job = await bridge.app.workflow.get(jobId, actor);
  const proposal = currentProposal(job);
  if (!proposal) throw new Error('no closing proposal to accept');
  const payload: Record<string, unknown> = {
    expected_revision: proposal.escrow_version,
    proposal_hash: proposal.proposal_hash,
  };
  if (typeof input.payer_signature === 'string' && typeof input.worker_signature === 'string') {
    payload.payer_signature = input.payer_signature;
    payload.worker_signature = input.worker_signature;
  } else if (proposal.proposer_id === actor) {
    throw new Error('the proposer cannot self-accept a closing settlement');
  }
  const updated = await actWithRetry(actor, jobId, 'accept_settlement', payload, String(input.idempotency_key ?? `accept-settlement-${jobId}-${proposal.proposal_hash}`), 8);
  const other = counterparty(updated, actor);
  if (other) {
    await notify(actor, other, updated.id, `DIRECT CLOSING SETTLEMENT on ${updated.id} settled. Read the confirmed receipt for the actual allocations.`);
  }
  return updated;
}

async function actWithRetry(
  actor: string,
  jobId: string,
  action: string,
  input: Record<string, unknown>,
  idempotencyKey: string,
  attempts = 6,
): Promise<WorkflowJob> {
  const bridge = await getA423Bridge();
  let job: WorkflowJob | null = null;
  for (let i = 0; i < attempts; i++) {
    job = await bridge.app.workflow.act(jobId, action, input as never, { actor, idempotencyKey });
    if (!job.pending) return job;
    await new Promise((resolve) => setTimeout(resolve, 800));
  }
  return job as WorkflowJob;
}

async function workOnJob(actor: string, input: Record<string, unknown>): Promise<WorkflowJob> {
  const bridge = await getA423Bridge();
  const jobId = jobIdOf(input);
  const job = await bridge.app.workflow.get(jobId, actor);
  if (job.participants.worker !== actor) throw new Error('only the worker can start work');
  if (isMalformedPendingSubmit(job)) return repairMalformedPendingSubmit(job);
  if (job.state === 'running') return job;
  const started = await actWithRetry(actor, jobId, 'start', {}, String(input.idempotency_key ?? `start-${jobId}`));
  if (started.state === 'running' && !started.pending) {
    await enqueueRunningJobs({ store: bridge.app.applicationOptions.store, queue: bridge.app.applicationOptions.queue });
    await notify(actor, started.participants.requester, jobId, [
      `WORK STARTED on ${jobId}.`,
      `The worker began the task at ${new Date().toISOString()}.`,
    ].join('\n'));
  }
  return started;
}

async function fundJob(actor: string, input: Record<string, unknown>): Promise<WorkflowJob> {
  const bridge = await getA423Bridge();
  const jobId = jobIdOf(input);
  const job = await bridge.app.workflow.get(jobId, actor);
  if (job.participants.requester !== actor) throw new Error('only the requester can fund escrow');
  if (!job.agreement) throw new Error('job has no agreement');
  const budget = budgetCents(job);
  const price = priceCents(job);
  if (budget && price && price > budget) {
    throw new Error(`current price ${usd(price)} exceeds the original budget ${usd(budget)}; do not fund this agreement`);
  }
  const payload: Record<string, unknown> = { ...input, job_id: jobId };
  if (!payload.worker_signature) {
    const stored = await bridge.storage.kv.get(CONSENT_NS, `${job.id}:${job.agreement.hash}`) as { signature?: string } | null;
    if (stored?.signature) payload.worker_signature = stored.signature;
  }
  if (typeof payload.worker_signature !== 'string') {
    throw new Error('worker_signature required; the worker must sign consent with action="sign_worker_consent" first');
  }
  payload.idempotency_key = String(input.idempotency_key ?? `fund-${jobId}-${job.agreement.hash}`);
  const funded = await actWithRetry(actor, jobId, 'fund', payload, String(payload.idempotency_key), 8);
  if (funded.state === 'funded' && !funded.pending) {
    await notify(actor, funded.participants.worker, jobId, [
      `ESCROW FUNDED on ${jobId} at ${priceText(funded)}.`,
      `Start the work with action="work_on_job", input={ "job_id": "${jobId}" }.`,
    ].join('\n'));
  }
  return funded;
}

async function notifyTransition(job: WorkflowJob, actor: string, action: string): Promise<void> {
  const requester = job.participants.requester;
  const worker = job.participants.worker;
  const other = counterparty(job, actor);
  const text = (() => {
    switch (action) {
      case 'verify_job': return `ARTIFACT VERIFIED on ${job.id} at ${priceText(job)}. Release can now be called.`;
      case 'release_escrow': return `PAYMENT RELEASED on ${job.id} at ${priceText(job)}. The work is settled.`;
      case 'refund_escrow': return `ESCROW REFUNDED on ${job.id} at ${priceText(job)}. No work payment was made.`;
      case 'dispute_job': return `DISPUTE OPENED on ${job.id}. The arbitrator will resolve the allocation.`;
      case 'resolve_job': return `DISPUTE RESOLVED on ${job.id}. The settlement is final.`;
      case 'timeout_job': return `TIMEOUT SETTLEMENT on ${job.id}. The escrow was allocated by the agreement's timeout policy.`;
      case 'submit_job': return `WORK SUBMITTED on ${job.id}. Verify the artifact commitment and release payment.`;
      case 'cancel_job': return `OFFER WITHDRAWN on ${job.id}. No work or payment will proceed.`;
      default: return null;
    }
  })();
  if (!text) return;
  if (action === 'verify_job' || action === 'release_escrow' || action === 'refund_escrow') {
    if (worker && worker !== actor) await notify(actor, worker, job.id, text);
    return;
  }
  if (action === 'submit_job') {
    if (requester !== actor) await notify(actor, requester, job.id, text);
    return;
  }
  if (other) await notify(actor, other, job.id, text);
}

/** Execute one SDK chat tool. `actor` comes from the authenticated credential. */
export async function chatToolCall(actor: string, tool: string, input: Record<string, unknown>): Promise<unknown> {
  if (!TOOLS.has(tool)) throw new Error(`unknown A423 tool ${tool}`);
  const bridge = await getA423Bridge();

  switch (tool) {
    case 'send_job_offer':
      return sendOffer(actor, input);
    case 'respond_to_offer': {
      const decision = String(input.decision ?? '').toLowerCase();
      if (decision === 'accept') return acceptOffer(actor, input);
      if (decision === 'counter') return counterOffer(actor, input, true);
      if (decision === 'reject' || decision === 'decline') return declineOffer(actor, input);
      throw new Error('decision must be accept, reject or counter');
    }
    case 'counter_offer':
      return counterOffer(actor, input);
    case 'accept_job_offer':
    case 'accept_quote':
      return acceptOffer(actor, input);
    case 'decline_job_offer':
      return declineOffer(actor, input);
    case 'sign_worker_consent':
      return signWorkerConsent(actor, input);
    case 'propose_settlement':
    case 'request_cancellation':
      return proposeSettlementAction(actor, input, 'propose_settlement');
    case 'counter_settlement':
      return proposeSettlementAction(actor, input, 'counter_settlement');
    case 'sign_cancellation_consent':
      return signCancellationConsent(actor, input);
    case 'accept_cancellation':
      return acceptCancellationAction(actor, input);
    case 'execute_cancellation':
      return executeCancellationAction(actor, input);
    case 'accept_settlement':
      return acceptSettlementAction(actor, input);
    case 'reopen_job': {
      const jobId = jobIdOf(input);
      if (typeof input.cancellation_id !== 'string' || !input.cancellation_id) throw new Error('reopen_job requires the current cancellation_id');
      return actWithRetry(actor, jobId, 'reopen', {
        cancellation_id: input.cancellation_id,
        ...(input.expected_epoch !== undefined ? { expected_epoch: input.expected_epoch } : {}),
      }, String(input.idempotency_key ?? `reopen-${jobId}-${input.cancellation_id}`), 4);
    }
    case 'work_on_job':
      return workOnJob(actor, input);
    case 'submit_job': {
      const resultHash = input.result_hash ?? input.resultHash;
      if (typeof resultHash !== 'string' || !/^0x[0-9a-fA-F]{64}$/.test(resultHash)) {
        throw new Error('submit_job requires a 0x-prefixed 32-byte result_hash; work_on_job/the execution runner submits the artifact automatically');
      }
      const jobId = jobIdOf(input);
      const key = String(input.idempotency_key ?? `submit-${jobId}-${resultHash}`);
      const submitted = await actWithRetry(actor, jobId, 'submit', { result_hash: resultHash }, key);
      await notifyTransition(submitted, actor, 'submit_job');
      return submitted;
    }
    case 'fund_escrow':
      return fundJob(actor, input);
    case 'propose_quote': {
      if (!input.terms) throw new Error('propose_quote requires a terms object; use counter_offer to revise a price');
      const jobId = jobIdOf(input);
      const updated = await bridge.app.workflow.act(jobId, 'quote', { terms: input.terms } as never, {
        actor,
        idempotencyKey: String(input.idempotency_key ?? `quote-${jobId}-${Date.now()}`),
      });
      await notifyNegotiation(updated, actor, 'counter', typeof input.note === 'string' ? input.note : undefined);
      return updated;
    }
    default: {
      const fn = bridge.app.chatTools(actor)[tool];
      if (!fn) throw new Error(`tool ${tool} is not available`);
      const jobId = jobIdOf(input);
      const transition: Record<string, string> = {
        submit_job: 'submit',
        verify_job: 'verify',
        release_escrow: 'release',
        refund_escrow: 'refund',
        dispute_job: 'dispute',
        resolve_job: 'resolve',
        timeout_job: 'timeout',
        cancel_job: 'cancel',
      };
      const action = transition[tool];
      const key = String(input.idempotency_key ?? `${action ?? tool}-${jobId}-${action ? (action === 'verify' || action === 'release' ? 1 : Date.now()) : 1}`);
      const job: WorkflowJob = action
        ? await actWithRetry(actor, jobId, action, input, key)
        : await fn({ ...input, job_id: jobId, idempotency_key: key });
      await notifyTransition(job, actor, tool);
      return job;
    }
  }
}

/** Helper for the agent prompt/tool description. */
export const A423_CHAT_ACTIONS = [
  'send_job_offer', 'respond_to_offer', 'counter_offer', 'accept_job_offer', 'decline_job_offer',
  'sign_worker_consent', 'sign_cancellation_consent', 'propose_settlement', 'counter_settlement',
  'accept_cancellation', 'execute_cancellation', 'accept_settlement', 'request_cancellation',
  'fund_escrow', 'work_on_job', 'submit_job', 'verify_job',
  'release_escrow', 'refund_escrow', 'dispute_job', 'resolve_job', 'timeout_job',
  'cancel_job', 'propose_quote',
] as const;

async function walletOf(agentId: string): Promise<string> {
  if (agentId === (process.env.A423_ARBITER_ID ?? 'a423-arbiter')) {
    const { Wallet } = await import('ethers');
    let key = process.env.A423_ARBITER_PRIVATE_KEY;
    if (!key) {
      const { readFileSync } = await import('fs');
      key = (JSON.parse(readFileSync(process.env.A423_ARBITER_WALLET_KEY_PATH!, 'utf8')) as { private_key: string }).private_key;
    }
    return new Wallet(key).address;
  }
  const db = getDb();
  const row = await db.query.agentWallets.findFirst({ where: eq(agentWallets.agentId, agentId) });
  if (!row) throw new Error('agent wallet missing');
  return row.address;
}

async function termsForChat(
  requester: string,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const bridge = await getA423Bridge();
  const workerId = String(input.worker_id ?? input.workerAgentId ?? '');
  const verifierId = String(input.verifier_id ?? requester);
  const arbiterId = String(input.arbitrator_id ?? process.env.A423_ARBITER_ID ?? 'a423-arbiter');
  if (!workerId) throw new Error('worker_id required');
  const db = getDb();
  for (const id of [workerId, verifierId, arbiterId]) {
    if (id === arbiterId) continue;
    const row = await db.query.agents.findFirst({ where: eq(agents.id, id) });
    if (!row) throw new Error(`unknown agent ${id}`);
  }
  const usdCents = Number(input.usdCents ?? input.usd_cents ?? 100);
  if (!Number.isSafeInteger(usdCents) || usdCents <= 0) throw new Error('usdCents must be a positive integer');
  const tokenPrice = process.env.DEMO_TOKEN_PRICE_USD ?? '0.02';
  const amountRaw = usdCentsToTokenRaw(usdCents, tokenPrice, 18).toString();
  // Use the later of the chain clock and wall clock so deadlines are not
  // already in the past.
  const latest = await bridge.provider.getBlock('latest');
  const chainNow = Math.max(latest ? Number(latest.timestamp) * 1000 : 0, Date.now());
  return buildTerms04({
    now: chainNow,
    taskId: `task-${randomUUID()}`,
    taskType: String(input.taskType ?? input.task_type ?? 'research'),
    description: String(input.description ?? 'A423 workflow task'),
    artifactPath: (() => {
      const requested = String(input.artifactPath ?? input.artifact_path ?? '/report.md');
      return isAllowedPath(requested) ? requested : '/report.md';
    })(),
    criteria: (input.criteria as Record<string, never>) ?? { minWords: 5, minChars: 20 },
    amountRaw,
    amountDecimals: 18,
    symbol: 'tWIF',
    chainId: bridge.chainId,
    escrow: bridge.escrowAddress,
    token: bridge.tokenAddress,
    requester: { agentId: requester, wallet: await walletOf(requester) },
    worker: { agentId: workerId, wallet: await walletOf(workerId) },
    verifier: { agentId: verifierId, wallet: await walletOf(verifierId) },
    arbitrator: { agentId: arbiterId, wallet: await walletOf(arbiterId) },
  }) as unknown as Record<string, unknown>;
}
