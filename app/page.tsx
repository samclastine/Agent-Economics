'use client';

import { displayTokenSymbol } from '@/lib/token-symbol';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Wallet, X, Square, Copy, Coins, MessageSquarePlus, Sparkles, Mail, CheckCircle2, Circle, Clock3, ChevronDown, ChevronRight, AlertTriangle } from 'lucide-react';

type Agent = { id: string; name: string; role: string; status: string };
type A423Job = {
  id: string;
  state: string;
  participants: Record<string, string>;
  agreement?: {
    hash: string;
    revision: number;
    accepted_by?: string[];
    terms?: Record<string, unknown>;
  } | null;
  created_at?: string;
  updated_at?: string;
  pending?: { action: string; actor: string } | null;
  evidence?: Array<{ action: string; evidence: Record<string, unknown> }>;
  events?: Array<{ sequence: number; type: string; actor_id: string; at: string; data?: Record<string, unknown> }>;
  safety?: { blocked: boolean; checked_at?: string } | null;
  metadata?: Record<string, unknown>;
  submission?: { result_hash?: string } | null;
  consent?: { signed: boolean; at?: string; revision?: number; hash?: string } | null;
  work_status?: string | null;
  negotiation?: {
    status: string;
    origin_state: string;
    current?: {
      version: string;
      worker_amount: string;
      payer_amount: string;
      escrow_version: number;
      expires_at: number;
      reason: string;
      claims: Array<{ kind: string; description: string; amount?: string; evidence?: string[] }>;
      proposal_hash: string;
      proposer_id?: string;
      at?: string;
    } | null;
    history?: Array<Record<string, unknown>>;
    accepted_by?: string;
    settled_at?: string;
  } | null;
  escrow_ledger?: { funded_amount: string; worker_paid: string; payer_refunded: string; locked_amount: string; escrow_version: number } | null;
  subflows?: Array<{
    id: string;
    kind: 'cancellation';
    parent_job_id: string;
    status: string;
    proposal_revision: number;
    accepted_at?: string;
    completed_at?: string;
    instruction?: {
      id: string;
      funds_status: string;
      proposal_hash: string;
      expires_at: number;
      worker: { agent_id: string; address: string; amount: string };
      payer: { agent_id: string; address: string; amount: string };
    } | null;
    receipt?: {
      id: string;
      status: string;
      outcome?: string;
      instruction_id?: string | null;
      prior_instruction_id?: string | null;
      allocations: { worker: { address: string; amount: string }; payer: { address: string; amount: string } };
      remaining_locked: '0';
      evidence?: Record<string, unknown>;
    } | null;
    closing_action?: string;
    last_error?: string | null;
    events?: Array<{ sequence: number; type: string; actor_id: string; at: string; data: Record<string, unknown> }>;
  }>;
  active_subflow_id?: string | null;
  cancellation_signers?: { payer: boolean; worker: boolean; proposal_hash: string | null } | null;
  profit?: {
    advisory?: true;
    cost_basis_raw?: string;
    target_margin_bps?: number;
    min_margin_bps?: number;
    max_margin_bps?: number;
    target_payout?: string;
    min_payout?: string;
    max_payout?: string;
    recommended_payout?: string;
    expected_profit?: string;
    expected_margin_bps?: string | null;
    projected_payout_raw?: string;
    projected_profit_raw?: string;
    projected_margin_bps?: string | null;
    realized_payout_raw?: string | null;
    realized_profit_raw?: string | null;
    realized_margin_bps?: string | null;
    target_status?: 'target_met' | 'below_target';
    receipt_confirmed?: boolean;
    basis_frozen?: boolean;
    evidence_status?: string;
    proposed_payout_raw?: string | null;
  } | null;
  work_meter?: {
    mock: true;
    job_id: string;
    started_at: string | null;
    frozen_at: string | null;
    progress_percent: number;
    work_completed: string;
    tokens_used: string;
    token_unit_cost_usd: string;
    estimated_cost_usd: string;
    estimated_cost_cents: number;
    recovery_raw: string;
    recovery_token_symbol: string;
    recovery_usd: string;
    note: string;
  } | null;
};

type A423Stage = {
  key: string;
  label: string;
  done: boolean;
  active?: boolean;
  at?: string;
  detail?: string;
  tx?: string;
  tone?: 'ok' | 'warn' | 'bad' | 'muted';
  branch?: boolean;
};
type Wallet = {
  agent: { id: string; name: string; role: string };
  wallet: { address: string; chainId: number; paused: boolean };
  token: { address: string; spendableRaw: string; lockedInEscrowRaw: string; decimals: number; symbol: string; isMock: boolean };
  gas: { ethBalanceWei: string };
  escrows: { id: string; jobId: string; amountRaw: string; state: string; role?: string }[];
};
type EventItem = { id: string; type: string; payload: Record<string, unknown>; agentId?: string; jobId?: string; runId?: string; createdAt: string; ephemeral?: boolean; replay?: boolean };
type ChatMsg = { key: string; role: 'user' | 'agent'; text: string; cid?: string | null; prefix?: string; kind?: 'tool' | 'think' | 'speak' };
type FeedItem = { key: string; text: string; ts: number };
type ChainConfig = { chainId: number; chainName?: string; tokenSymbol?: string; rpcUrl: string; mockWif: string | null; escrowAddress: string | null; tokenPriceUsd: string; explorerUrl?: string | null };

const TEST_JOB_PREFIXES = ['debug-', 'wf04-', 'refund-', 'timeout-', 'dispute-', 'safety-', 'cap-', 'wrong-', 'neg-'];
const isTestWorkflow = (id: string) => TEST_JOB_PREFIXES.some((prefix) => id.startsWith(prefix));

const TASK_SUGGESTIONS: Record<'dispatcher' | 'worker', string[]> = {
  dispatcher: [
    'Use a423_job_action to assign Agent B a $1 research report on AI agent marketplaces. Include the workflow id and state in your reply.',
    'Hire Agent B for a 150–250 word product brief about Agent Treasury, budget $1, deliverable /report.md.',
    'Ask Agent B to produce a five-step launch verification checklist and quote the price before work starts.',
    'Assign Agent B a frontend landing-page preview task with a $2 budget and clear acceptance criteria.',
    'Ask Agent B for a backend API outline with an OpenAPI file and tests, budget $2.',
    'List my A423 jobs with a423_list_jobs and summarize the latest offer and its exact workflow ID.',
  ],
  worker: [
    'List my A423 jobs with a423_list_jobs, then respond to the latest offer with a423_job_action.',
    'Use a423_job_status on my newest offer, then accept it if the price and deadline are clear.',
    'Counter the open A423 offer within the stated budget with a short rationale.',
    'Ask Agent A for clearer acceptance criteria before accepting the task.',
    'Summarize the current task, its artifact path and deadline before starting.',
    'Check the A423 workflow status and report what is pending.',
  ],
};
type IdentityBootstrapAgent = {
  app_agent_id: string; agent_id: string; agent_name: string; org_id: string;
  org_public_key: string; agent_public_key: string;
  status: 'pending' | 'verified'; verified: boolean; expires_at: string | null;
};
type IdentityBootstrap = {
  governor: { key_id: string; algorithm: 'ed25519'; public_key: string };
  agents: IdentityBootstrapAgent[];
};

const fmt2 = (raw: string, decimals = 18) => {
  const v = Number(BigInt(raw)) / 10 ** decimals;
  return v.toLocaleString(undefined, { maximumFractionDigits: 2 });
};
const fmtEth = (wei: string) => (Number(BigInt(wei)) / 1e18).toFixed(4);
const short = (s?: string | null, n = 10) => (s ? `${s.slice(0, Math.max(4, n - 4))}…${s.slice(-4)}` : '—');
function a423Terms(job: A423Job): Record<string, unknown> {
  return (job.agreement?.terms ?? {}) as Record<string, unknown>;
}

function a423Price(job: A423Job): string {
  const terms = a423Terms(job);
  const cents = Number(terms.price_usd_cents);
  if (Number.isSafeInteger(cents) && cents > 0) return `$${(cents / 100).toFixed(2)}`;
  const escrow = (terms.escrow ?? {}) as Record<string, unknown>;
  return typeof escrow.amount === 'string' ? `${escrow.amount} raw` : '—';
}

function a423Amount(job: A423Job): string {
  const terms = a423Terms(job);
  const escrow = (terms.escrow ?? {}) as Record<string, unknown>;
  if (typeof escrow.amount !== 'string' || !/^\d+$/.test(escrow.amount)) return '—';
  const decimals = Number(terms.token_decimals ?? 18);
  const symbol = displayTokenSymbol(typeof terms.token_symbol === 'string' ? terms.token_symbol : null);
  return `${fmt2(escrow.amount, Number.isSafeInteger(decimals) ? decimals : 18)} ${symbol}`;
}

function a423TokenText(raw: unknown, job: A423Job): string {
  if (typeof raw !== 'string' || !/^-?\d+$/.test(raw)) return '—';
  const negative = raw.startsWith('-');
  const digits = negative ? raw.slice(1) : raw;
  const terms = a423Terms(job);
  const decimals = Number(terms.token_decimals ?? 18);
  const symbol = displayTokenSymbol(typeof terms.token_symbol === 'string' ? terms.token_symbol : null);
  return `${negative ? '-' : ''}${fmt2(digits, Number.isSafeInteger(decimals) ? decimals : 18)} ${symbol}`;
}

function a423Time(iso?: string): string {
  return iso ? new Date(iso).toLocaleString() : '—';
}

function bpsText(value?: string | number | null): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? `${(n / 100).toFixed(2)}%` : '—';
}

function a423StateColor(job: A423Job): string {
  if (job.safety?.blocked) return 'text-red-400';
  if (job.state === 'paid' || job.state === 'settled') return 'text-emerald-400';
  if (job.state === 'cancelled' || job.state === 'expired' || job.state === 'refunded') return 'text-zinc-400';
  if (job.state === 'disputed') return 'text-red-300';
  return 'text-amber-300';
}

