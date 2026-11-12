import { getDb } from '@/lib/db/client';
import { agentEvents } from '@/lib/db/schema';
import { asc, desc, gt } from 'drizzle-orm';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 300;

const REPLAY_LIMIT = 200;
const POLL_MS = 1500;

/**
 * Vercel-compatible event feed. Instead of an in-process subscriber bus, the
 * stream polls the durable event table; this works across serverless instances.
 * The dashboard reconnects automatically when the function reaches maxDuration.
 */
async function handle(req: Request) {
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let lastId = 0;
      let closed = false;
      const send = (data: unknown) => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`)); } catch { closed = true; }
      };

      const db = getDb();
      try {
        const recent = await db.select().from(agentEvents).orderBy(desc(agentEvents.id)).limit(REPLAY_LIMIT);
        for (const row of recent.reverse()) {
          lastId = Math.max(lastId, row.id);
          send({
            id: row.id.toString(), type: row.type, payload: row.payloadJson,
            agentId: row.agentId, jobId: row.jobId, runId: row.runId, createdAt: row.createdAt,
            replay: true,
          });
        }
      } catch { /* db may be temporarily unavailable */ }

      const poll = setInterval(async () => {
        if (closed) return;
        try {
          const rows = await db.select().from(agentEvents)
            .where(gt(agentEvents.id, lastId))
            .orderBy(asc(agentEvents.id))
            .limit(200);
          for (const row of rows) {
            lastId = Math.max(lastId, row.id);
            send({
              id: row.id.toString(), type: row.type, payload: row.payloadJson,
              agentId: row.agentId, jobId: row.jobId, runId: row.runId, createdAt: row.createdAt,
            });
          }
        } catch { /* retry on next poll */ }
      }, POLL_MS);

      const keepalive = setInterval(() => {
        if (closed) return;
        try { controller.enqueue(encoder.encode(': ping\n\n')); } catch { closed = true; }
      }, 15000);

      req.signal.addEventListener('abort', () => {
        closed = true;
        clearInterval(poll);
        clearInterval(keepalive);
        try { controller.close(); } catch { /* noop */ }
      });
    },
  });
  return new Response(stream, {
    headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
  });
}

export async function POST(req: Request) {
  return handle(req);
}

export async function GET(req: Request) {
  return handle(req);
}
