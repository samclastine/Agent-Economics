import type { WorkflowJob } from '@allorc/a423-sdk/workflow';
import { getA423Bridge } from './bridge04';
import { computeWorkMeter, defaultWorkMeterConfig, type WorkMeter, type WorkMeterConfig } from './work-meter-core';

export type { WorkMeter, WorkMeterConfig };
export { computeWorkMeter, defaultWorkMeterConfig };

const NS = 'a423:work-meter';
const TERMINAL = new Set(['paid', 'settled', 'refunded', 'cancelled', 'expired', 'resolved']);

/** Older meters persisted only recovery_raw; treat that as cost basis. */
function normalizeMeter(meter: WorkMeter): WorkMeter {
  if (meter.cost_basis_raw) return meter;
  return {
    ...meter,
    cost_basis_raw: meter.recovery_raw,
    cost_basis_usd: meter.estimated_cost_usd,
  };
}

export async function getWorkMeter(
  job: WorkflowJob,
  options: { freeze?: boolean; now?: number; config?: Partial<WorkMeterConfig> } = {},
): Promise<WorkMeter> {
  const bridge = await getA423Bridge();
  const stored = await bridge.storage.kv.get(NS, job.id) as WorkMeter | null;
  if (stored?.frozen_at) return normalizeMeter(stored);
  const config = { ...defaultWorkMeterConfig(), ...options.config };
  const defaultNow = options.now ?? (TERMINAL.has(job.state) || job.state === 'settlement_negotiation'
    ? Date.parse(job.updated_at) || Date.now()
    : Date.now());
  const meter = computeWorkMeter(job, defaultNow, config);
  const shouldFreeze = options.freeze === true || TERMINAL.has(job.state) || job.state === 'settlement_negotiation';
  if (!shouldFreeze) return meter;
  const frozen = { ...meter, frozen_at: new Date(defaultNow).toISOString() };
  await bridge.storage.kv.put(NS, job.id, frozen);
  return frozen;
}

export async function getStoredWorkMeter(jobId: string): Promise<WorkMeter | null> {
  const bridge = await getA423Bridge();
  const stored = await bridge.storage.kv.get(NS, jobId) as WorkMeter | null;
  return stored ? normalizeMeter(stored) : null;
}

/** Projection rule: live while working, persisted for any closing negotiation. */
export async function getWorkMeterForProjection(job: WorkflowJob): Promise<WorkMeter | null> {
  const stored = await getStoredWorkMeter(job.id);
  if (stored) return stored;
  if (job.state === 'running' || job.state === 'settlement_negotiation') return getWorkMeter(job);
  return null;
}

export async function freezeWorkMeter(
  job: WorkflowJob,
  options: { now?: number; config?: Partial<WorkMeterConfig> } = {},
): Promise<WorkMeter> {
  return getWorkMeter(job, { ...options, freeze: true });
}
