import type { WorkflowJob } from '@allorc/a423-sdk/workflow';
import { getA423Bridge } from './bridge04';
import { formatA423Context, type ProfitView } from './summary';
import { getWorkMeterForProjection, type WorkMeter } from './work-meter';

const TERMINAL = new Set(['paid', 'settled', 'resolved', 'cancelled', 'expired', 'refunded']);

function newestFirst(a: WorkflowJob, b: WorkflowJob): number {
  return Date.parse(b.updated_at ?? b.created_at ?? '') - Date.parse(a.updated_at ?? a.created_at ?? '');
}

/**
 * Fresh A423 context for every agent turn. This is what lets an agent recover
 * its workflow ID after a new chat session instead of guessing or saying it
 * cannot find the job.
 */
export async function a423ContextFor(agentId: string): Promise<string> {
  const bridge = await getA423Bridge();
  const jobs = await bridge.storage.jobs.list({ actor: agentId, limit: 50 });
  const active = jobs.filter((job) => !TERMINAL.has(job.state)).sort(newestFirst);
  const recent = jobs.filter((job) => TERMINAL.has(job.state)).sort(newestFirst).slice(0, 3);
  const selected = [...active, ...recent].slice(0, 10);
  const meters = new Map<string, WorkMeter>();
  const profits = new Map<string, ProfitView | null>();
  await Promise.all(selected.map(async (job) => {
    try {
      const meter = await getWorkMeterForProjection(job);
      if (meter) meters.set(job.id, meter);
    } catch { /* meter is advisory */ }
    try {
      profits.set(job.id, await bridge.app.applicationOptions.profitFor?.(job, agentId) ?? null);
    } catch { /* policy projection is advisory */ }
  }));
  return formatA423Context(selected, agentId, meters, profits);
}