function a423Stages(job: A423Job): A423Stage[] {
  const events = job.events ?? [];
  const evidence = job.evidence ?? [];
  const accepted = new Set(job.agreement?.accepted_by ?? []);
  const eventFor = (action: string, actor?: string) => [...events].reverse().find((event) => {
    const matches = event.type === action || event.type.startsWith(`${action}.`);
    return matches && (!actor || event.actor_id === actor);
  });
  const evidenceFor = (action: string) => [...evidence].reverse().find((item) => item.action === action)?.evidence;
  const when = (event?: { at?: string }, proof?: Record<string, unknown>) =>
    event?.at ?? (typeof proof?.observed_at === 'string' ? proof.observed_at : undefined);
  const tx = (proof?: Record<string, unknown>) =>
    typeof proof?.transaction_hash === 'string' ? proof.transaction_hash : undefined;
  const stateIn = (...states: string[]) => states.includes(job.state);

  const fund = evidenceFor('fund');
  const start = evidenceFor('start');
  const submit = evidenceFor('submit');
  const verify = evidenceFor('verify');
  const release = evidenceFor('release');
  const refund = evidenceFor('refund');
  const dispute = evidenceFor('dispute');
  const resolve = evidenceFor('resolve');
  const timeout = evidenceFor('timeout');
  const consent = job.consent?.signed === true;
  const requesterAccepted = accepted.has(job.participants.requester);
  const workerAccepted = accepted.has(job.participants.worker);

  const steps: A423Stage[] = [
    {
      key: 'created', label: 'Job created', done: true, tone: 'ok',
      at: job.created_at, detail: 'A423 workflow record persisted',
    },
    {
      key: 'quoted', label: 'Offer quoted', done: !!job.agreement, tone: 'ok',
      at: eventFor('quote')?.at,
      detail: job.agreement ? `Revision ${job.agreement.revision} · ${a423Price(job)} · ${a423Amount(job)}` : 'Waiting for the first quote',
    },
    {
      key: 'requester_accepted', label: 'Requester accepted', done: requesterAccepted, tone: 'ok',
      at: requesterAccepted ? eventFor('accept', job.participants.requester)?.at : undefined,
      detail: requesterAccepted ? 'Accepted the current revision' : 'Not accepted yet',
    },
    {
      key: 'worker_accepted', label: 'Worker accepted', done: workerAccepted, tone: 'ok',
      at: workerAccepted ? eventFor('accept', job.participants.worker)?.at : undefined,
      detail: workerAccepted ? 'Accepted the current revision' : 'Waiting for the worker',
    },
    {
      key: 'consent', label: 'Worker consent signed', done: consent || !!fund || stateIn('funded', 'running', 'submitted', 'verified', 'paid'), tone: 'ok',
      at: job.consent?.at ?? when(eventFor('fund'), fund),
      detail: consent ? 'EIP-712 consent stored for this revision' : fund ? 'Consent verified during funding' : 'Waiting for the worker signature',
    },
    {
      key: 'funded', label: 'Escrow funded', done: !!fund || stateIn('funded', 'running', 'submitted', 'verified', 'paid'), tone: 'ok',
      at: when(eventFor('fund'), fund),
      detail: fund ? `Funding confirmed${tx(fund) ? ` · ${short(tx(fund))}` : ''}` : 'Waiting for requester funding',
      tx: tx(fund),
    },
    {
      key: 'started', label: 'Work started', done: !!start || stateIn('running', 'submitted', 'verified', 'paid'), tone: 'ok',
      at: when(eventFor('start'), start),
      detail: start ? 'Worker checked custody and began' : 'Waiting for the worker to start',
    },
    {
      key: 'submitted', label: 'Work submitted', done: !!submit || !!job.submission || stateIn('submitted', 'verified', 'paid'), tone: 'ok',
      at: when(eventFor('submit'), submit),
      detail: job.submission?.result_hash ? `Artifact commitment ${short(job.submission.result_hash)}` : submit ? 'Artifact commitment on-chain' : 'Waiting for submission',
    },
    {
      key: 'verified', label: 'Artifact verified', done: !!verify || stateIn('verified', 'paid'), tone: 'ok',
      at: when(eventFor('verify'), verify),
      detail: verify ? 'Deterministic validator passed' : 'Waiting for verifier review',
    },
    {
      key: 'released', label: 'Payment released', done: !!release || job.state === 'paid', tone: 'ok',
      at: when(eventFor('release'), release),
      detail: release ? `Worker paid · ${a423Amount(job)}` : job.state === 'paid' ? 'Escrow settled to the worker' : 'Waiting for release',
      tx: tx(release),
    },
  ];

  const closingSettlement = !!job.negotiation && ['accepted', 'settled'].includes(job.negotiation.status);
  if (dispute || stateIn('disputed', 'resolved') || (job.state === 'settled' && !release && !closingSettlement && !resolve && !timeout)) {
    steps.push({
      key: 'disputed', label: 'Dispute opened', done: true, branch: true, tone: 'warn',
      at: when(eventFor('dispute'), dispute),
      detail: dispute ? 'Submitted to the arbitrator' : 'Workflow entered dispute',
      tx: tx(dispute),
    });
  }
  if (resolve || stateIn('resolved')) {
    steps.push({
      key: 'resolved', label: 'Dispute resolved', done: true, branch: true, tone: 'ok',
      at: when(eventFor('resolve'), resolve),
      detail: resolve ? 'Arbitrator allocation executed' : 'Resolution recorded',
      tx: tx(resolve),
    });
  }
  if (timeout || (job.state === 'settled' && !release && !resolve && !closingSettlement)) {
    steps.push({
      key: 'timeout', label: 'Timeout settlement', done: true, branch: true, tone: 'warn',
      at: when(eventFor('timeout'), timeout),
      detail: timeout ? 'Agreement timeout allocation executed' : 'Timeout policy applied',
      tx: tx(timeout),
    });
  }
  if (refund || job.state === 'refunded') {
    steps.push({
      key: 'refunded', label: 'Refunded to requester', done: true, branch: true, tone: 'bad',
      at: when(eventFor('refund'), refund),
      detail: refund ? 'Escrow refunded after expiry' : 'Refund recorded',
      tx: tx(refund),
    });
  }
  if (job.state === 'cancelled') {
    steps.push({
      key: 'cancelled', label: 'Offer cancelled', done: true, branch: true, tone: 'muted',
      at: eventFor('cancel')?.at, detail: 'No work or payment will proceed',
    });
  }
  if (job.state === 'expired') {
    steps.push({
      key: 'expired', label: 'Offer expired', done: true, branch: true, tone: 'muted',
      at: eventFor('expire')?.at, detail: 'Quote expired before acceptance',
    });
  }
  if (job.safety?.blocked) {
    steps.push({
      key: 'safety', label: 'Safety hold', done: true, branch: true, tone: 'bad',
      at: job.safety.checked_at, detail: 'Execution blocked until evidence is reconciled',
    });
  }

  const negotiation = job.negotiation;
  const cancellation = (job.subflows ?? []).find((subflow) => subflow.kind === 'cancellation');
  if (negotiation?.current) {
    const proposal = negotiation.current;
    steps.push({
      key: 'closing_proposal', label: 'Closing proposal published', done: true, branch: true, tone: 'warn',
      at: proposal.at,
      detail: `Revision ${proposal.escrow_version} · worker ${a423TokenText(proposal.worker_amount, job)} · payer ${a423TokenText(proposal.payer_amount, job)}`,
    });
    if ((negotiation.history?.length ?? 0) > 1) {
      steps.push({
        key: 'closing_counter', label: `Counterproposal (${negotiation.history?.length ?? 0} revisions)`, done: true, branch: true, tone: 'warn',
        at: proposal.at,
        detail: proposal.reason,
      });
    }
    const payerSigned = job.cancellation_signers?.payer === true;
    const workerSigned = job.cancellation_signers?.worker === true;
    steps.push({
      key: 'closing_signatures', label: 'Both parties signed closing terms', done: payerSigned && workerSigned, branch: true, tone: 'ok',
      detail: `Payer ${payerSigned ? 'signed' : 'not signed'} · worker ${workerSigned ? 'signed' : 'not signed'}`,
    });
    const accepted = negotiation.status === 'accepted' || negotiation.status === 'settled' || !!cancellation?.instruction;
    steps.push({
      key: 'closing_acceptance', label: 'Cancellation accepted', done: accepted, branch: true, tone: 'ok',
      at: cancellation?.accepted_at,
      detail: cancellation?.instruction
        ? `Instruction ${short(cancellation.instruction.id)} · funds_status=${cancellation.instruction.funds_status} (authorization only)`
        : 'Acceptance authorizes closure; it is not proof of payment.',
    });
    steps.push({
      key: 'closing_execution', label: 'Cancellation executed', done: cancellation?.status === 'completed' || !!cancellation?.receipt, branch: true, tone: 'ok',
      at: cancellation?.completed_at,
      detail: cancellation?.receipt
        ? `Worker ${a423TokenText(cancellation.receipt.allocations.worker.amount, job)} · payer ${a423TokenText(cancellation.receipt.allocations.payer.amount, job)} · remaining 0`
        : 'No payment receipt until confirmed execution.',
    });
  }

  const terminal = ['paid', 'settled', 'resolved', 'cancelled', 'expired', 'refunded'].includes(job.state);
  const paused = job.state === 'settlement_negotiation' || job.state === 'disputed';
  if (!terminal && !paused) {
    const firstPending = steps.find((step) => !step.done && !step.branch);
    if (firstPending) firstPending.active = true;
  }
  return steps;
}

function describeEvent(e: EventItem): string {
  const p = e.payload ?? {};
  switch (e.type) {
    case 'chat.user': return `you: ${String(p.message ?? '').slice(0, 80)}`;
    case 'chat.reply': return 'agent replied';
    case 'chat.session': return 'new chat session started';
    case 'peer.message': return `${p.fromName ?? 'agent'} → you: ${String(p.text ?? '').slice(0, 70)}`;
    case 'peer.reply': return 'agent replied to peer message';
    case 'peer.inbound': return `${p.fromName ?? 'agent'} replied`;
    case 'peer.tool': case 'chat.tool': return `tool call: ${String(p.name ?? '')}`;
    case 'peer.error': case 'peer.cancelled': return `peer message ${e.type === 'peer.error' ? 'failed' : 'cancelled'}: ${String(p.error ?? '').slice(0, 50)}`;
    case 'peer.muted': return `peer exchange muted: ${String(p.reason ?? '')}`;
    case 'chat.error': case 'chat.cancelled': return `chat ${e.type === 'chat.error' ? 'error' : 'cancelled'}: ${String(p.error ?? '').slice(0, 60)}`;
    default: return '';
  }
}

