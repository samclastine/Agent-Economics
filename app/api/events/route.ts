import { getDb } from '@/lib/db/client';
import { agentEvents } from '@/lib/db/schema';
import { gt, asc, desc } from 'drizzle-orm';
import { ok, fail } from '@/lib/api';

export const runtime = 'nodejs';

export async function GET(req: Request) {
  const url = new URL(req.url);
  const after = url.searchParams.get('after');
  const latest = url.searchParams.get('latest');
  const db = getDb();
  try {
    // `latest=1` mirrors the SSE replay (most recent window, ascending) for
    // clients that cannot stream, e.g. behind a Cloudflare Quick Tunnel.
    const rows = latest
      ? (await db.select().from(agentEvents).orderBy(desc(agentEvents.id)).limit(200)).reverse()
      : after
        ? await db.select().from(agentEvents).where(gt(agentEvents.id, Number(after))).orderBy(asc(agentEvents.id)).limit(200)
        : await db.select().from(agentEvents).orderBy(asc(agentEvents.id)).limit(200);
    return ok({
      events: rows.map((r) => ({
        id: r.id.toString(),
        type: r.type,
        payload: r.payloadJson,
        agentId: r.agentId,
        jobId: r.jobId,
        runId: r.runId,
        createdAt: r.createdAt,
      })),
    });
  } catch (e) {
    return fail(e instanceof Error ? e.message : 'error', 500);
  }
}
