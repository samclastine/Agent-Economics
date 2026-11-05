import type { WorkflowJob } from '@allorc/a423-sdk/workflow';

export type WorkMeter = {
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
  cost_basis_raw: string;
  cost_basis_usd: string;
  recovery_raw: string;
  recovery_token_symbol: string;
  recovery_usd: string;
  note: string;
};

const TERMINAL = new Set(['paid', 'settled', 'refunded', 'cancelled', 'expired', 'resolved']);

export type WorkMeterConfig = {
  taskMinutes: number;
  tokensPerMinute: number;
  tokenUnitCostUsd: number;
  tokenPriceUsd: number;
};

function numberEnv(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export function defaultWorkMeterConfig(): WorkMeterConfig {
  return {
    taskMinutes: numberEnv('A423_MOCK_TASK_MINUTES', 10),
    tokensPerMinute: numberEnv('A423_MOCK_TOKENS_PER_MINUTE', 1800),
    tokenUnitCostUsd: numberEnv('A423_MOCK_LLM_TOKEN_COST_USD', 0.00002),
    tokenPriceUsd: numberEnv('DEMO_TOKEN_PRICE_USD', 0.02),
  };
}

function seedOf(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i += 1) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function termsOf(job: WorkflowJob): Record<string, unknown> {
  return (job.agreement?.terms ?? {}) as Record<string, unknown>;
}

function escrowOf(job: WorkflowJob): Record<string, unknown> {
  return (termsOf(job).escrow ?? {}) as Record<string, unknown>;
}

function startOf(job: WorkflowJob): { at: number | null; iso: string | null } {
  const started = [...(job.events ?? [])].reverse().find((event) => event.type === 'start.confirmed' || event.type === 'start.requested');
  if (!started?.at) return { at: null, iso: null };
  const at = Date.parse(started.at);
  return Number.isFinite(at) ? { at, iso: started.at } : { at: null, iso: null };
}

function progressFor(job: WorkflowJob, startedAt: number | null, now: number, taskMinutes: number): number {
  if (!startedAt) return 0;
  if (job.state === 'submitted' || job.state === 'verified' || job.state === 'paid') return 100;
  if (job.state === 'running') {
    const minutes = Math.max(0, (now - startedAt) / 60000);
    return Math.min(95, Math.max(1, Math.floor((minutes / taskMinutes) * 100)));
  }
  if (job.state === 'settlement_negotiation' || TERMINAL.has(job.state)) {
    const minutes = Math.max(0, (now - startedAt) / 60000);
    return Math.min(95, Math.max(1, Math.floor((minutes / taskMinutes) * 100)));
  }
  return 0;
}

function completedLabel(progress: number): string {
  if (progress <= 0) return 'not started';
  if (progress < 16) return 'setup and source review';
  if (progress < 36) return 'research and source collection';
  if (progress < 56) return 'drafting';
  if (progress < 76) return 'analysis and refinement';
  if (progress < 91) return 'validation and final checks';
  if (progress < 100) return 'final review';
  return 'complete';
}

/** Pure, deterministic mock meter. No real model billing is implied. */
export function computeWorkMeter(
  job: WorkflowJob,
  now = Date.now(),
  config: WorkMeterConfig = defaultWorkMeterConfig(),
): WorkMeter {
  const started = startOf(job);
  const progress = progressFor(job, started.at, now, config.taskMinutes);
  const seed = seedOf(job.id);
  const variance = 0.8 + (seed % 41) / 100; // 0.80–1.20
  const estimatedTotal = Math.max(1000, Math.round(config.tokensPerMinute * config.taskMinutes * variance));
  const elapsedMinutes = started.at ? Math.max(0, (now - started.at) / 60000) : 0;
  const tokensUsed = progress <= 0
    ? 0
    : progress >= 100
      ? estimatedTotal
      : Math.min(estimatedTotal, Math.max(1000, Math.round(config.tokensPerMinute * elapsedMinutes) + 1000));
  const costUsd = tokensUsed * config.tokenUnitCostUsd;
  const escrow = escrowOf(job);
  const decimals = Number(termsOf(job).token_decimals ?? 18);
  const symbol = typeof termsOf(job).token_symbol === 'string' ? termsOf(job).token_symbol as string : 'tWIF';
  const totalRaw = typeof escrow.amount === 'string' && /^\d+$/.test(escrow.amount) ? BigInt(escrow.amount) : 0n;
  const decimalsSafe = Number.isSafeInteger(decimals) && decimals >= 0 && decimals <= 36 ? decimals : 18;
  let recoveryRaw = 0n;
  if (progress > 0 && costUsd > 0 && config.tokenPriceUsd > 0) {
    const unit = 10n ** BigInt(decimalsSafe);
    const numerator = BigInt(Math.ceil(costUsd * 1_000_000)) * unit;
    const denominator = BigInt(Math.max(1, Math.round(config.tokenPriceUsd * 1_000_000)));
    recoveryRaw = (numerator + denominator - 1n) / denominator;
    if (recoveryRaw === 0n) recoveryRaw = 1n;
    if (totalRaw > 0n && recoveryRaw > totalRaw) recoveryRaw = totalRaw;
  }
  const recoveryUsd = Number(recoveryRaw) / 10 ** decimalsSafe * config.tokenPriceUsd;

  return {
    mock: true,
    job_id: job.id,
    started_at: started.iso,
    frozen_at: null,
    progress_percent: progress,
    work_completed: `${progress}% — ${completedLabel(progress)}`,
    tokens_used: tokensUsed.toString(),
    token_unit_cost_usd: String(config.tokenUnitCostUsd),
    estimated_cost_usd: costUsd.toFixed(6),
    estimated_cost_cents: Math.round(costUsd * 100),
    cost_basis_raw: recoveryRaw.toString(),
    cost_basis_usd: costUsd.toFixed(6),
    recovery_raw: recoveryRaw.toString(),
    recovery_token_symbol: symbol,
    recovery_usd: recoveryUsd.toFixed(6),
    note: 'Simulated AI usage for the demo; not a real bill.',
  };
}
