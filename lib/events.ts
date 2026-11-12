import { getDb } from '@/lib/db/client';
import { agentEvents } from '@/lib/db/schema';

export async function emitEvent(opts: {
  type: string;
  payload?: Record<string, unknown>;
  agentId?: string | null;
  jobId?: string | null;
  runId?: string | null;
  /** Skip the Postgres insert and only publish to live subscribers (e.g. token deltas). */
  ephemeral?: boolean;
}): Promise<void> {
  // Ephemeral token deltas are best-effort only; serverless instances cannot
  // share an in-process subscriber bus. Durable events are polled by the SSE route.
  if (opts.ephemeral) return;
  const db = getDb();
  await db
    .insert(agentEvents)
    .values({
      type: opts.type,
      payloadJson: opts.payload ?? {},
      agentId: opts.agentId ?? null,
      jobId: opts.jobId ?? null,
      runId: opts.runId ?? null,
    })
    .returning().all();
}
