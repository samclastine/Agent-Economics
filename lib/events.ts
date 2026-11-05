import { getDb } from '@/lib/db/client';
import { agentEvents } from '@/lib/db/schema';

type Listener = (event: { id: string; type: string; payload: unknown; agentId?: string; jobId?: string; createdAt: Date; ephemeral?: boolean }) => void;

// Next.js dev can evaluate this module once per route bundle — keep the
// subscriber registry on globalThis so publishers and the SSE route share it.
const g = globalThis as unknown as {
  __agentTreasuryListeners?: Set<Listener>;
  __agentTreasuryEphemeralSeq?: number;
};
const listeners = (g.__agentTreasuryListeners ??= new Set<Listener>());
const ephemeralSeq = () => (g.__agentTreasuryEphemeralSeq = (g.__agentTreasuryEphemeralSeq ?? 0) + 1);

export function subscribeEvents(fn: Listener): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export async function emitEvent(opts: {
  type: string;
  payload?: Record<string, unknown>;
  agentId?: string | null;
  jobId?: string | null;
  runId?: string | null;
  /** Skip the Postgres insert and only publish to live subscribers (e.g. token deltas). */
  ephemeral?: boolean;
}): Promise<void> {
  if (opts.ephemeral) {
    const evt = {
      id: `live-${ephemeralSeq()}`,
      type: opts.type,
      payload: opts.payload ?? {},
      agentId: opts.agentId ?? undefined,
      jobId: opts.jobId ?? undefined,
      createdAt: new Date(),
      ephemeral: true,
    };
    for (const fn of listeners) {
      try { fn(evt); } catch { /* ignore listener errors */ }
    }
    return;
  }
  const db = getDb();
  const [row] = await db
    .insert(agentEvents)
    .values({
      type: opts.type,
      payloadJson: opts.payload ?? {},
      agentId: opts.agentId ?? null,
      jobId: opts.jobId ?? null,
      runId: opts.runId ?? null,
    })
    .returning().all();
  const evt = {
    id: row.id.toString(),
    type: row.type,
    payload: row.payloadJson,
    agentId: row.agentId ?? undefined,
    jobId: row.jobId ?? undefined,
    createdAt: row.createdAt,
  };
  for (const fn of listeners) {
    try { fn(evt); } catch { /* ignore listener errors */ }
  }
}
