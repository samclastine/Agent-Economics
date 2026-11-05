import { ok } from '@/lib/api';
import { abortAllRuns, abortRun } from '@/lib/run-control';

export const runtime = 'nodejs';

/** Abort one agent's chat/mailbox runs, or every registered run. */
export async function POST(req: Request) {
  let agentId: string | undefined;
  let scope: 'chat' | 'peer' | 'all' = 'all';
  try {
    const body = await req.json();
    agentId = typeof body?.agentId === 'string' ? body.agentId : undefined;
    if (body?.run === 'chat' || body?.run === 'peer' || body?.run === 'all') scope = body.run;
  } catch { /* no body */ }
  let aborted = 0;
  if (agentId) {
    if (scope === 'all' || scope === 'chat') aborted += abortRun(`chat:${agentId}`) ? 1 : 0;
    if (scope === 'all' || scope === 'peer') aborted += abortRun(`peer:${agentId}`) ? 1 : 0;
  } else {
    aborted = abortAllRuns();
  }
  return ok({ ok: true, abortedRuns: aborted });
}
