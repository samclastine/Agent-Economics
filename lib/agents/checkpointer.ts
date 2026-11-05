import { MemorySaver } from '@langchain/langgraph-checkpoint';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';

/**
 * Checkpointer singleton. In-memory MemorySaver only — each thread_id gets a
 * checkpointed session inside this process, and reset/restart drops it. There
 * is intentionally no durable checkpoint store: sessions are ephemeral by
 * design. To persist across restarts, implement a different saver and point
 * this module at it; nothing else in the app depends on the choice.
 *
 * Stored on globalThis: Next.js dev evaluates this module once per route
 * bundle, and all agents/routes must share ONE saver or checkpoints fragment.
 * The entry shape is kept so older cached copies in a warm process keep working.
 */
type Entry = { saver: BaseCheckpointSaver; durable: boolean };
const g = globalThis as unknown as { __agentTreasuryCheckpointer?: Entry | BaseCheckpointSaver };

function entry(): Entry {
  const cur = g.__agentTreasuryCheckpointer;
  if (cur && typeof cur === 'object' && 'saver' in cur) return cur as Entry;
  if (cur) {
    const fallback = { saver: cur as BaseCheckpointSaver, durable: false };
    g.__agentTreasuryCheckpointer = fallback;
    return fallback;
  }
  const e: Entry = { saver: new MemorySaver(), durable: false };
  g.__agentTreasuryCheckpointer = e;
  return e;
}

export function getCheckpointer(): BaseCheckpointSaver {
  return entry().saver;
}

export async function ensureCheckpointerSetup() {
  // MemorySaver needs no setup.
}
