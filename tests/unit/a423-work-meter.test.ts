import { describe, it, expect } from 'vitest';
import type { WorkflowJob } from '@allorc/a423-sdk/workflow';
import { computeWorkMeter } from '@/lib/a423/work-meter';

const NOW = Date.parse('2026-11-12T05:00:00.000Z');
const CONFIG = { taskMinutes: 10, tokensPerMinute: 1800, tokenUnitCostUsd: 0.00002, tokenPriceUsd: 0.02 };

function job(overrides: Partial<WorkflowJob> = {}): WorkflowJob {
  const startAt = new Date(NOW - 5 * 60_000).toISOString();
  return {
    id: 'wf-meter-test',
    protocol: 'a423.workflow.v1',
    version: 1,
    state: 'running',
    participants: {
      requester: 'agent-a',
      worker: 'agent-b',
      verifier: 'agent-a',
      arbitrator: 'a423-arbiter',
    },
    metadata: {},
    agreement: {
      revision: 1,
      hash: 'hash',
      accepted_by: ['agent-a', 'agent-b'],
      terms: {
        token_decimals: 18,
        token_symbol: 'tWIF',
        price_usd_cents: 100,
        escrow: {
          chain_id: '46630',
          contract: '0x2E983A1Ba5e8b38AAAeC4B440B9dDcFBf72E15d1',
          token: '0x663F3ad617193148711d28f5334eE4Ed07016602',
          amount: (50n * 10n ** 18n).toString(),
          work_deadline: Math.floor(NOW / 1000) + 3600,
          review_deadline: Math.floor(NOW / 1000) + 7200,
          resolution_deadline: Math.floor(NOW / 1000) + 10800,
        },
      },
    },
    submission: null,
    pending: null,
    operations: {},
    evidence: [],
    events: [
      { sequence: 1, type: 'created', actor_id: 'agent-a', at: new Date(NOW - 10 * 60_000).toISOString(), data: {} },
      { sequence: 2, type: 'start.confirmed', actor_id: 'agent-b', at: startAt, data: {} },
    ],
    created_at: new Date(NOW - 10 * 60_000).toISOString(),
    updated_at: startAt,
    ...overrides,
  } as WorkflowJob;
}

describe('simulated A423 work meter', () => {
  it('reports progress and a token-cost recovery suggestion while running', () => {
    const meter = computeWorkMeter(job(), NOW, CONFIG);
    expect(meter.mock).toBe(true);
    expect(meter.progress_percent).toBe(50);
    expect(meter.work_completed).toContain('50%');
    expect(Number(meter.tokens_used)).toBe(10_000);
    expect(Number(meter.estimated_cost_usd)).toBeCloseTo(0.2, 6);
    expect(meter.recovery_raw).toBe((10n * 10n ** 18n).toString());
    expect(meter.recovery_token_symbol).toBe('tWIF');
    expect(meter.note).toContain('Simulated');
  });

  it('reports zero when work has not started', () => {
    const meter = computeWorkMeter(job({ state: 'funded', events: [] }), NOW, CONFIG);
    expect(meter.progress_percent).toBe(0);
    expect(meter.tokens_used).toBe('0');
    expect(meter.recovery_raw).toBe('0');
  });

  it('reports complete on submitted work', () => {
    const meter = computeWorkMeter(job({ state: 'submitted' }), NOW, CONFIG);
    expect(meter.progress_percent).toBe(100);
    expect(Number(meter.tokens_used)).toBeGreaterThan(10_000);
  });

  it('caps the recovery suggestion at the escrow amount', () => {
    const small = job();
    (small.agreement!.terms.escrow as Record<string, unknown>).amount = (1n * 10n ** 18n).toString();
    const meter = computeWorkMeter(small, NOW, CONFIG);
    expect(BigInt(meter.recovery_raw)).toBeLessThanOrEqual(1n * 10n ** 18n);
    expect(BigInt(meter.recovery_raw)).toBeGreaterThan(0n);
  });
});