export default function Dashboard() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [a423Jobs, setA423Jobs] = useState<A423Job[]>([]);
  const [showTestWorkflows, setShowTestWorkflows] = useState(false);
  const [wallets, setWallets] = useState<Record<string, Wallet>>({});
  const [events, setEvents] = useState<EventItem[]>([]);
  const [selectedA423Job, setSelectedA423Job] = useState<string | null>(null);
  const [expandedA423Job, setExpandedA423Job] = useState<string | null>(null);
  const [chatInputs, setChatInputs] = useState<Record<string, string>>({});
  const [suggestOpen, setSuggestOpen] = useState<Record<string, boolean>>({});
  const [inboxOpen, setInboxOpen] = useState<Record<string, boolean>>({});
  const [chatLogs, setChatLogs] = useState<Record<string, ChatMsg[]>>({});
  const [pendingChat, setPendingChat] = useState<Record<string, boolean>>({});
  const [streamText, setStreamText] = useState<Record<string, string>>({});
  const [reasonText, setReasonText] = useState<Record<string, string>>({});
  const streamRef = useRef<Record<string, string>>({});
  const reasonRef = useRef<Record<string, string>>({});
  // Live-run bookkeeping. `pendingChat` drives the UI busy state, but the
  // streaming buffers are shared by two independent server runs per agent
  // (`chat:*` turns and `peer:*` mailbox runs), so we track which one owns
  // them. A peer run must never bleed its tokens into a user chat turn.
  const pendingChatRef = useRef<Record<string, boolean>>({});
  const chatBusyRef = useRef<Record<string, boolean>>({});
  const peerBusyRef = useRef<Record<string, boolean>>({});
  const activeChatCidRef = useRef<Record<string, string | undefined>>({});
  const newSessionCidRef = useRef<Record<string, string | undefined>>({});
  const sessionEpochRef = useRef<Record<string, number>>({});
  const deferredPeerRef = useRef<Record<string, ChatMsg[]>>({});
  const [newSessPending, setNewSessPending] = useState<Record<string, boolean>>({});
  const [walletOpen, setWalletOpen] = useState<Record<string, boolean>>({});
  const [localFeed, setLocalFeed] = useState<Record<string, FeedItem[]>>({});
  const [config, setConfig] = useState<ChainConfig | null>(null);
  const [identityGate, setIdentityGate] = useState<'loading' | 'ready' | 'error'>('loading');
  const [identityInfo, setIdentityInfo] = useState<IdentityBootstrap | null>(null);
  const [identityError, setIdentityError] = useState('');
  const [identityModalOpen, setIdentityModalOpen] = useState(true);
  const lastEventId = useRef('0');
  // Current viewed checkpoint session per agent: 'main' | session-uuid | 'NEW' (pending first msg).
  const sessRef = useRef<Record<string, string>>({});
  const refreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chatBoxRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const feedRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const evidenceRef = useRef<HTMLDivElement | null>(null);

  const bootstrapIdentity = useCallback(async () => {
    try {
      const res = await fetch('/api/a423-identity/status');
      const data = await res.json();
      if (!res.ok || !data.ok) throw new Error(data.error?.message ?? 'identity bootstrap failed');
      setIdentityInfo({ governor: data.governor, agents: data.agents ?? [] });
      setIdentityGate('ready');
    } catch (e) {
      setIdentityError(e instanceof Error ? e.message : String(e));
      setIdentityGate('error');
    }
  }, []);

  const retryIdentity = useCallback(() => {
    setIdentityGate('loading');
    setIdentityError('');
    setIdentityModalOpen(true);
    void bootstrapIdentity();
  }, [bootstrapIdentity]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/a423-identity/status');
        const data = await res.json();
        if (cancelled) return;
        if (!res.ok || !data.ok) throw new Error(data.error?.message ?? 'identity bootstrap failed');
        setIdentityInfo({ governor: data.governor, agents: data.agents ?? [] });
        setIdentityGate('ready');
      } catch (e) {
        if (!cancelled) {
          setIdentityError(e instanceof Error ? e.message : String(e));
          setIdentityGate('error');
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);
  useEffect(() => {
    if (identityGate !== 'ready') return;
    const t = setTimeout(() => setIdentityModalOpen(false), 1200);
    return () => clearTimeout(t);
  }, [identityGate]);

  const refresh = useCallback(async () => {
    try {
      const agentList = await fetch('/api/agents').then((r) => r.json());
      const agentsArr: Agent[] = agentList.agents ?? [];
      const [s, w] = await Promise.all([
        fetch('/api/state').then((r) => r.json()),
        Promise.all(
          agentsArr.map((ag) =>
            fetch(`/api/agents/${ag.id}/wallet`).then((r) => r.json()).then((w) => [ag.id, w] as const).catch(() => null),
          ),
        ),
      ]);
      setAgents(agentsArr);
      setA423Jobs(s.a423?.jobs ?? []);
      const wm: Record<string, Wallet> = {};
      for (const entry of w) if (entry) wm[entry[0]] = entry[1];
      setWallets(wm);
    } catch { /* ignore */ }
  }, []);

  const refreshSoon = useCallback(() => {
    if (refreshTimer.current) return;
    refreshTimer.current = setTimeout(() => {
      refreshTimer.current = null;
      refresh();
    }, 800);
  }, [refresh]);

  const appendChat = useCallback((agentId: string, msg: ChatMsg) => {
    setChatLogs((p) => {
      const log = p[agentId] ?? [];
      if (msg.cid && log.some((m) => m.cid === msg.cid && m.role === msg.role)) return p;
      if (log.some((m) => m.key === msg.key)) return p;
      return { ...p, [agentId]: [...log, msg].slice(-300) };
    });
  }, []);

  // Persist the streamed thinking/speaking text into the transcript when a run
  // finalizes. The server now sends both totals with the final event, so the
  // blocks survive reloads and can't be lost when the HTTP response beats the
  // SSE reply (the old ref-only flush had that race).
  const persistBlocks = useCallback((agentId: string, keyId: string, reasoning: unknown, speech: unknown) => {
    const r = (typeof reasoning === 'string' ? reasoning : reasonRef.current[agentId] ?? '').trim();
    const s = (typeof speech === 'string' ? speech : streamRef.current[agentId] ?? '').trim();
    if (r) appendChat(agentId, { key: `think-${keyId}`, role: 'agent', text: r, kind: 'think' });
    if (s) appendChat(agentId, { key: `speak-${keyId}`, role: 'agent', text: s, kind: 'speak' });
  }, [appendChat]);

  const clearLive = useCallback((agentId: string) => {
    reasonRef.current[agentId] = '';
    streamRef.current[agentId] = '';
    setReasonText((p) => (p[agentId] ? { ...p, [agentId]: '' } : p));
    setStreamText((p) => (p[agentId] ? { ...p, [agentId]: '' } : p));
  }, []);

  const setBusy = useCallback((agentId: string, busy: boolean) => {
    pendingChatRef.current[agentId] = busy;
    setPendingChat((p) => (p[agentId] === busy ? p : { ...p, [agentId]: busy }));
  }, []);

  // Peer mail that arrives while the user is mid-chat is queued so it cannot
  // split the live stream across two run cards; it flushes after the chat turn.
  const appendOrQueuePeer = useCallback((agentId: string, msgs: ChatMsg[]) => {
    if (chatBusyRef.current[agentId]) {
      deferredPeerRef.current[agentId] = [...(deferredPeerRef.current[agentId] ?? []), ...msgs].slice(-80);
      return;
    }
    for (const msg of msgs) appendChat(agentId, msg);
  }, [appendChat]);

  const flushPeer = useCallback((agentId: string) => {
    const queued = deferredPeerRef.current[agentId];
    if (!queued?.length) return;
    deferredPeerRef.current[agentId] = [];
    for (const msg of queued) appendChat(agentId, msg);
  }, [appendChat]);

  const finishChatRun = useCallback((agentId: string, cid: string | null) => {
    // A newer turn may already own the live buffers — never clear those.
    if (cid && activeChatCidRef.current[agentId] !== cid) return false;
    activeChatCidRef.current[agentId] = undefined;
    chatBusyRef.current[agentId] = false;
    clearLive(agentId);
    flushPeer(agentId);
    if (!peerBusyRef.current[agentId]) setBusy(agentId, false);
    return true;
  }, [clearLive, flushPeer, setBusy]);

  const addFeed = useCallback((agentId: string, text: string) => {
    setLocalFeed((p) => ({
      ...p,
      [agentId]: [...(p[agentId] ?? []), { key: `l${Date.now()}${Math.random()}`, text, ts: Date.now() }].slice(-60),
    }));
  }, []);

  const sessKey = useCallback((agentId: string) => `chat-session-${agentId}`, []);
  const baseThread = useCallback((agentId: string) => `agent:${agentId}:chat`, []);
  const sessionOf = useCallback((agentId: string, thread: unknown): string => {
    const t = typeof thread === 'string' ? thread : '';
    if (!t || t === baseThread(agentId)) return 'main';
    return t.split(':chat:')[1] ?? 'main';
  }, [baseThread]);
  const viewSession = useCallback((agentId: string): string => {
    if (sessRef.current[agentId] !== undefined) return sessRef.current[agentId];
    let s = 'main';
    try { s = localStorage.getItem(sessKey(agentId)) || 'main'; } catch { /* ignore */ }
    sessRef.current[agentId] = s;
    return s;
  }, [sessKey]);
  /** Does a chat event belong to the session currently shown for this agent? */
  const sessionMatches = useCallback((agentId: string, thread: unknown, clientId?: string): boolean => {
    const view = viewSession(agentId);
    const sess = sessionOf(agentId, thread);
    if (view === 'NEW') {
      // Before the first message of a fresh session, only accept that
      // message's own run (identified by its client id). Otherwise a still
      // running earlier session would stream into the just-cleared panel.
      const pendingCid = newSessionCidRef.current[agentId];
      return !!pendingCid && clientId === pendingCid;
    }
    return sess === view;
  }, [sessionOf, viewSession]);
  const adoptSession = useCallback((agentId: string, thread: unknown) => {
    const sess = sessionOf(agentId, thread);
    if (sess === 'main') return;
    sessRef.current[agentId] = sess;
    newSessionCidRef.current[agentId] = undefined;
    try { localStorage.setItem(sessKey(agentId), sess); } catch { /* ignore */ }
    setNewSessPending((p) => ({ ...p, [agentId]: false }));
  }, [sessionOf, sessKey]);

  useEffect(() => {
    void Promise.resolve().then(refresh);
    fetch('/api/config').then((r) => r.json()).then(setConfig).catch(() => undefined);
    const handleEvent = (evt: EventItem) => {
      try {
        const t = evt.type;
        const p = (evt.payload ?? {}) as Record<string, unknown>;
        const agentId = evt.agentId;

        // Ephemeral token deltas: never persisted, so they bypass id dedupe.
        if (evt.ephemeral) {
          if (!agentId) return;
          const isReason = t === 'chat.reasoning' || t === 'peer.reasoning';
          const isSpeech = t === 'chat.delta' || t === 'peer.delta';
          if (!isReason && !isSpeech) return;
          const text = String(p.text ?? '');
          if (!text) return;
          if (t.startsWith('chat.')) {
            const cid = typeof p.clientId === 'string' ? p.clientId : undefined;
            if (!sessionMatches(agentId, p.thread, cid)) return;
          } else if (chatBusyRef.current[agentId]) {
            // A mailbox run overlapping a user chat turn: its full reasoning
            // and speech arrive with peer.reply, so keep the live chat clean.
            return;
          }
          const setter = isReason ? setReasonText : setStreamText;
          const ref = isReason ? reasonRef : streamRef;
          ref.current[agentId] = (ref.current[agentId] ?? '') + text;
          setter((prev) => ({ ...prev, [agentId]: (prev[agentId] ?? '') + text }));
          return;
        }

        // Persisted event: replay or live broadcast. Dedupe by database id.
        if (BigInt(evt.id) <= BigInt(lastEventId.current)) return;
        lastEventId.current = evt.id;
        setEvents((prev) => [...prev.slice(-300), evt]);
        if (!agentId) { refreshSoon(); return; }

        // Replays rebuild the transcript for the session being viewed. Old
        // agent-to-agent mail is not part of a chat thread, so it stays in the
        // activity feed instead of being injected into an unrelated session.
        if (evt.replay && t.startsWith('peer.')) { refreshSoon(); return; }

        if (t.startsWith('peer.')) {
          const fromName = String(p.fromName ?? 'Agent');
          if (t === 'peer.message') {
            peerBusyRef.current[agentId] = true;
            setBusy(agentId, true);
            // Fresh mailbox run — drop any tail left by the previous one.
            if (!chatBusyRef.current[agentId]) clearLive(agentId);
            appendOrQueuePeer(agentId, [
              { key: `e${evt.id}`, role: 'agent', text: String(p.text ?? ''), prefix: `${fromName} ▸` },
            ]);
          } else if (t === 'peer.tool') {
            appendOrQueuePeer(agentId, [
              { key: `e${evt.id}`, role: 'agent', text: `⚙ ${String(p.name ?? 'tool')}`, kind: 'tool' },
            ]);
          } else if (t === 'peer.reply') {
            persistBlocks(agentId, `e${evt.id}`, p.reasoning, p.speech);
            const text = String(p.text ?? '');
            if (text.trim()) appendOrQueuePeer(agentId, [{ key: `e${evt.id}`, role: 'agent', text }]);
            peerBusyRef.current[agentId] = false;
            if (!chatBusyRef.current[agentId]) {
              clearLive(agentId);
              setBusy(agentId, false);
              flushPeer(agentId);
            }
          } else if (t === 'peer.inbound') {
            appendOrQueuePeer(agentId, [
              { key: `e${evt.id}`, role: 'agent', text: String(p.text ?? ''), prefix: `${fromName} ▸` },
            ]);
          } else if (t === 'peer.error' || t === 'peer.cancelled') {
            persistBlocks(agentId, `e${evt.id}`, p.reasoning, p.speech);
            appendOrQueuePeer(agentId, [
              { key: `e${evt.id}`, role: 'agent', text: `⚠ ${String(p.error ?? 'peer stopped')}` },
            ]);
            peerBusyRef.current[agentId] = false;
            if (!chatBusyRef.current[agentId]) {
              clearLive(agentId);
              setBusy(agentId, false);
              flushPeer(agentId);
            }
          }
        } else if (t === 'chat.user' || t === 'chat.reply' || t === 'chat.error' || t === 'chat.cancelled' || t === 'chat.session' || t === 'chat.tool') {
          const cid = typeof p.clientId === 'string' ? p.clientId : null;
          if (!sessionMatches(agentId, p.thread, cid ?? undefined)) { refreshSoon(); return; }
          if (!evt.replay && viewSession(agentId) === 'NEW') adoptSession(agentId, p.thread);
          if (t === 'chat.user') {
            appendChat(agentId, { key: `e${evt.id}`, role: 'user', text: String(p.message ?? ''), cid });
          } else if (t === 'chat.tool') {
            appendChat(agentId, { key: `e${evt.id}`, role: 'agent', text: `⚙ ${String(p.name ?? 'tool')}`, kind: 'tool' });
          } else if (t === 'chat.session') {
            // handled via feed label; nothing to append
          } else {
            const keyId = cid || `e${evt.id}`;
            persistBlocks(agentId, keyId, p.reasoning, p.speech);
            const text = t === 'chat.reply' ? String(p.reply ?? '') : `⚠ ${String(p.error ?? 'stopped')}`;
            if (t !== 'chat.reply' || text.trim()) {
              appendChat(agentId, { key: `e${evt.id}`, role: 'agent', text, cid });
            }
            if (!evt.replay) finishChatRun(agentId, cid);
          }
        }
        refreshSoon();
      } catch { /* ignore malformed event */ }
    };

    // Cloudflare Quick Tunnels buffer SSE GET responses, but stream POST
    // responses, so the live feed is read with fetch() instead of EventSource.
    // If the stream still stays silent (e.g. another buffering proxy), fall
    // back to polling the persisted log so the UI keeps updating.
    let polling: ReturnType<typeof setInterval> | null = null;
    const pollOnce = async () => {
      try {
        const after = lastEventId.current;
        const r = await fetch(after === '0' ? '/api/events?latest=1' : `/api/events?after=${after}`);
        const data = await r.json();
        for (const evt of (data.events ?? []) as EventItem[]) {
          handleEvent({ ...evt, replay: after === '0' });
        }
      } catch { /* ignore */ }
    };
    const startPolling = () => {
      if (polling) return;
      polling = setInterval(() => { void pollOnce(); }, 2000);
      void pollOnce();
    };
    const fallback = setTimeout(startPolling, 5000);

    const abort = new AbortController();
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    const startStream = async () => {
      try {
        const res = await fetch('/api/events/stream', {
          method: 'POST',
          headers: { Accept: 'text/event-stream' },
          signal: abort.signal,
        });
        if (!res.body) throw new Error('no stream body');
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let sep: number;
          while ((sep = buf.indexOf('\n\n')) >= 0) {
            const frame = buf.slice(0, sep);
            buf = buf.slice(sep + 2);
            for (const line of frame.split('\n')) {
              if (!line.startsWith('data:')) continue;
              // Live data proves the stream works — cancel the poll fallback.
              clearTimeout(fallback);
              if (polling) { clearInterval(polling); polling = null; }
              try { handleEvent(JSON.parse(line.slice(5).trim()) as EventItem); } catch { /* ignore */ }
            }
          }
        }
      } catch { /* aborted or network error */ }
      if (!abort.signal.aborted) {
        retryTimer = setTimeout(() => { void startStream(); }, 1500);
      }
    };
    void startStream();

    return () => {
      clearTimeout(fallback);
      if (retryTimer) clearTimeout(retryTimer);
      if (polling) clearInterval(polling);
      abort.abort();
    };
  }, [refresh, refreshSoon, appendChat, persistBlocks, clearLive, setBusy, appendOrQueuePeer, flushPeer, finishChatRun, sessionMatches, adoptSession, viewSession]);

  // Auto-scroll chat boxes, per-agent feeds and evidence drawer.
  useEffect(() => {
    for (const el of Object.values(chatBoxRefs.current)) if (el) el.scrollTop = el.scrollHeight;
  }, [chatLogs, pendingChat, streamText, reasonText, walletOpen]);
  useEffect(() => {
    for (const el of Object.values(feedRefs.current)) if (el) el.scrollTop = el.scrollHeight;
  }, [events, localFeed]);
  useEffect(() => {
    const el = evidenceRef.current;
    if (el) el.scrollTop = 0;
  }, [selectedA423Job]);

  const stopChat = async (agentId: string) => {
    activeChatCidRef.current[agentId] = undefined;
    chatBusyRef.current[agentId] = false;
    peerBusyRef.current[agentId] = false;
    setBusy(agentId, false);
    clearLive(agentId);
    flushPeer(agentId);
    addFeed(agentId, 'stop requested — aborting current run');
    try {
      await fetch('/api/agents/stop', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId }),
      });
    } catch { /* ignore */ }
    refresh();
  };

  const stopAgents = async () => {
    try { await fetch('/api/agents/stop', { method: 'POST' }); } catch { /* ignore */ }
    const ids = new Set([
      ...Object.keys(pendingChatRef.current),
      ...Object.keys(chatBusyRef.current),
      ...Object.keys(peerBusyRef.current),
      ...Object.keys(activeChatCidRef.current),
    ]);
    for (const id of ids) {
      pendingChatRef.current[id] = false;
      chatBusyRef.current[id] = false;
      peerBusyRef.current[id] = false;
      activeChatCidRef.current[id] = undefined;
      clearLive(id);
      flushPeer(id);
    }
    setPendingChat({});
    refresh();
  };

  const copyText = async (text: string, agentId: string, label: string) => {
    try { await navigator.clipboard.writeText(text); } catch { /* ignore */ }
    addFeed(agentId, `copied ${label} to clipboard`);
  };

  const toggleWallet = (agentId: string) => {
    const opening = !walletOpen[agentId];
    setWalletOpen((p) => ({ ...p, [agentId]: opening }));
    if (opening) {
      const w = wallets[agentId];
      addFeed(agentId, `opened wallet — public address ${short(w?.wallet?.address)} ready to receive ${displayTokenSymbol(config?.tokenSymbol)}`);
    } else {
      addFeed(agentId, 'closed wallet view');
    }
  };

  const newChatSession = (agentId: string) => {
    const hadChat = !!chatBusyRef.current[agentId] || !!activeChatCidRef.current[agentId];
    const peerWasBusy = !!peerBusyRef.current[agentId];
    // Invalidate any in-flight response/timer for the previous session.
    sessionEpochRef.current[agentId] = (sessionEpochRef.current[agentId] ?? 0) + 1;
    activeChatCidRef.current[agentId] = undefined;
    chatBusyRef.current[agentId] = false;
    newSessionCidRef.current[agentId] = undefined;
    deferredPeerRef.current[agentId] = [];
    clearLive(agentId);
    setBusy(agentId, peerWasBusy);
    try { localStorage.removeItem(sessKey(agentId)); } catch { /* ignore */ }
    sessRef.current[agentId] = 'NEW';
    setChatLogs((p) => ({ ...p, [agentId]: [] }));
    setNewSessPending((p) => ({ ...p, [agentId]: true }));
    addFeed(agentId, 'new chat session — fresh checkpoint thread');
    if (hadChat) {
      // Abort only the chat turn; mailbox runs are independent and may still
      // deliver mail into this panel.
      void fetch('/api/agents/stop', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ agentId, run: 'chat' }),
      }).catch(() => undefined);
    }
  };

  const sendChat = async (agentId: string) => {
    const msg = chatInputs[agentId];
    if (!msg?.trim()) return;
    const cid = crypto.randomUUID();
    const epoch = sessionEpochRef.current[agentId] ?? 0;
    const sendingNew = !!newSessPending[agentId] || viewSession(agentId) === 'NEW';
    const currentEpoch = () => epoch === (sessionEpochRef.current[agentId] ?? 0);
    newSessionCidRef.current[agentId] = sendingNew ? cid : undefined;
    activeChatCidRef.current[agentId] = cid;
    chatBusyRef.current[agentId] = true;
    setChatInputs((p) => ({ ...p, [agentId]: '' }));
    setBusy(agentId, true);
    clearLive(agentId);
    appendChat(agentId, { key: `u-${cid}`, role: 'user', text: msg, cid });
    const storedSession = (() => { try { return localStorage.getItem(sessKey(agentId)); } catch { return null; } })();
    const body: Record<string, unknown> = { message: msg, clientId: cid };
    if (sendingNew) body.newSession = true;
    else if (storedSession) body.session = storedSession;
    try {
      const res = await fetch(`/api/agents/${agentId}/chat`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!currentEpoch()) return; // session was reset while this turn ran
      // A newer turn superseded this one — its response owns the UI now.
      if (activeChatCidRef.current[agentId] !== cid) return;
      // Persist the checkpoint session id so reloads restore this conversation.
      const tid = typeof data.threadId === 'string' ? data.threadId : '';
      if (tid && tid !== baseThread(agentId)) {
        const sess = tid.split(':chat:')[1];
        if (sess) {
          try { localStorage.setItem(sessKey(agentId), sess); } catch { /* ignore */ }
          sessRef.current[agentId] = sess;
          newSessionCidRef.current[agentId] = undefined;
          setNewSessPending((p) => ({ ...p, [agentId]: false }));
        }
      } else if (data.ok !== false) {
        setNewSessPending((p) => ({ ...p, [agentId]: false }));
      }
      if (data.ok === false) {
        appendChat(agentId, { key: `r-${cid}-err`, role: 'agent', text: `⚠ ${data.error ?? 'request failed'}`, cid });
        finishChatRun(agentId, cid);
        return;
      }
      // Safety net for a missed SSE reply. The keys match the ones used by the
      // event stream, so whichever lands first wins and the other dedupes.
      setTimeout(() => {
        if (!currentEpoch()) return;
        persistBlocks(agentId, cid, data.reasoning, data.speech);
        const text = typeof data.reply === 'string' && data.reply.trim()
          ? data.reply
          : data.error ? `⚠ ${data.error}` : '(no reply)';
        appendChat(agentId, { key: `r-${cid}`, role: 'agent', text, cid });
        finishChatRun(agentId, cid);
      }, 1500);
    } catch (e) {
      if (currentEpoch()) {
        appendChat(agentId, { key: `r-${cid}-err`, role: 'agent', text: `error: ${e}`, cid });
        finishChatRun(agentId, cid);
      }
    } finally {
      refresh();
    }
  };

  const agentName = (id: string | undefined | null) => (id
    ? id === 'a423-arbiter'
      ? 'A423 Arbiter'
      : agents.find((a) => a.id === id)?.name ?? short(id)
    : 'system');
  const anyAgentBusy = Object.values(pendingChat).some(Boolean);

  const feedFor = (agentId: string): FeedItem[] => {
    const sse = events
      .filter((e) => e.agentId === agentId || !e.agentId)
      .map((e) => ({ key: `e${e.id}`, text: describeEvent(e), ts: new Date(e.createdAt).getTime() }))
      .filter((x) => x.text !== '');
    return [...sse, ...(localFeed[agentId] ?? [])]
      .sort((a, b) => a.ts - b.ts)
      .slice(-50);
  };

  const usd = (raw: string) => (Number(BigInt(raw)) / 1e18) * Number(config?.tokenPriceUsd ?? 0.02);
  const networkLabel = config?.chainId === 4663 ? 'MAINNET' : config?.chainId === 46630 ? 'ROBINHOOD TESTNET' : `CHAIN ${config?.chainId ?? '—'}`;
  const tokenLabel = displayTokenSymbol(config?.tokenSymbol);

  if (identityModalOpen || identityGate === 'error') {
    return (
      <div className="h-screen bg-zinc-950 text-zinc-100 flex items-center justify-center p-6">
        <div className="w-full max-w-xl rounded-2xl border border-zinc-800 bg-zinc-900/80 shadow-2xl overflow-hidden">
          <div className="px-6 py-4 border-b border-zinc-800">
            <h1 className="text-lg font-bold">Agent identity</h1>
            <p className="text-xs text-zinc-400 mt-1">Organizations, ed25519 keys and governor credentials are provisioned before the marketplace opens.</p>
          </div>
          <div className="p-6 space-y-4">
            {identityGate === 'loading' && (
              <div className="flex items-center gap-3 text-sm text-zinc-300">
                <span className="h-4 w-4 rounded-full border-2 border-emerald-400 border-t-transparent animate-spin" />
                Loading the organization registry and verifying Agent A and Agent B identity records…
              </div>
            )}
            {identityGate === 'error' && (
              <div className="space-y-3">
                <div className="text-sm text-red-400">{identityError || 'Identity bootstrap failed.'}</div>
                <button onClick={retryIdentity} className="px-3 py-2 rounded bg-emerald-700 hover:bg-emerald-600 text-sm font-semibold">Retry</button>
              </div>
            )}
            {identityGate === 'ready' && identityInfo && (
              <div className="space-y-3">
                {(identityInfo.agents ?? []).map((a) => (
                  <div key={a.app_agent_id} className="rounded-lg border border-zinc-800 bg-zinc-950/60 p-3">
                    <div className="flex items-center justify-between">
                      <span className="font-semibold text-sm">{a.agent_name}</span>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${a.verified ? 'bg-emerald-900/60 text-emerald-300' : 'bg-amber-900/50 text-amber-300'}`}>
                        {a.verified ? 'VERIFIED' : 'PENDING'}
                      </span>
                    </div>
                    <div className="mt-2 text-[10px] text-zinc-500 font-mono break-all">org {a.org_id}</div>
                    <div className="text-[10px] text-zinc-500 font-mono break-all">identity {a.agent_id}</div>
                    {a.expires_at && <div className="text-[10px] text-zinc-600 mt-1">credential expires {new Date(a.expires_at).toLocaleString()}</div>}
                  </div>
                ))}
                <p className="text-xs text-emerald-400">Identities verified — opening the marketplace…</p>
              </div>
            )}
            <p className="text-[10px] text-zinc-600">Local development governor. Public org/identity values only; private keys stay in the gitignored .a423 directory.</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-zinc-950 text-zinc-100 flex flex-col overflow-hidden">
      <header className="flex items-center justify-between px-6 py-3 border-b border-zinc-800 shrink-0">
        <div>
          <h1 className="text-xl font-bold">Agent Treasury</h1>
          <p className="text-xs text-amber-400">
            {networkLabel} · {tokenLabel} · {config?.chainName ?? `CHAIN ${config?.chainId ?? '—'}`} · SIMULATED RATE (${config?.tokenPriceUsd ?? '0.02'}/{tokenLabel})
          </p>
        </div>
        <div className="flex gap-2">
          {anyAgentBusy && (
            <button onClick={stopAgents} className="px-3 py-2 rounded bg-red-700 hover:bg-red-600 text-sm font-semibold flex items-center gap-1">
              <Square size={14} /> Stop agents
            </button>
          )}
        </div>
      </header>

      {config && (
        <div className="flex items-center gap-2 px-6 py-1.5 border-b border-zinc-800/70 bg-zinc-900/40 text-[10px] font-mono overflow-x-auto shrink-0">
          <span className="text-zinc-500">app:</span>
          <button onClick={() => copyText(window.location.origin, agents[0]?.id ?? '', 'app URL')} className="text-sky-400 hover:underline flex items-center gap-1">
            {window.location.host} <Copy size={9} />
          </button>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-500">rpc:</span>
          <button onClick={() => copyText(config.rpcUrl, agents[0]?.id ?? '', 'RPC URL')} className="text-sky-400 hover:underline flex items-center gap-1">
            {config.rpcUrl} <Copy size={9} />
          </button>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-500">chain:</span><span className="text-zinc-300">{config.chainId}</span>
          <span className="text-zinc-600">|</span>
          <span className="text-zinc-500">token:</span>
          <button onClick={() => config.mockWif && copyText(config.mockWif, agents[0]?.id ?? '', 'token address')} className="text-zinc-300 hover:text-sky-300 flex items-center gap-1">
            {short(config.mockWif)} <Copy size={9} />
          </button>
          <span className="text-zinc-500">escrow:</span>
          <button onClick={() => config.escrowAddress && copyText(config.escrowAddress, agents[0]?.id ?? '', 'escrow address')} className="text-zinc-300 hover:text-sky-300 flex items-center gap-1">
            {short(config.escrowAddress)} <Copy size={9} />
          </button>
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        {/* Jobs sidebar */}
        <aside className="w-64 border-r border-zinc-800 p-3 overflow-y-auto shrink-0">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-sm font-semibold text-zinc-400">A423 escrow</h2>
            <button onClick={() => setShowTestWorkflows((v) => !v)} className="text-[9px] text-zinc-500 hover:text-zinc-300">{showTestWorkflows ? 'hide tests' : 'show tests'}</button>
          </div>
          {[...a423Jobs]
            .filter((j) => showTestWorkflows || !isTestWorkflow(j.id))
            .sort((a, b) => Date.parse(b.created_at ?? '') - Date.parse(a.created_at ?? ''))
            .slice(0, 12)
            .map((j) => {
              const expanded = expandedA423Job === j.id;
              const selected = selectedA423Job === j.id;
              const stages = a423Stages(j);
              const accepted = new Set(j.agreement?.accepted_by ?? []);
              const cancellation = (j.subflows ?? []).find((subflow) => subflow.kind === 'cancellation') ?? null;
              const stateColor = a423StateColor(j);
              const profitMargin = j.profit?.realized_payout_raw != null
                ? j.profit?.realized_margin_bps
                : j.profit?.projected_payout_raw != null
                  ? j.profit?.projected_margin_bps
                  : j.profit?.expected_margin_bps;
              const profitLabel = j.profit?.realized_profit_raw?.startsWith('-')
                ? 'realized loss'
                : j.profit?.realized_payout_raw != null
                  ? 'realized profit'
                  : j.profit?.projected_payout_raw != null
                    ? 'projected profit'
                    : 'target profit';
              const profitTone = j.profit?.realized_profit_raw?.startsWith('-')
                ? 'text-red-400'
                : j.profit && ((j.profit.realized_profit_raw && Number(j.profit.realized_margin_bps ?? 0) >= Number(j.profit.target_margin_bps ?? 0)) || j.profit.target_status === 'target_met')
                  ? 'text-emerald-400'
                  : 'text-amber-300';
              const toggle = () => {
                setExpandedA423Job(expanded ? null : j.id);
                setSelectedA423Job(j.id);
              };
              return (
                <div
                  key={j.id}
                  role="button"
                  tabIndex={0}
                  aria-expanded={expanded}
                  onClick={toggle}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault();
                      toggle();
                    }
                  }}
                  className={`mb-2 p-2 rounded border text-xs cursor-pointer transition-colors ${expanded || selected ? 'border-sky-600/70 bg-zinc-900' : 'border-zinc-800 bg-zinc-900/50 hover:border-zinc-700'}`}
                >
                  <div className="flex justify-between gap-2">
                    <span className="font-mono text-[10px] text-zinc-300 flex items-center gap-1 min-w-0">
                      {expanded ? <ChevronDown size={10} className="shrink-0" /> : <ChevronRight size={10} className="shrink-0" />}
                      <span className="truncate">{short(j.id)}</span>
                    </span>
                    <span className={`${stateColor} shrink-0`}>{j.state}</span>
                  </div>
                  <div className="text-[10px] text-zinc-500 truncate">rev {j.agreement?.revision ?? '—'} · {j.pending ? `pending ${j.pending.action}` : 'idle'}</div>
                  <div className="text-[9px] text-zinc-600 mt-0.5">
                    created {j.created_at ? new Date(j.created_at).toLocaleString() : '—'}
                    {j.updated_at && j.updated_at !== j.created_at ? ` · updated ${new Date(j.updated_at).toLocaleTimeString()}` : ''}
                  </div>
                  {j.safety?.blocked && <div className="text-[10px] text-red-400 mt-1">SAFETY HOLD</div>}
                  {j.work_meter && j.work_meter.progress_percent > 0 && (
                    <div className="mt-1.5">
                      <div className="flex justify-between text-[9px] text-zinc-500">
                        <span>work ~{j.work_meter.progress_percent}%</span>
                        <span>{Number(j.work_meter.tokens_used).toLocaleString()} mock tok · ${j.work_meter.estimated_cost_usd}</span>
                      </div>
                      <div className="h-1 bg-zinc-800 rounded overflow-hidden mt-0.5">
                        <div className="h-full bg-amber-500" style={{ width: `${j.work_meter.progress_percent}%` }} />
                      </div>
                    </div>
                  )}
                  {j.profit && profitMargin && (
                    <div className="mt-1 flex justify-between text-[9px]">
                      <span className="text-zinc-500">{profitLabel}</span>
                      <span className={profitTone}>{bpsText(profitMargin)} {j.profit.target_status ? `· ${j.profit.target_status === 'target_met' ? 'target met' : 'below target'}` : ''}</span>
                    </div>
                  )}

                  {expanded && (
                    <div className="mt-2 pt-2 border-t border-zinc-800 space-y-1.5" onClick={(e) => e.stopPropagation()}>
                      <div className="font-mono text-[9px] break-all text-zinc-400">{j.id}</div>
                      <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[9px]">
                        <span className="text-zinc-500">Created</span>
                        <span className="text-zinc-300">{a423Time(j.created_at)}</span>
                        <span className="text-zinc-500">Updated</span>
                        <span className="text-zinc-300">{a423Time(j.updated_at)}</span>
                        <span className="text-zinc-500">From</span>
                        <span className="text-zinc-300 truncate">{agentName(j.participants.requester)}</span>
                        <span className="text-zinc-500">Worker</span>
                        <span className="text-zinc-300 truncate">{agentName(j.participants.worker)}</span>
                        <span className="text-zinc-500">Price</span>
                        <span className="text-zinc-300">{a423Price(j)} · {a423Amount(j)}</span>
                        <span className="text-zinc-500">Accepted</span>
                        <span className="text-zinc-300">
                          from {accepted.has(j.participants.requester) ? '✓' : '—'} · worker {accepted.has(j.participants.worker) ? '✓' : '—'}
                        </span>
                      </div>
                      {(j.work_status || j.negotiation || cancellation) && (
                        <div className="rounded border border-amber-900/60 bg-amber-950/20 p-1.5 space-y-0.5">
                          <div className="flex justify-between"><span className="text-zinc-500">Work</span><span className="text-amber-200">{j.work_status ?? '—'}</span></div>
                          {j.negotiation?.current && (
                            <>
                              <div className="flex justify-between"><span className="text-zinc-500">Closing proposal</span><span className="text-zinc-300">rev {j.negotiation.current.escrow_version}</span></div>
                              <div className="text-zinc-300">Worker {a423TokenText(j.negotiation.current.worker_amount, j)} · payer {a423TokenText(j.negotiation.current.payer_amount, j)}</div>
                              <div className="text-zinc-500">Signatures: payer {j.cancellation_signers?.payer ? '✓' : '—'} · worker {j.cancellation_signers?.worker ? '✓' : '—'}</div>
                            </>
                          )}
                          {cancellation && (
                            <div className="flex justify-between"><span className="text-zinc-500">Cancellation</span><span className={cancellation.status === 'completed' ? 'text-emerald-300' : 'text-amber-200'}>{cancellation.status}</span></div>
                          )}
                          {cancellation?.receipt ? (
                            <a onClick={(e) => e.stopPropagation()} href={`/api/a423-dashboard/cancellation-receipts/${j.id}`} target="_blank" rel="noreferrer" className="text-sky-400 hover:underline block">Cancellation receipt (JSON)</a>
                          ) : cancellation?.instruction ? (
                            <div className="text-zinc-500">Accepted instruction saved — no payment receipt yet.</div>
                          ) : null}
                        </div>
                      )}
                      <div className="pt-1 space-y-0.5">
                        {stages.filter((stage) => !stage.branch).map((stage) => (
                          <div key={stage.key} className="flex items-center gap-1 text-[9px]">
                            {stage.done
                              ? <CheckCircle2 size={10} className="text-emerald-400 shrink-0" />
                              : stage.active
                                ? <Clock3 size={10} className="text-amber-300 shrink-0" />
                                : <Circle size={9} className="text-zinc-600 shrink-0" />}
                            <span className={stage.done ? 'text-zinc-300' : stage.active ? 'text-amber-200' : 'text-zinc-600'}>{stage.label}</span>
                            <span className="ml-auto text-[8px] text-zinc-600 shrink-0">
                              {stage.at ? new Date(stage.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}
                            </span>
                          </div>
                        ))}
                        {stages.filter((stage) => stage.branch).map((stage) => (
                          <div key={stage.key} className="flex items-center gap-1 text-[9px]">
                            {stage.done && stage.tone === 'ok'
                              ? <CheckCircle2 size={10} className="text-emerald-400 shrink-0" />
                              : <AlertTriangle size={10} className={stage.tone === 'bad' ? 'text-red-400 shrink-0' : 'text-amber-300 shrink-0'} />}
                            <span className={stage.tone === 'bad' ? 'text-red-300' : stage.tone === 'ok' ? 'text-zinc-300' : 'text-amber-200'}>{stage.label}</span>
                          </div>
                        ))}
                      </div>
                      <div className="flex gap-2 pt-1 text-[9px]">
                        <a onClick={(e) => e.stopPropagation()} className="text-sky-400 hover:underline" href={`/api/a423-dashboard/receipts/${j.id}`} target="_blank" rel="noreferrer">JSON receipt</a>
                        <a onClick={(e) => e.stopPropagation()} className="text-sky-400 hover:underline" href={`/api/a423-dashboard/receipts/${j.id}?format=pdf`} target="_blank" rel="noreferrer">PDF</a>
                      </div>
                      <div className="text-[8px] text-zinc-600">Full timeline and participants in the right panel.</div>
                    </div>
                  )}

                  {!expanded && (
                    <div className="flex gap-2 mt-1 text-[10px]">
                      <a onClick={(e) => e.stopPropagation()} className="text-sky-400 hover:underline" href={`/api/a423-dashboard/receipts/${j.id}`} target="_blank" rel="noreferrer">JSON receipt</a>
                      <a onClick={(e) => e.stopPropagation()} className="text-sky-400 hover:underline" href={`/api/a423-dashboard/receipts/${j.id}?format=pdf`} target="_blank" rel="noreferrer">PDF</a>
                    </div>
                  )}
                </div>
              );
            })}
          {a423Jobs.length === 0 && <p className="text-[10px] text-zinc-600 mb-3">No A423 workflows for the dashboard actor.</p>}
        </aside>

        {/* Two agent screens */}
        <main className="flex-1 grid grid-cols-2 gap-3 p-3 min-w-0">
          {agents.map((a) => {
            const w = wallets[a.id];
            const log = chatLogs[a.id] ?? [];
            const thinking = pendingChat[a.id];
            const feed = feedFor(a.id);
            const inbox = events
              .filter((e) => e.type === 'peer.message' && e.agentId === a.id)
              .filter((e) => {
                const jobId = (e.payload as Record<string, unknown>)?.job_id;
                return typeof jobId === 'string' && !isTestWorkflow(jobId);
              })
              .slice(-3)
              .reverse();
            const open = !!walletOpen[a.id];
            return (
              <section key={a.id} className="relative rounded-lg border border-zinc-800 bg-zinc-900/60 flex flex-col min-h-0 overflow-hidden">
                {/* Screen header */}
                <div className="px-3 py-2 border-b border-zinc-800 flex items-center justify-between shrink-0">
                  <div className="flex items-center gap-2 min-w-0">
                    <span className={`w-2 h-2 rounded-full ${thinking || anyAgentBusy ? 'bg-emerald-400 animate-pulse' : 'bg-zinc-600'}`} />
                    <h3 className="font-semibold truncate">{a.name} <span className="text-xs text-zinc-500 font-normal">({a.role})</span></h3>
                  </div>
                  <div className="flex items-center gap-1.5 shrink-0">
                    <button
                      onClick={() => newChatSession(a.id)}
                      className="p-1.5 rounded hover:bg-zinc-700 text-zinc-400 hover:text-white"
                      title="New chat session (fresh checkpoint thread)"
                    >
                      <MessageSquarePlus size={16} />
                    </button>
                    <button
                      onClick={() => toggleWallet(a.id)}
                      className={`p-1.5 rounded ${open ? 'bg-amber-600/80 text-white' : 'hover:bg-zinc-700 text-zinc-400 hover:text-white'}`}
                      title="Open wallet"
                    >
                      <Wallet size={16} />
                    </button>
                  </div>
                </div>

                {/* Chat */}
                <div
                  ref={(el) => { chatBoxRefs.current[a.id] = el; }}
                  className="flex-1 min-h-0 overflow-y-auto p-3 space-y-2 text-sm"
                >
                  {(() => {
                    // Group the flat event log into run cards: each card is one
                    // agent turn containing typed blocks — mail in, tool calls,
                    // live thinking stream, final answer.
                    type Blk = { key: string; kind: 'mail' | 'tool' | 'answer' | 'error' | 'think' | 'speak'; text: string; prefix?: string; live?: boolean };
                    const segs: ({ t: 'user'; m: (typeof log)[number] } | { t: 'card'; blocks: Blk[] })[] = [];
                    for (const m of log) {
                      if (m.role === 'user') { segs.push({ t: 'user', m }); continue; }
                      const isMail = !!m.prefix;
                      const last = segs[segs.length - 1];
                      if (isMail || !last || last.t !== 'card') segs.push({ t: 'card', blocks: [] });
                      const card = (segs[segs.length - 1] as { t: 'card'; blocks: Blk[] }).blocks;
                      const kind: Blk['kind'] = m.kind === 'tool' ? 'tool' : m.kind === 'think' ? 'think' : m.kind === 'speak' ? 'speak' : isMail ? 'mail' : m.text.startsWith('⚠') ? 'error' : 'answer';
                      card.push({ key: m.key, kind, text: m.text, prefix: m.prefix });
                    }
                    const reason = reasonText[a.id] ?? '';
                    const stream = streamText[a.id] ?? '';
                    const live: Blk[] = [];
                    if (reason) live.push({ key: '__reason', kind: 'think', text: reason });
                    if (stream) live.push({ key: '__stream', kind: 'speak', text: stream, live: true });
                    if (live.length) {
                      const last = segs[segs.length - 1];
                      if (last?.t === 'card') last.blocks.push(...live);
                      else segs.push({ t: 'card', blocks: live });
                    }
                    if (segs.length === 0) {
                      if (!thinking) return <p className="text-xs text-zinc-600">Message {a.name} to start a workflow conversation.</p>;
                      segs.push({ t: 'card', blocks: [] }); // empty card so the "thinking" dots render
                    }
                    return segs.map((s, i) => {
                      if (s.t === 'user') {
                        return (
                          <div key={s.m.key} className="text-right">
                            <span className="inline-block max-w-[90%] rounded px-2 py-1 whitespace-pre-wrap bg-sky-700/60">{s.m.text}</span>
                          </div>
                        );
                      }
                      const isLast = i === segs.length - 1;
                      return (
                        <div key={`card${i}`} className="rounded-md border border-sky-900/60 border-l-2 border-l-sky-600/70 bg-zinc-950/70 px-2.5 py-2 space-y-1.5 shadow-sm">
                          {s.blocks.map((b) => (
                            <div key={b.key} className="text-left">
                              {b.kind === 'tool' ? (
                                <div>
                                  <span className="inline-block rounded-sm bg-amber-500/15 border border-amber-600/40 px-1 py-px text-[8px] font-bold uppercase tracking-wider text-amber-400 mb-0.5">tool</span>
                                  <div><span className="inline-block rounded px-2 py-0.5 font-mono text-[10px] bg-amber-900/50 border border-amber-700/60 text-amber-200">{b.text}</span></div>
                                </div>
                              ) : b.kind === 'think' || b.kind === 'speak' ? (
                                <div>
                                  <span className={`inline-block rounded-sm px-1 py-px text-[8px] font-bold uppercase tracking-wider mb-0.5 border ${b.kind === 'think' ? 'bg-violet-500/15 border-violet-500/40 text-violet-300' : 'bg-sky-500/15 border-sky-500/40 text-sky-300'}`}>{b.kind === 'think' ? 'thinking' : 'speaking'}</span>
                                  <div><span className={`inline-block max-w-[92%] rounded px-2 py-1 whitespace-pre-wrap text-sm ${b.kind === 'think' ? 'bg-violet-950/50 border border-violet-800/50 text-violet-100/90' : 'bg-sky-950/40 border border-sky-800/50 text-zinc-100'}`}>
                                    {b.text}
                                    {b.live && <span className="inline-block w-1.5 h-3.5 bg-sky-400/80 animate-pulse ml-0.5 align-text-bottom" />}
                                  </span></div>
                                </div>
                              ) : (
                                <div>
                                  <span className={`inline-block rounded-sm px-1 py-px text-[8px] font-bold uppercase tracking-wider mb-0.5 border ${b.kind === 'mail' ? 'bg-sky-500/15 border-sky-500/40 text-sky-300' : b.kind === 'error' ? 'bg-red-500/15 border-red-500/40 text-red-300' : 'bg-emerald-500/15 border-emerald-500/40 text-emerald-300'}`}>
                                    {b.kind === 'mail' ? 'mail in' : b.kind === 'error' ? 'error' : 'final answer'}
                                  </span>
                                  {b.prefix && <div className="text-[9px] text-sky-400 mb-0.5">{b.prefix}</div>}
                                  <div><span className={`inline-block max-w-[92%] rounded px-2 py-1 whitespace-pre-wrap ${b.kind === 'error' ? 'bg-red-950/60 border border-red-800/50 text-red-200' : 'bg-zinc-800 text-zinc-100'}`}>{b.text}</span></div>
                                </div>
                              )}
                            </div>
                          ))}
                          {thinking && isLast && !stream && (
                            <div className="inline-flex items-center gap-1 rounded px-2 py-1.5 bg-zinc-800 text-zinc-400 text-xs">
                              <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-bounce" style={{ animationDelay: '0ms' }} />
                              <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-bounce" style={{ animationDelay: '150ms' }} />
                              <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-bounce" style={{ animationDelay: '300ms' }} />
                              {a.name} is thinking…
                            </div>
                          )}
                        </div>
                      );
                    });
                  })()}
                </div>
                {inbox.length > 0 && (
                  <div className="px-2 pt-2 shrink-0">
                    <button
                      onClick={() => setInboxOpen((p) => ({ ...p, [a.id]: !p[a.id] }))}
                      className="flex items-center gap-1 text-[10px] text-zinc-400 hover:text-sky-300"
                      title="Show persisted A423 marketplace mail for this agent"
                    >
                      <Mail size={11} /> Marketplace inbox
                      <span className="rounded-full bg-sky-500/20 border border-sky-500/40 px-1.5 py-px text-[8px] font-bold text-sky-300">{inbox.length}</span>
                    </button>
                    {inboxOpen[a.id] && (
                      <div className="mt-1.5 space-y-1 rounded-lg border border-zinc-800 bg-zinc-950/70 p-1.5">
                        {inbox.map((e) => {
                          const p = e.payload as Record<string, unknown>;
                          const jobId = String(p.job_id ?? '');
                          const text = String(p.text ?? '');
                          return (
                            <div key={e.id} className="rounded border border-zinc-800 bg-zinc-900/60 p-2">
                              <div className="flex justify-between gap-2 text-[9px]">
                                <span className="text-sky-300 truncate">{String(p.fromName ?? 'Agent')} → {a.name}</span>
                                <span className="text-zinc-500 font-mono shrink-0">{short(jobId)}</span>
                              </div>
                              <div className="mt-1 text-[10px] leading-snug text-zinc-300 whitespace-pre-wrap">
                                {text.slice(0, 240)}{text.length > 240 ? '…' : ''}
                              </div>
                              <button
                                onClick={() => {
                                  setChatInputs((prev) => ({
                                    ...prev,
                                    [a.id]: `Use a423_job_status on ${jobId}, then respond to the offer with a423_job_action. Do not start work until funding is confirmed.`,
                                  }));
                                  setInboxOpen((prev) => ({ ...prev, [a.id]: false }));
                                }}
                                className="mt-1.5 text-[9px] text-sky-400 hover:text-sky-300"
                              >
                                Negotiate in chat →
                              </button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>
                )}
                <div className="px-2 pt-2 shrink-0">
                  <button
                    onClick={() => setSuggestOpen((p) => ({ ...p, [a.id]: !p[a.id] }))}
                    className="flex items-center gap-1 text-[10px] text-zinc-400 hover:text-sky-300"
                    title="Show task suggestions for this agent"
                  >
                    <Sparkles size={11} /> Task suggestions
                  </button>
                  {suggestOpen[a.id] && (
                    <div className="mt-1.5 space-y-1 rounded-lg border border-zinc-800 bg-zinc-950/70 p-1.5">
                      {(TASK_SUGGESTIONS[a.role === 'dispatcher' ? 'dispatcher' : 'worker'] ?? []).map((s) => (
                        <button
                          key={s}
                          onClick={() => {
                            setChatInputs((p) => ({ ...p, [a.id]: s }));
                            setSuggestOpen((p) => ({ ...p, [a.id]: false }));
                          }}
                          className="block w-full text-left text-[10px] leading-snug rounded px-2 py-1.5 text-zinc-300 hover:bg-zinc-800 hover:text-white"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                <div className="p-2 border-t border-zinc-800 flex gap-2 shrink-0">
                  <input
                    value={chatInputs[a.id] ?? ''}
                    onChange={(e) => setChatInputs((p) => ({ ...p, [a.id]: e.target.value }))}
                    onKeyDown={(e) => e.key === 'Enter' && !thinking && sendChat(a.id)}
                    placeholder={thinking ? `${a.name} is working…` : `Message ${a.name}…`}
                    disabled={thinking}
                    className="flex-1 bg-zinc-950 border border-zinc-700 rounded px-2 py-1 text-sm min-w-0 disabled:opacity-60"
                  />
                  {thinking ? (
                    <button
                      onClick={() => stopChat(a.id)}
                      className="px-3 py-1 rounded bg-red-700 hover:bg-red-600 text-sm shrink-0 flex items-center gap-1"
                      title={`Stop ${a.name}'s current run`}
                    >
                      <Square size={12} /> Stop
                    </button>
                  ) : (
                    <button onClick={() => sendChat(a.id)} className="px-3 py-1 rounded bg-zinc-700 hover:bg-zinc-600 text-sm shrink-0">Send</button>
                  )}
                </div>

                {/* Per-agent live event feed */}
                <div className="h-32 border-t border-zinc-800 overflow-y-auto px-3 py-1.5 shrink-0 bg-zinc-950/60">
                  <div className="text-[9px] font-semibold text-zinc-500 uppercase tracking-wide mb-0.5">live activity</div>
                  <div ref={(el) => { feedRefs.current[a.id] = el; }} className="space-y-0.5">
                    {feed.map((f) => (
                      <div key={f.key} className="text-[10px] font-mono text-zinc-400 truncate">
                        <span className="text-zinc-600">{new Date(f.ts).toLocaleTimeString()}</span> {f.text}
                      </div>
                    ))}
                    {feed.length === 0 && <div className="text-[10px] text-zinc-600">No activity yet.</div>}
                  </div>
                </div>

                {/* Wallet drawer — slides over the whole screen panel */}
                {open && w && (
                  <div className="absolute inset-0 z-20 bg-zinc-950 overflow-y-auto">
                    <div className="sticky top-0 bg-zinc-950/95 backdrop-blur border-b border-zinc-800 px-4 py-3 flex items-center justify-between">
                      <div>
                        <h3 className="font-bold flex items-center gap-2"><Wallet size={16} className="text-amber-400" /> {a.name} Wallet</h3>
                        <p className="text-[10px] text-amber-400">{tokenLabel} · {config?.chainName ?? `chain ${w.wallet.chainId}`} · {w.token.isMock ? 'mock token' : 'live token'}</p>
                      </div>
                      <button onClick={() => toggleWallet(a.id)} className="p-1 rounded hover:bg-zinc-700"><X size={16} /></button>
                    </div>
                    <div className="p-4 space-y-3">
                      {/* Balance card */}
                      <div className="rounded-lg border border-zinc-800 bg-gradient-to-br from-zinc-900 to-zinc-950 p-4">
                        <div className="text-zinc-500 text-xs">Total balance</div>
                        <div className="text-3xl font-mono font-bold">{fmt2(w.token.spendableRaw)} <span className="text-base text-amber-400">{tokenLabel}</span></div>
                        <div className="text-xs text-zinc-500 mt-1">≈ ${usd(w.token.spendableRaw).toFixed(2)} USD ({w.token.isMock ? 'simulated' : 'reference'} rate ${config?.tokenPriceUsd ?? '0.02'}/{tokenLabel})</div>
                        <div className="grid grid-cols-2 gap-2 mt-3 text-center">
                          <div className="rounded bg-zinc-900/70 p-2"><div className="text-[10px] text-zinc-500">Locked in escrow</div><div className="font-mono text-sm">{fmt2(w.token.lockedInEscrowRaw)} <span className="text-[9px] text-zinc-500">{tokenLabel}</span></div></div>
                          <div className="rounded bg-zinc-900/70 p-2"><div className="text-[10px] text-zinc-500">Gas ETH</div><div className="font-mono text-sm">{fmtEth(w.gas.ethBalanceWei)}</div></div>
                        </div>
                      </div>

                      {/* Public address — receive funds */}
                      <div className="rounded-lg border border-zinc-800 p-3">
                        <div className="text-zinc-500 text-xs mb-1 flex items-center gap-1"><Coins size={12} /> Public address — send {tokenLabel} here</div>
                        <div className="flex items-center gap-2">
                          <code className="flex-1 text-[11px] font-mono text-zinc-300 break-all">{w.wallet.address}</code>
                          <button onClick={() => copyText(w.wallet.address, a.id, 'public address')} className="shrink-0 p-1.5 rounded bg-zinc-800 hover:bg-zinc-700" title="Copy address">
                            <Copy size={13} />
                          </button>
                        </div>
                        <div className="text-[10px] text-zinc-600 mt-1.5">Private key stays server-side — agents never see it. Anyone can transfer {tokenLabel} to this address.</div>
                      </div>

                      {/* Escrow positions */}
                      {w.escrows.length > 0 && (
                        <div className="rounded-lg border border-zinc-800 p-3">
                          <div className="text-zinc-500 text-xs mb-1">Escrow positions</div>
                          {w.escrows.map((e) => (
                            <div key={e.id} className="text-xs font-mono flex justify-between text-zinc-400 gap-2">
                              <span>A423 · {e.state}{e.role ? ` · ${e.role}` : ''}</span>
                              <span className="text-right">{fmt2(e.amountRaw)} {tokenLabel} · job {short(e.jobId)}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )}

              </section>
            );
          })}
        </main>

        {/* Right drawer: job evidence / artifact */}
        <aside ref={evidenceRef} className="w-80 border-l border-zinc-800 p-3 overflow-y-auto shrink-0">
          <h2 className="text-sm font-semibold text-zinc-400 mb-2">Job evidence</h2>
          {selectedA423Job ? (() => {
            const j = a423Jobs.find((job) => job.id === selectedA423Job);
            if (!j) return <div className="text-xs text-zinc-500">Selected A423 workflow no longer exists.</div>;
            const stages = a423Stages(j);
            const accepted = new Set(j.agreement?.accepted_by ?? []);
            const cancellation = (j.subflows ?? []).find((subflow) => subflow.kind === 'cancellation') ?? null;
            const participants: Array<{ role: string; id: string; acceptance?: boolean }> = [
              { role: 'Requester / from', id: j.participants.requester, acceptance: accepted.has(j.participants.requester) },
              { role: 'Worker', id: j.participants.worker, acceptance: accepted.has(j.participants.worker) },
              { role: 'Verifier', id: j.participants.verifier },
              { role: 'Arbitrator', id: j.participants.arbitrator },
            ];
            return (
              <div className="space-y-3 text-xs">
                <div className="rounded border border-zinc-800 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-semibold">A423 workflow</span>
                    <span className={`rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] font-bold uppercase ${a423StateColor(j)}`}>{j.state}</span>
                  </div>
                  <div className="font-mono text-[10px] break-all text-zinc-400 mt-1">{j.id}</div>
                  <div className="mt-2 grid grid-cols-[auto_1fr] gap-x-2 gap-y-1 text-[10px]">
                    <span className="text-zinc-500">Created</span><span className="text-zinc-300">{a423Time(j.created_at)}</span>
                    <span className="text-zinc-500">Updated</span><span className="text-zinc-300">{a423Time(j.updated_at)}</span>
                    <span className="text-zinc-500">Agreement</span><span className="text-zinc-300">revision {j.agreement?.revision ?? '—'} · {j.agreement?.hash ? short(j.agreement.hash, 12) : '—'}</span>
                    <span className="text-zinc-500">Price</span><span className="text-zinc-300">{a423Price(j)} · {a423Amount(j)}</span>
                    <span className="text-zinc-500">Artifact</span><span className="font-mono text-zinc-300">{String(a423Terms(j).artifact_path ?? '—')}</span>
                    <span className="text-zinc-500">Pending</span><span className="text-zinc-300">{j.pending ? `${j.pending.action} · ${agentName(j.pending.actor)}` : 'none'}</span>
                  </div>
                  {j.safety?.blocked && (
                    <div className="mt-2 rounded border border-red-800 bg-red-950/40 p-2 text-red-300 flex items-center gap-1">
                      <AlertTriangle size={12} /> Safety hold since {a423Time(j.safety.checked_at)}
                    </div>
                  )}
                </div>

                <div className="rounded border border-zinc-800 p-3">
                  <div className="font-semibold mb-2">Participants</div>
                  <div className="space-y-1.5">
                    {participants.map(({ role, id, acceptance }) => (
                      <div key={role} className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <div className="text-[10px] text-zinc-500">{role}</div>
                          <div className="truncate text-zinc-200">{agentName(id)} <span className="text-[9px] text-zinc-600 font-mono">{short(id, 10)}</span></div>
                        </div>
                        {acceptance !== undefined && (
                          <span className={`shrink-0 text-[9px] ${acceptance ? 'text-emerald-400' : 'text-zinc-600'}`}>
                            {acceptance ? '✓ accepted' : 'not accepted'}
                          </span>
                        )}
                      </div>
                    ))}
                  </div>
                </div>

                {j.profit && (
                  <div className="rounded border border-emerald-900/50 p-3 space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">Profit policy</span>
                      <span className="text-[9px] text-zinc-500">advisory · simulated cost</span>
                    </div>
                    {j.profit.cost_basis_raw && (
                      <div className="text-[10px]"><span className="text-zinc-500">Cost basis:</span> {a423TokenText(j.profit.cost_basis_raw, j)}</div>
                    )}
                    {j.profit.recommended_payout && (
                      <div className="text-[10px]"><span className="text-zinc-500">Recommended payout:</span> {a423TokenText(j.profit.recommended_payout, j)}</div>
                    )}
                    {j.profit.target_payout && (
                      <div className="text-[10px]"><span className="text-zinc-500">Target payout:</span> {a423TokenText(j.profit.target_payout, j)} · {bpsText(j.profit.target_margin_bps)} margin</div>
                    )}
                    {j.profit.min_payout && (
                      <div className="text-[10px] text-zinc-500">Minimum payout: {a423TokenText(j.profit.min_payout, j)} · {bpsText(j.profit.min_margin_bps)}</div>
                    )}
                    {typeof j.profit.realized_profit_raw === 'string' ? (
                      <div className={`text-[11px] ${j.profit.realized_profit_raw.startsWith('-') ? 'text-red-300' : 'text-emerald-300'}`}>
                        {j.profit.realized_profit_raw.startsWith('-') ? 'Realized loss' : 'Realized profit'}: {a423TokenText(j.profit.realized_profit_raw, j)} · {bpsText(j.profit.realized_margin_bps)} margin
                        {j.profit.receipt_confirmed ? ' · receipt confirmed' : ' · receipt not confirmed'}
                      </div>
                    ) : typeof j.profit.projected_profit_raw === 'string' ? (
                      <div className="text-[11px] text-amber-200">
                        Projected profit: {a423TokenText(j.profit.projected_profit_raw, j)} · {bpsText(j.profit.projected_margin_bps)} margin
                      </div>
                    ) : typeof j.profit.expected_profit === 'string' ? (
                      <div className="text-[11px] text-amber-200">
                        Expected profit at target: {a423TokenText(j.profit.expected_profit, j)} · {bpsText(j.profit.expected_margin_bps)} margin
                      </div>
                    ) : null}
                    {j.profit.target_status && (
                      <div className={`text-[10px] ${j.profit.target_status === 'target_met' ? 'text-emerald-400' : 'text-amber-300'}`}>
                        {j.profit.target_status === 'target_met' ? 'Target met' : 'Below target'}
                      </div>
                    )}
                    {j.profit.receipt_confirmed === false && (
                      <div className="text-[9px] text-zinc-600">Receipt not confirmed — these are projected economics, not realized payment.</div>
                    )}
                  </div>
                )}

                {j.work_meter && (
                  <div className="rounded border border-zinc-800 p-3">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">Work meter</span>
                      <span className="text-[9px] text-zinc-500">{j.work_meter.frozen_at ? 'final' : 'live'} · simulated</span>
                    </div>
                    <div className="mt-1 text-[11px] text-zinc-200">{j.work_meter.work_completed}</div>
                    <div className="h-1.5 bg-zinc-800 rounded overflow-hidden mt-1.5">
                      <div className="h-full bg-amber-500" style={{ width: `${j.work_meter.progress_percent}%` }} />
                    </div>
                    <div className="grid grid-cols-2 gap-2 mt-2 text-[10px]">
                      <div><div className="text-zinc-500">Tokens used</div><div className="font-mono text-zinc-200">{Number(j.work_meter.tokens_used).toLocaleString()}</div></div>
                      <div><div className="text-zinc-500">Estimated cost</div><div className="font-mono text-zinc-200">${j.work_meter.estimated_cost_usd}</div></div>
                      <div><div className="text-zinc-500">Recovery suggestion</div><div className="font-mono text-emerald-300">{a423TokenText(j.work_meter.recovery_raw, j)}</div></div>
                      <div><div className="text-zinc-500">Unit cost</div><div className="font-mono text-zinc-200">${j.work_meter.token_unit_cost_usd}/tok</div></div>
                    </div>
                    <div className="text-[9px] text-zinc-600 mt-1">{j.work_meter.note}</div>
                  </div>
                )}

                {(j.work_status || j.negotiation || cancellation || j.escrow_ledger) && (
                  <div className="rounded border border-amber-900/60 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold">Cancellation / closing settlement</span>
                      <span className="text-[10px] text-amber-300">{j.work_status ?? '—'}</span>
                    </div>
                    {j.escrow_ledger && (
                      <div className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-0.5 text-[10px]">
                        <span className="text-zinc-500">Funded</span><span>{a423TokenText(j.escrow_ledger.funded_amount, j)}</span>
                        <span className="text-zinc-500">Worker paid</span><span>{a423TokenText(j.escrow_ledger.worker_paid, j)}</span>
                        <span className="text-zinc-500">Payer refunded</span><span>{a423TokenText(j.escrow_ledger.payer_refunded, j)}</span>
                        <span className="text-zinc-500">Locked</span><span>{a423TokenText(j.escrow_ledger.locked_amount, j)}</span>
                      </div>
                    )}
                    {j.negotiation?.current && (
                      <div className="space-y-1 text-[10px]">
                        <div className="flex justify-between gap-2"><span className="text-zinc-500">Proposal</span><span>revision {j.negotiation.current.escrow_version} · expires {a423Time(new Date(j.negotiation.current.expires_at * 1000).toISOString())}</span></div>
                        <div><span className="text-zinc-500">Worker amount:</span> {a423TokenText(j.negotiation.current.worker_amount, j)}</div>
                        <div><span className="text-zinc-500">Payer refund:</span> {a423TokenText(j.negotiation.current.payer_amount, j)}</div>
                        <div><span className="text-zinc-500">Reason:</span> {j.negotiation.current.reason}</div>
                        {j.negotiation.current.claims.length > 0 && (
                          <div><span className="text-zinc-500">Claims:</span> {j.negotiation.current.claims.map((claim) => `${claim.kind}: ${claim.description}`).join(' · ')}</div>
                        )}
                        <div className="flex gap-3 pt-1">
                          <span className={j.cancellation_signers?.payer ? 'text-emerald-400' : 'text-zinc-600'}>payer {j.cancellation_signers?.payer ? 'signed ✓' : 'not signed'}</span>
                          <span className={j.cancellation_signers?.worker ? 'text-emerald-400' : 'text-zinc-600'}>worker {j.cancellation_signers?.worker ? 'signed ✓' : 'not signed'}</span>
                        </div>
                      </div>
                    )}
                    {cancellation && (
                      <div className="space-y-1 text-[10px]">
                        <div><span className="text-zinc-500">Child status:</span> <span className={cancellation.status === 'completed' ? 'text-emerald-300' : 'text-amber-300'}>{cancellation.status}</span></div>
                        {cancellation.instruction && (
                          <div className="font-mono text-[9px] break-all text-zinc-500">
                            instruction {cancellation.instruction.id}<br />
                            {cancellation.instruction.funds_status} — authorization only
                          </div>
                        )}
                        {cancellation.receipt ? (
                          <div className="space-y-1 pt-1">
                            <div className="text-emerald-400">Receipt confirmed — funds executed.</div>
                            <div className="flex gap-2">
                            <a href={`/api/a423-dashboard/cancellation-receipts/${j.id}`} target="_blank" rel="noreferrer" className="flex-1 text-center rounded bg-emerald-800/70 hover:bg-emerald-700 px-2 py-1 text-[10px] font-semibold">Cancellation JSON</a>
                            <a href={`/api/a423-dashboard/cancellation-receipts/${j.id}?format=pdf`} target="_blank" rel="noreferrer" className="flex-1 text-center rounded bg-emerald-800/70 hover:bg-emerald-700 px-2 py-1 text-[10px] font-semibold">PDF</a>
                            </div>
                          </div>
                        ) : (
                          <div className="rounded border border-zinc-800 bg-zinc-950/60 p-2 text-zinc-500">
                            {cancellation.instruction
                              ? 'Accepted. Funds have not moved. No payment receipt exists until execution is confirmed.'
                              : 'No cancellation payment receipt yet.'}
                          </div>
                        )}
                        {cancellation.last_error && <div className="text-red-300">Last error: {cancellation.last_error}</div>}
                      </div>
                    )}
                  </div>
                )}

                <div className="rounded border border-zinc-800 p-3">
                  <div className="font-semibold mb-2">Lifecycle status</div>
                  <div>
                    {stages.map((stage, index) => (
                      <div key={stage.key} className="flex gap-2">
                        <div className="flex flex-col items-center w-4 shrink-0">
                          <span className={`mt-0.5 w-4 h-4 rounded-full border flex items-center justify-center ${
                            stage.done
                              ? stage.tone === 'bad'
                                ? 'bg-red-500/20 border-red-500 text-red-300'
                                : stage.tone === 'warn'
                                  ? 'bg-amber-500/20 border-amber-500 text-amber-300'
                                  : 'bg-emerald-500/20 border-emerald-500 text-emerald-300'
                              : stage.active
                                ? 'border-amber-500 text-amber-300'
                                : 'border-zinc-600 text-zinc-600'
                          }`}>
                            {stage.done ? <CheckCircle2 size={10} /> : stage.active ? <Clock3 size={10} /> : <Circle size={8} />}
                          </span>
                          {index < stages.length - 1 && <div className={`w-px flex-1 ${stage.done ? 'bg-emerald-900' : 'bg-zinc-800'}`} />}
                        </div>
                        <div className="pb-2 min-w-0 flex-1">
                          <div className={`text-[11px] ${stage.done ? 'text-zinc-200' : stage.active ? 'text-amber-200' : 'text-zinc-600'}`}>{stage.label}</div>
                          <div className="text-[9px] text-zinc-600">{a423Time(stage.at)}</div>
                          {stage.detail && <div className="text-[10px] text-zinc-500">{stage.detail}</div>}
                          {stage.tx && (config?.explorerUrl
                            ? <a href={`${config.explorerUrl}/tx/${stage.tx}`} target="_blank" rel="noreferrer" className="text-[9px] text-sky-400 font-mono break-all">{stage.tx}</a>
                            : <div className="text-[9px] text-zinc-600 font-mono break-all">{stage.tx}</div>)}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="rounded border border-zinc-800 p-3">
                  <div className="font-semibold mb-2">Receipts</div>
                  <div className="flex gap-2">
                    <a href={`/api/a423-dashboard/receipts/${j.id}`} target="_blank" rel="noreferrer" className="flex-1 text-center rounded bg-sky-800/70 hover:bg-sky-700 px-2 py-1 text-[10px] font-semibold">JSON receipt</a>
                    <a href={`/api/a423-dashboard/receipts/${j.id}?format=pdf`} target="_blank" rel="noreferrer" className="flex-1 text-center rounded bg-sky-800/70 hover:bg-sky-700 px-2 py-1 text-[10px] font-semibold">PDF</a>
                  </div>
                </div>

                <details className="rounded border border-zinc-800 p-3">
                  <summary className="font-semibold cursor-pointer">Raw event log ({j.events?.length ?? 0})</summary>
                  <div className="mt-2 space-y-1">
                    {[...(j.events ?? [])].reverse().slice(0, 20).map((event) => (
                      <div key={event.sequence} className="text-[9px] border-b border-zinc-800/60 pb-1">
                        <div className="flex justify-between gap-2">
                          <span className="font-mono text-zinc-400">{event.type}</span>
                          <span className="text-zinc-600">{a423Time(event.at)}</span>
                        </div>
                        <div className="text-zinc-600">{agentName(event.actor_id)} · {short(event.actor_id, 10)}</div>
                      </div>
                    ))}
                  </div>
                </details>
              </div>
            );
          })() : (
            <p className="text-xs text-zinc-600">Select a job in the sidebar to inspect quotes, escrow txs and artifacts.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
