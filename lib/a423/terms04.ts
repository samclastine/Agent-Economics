import type { Json } from '@allorc/a423-sdk/workflow';

export type Terms04Input = {
  taskId: string;
  taskType: string;
  description: string;
  artifactPath: string;
  criteria: Record<string, Json>;
  amountRaw: string;
  amountDecimals: number;
  symbol: string;
  chainId: number;
  escrow: string;
  token: string;
  requester: { agentId: string; wallet: string };
  worker: { agentId: string; wallet: string };
  verifier: { agentId: string; wallet: string };
  arbitrator: { agentId: string; wallet: string };
  now?: number;
  workSeconds?: number;
  reviewSeconds?: number;
  resolutionSeconds?: number;
  timeoutWorkerBps?: number;
  quoteTtlSeconds?: number;
};

/** A423 terms: SDK task schema + official escrow object + app artifact path. */
export function buildTerms04(input: Terms04Input): { [key: string]: Json } {
  const now = Math.floor((input.now ?? Date.now()) / 1000);
  const work = now + (input.workSeconds ?? 3600);
  const review = work + (input.reviewSeconds ?? 3600);
  const resolution = review + (input.resolutionSeconds ?? 3600);
  return {
    task: {
      id: input.taskId,
      type: input.taskType,
      description: input.description,
      deliverables: [{ id: 'artifact', media_type: 'text/markdown', description: input.description }],
      acceptance: { validator: 'deterministic-v1', version: '1', criteria: { ...input.criteria, path: input.artifactPath } },
    },
    escrow: {
      chain_id: String(input.chainId),
      contract: input.escrow,
      token: input.token,
      amount: input.amountRaw,
      payer: input.requester.wallet,
      worker: input.worker.wallet,
      verifier: input.verifier.wallet,
      arbitrator: input.arbitrator.wallet,
      work_deadline: work,
      review_deadline: review,
      resolution_deadline: resolution,
      timeout_worker_bps: input.timeoutWorkerBps ?? 2500,
    },
    artifact_path: input.artifactPath,
    token_decimals: input.amountDecimals,
    token_symbol: input.symbol,
    expires_at: now + (input.quoteTtlSeconds ?? 900),
    price_usd_cents: 100,
  };
}
